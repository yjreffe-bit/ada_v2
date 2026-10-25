/** Layer choices for the Sweety hologram. No canvas, so node can test them. */

export function smoothstep(edge0, edge1, value) {
    const span = edge1 - edge0;
    if (span === 0) return value >= edge1 ? 1 : 0;
    const t = Math.min(1, Math.max(0, (value - edge0) / span));
    return t * t * (3 - 2 * t);
}

/** How strongly the parted and open mouth layers cover the resting portrait. */
export function mouthLayers(openness) {
    const open = Math.min(1, Math.max(0, Number(openness) || 0));
    const mid = smoothstep(0.16, 0.42, open);
    const wide = smoothstep(0.40, 0.78, open);
    return { mid: mid * (1 - wide), open: wide };
}

export function lidOpacity(blink) {
    return Math.min(1, Math.max(0, 1 - (Number(blink) || 0)));
}

/** Horizontal squeeze from the section 18 width. Full speech is a little narrower. */
export function mouthScaleX(width) {
    const value = Number(width) || 0.72;
    return 1 + (value - 0.72) * 0.35;
}

export function rainColumns(count = 36) {
    const columns = [];
    for (let index = 0; index < count; index += 1) {
        const n = (index * 37 + 11) % 97;
        columns.push({
            x: (index + 0.5) / count,
            speed: 0.00012 + (n % 7) * 0.00003,
            length: 0.08 + (n % 5) * 0.025,
            phase: (n % 17) / 17,
            bright: n % 4 === 0,
        });
    }
    return columns;
}

export function rainHead(column, elapsed, reduced) {
    if (reduced) return column.phase;
    const travel = (Number(elapsed) || 0) * column.speed;
    return (column.phase + travel) % 1;
}
