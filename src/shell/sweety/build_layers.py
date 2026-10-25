"""Cut the expression sheet into a keyed sprite the desktop and Android apps share.

The source sheet is an original illustration generated for ADA. It is not a
photo and not someone else's artwork. Run from the repo root:

    python src/shell/sweety/build_layers.py
"""

import json
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "source-sheet.jpg"
OUTPUT = ROOT / "sweety-layers.png"
LAYOUT = ROOT / "layers.json"

# Native crops from the 1024 sheet. closed/open share the rest frame's origin
# offset. mid is shifted by the measured registration (sample mid at +2, -2).
FRAME_W = 454
FRAME_H = 488
ORIGINS = {
    "rest": (29, 15),
    "closed": (538, 15),
    "mid": (30, 518),
    "open": (537, 520),
}


def _keyed(image):
    """Drop the flat magenta backdrop and pull magenta spill off the edges."""
    image = image.convert("RGBA")
    pixels = image.load()
    width, height = image.size
    for y in range(height):
        for x in range(width):
            red, green, blue, alpha = pixels[x, y]
            spill = min(red, blue) - green
            magenta = red > 145 and blue > 95 and green < 150 and spill > 35 and red + blue > green * 2.1
            if not magenta:
                continue
            if spill > 90:
                pixels[x, y] = (0, 0, 0, 0)
                continue
            cover = int(255 * (spill - 35) / 55)
            kept = max(0, min(alpha, 255 - cover))
            pixels[x, y] = (min(red, green + 30), green, min(blue, green + 30), kept)
    return image


def build(source=SOURCE, output=OUTPUT, layout_path=LAYOUT):
    sheet = Image.open(source).convert("RGB")
    sprite = Image.new("RGBA", (FRAME_W * len(ORIGINS), FRAME_H), (0, 0, 0, 0))
    order = ("rest", "closed", "mid", "open")
    for index, name in enumerate(order):
        left, top = ORIGINS[name]
        frame = _keyed(sheet.crop((left, top, left + FRAME_W, top + FRAME_H)))
        sprite.paste(frame, (index * FRAME_W, 0), frame)
    output.parent.mkdir(parents=True, exist_ok=True)
    sprite.save(output, optimize=True)
    layout = {
        "version": 1,
        "image": output.name,
        "frameWidth": FRAME_W,
        "frameHeight": FRAME_H,
        "frames": {name: index for index, name in enumerate(order)},
        "eyes": {"x": 0.22, "y": 0.16, "w": 0.56, "h": 0.24},
        "mouth": {"x": 0.34, "y": 0.45, "w": 0.39, "h": 0.28},
        "accent": "#22D3EE",
        "error": "#FB7185",
        "notes": "Normalized rects are fractions of one frame. Y increases downward. The sheet order is rest, eyes closed, mouth parted, mouth open.",
    }
    layout_path.write_text(json.dumps(layout, indent=2) + "\n", encoding="utf-8")
    return sprite


if __name__ == "__main__":
    image = build()
    print(image.size, image.mode)
