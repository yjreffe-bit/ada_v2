import asyncio
import json
import re
from datetime import datetime
from pathlib import Path
from xml.sax.saxutils import escape

from oauth_connections import canva_access_token
from provider_http import http_request


class DigitalProductAgent:
    """Creates a real presentation, flyer, or document on disk.

    A Canva design is also created when Canva is connected in Settings, or when
    CANVA_ACCESS_TOKEN is set. The local file is the content.
    """

    def __init__(self, output_dir=None, http_request=None):
        self.output_dir = Path(output_dir) if output_dir else Path.home() / "Documents" / "ADA_3.1"
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self._http = http_request or globals()["http_request"]

    async def create_digital_product(self, prompt, platform="canva", product_type="presentation"):
        if not prompt or not str(prompt).strip():
            return "A description is required before ADA can create a digital product."

        kind = _normalize_product_type(product_type)
        outline = _outline_from_prompt(str(prompt).strip(), kind)
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        slug = _slug(outline["title"])

        if kind == "flyer":
            path = self.output_dir / f"{slug}_{stamp}.png"
            _write_flyer(path, outline)
        elif kind == "document":
            path = self.output_dir / f"{slug}_{stamp}.pdf"
            _write_pdf(path, outline)
        else:
            path = self.output_dir / f"{slug}_{stamp}.pptx"
            _write_pptx(path, outline)

        if not path.exists() or path.stat().st_size == 0:
            return f"ADA failed to write the {kind} file."

        canva_note = await self._maybe_create_canva_design(outline["title"], kind, platform)
        return f"Created {kind} '{outline['title']}' at {path}. {canva_note}"

    async def _maybe_create_canva_design(self, title, kind, platform):
        token = canva_access_token()
        if (platform or "").strip().lower() not in {"", "canva"}:
            return f"Platform '{platform}' is saved as a local file. ADA creates the editable Canva design when platform is canva."
        if not token:
            return "Canva design was not created because Canva is not connected. Use Connect in Settings, or set CANVA_ACCESS_TOKEN."

        if kind == "document":
            design_type = {"type": "preset", "name": "doc"}
        elif kind == "flyer":
            design_type = {"type": "custom", "width": 1080, "height": 1350}
        else:
            design_type = {"type": "preset", "name": "presentation"}

        payload = {"title": title[:250], "design_type": design_type}
        try:
            result = await asyncio.to_thread(
                self._http,
                "POST",
                "https://api.canva.com/rest/v1/designs",
                {
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                },
                json.dumps(payload).encode("utf-8"),
            )
        except Exception as exc:
            return f"The local file was saved, but Canva design creation failed: {exc}"

        if result.status >= 400:
            return f"The local file was saved, but Canva rejected the design ({result.status}): {result.text()[:300]}"

        design = (result.json() or {}).get("design") or {}
        edit_url = ((design.get("urls") or {}).get("edit_url")) or ""
        if not edit_url:
            return "The local file was saved, but Canva did not return an edit URL."
        return f"Canva design is ready to edit: {edit_url}"


def _normalize_product_type(product_type):
    name = (product_type or "presentation").strip().lower()
    if name in {"flyer", "poster", "image", "png"}:
        return "flyer"
    if name in {"document", "doc", "pdf", "report"}:
        return "document"
    return "presentation"


def _slug(title):
    cleaned = re.sub(r"[^a-zA-Z0-9]+", "_", title).strip("_").lower()
    return (cleaned or "ada_product")[:40]


def _outline_from_prompt(prompt, kind):
    lines = [line.strip(" -*\t") for line in prompt.splitlines() if line.strip()]
    if not lines:
        lines = [prompt.strip()]
    title = lines[0][:80]
    body = lines[1:] or _sentences(prompt)
    if body and body[0] == title:
        body = body[1:]
    if not body:
        body = [prompt.strip()]

    if kind == "flyer":
        return {"title": title, "lines": body[:8]}

    if kind == "document":
        sections = [{"heading": title, "body": paragraph} for paragraph in body[:12]]
        return {"title": title, "sections": sections}

    slides = []
    chunk = []
    for line in body:
        chunk.append(line[:180])
        if len(chunk) == 4:
            slides.append(chunk)
            chunk = []
    if chunk:
        slides.append(chunk)
    slides = slides[:8] or [[prompt.strip()[:180]]]
    return {
        "title": title,
        "slides": [{"title": title if index == 0 else f"{title} ({index + 1})", "bullets": bullets} for index, bullets in enumerate(slides)],
    }


