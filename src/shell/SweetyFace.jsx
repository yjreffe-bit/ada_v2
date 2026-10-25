import { useEffect, useRef, useState } from 'react';
import { faceClock, mouthShape } from './sweetyMath';

const prefersReducedMotion = () => (
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
);

/**
 * Holographic portrait from ADA Mobile 1.7.0 section 18.
 * The proportions, timings, and mouth math match the spec.
 * Line quality is a little finer than the static mockups: round strokes,
 * a tilted almond, and a small catchlight. Still one original woman in
 * her twenties, head and collar only.
 */
export function drawSweetyFace(ctx, size, mood, playbackLevel, elapsed, reduced) {
    const unit = size;
    const rx = 0.28 * unit;
    const ry = 0.37 * unit;
    const accent = mood === 'error' ? '#FB7185' : '#22D3EE';
    const clock = faceClock(elapsed, reduced);
    const { breath, blink, flicker, shimmer, pulse, floatY } = clock;
    const glowMix = mood === 'idle' ? 0.45 + breath * 0.35 : 0.85;
    const strokeAlpha = Math.min(1, Math.max(0.35, glowMix * flicker));
    const eyeScale = mood === 'listening' ? 1.22 : 1;
    const eyeY = -ry * 0.08;
    const eyeX = rx * 0.38;
    const eyeRx = rx * 0.20;
    const eyeRy = Math.max(0.8, ry * 0.055 * blink * eyeScale);
    const speaking = mood === 'speaking';
    const mouth = mouthShape(speaking, playbackLevel);

    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.translate(size / 2, size / 2 + floatY);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = accent;
    ctx.fillStyle = accent;

    ctx.globalAlpha = 0.07 * flicker;
    ctx.beginPath();
    ctx.arc(0, 0, rx * 1.85, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 0.14 * flicker;
    ctx.beginPath();
    ctx.arc(0, 0, rx * 1.35, 0, Math.PI * 2);
    ctx.fill();

    if (mood === 'listening') {
        const pulseNow = reduced ? 0 : pulse;
        ctx.globalAlpha = (1 - pulseNow) * 0.45;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(0, 0, rx * (1.45 + pulseNow * 0.55), 0, Math.PI * 2);
        ctx.stroke();
    }

    ctx.globalAlpha = 1;
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    ctx.clip();
    const volume = ctx.createRadialGradient(-rx * 0.2, -ry * 0.25, rx * 0.1, 0, 0, rx * 1.2);
    volume.addColorStop(0, '#0c2c36');
    volume.addColorStop(1, '#041318');
    ctx.fillStyle = volume;
    ctx.fillRect(-rx, -ry, rx * 2, ry * 2);
    ctx.restore();
    ctx.strokeStyle = accent;
    ctx.globalAlpha = strokeAlpha;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();

    const drawEye = (x, tilt) => {
        ctx.save();
        ctx.translate(x, eyeY);
        ctx.rotate(tilt);
        ctx.beginPath();
        ctx.ellipse(0, 0, eyeRx, eyeRy, 0, 0, Math.PI * 2);
        ctx.lineWidth = 1.8;
        ctx.stroke();
        if (eyeRy > 2) {
            ctx.beginPath();
            ctx.arc(0, eyeRy * 0.05, eyeRx * 0.18, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = Math.min(1, strokeAlpha + 0.15);
            ctx.fillStyle = '#E6FBFF';
            ctx.beginPath();
            ctx.arc(-eyeRx * 0.06, -eyeRy * 0.2, Math.max(0.7, eyeRx * 0.045), 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = accent;
            ctx.globalAlpha = strokeAlpha;
        }
        ctx.lineWidth = 1.2;
        const lash = eyeRx * 0.22;
        ctx.beginPath();
        ctx.moveTo(eyeRx * 0.72, -eyeRy * 0.15);
        ctx.lineTo(eyeRx * 0.72 + lash, -eyeRy * 0.85);
        ctx.moveTo(eyeRx * 0.35, -eyeRy * 0.55);
        ctx.lineTo(eyeRx * 0.42, -eyeRy * 0.55 - lash);
        ctx.stroke();
        ctx.restore();
    };
    ctx.globalAlpha = strokeAlpha;
    drawEye(-eyeX, -0.22);
    drawEye(eyeX, 0.22);

    ctx.globalAlpha = strokeAlpha * 0.9;
    ctx.lineWidth = 1.7;
    ctx.beginPath();
    ctx.moveTo(-eyeX - eyeRx * 0.9, eyeY - ry * 0.075);
    ctx.quadraticCurveTo(-eyeX, eyeY - ry * 0.145, -eyeX + eyeRx * 0.85, eyeY - ry * 0.09);
    ctx.moveTo(eyeX - eyeRx * 0.85, eyeY - ry * 0.09);
    ctx.quadraticCurveTo(eyeX, eyeY - ry * 0.15, eyeX + eyeRx * 0.9, eyeY - ry * 0.07);
    ctx.stroke();

    ctx.globalAlpha = strokeAlpha * 0.85;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(rx * 0.02, ry * 0.02);
    ctx.lineTo(-rx * 0.045, ry * 0.14);
    ctx.moveTo(-rx * 0.07, ry * 0.145);
    ctx.quadraticCurveTo(rx * 0.01, ry * 0.175, rx * 0.08, ry * 0.125);
    ctx.stroke();

    const half = rx * 0.34 * (mouth.width / 0.72);
    const gap = ry * 0.10 * mouth.openness;
    const mouthY = ry * 0.30;
    const upperLift = ry * 0.03 + gap * 0.15;
    const lowerDrop = ry * 0.045 + gap;
    ctx.globalAlpha = strokeAlpha;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(-half, mouthY);
    ctx.quadraticCurveTo(0, mouthY - upperLift, half, mouthY);
    ctx.quadraticCurveTo(0, mouthY + lowerDrop, -half, mouthY);
    ctx.globalAlpha = strokeAlpha * 0.16;
    ctx.fill();
    ctx.globalAlpha = strokeAlpha;
    ctx.beginPath();
    ctx.moveTo(-half, mouthY);
    ctx.quadraticCurveTo(0, mouthY - upperLift, half, mouthY);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-half, mouthY);
    ctx.quadraticCurveTo(0, mouthY + lowerDrop, half, mouthY);
    ctx.stroke();

    ctx.lineWidth = 1.7;
    ctx.globalAlpha = strokeAlpha * 0.92;
    ctx.beginPath();
    ctx.moveTo(-rx * 0.62, -ry * 0.78);
    ctx.quadraticCurveTo(-rx * 0.05, -ry * 1.16, rx * 0.58, -ry * 0.7);
    ctx.moveTo(-rx * 0.86, -ry * 0.28);
    ctx.bezierCurveTo(-rx * 1.14, -ry * 0.02, -rx * 1.02, ry * 0.28, -rx * 0.58, ry * 0.62);
    ctx.stroke();

    ctx.globalAlpha = strokeAlpha;
    ctx.lineWidth = 1.8;
    const neckTop = ry * 0.78;
    const neckBottom = ry * 1.02;
    ctx.beginPath();
    ctx.moveTo(-rx * 0.18, neckTop);
    ctx.lineTo(-rx * 0.26, neckBottom);
    ctx.moveTo(rx * 0.18, neckTop);
    ctx.lineTo(rx * 0.26, neckBottom);
    ctx.moveTo(-rx * 0.34, neckBottom);
    ctx.lineTo(rx * 0.34, neckBottom);
    ctx.stroke();

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    ctx.clip();
    ctx.globalAlpha = 0.07;
    ctx.lineWidth = 1;
    for (let index = 0; index < 7; index += 1) {
        const y = -ry + ((index + 0.5) / 7) * ry * 2 + breath * 3;
        ctx.beginPath();
        ctx.moveTo(-rx, y);
        ctx.lineTo(rx, y);
        ctx.stroke();
    }
    ctx.restore();

    if (mood === 'thinking') {
        const y = -ry + (reduced ? 0 : shimmer) * ry * 2;
        ctx.save();
        ctx.beginPath();
        ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
        ctx.clip();
        ctx.globalAlpha = 0.28;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(-rx, y);
        ctx.lineTo(rx, y);
        ctx.stroke();
        ctx.restore();
    }

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

export default function SweetyFace({ mood = 'idle', playbackLevel = 0, size = 280 }) {
    const canvasRef = useRef(null);
    const moodRef = useRef(mood);
    const levelRef = useRef(playbackLevel);
    moodRef.current = mood;
    levelRef.current = playbackLevel;
    const [reduced, setReduced] = useState(prefersReducedMotion);

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
        drawSweetyFace(prepareCanvas(canvas, size), size, mood, playbackLevel, 0, true);
        return undefined;
    }, [size, reduced, mood, playbackLevel]);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || reduced) return undefined;
        const ctx = prepareCanvas(canvas, size);
        const started = performance.now();
        let frame = 0;
        const paint = (now) => {
            drawSweetyFace(ctx, size, moodRef.current, levelRef.current, now - started, false);
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
            aria-label="Sweety, holographic assistant"
        />
    );
}
