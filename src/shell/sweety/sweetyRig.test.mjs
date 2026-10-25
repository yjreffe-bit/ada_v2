import test from 'node:test';
import assert from 'node:assert/strict';
import { lidOpacity, mouthLayers, mouthScaleX, rainHead } from './sweetyRig.js';
import { mouthShape } from '../sweetyMath.js';

test('resting speech keeps the closed mouth, loud speech opens it', () => {
    const rest = mouthLayers(mouthShape(false, 1).openness);
    assert.equal(rest.mid, 0);
    assert.equal(rest.open, 0);
    const loud = mouthLayers(mouthShape(true, 1).openness);
    assert.equal(loud.mid, 0);
    assert.ok(loud.open > 0.99);
});

test('a blink closes the eye layer and reduced-motion rain stays put', () => {
    assert.equal(lidOpacity(1), 0);
    assert.equal(lidOpacity(0), 1);
    const column = { phase: 0.25, speed: 0.0003 };
    assert.equal(rainHead(column, 1000, true), 0.25);
    assert.ok(Math.abs(rainHead(column, 1000, false) - 0.55) < 1e-9);
});

test('an open mouth is a little narrower than the rest width', () => {
    const full = mouthShape(true, 1);
    assert.ok(mouthScaleX(full.width) < mouthScaleX(0.72));
    assert.ok(mouthScaleX(full.width) > 0.85);
});