def _sentences(prompt):
    parts = re.split(r"(?<=[.!?])\s+", prompt.strip())
    return [part.strip() for part in parts if part.strip()]


def _write_flyer(path, outline):
    from PIL import Image, ImageDraw, ImageFont

    image = Image.new("RGB", (1080, 1350), "#07131c")
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default()
    draw.rectangle((0, 0, 1080, 16), fill="#39d0ff")
    draw.text((72, 80), outline["title"][:80], fill="#e8fbff", font=font)
    y = 180
    for line in outline["lines"]:
        for wrapped in _wrap(line, 48):
            draw.text((72, y), wrapped, fill="#d5e7ef", font=font)
            y += 28
            if y > 1240:
                break
    image.save(path, "PNG")


def _wrap(text, width):
    words = text.split()
    if not words:
        return [""]
    lines = []
    current = words[0]
    for word in words[1:]:
        if len(current) + 1 + len(word) <= width:
            current += " " + word
        else:
            lines.append(current)
            current = word
    lines.append(current)
    return lines


def _write_pdf(path, outline):
    lines = [outline["title"], ""]
    for section in outline["sections"]:
        lines.append(section["heading"])
        lines.extend(_wrap(section["body"], 90))
        lines.append("")
    commands = ["BT", "/F1 12 Tf", "72 740 Td", "16 TL"]
    for line in lines[:50]:
        safe = line.encode("latin-1", "replace").decode("latin-1")
        safe = safe.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        commands.append(f"({safe}) Tj")
        commands.append("T*")
    commands.append("ET")
    stream = "\n".join(commands).encode("latin-1", "replace")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length " + str(len(stream)).encode("ascii") + b" >>\nstream\n" + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    pdf = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for index, obj in enumerate(objects, start=1):
        offsets.append(len(pdf))
        pdf.extend(f"{index} 0 obj\n".encode("ascii"))
        pdf.extend(obj)
        pdf.extend(b"\nendobj\n")
    xref = len(pdf)
    pdf.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
    pdf.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        pdf.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    pdf.extend(
        f"trailer << /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode("ascii")
    )
    path.write_bytes(pdf)


def _write_pptx(path, outline):
    slides = outline["slides"]
    files = {
        "[Content_Types].xml": _content_types(len(slides)),
        "_rels/.rels": _package_rels(),
        "ppt/presentation.xml": _presentation_xml(len(slides)),
        "ppt/_rels/presentation.xml.rels": _presentation_rels(len(slides)),
        "ppt/slideMasters/slideMaster1.xml": _SLIDE_MASTER,
        "ppt/slideMasters/_rels/slideMaster1.xml.rels": _SLIDE_MASTER_RELS,
        "ppt/slideLayouts/slideLayout1.xml": _SLIDE_LAYOUT,
        "ppt/slideLayouts/_rels/slideLayout1.xml.rels": _SLIDE_LAYOUT_RELS,
        "ppt/theme/theme1.xml": _THEME,
    }
    for index, slide in enumerate(slides, start=1):
        files[f"ppt/slides/slide{index}.xml"] = _slide_xml(slide["title"], slide["bullets"])
        files[f"ppt/slides/_rels/slide{index}.xml.rels"] = _SLIDE_RELS

    import zipfile
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, contents in files.items():
            archive.writestr(name, contents)


def _content_types(slide_count):
    overrides = [
        '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>',
        '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>',
        '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>',
        '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>',
    ]
    for index in range(1, slide_count + 1):
        overrides.append(
            f'<Override PartName="/ppt/slides/slide{index}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'
        )
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        + "".join(overrides)
        + "</Types>"
    )


def _package_rels():
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>'
        "</Relationships>"
    )


def _presentation_xml(slide_count):
    slide_ids = "".join(
        f'<p:sldId id="{256 + index}" r:id="rId{index + 1}"/>' for index in range(slide_count)
    )
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
        'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
        '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>'
        f"<p:sldIdLst>{slide_ids}</p:sldIdLst>"
        '<p:sldSz cx="12192000" cy="6858000" type="screen16x9"/>'
        '<p:notesSz cx="6858000" cy="9144000"/>'
        "</p:presentation>"
    )


