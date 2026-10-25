# Sweety hologram layers

Original illustrated character for ADA. She is a woman in her twenties, not a real person and not a copy of any stock image. Long dark auburn hair in a high ponytail, warm calm face, matte charcoal high-collar tunic with cyan piping. Head and shoulders only. The suit covers her neck, shoulders, and chest.

The desktop draws her on a canvas. Android can reuse the same files.

## Assets

| File | Role |
| --- | --- |
| `sweety-layers.png` | Four frames side by side, keyed to transparent. Runtime sprite. |
| `source-sheet.jpg` | The uncut illustration the sprite was made from. |
| `layers.json` | Frame size, frame index, and normalized eye and mouth rectangles. |
| `build_layers.py` | Rebuilds the PNG and JSON from the sheet. Needs Pillow. |

Frame order, left to right:

1. `rest` — eyes open, gentle closed smile. This is the body that is always drawn.
2. `closed` — same crop, eyes closed. Only the eye rectangle is copied, for blinks.
3. `mid` — lips parted.
4. `open` — mouth open for louder speech.

`layers.json` rectangles are fractions of one frame, origin top-left, Y downward.

Regenerate:

```bash
python src/shell/sweety/build_layers.py
```

## Draw order

1. Data streams behind her. 36 vertical streaks from `rainColumns()` in `sweetyRig.js`. No per-frame random. They scroll with time and use the accent color.
2. Soft cyan glow of the resting frame (`shadowBlur` baked once).
3. Resting frame, fitted inside the square with a 3% margin.
4. Mouth rectangle from `mid` and `open`, feathered at the edges, alphas from `mouthLayers(openness)`.
5. Eye rectangle from `closed`, alpha `1 - blink`.
6. Listening adds a cyan glow on each eye and a pulse ring.
7. Error multiplies the portrait toward `#FB7185` at alpha 0.42.
8. Scan lines every 4px at alpha 0.16, clipped to the portrait, drifting with breath. Thinking adds one brighter band that travels top to bottom.

Accent is `#22D3EE`. Error accent is `#FB7185`. A short flicker drops portrait alpha to 0.78. Idle glow breathes from 0.55 to 0.90. The portrait itself stays readable.

Slight tilt follows breath, about ±0.025 rad. Vertical float is `sin(breath * π) * 6` px, the same clock as before.

## Mouth, blink, and the clock

Openness and width come from the existing playback math. The mouth never follows the microphone.

```
rest = openness 0.08, width 0.72
if not speaking or level < 0.045: rest
openness = clamp(0.10 + (level - 0.045) / 0.955 * 0.90, 0, 1)
width = clamp(0.78 - openness * 0.28, 0.45, 0.85)
```

`mouthLayers`:

- below 0.16: no mouth overlay (the resting smile shows)
- 0.16 → 0.42: fade in the parted mouth
- 0.40 → 0.78: crossfade from parted to open

`mouthScaleX = 1 + (width - 0.72) * 0.35`, so a loud syllable is a little narrower.

Blink stays open except during 0.84–0.92 of a 4500 ms cycle, where it closes and opens. The closed point is 0.88. Clock lengths: breath 3200 ms reverse, flicker 2400 ms (gain 0.78 only during 0.12–0.18), shimmer 1400 ms, pulse 1600 ms.

Listening uses wider-eye glow. Thinking uses the traveling band. Speaking uses the mouth layers above. Anything else is idle.

## Reduced motion and power

When the OS asks for reduced motion, breath, blink, flicker, float, tilt, scan drift, shimmer, pulse, and the data streams freeze. Blink stays open. Do not run the animation clock. The mouth still follows playback level, and a level change redraws one frame.

Cap the backing-store pixel ratio at 1.5. When the document is hidden, cancel the animation frame and do not draw until it is visible again.

The orb fallback is a separate component and is not drawn while this face is showing.
