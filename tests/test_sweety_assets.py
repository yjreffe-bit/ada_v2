"""The hologram sprite Android reuses is present and keyed."""

import json
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SWEETY = ROOT / "src" / "shell" / "sweety"


def test_sprite_sheet_matches_layout():
    meta = json.loads((SWEETY / "layers.json").read_text(encoding="utf-8"))
    image = Image.open(SWEETY / "sweety-layers.png")
    assert image.mode == "RGBA"
    assert image.size == (meta["frameWidth"] * 4, meta["frameHeight"])
    assert set(meta["frames"]) == {"rest", "closed", "mid", "open"}
    assert image.getpixel((2, 2))[3] == 0
    face = image.getpixel((meta["frameWidth"] // 2, int(meta["frameHeight"] * 0.42)))
    suit = image.getpixel((meta["frameWidth"] // 2, int(meta["frameHeight"] * 0.86)))
    assert face[3] > 200
    assert suit[3] > 200
    assert suit[0] < 90 and suit[1] < 90 and suit[2] < 100
    for rect in (meta["eyes"], meta["mouth"]):
        assert 0 <= rect["x"] < 1
        assert 0 <= rect["y"] < 1
        assert rect["x"] + rect["w"] <= 1
        assert rect["y"] + rect["h"] <= 1