def _presentation_rels(slide_count):
    rels = [
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>'
    ]
    for index in range(1, slide_count + 1):
        rels.append(
            f'<Relationship Id="rId{index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide{index}.xml"/>'
        )
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + "".join(rels)
        + "</Relationships>"
    )


def _slide_xml(title, bullets):
    paragraphs = [_paragraph(title, 3200, bold=True)]
    for bullet in bullets:
        paragraphs.append(_paragraph(bullet, 2000, bold=False))
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
        'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
        "<p:cSld><p:spTree>"
        '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
        "<p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/>"
        "<a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr>"
        '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Content"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
        "<p:spPr><a:xfrm><a:off x=\"457200\" y=\"365760\"/><a:ext cx=\"11277600\" cy=\"6126480\"/></a:xfrm>"
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>'
        f"<p:txBody><a:bodyPr/><a:lstStyle/>{''.join(paragraphs)}</p:txBody></p:sp>"
        "</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>"
    )


def _paragraph(text, size, bold):
    bold_attr = ' b="1"' if bold else ""
    return (
        "<a:p><a:r>"
        f'<a:rPr lang="en-US" sz="{size}"{bold_attr}/>'
        f"<a:t>{escape(text)}</a:t></a:r></a:p>"
    )


_SLIDE_RELS = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>'
    "</Relationships>"
)

_SLIDE_LAYOUT = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="title" preserve="1">'
    "<p:cSld name=\"Title\"><p:spTree>"
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
    "<p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/><a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr>"
    "</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>"
)

_SLIDE_LAYOUT_RELS = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>'
    "</Relationships>"
)

_SLIDE_MASTER = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
    "<p:cSld><p:spTree>"
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
    "<p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/><a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr>"
    "</p:spTree></p:cSld>"
    "<p:clrMap bg1=\"lt1\" tx1=\"dk1\" bg2=\"lt2\" tx2=\"dk2\" accent1=\"accent1\" accent2=\"accent2\" accent3=\"accent3\" accent4=\"accent4\" accent5=\"accent5\" accent6=\"accent6\" hlink=\"hlink\" folHlink=\"folHlink\"/>"
    "<p:sldLayoutIdLst><p:sldLayoutId id=\"2147483649\" r:id=\"rId1\"/></p:sldLayoutIdLst>"
    "</p:sldMaster>"
)

_SLIDE_MASTER_RELS = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>'
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>'
    "</Relationships>"
)

_THEME = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="ADA">'
    "<a:themeElements>"
    "<a:clrScheme name=\"ADA\">"
    "<a:dk1><a:srgbClr val=\"07131C\"/></a:dk1><a:lt1><a:srgbClr val=\"FFFFFF\"/></a:lt1>"
    "<a:dk2><a:srgbClr val=\"0E2430\"/></a:dk2><a:lt2><a:srgbClr val=\"E8FBFF\"/></a:lt2>"
    "<a:accent1><a:srgbClr val=\"39D0FF\"/></a:accent1><a:accent2><a:srgbClr val=\"7C5CFF\"/></a:accent2>"
    "<a:accent3><a:srgbClr val=\"39D0FF\"/></a:accent3><a:accent4><a:srgbClr val=\"39D0FF\"/></a:accent4>"
    "<a:accent5><a:srgbClr val=\"39D0FF\"/></a:accent5><a:accent6><a:srgbClr val=\"39D0FF\"/></a:accent6>"
    "<a:hlink><a:srgbClr val=\"39D0FF\"/></a:hlink><a:folHlink><a:srgbClr val=\"7C5CFF\"/></a:folHlink>"
    "</a:clrScheme>"
    "<a:fontScheme name=\"ADA\"><a:majorFont><a:latin typeface=\"Calibri\"/></a:majorFont>"
    "<a:minorFont><a:latin typeface=\"Calibri\"/></a:minorFont></a:fontScheme>"
    "<a:fmtScheme name=\"ADA\"><a:fillStyleLst><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:fillStyleLst>"
    "<a:lnStyleLst><a:ln w=\"6350\"><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:ln></a:lnStyleLst>"
    "<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>"
    "<a:bgFillStyleLst><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:bgFillStyleLst>"
    "</a:fmtScheme></a:themeElements></a:theme>"
)
