/** Section 18 timings and mouth math. No canvas, so the numbers can be tested. */

export function normalizeLook(value) {
    return String(value || '').trim().toLowerCase() === 'orb' ? 'orb' : 'sweety';
}

export function mouthShape(speaking, playbackLevel) {
    const rest = { openness: 0.08, width: 0.72 };
    if (!speaking) return rest;
    const amp = Math.min(1, Math.max(0, Number(playbackLevel) || 0));
    if (amp < 0.045) return rest;
    const openness = Math.min(1, Math.max(0, 0.10 + ((amp - 0.045) / 0.955) * 0.90));
    const width = Math.min(0.85, Math.max(0.45, 0.78 - openness * 0.28));
    return { openness, width };
}

export function faceClock(elapsed, reduced) {
    if (reduced) {
        return { breath: 0, blink: 1, flicker: 1, shimmer: 0, pulse: 0, floatY: 0 };
    }
    const breathPhase = (elapsed % 6400) / 3200;
    const breath = breathPhase <= 1 ? breathPhase : 2 - breathPhase;
    const blinkPhase = (elapsed % 4500) / 4500;
    let blink = 1;
    if (blinkPhase >= 0.84 && blinkPhase <= 0.92) {
        const span = (blinkPhase - 0.84) / 0.08;
        blink = span <= 0.5 ? 1 - span * 2 : (span - 0.5) * 2;
    }
    const flickerPhase = (elapsed % 2400) / 2400;
    const flicker = flickerPhase >= 0.12 && flickerPhase <= 0.18 ? 0.78 : 1;
    return {
        breath,
        blink,
        flicker,
        shimmer: (elapsed % 1400) / 1400,
        pulse: (elapsed % 1600) / 1600,
        floatY: Math.sin(breath * Math.PI) * 6,
    };
}
