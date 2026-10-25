import test from 'node:test';
import assert from 'node:assert/strict';
import { faceClock, mouthShape, normalizeLook } from './sweetyMath.js';

test('mouth rests unless playback is actually speaking', () => {
    assert.deepEqual(mouthShape(false, 1), { openness: 0.08, width: 0.72 });
    assert.deepEqual(mouthShape(true, 0.04), { openness: 0.08, width: 0.72 });
    const full = mouthShape(true, 1);
    assert.equal(full.openness, 1);
    assert.ok(Math.abs(full.width - 0.5) < 1e-12);
});

test('reduced motion freezes the clock and keeps the eyes open', () => {
    const frozen = faceClock(99999, true);
    assert.equal(frozen.floatY, 0);
    assert.equal(frozen.blink, 1);
    assert.equal(frozen.flicker, 1);
    assert.equal(frozen.breath, 0);
    const midBlink = faceClock(4500 * 0.88, false);
    assert.ok(midBlink.blink < 0.05);
});

test('only orb selects the ring', () => {
    assert.equal(normalizeLook(' ORB '), 'orb');
    assert.equal(normalizeLook(''), 'sweety');
    assert.equal(normalizeLook('face'), 'sweety');
});
