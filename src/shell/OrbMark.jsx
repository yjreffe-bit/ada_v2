import { useEffect, useRef, useState } from 'react';

const reducedMotion = () => (
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
);

export function drawOrb(ctx, size, state, level, elapsed, reduced) {
    const accent = state === 'error' ? '#FB7185' : '#22D3EE';
    const breath = reduced ? 0 : (Math.sin((elapsed / 2200) * Math.PI * 2) + 1) / 2;
    const spin = reduced ? 0 : (elapsed / 14000) * Math.PI * 2;
    const clamped = Math.max(0, Math.min(1, level || 0));
    const base = size * 0.26;
    const radius = base + clamped * size * 0.08 + breath * 8;
    const idle = state === 'idle';
    const tickAlpha = state === 'listening' || state === 'speaking' ? 0.9 : state === 'connecting' ? 0.55 : 0.28;

    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.translate(size / 2, size / 2);

    ctx.globalAlpha = 0.08;
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(0, 0, radius * 1.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 0.16;
    ctx.beginPath();
    ctx.arc(0, 0, radius * 1.2, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalAlpha = 1;
    ctx.fillStyle = '#041318';
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = accent;
    ctx.globalAlpha = idle ? 0.55 : 0.95;
    ctx.lineWidth = 3 + clamped * 8;
    ctx.stroke();

    ctx.globalAlpha = tickAlpha;
    ctx.lineCap = 'round';
    for (let index = 0; index < 56; index += 1) {
        const angle = index * (Math.PI * 2 / 56) + spin;
        const inner = radius * 1.22;
        const outer = inner + (index % 4 === 0 ? 18 : 8);
        ctx.lineWidth = index % 4 === 0 ? 2.4 : 1.2;
        ctx.beginPath();
        ctx.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner);
        ctx.lineTo(Math.cos(angle) * outer, Math.sin(angle) * outer);
        ctx.stroke();
    }

    ctx.globalAlpha = 1;
    ctx.fillStyle = accent;
    ctx.font = '28px "Share Tech Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('A.D.A', 0, 0);
    ctx.restore();
}

function prepareCanvas(canvas, size) {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
}

export default function OrbMark({ state = 'idle', level = 0, size = 280 }) {
    const canvasRef = useRef(null);
    const levelRef = useRef(level);
    const stateRef = useRef(state);
    levelRef.current = level;
    stateRef.current = state;
    const [reduced, setReduced] = useState(reducedMotion);

    useEffect(() => {
        const query = window.matchMedia('(prefers-reduced-motion: reduce)');
        const apply = () => setReduced(query.matches);
        apply();
        query.addEventListener('change', apply);
        return () => query.removeEventListener('change', apply);
    }, []);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !reduced) return undefined;
        drawOrb(prepareCanvas(canvas, size), size, state, level, 0, true);
        return undefined;
    }, [size, reduced, state, level]);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || reduced) return undefined;
        const ctx = prepareCanvas(canvas, size);
        const started = performance.now();
        let frame = 0;
        const paint = (now) => {
            drawOrb(ctx, size, stateRef.current, levelRef.current, now - started, false);
            frame = requestAnimationFrame(paint);
        };
        frame = requestAnimationFrame(paint);
        return () => cancelAnimationFrame(frame);
    }, [size, reduced]);

    return (
        <canvas
            ref={canvasRef}
            width={size}
            height={size}
            className="mx-auto block"
            role="img"
            aria-label="A.D.A orb"
        />
    );
}
