import { useEffect, useRef, useState } from 'react';
import { faceClock, mouthShape } from './sweetyMath';
import { lidOpacity, mouthLayers, mouthScaleX, rainColumns, rainHead } from './sweety/sweetyRig';
import layout from './sweety/layers.json';
import sheetUrl from './sweety/sweety-layers.png';

const RAIN = rainColumns();
const prefersReducedMotion = () => (
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
);

function demoSpeaking(elapsed) {
    if (!import.meta.env.DEV || typeof window === 'undefined') return null;
    if (new URLSearchParams(window.location.search).get('face') !== 'speaking') return null;
    const wave = 0.5 + 0.5 * Math.sin(elapsed / 180);
    return { mood: 'speaking', playbackLevel: 0.12 + wave * 0.88 };
}

function prepareCanvas(canvas, size) {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
}

let scratch = null;
function scratchContext(width, height) {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    if (!scratch) scratch = document.createElement('canvas');
    if (scratch.width !== w || scratch.height !== h) {
        scratch.width = w;
        scratch.height = h;
    }
    const ctx = scratch.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, w, h);
    return ctx;
}

function blitFeathered(ctx, image, sx, sy, sw, sh, dx, dy, dw, dh, alpha) {
    if (alpha <= 0.02 || dw < 1 || dh < 1) return;
    const local = scratchContext(dw, dh);
    local.drawImage(image, sx, sy, sw, sh, 0, 0, local.canvas.width, local.canvas.height);
    local.globalCompositeOperation = 'destination-in';
    const fade = 0.2;
    const across = local.createLinearGradient(0, 0, local.canvas.width, 0);
    across.addColorStop(0, 'rgba(0,0,0,0)');
    across.addColorStop(fade, 'rgba(0,0,0,1)');
    across.addColorStop(1 - fade, 'rgba(0,0,0,1)');
    across.addColorStop(1, 'rgba(0,0,0,0)');
    local.fillStyle = across;
    local.fillRect(0, 0, local.canvas.width, local.canvas.height);
    const down = local.createLinearGradient(0, 0, 0, local.canvas.height);
    down.addColorStop(0, 'rgba(0,0,0,0)');
    down.addColorStop(fade, 'rgba(0,0,0,1)');
    down.addColorStop(1 - fade, 'rgba(0,0,0,1)');
    down.addColorStop(1, 'rgba(0,0,0,0)');
    local.fillStyle = down;
    local.fillRect(0, 0, local.canvas.width, local.canvas.height);
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.drawImage(local.canvas, dx, dy);
    ctx.restore();
}

function makeGlow(image, color) {
    const { frameWidth: fw, frameHeight: fh } = layout;
    const pad = 56;
    const canvas = document.createElement('canvas');
    canvas.width = fw + pad * 2;
    canvas.height = fh + pad * 2;
    const ctx = canvas.getContext('2d');
    ctx.shadowColor = color;
    ctx.shadowBlur = 42;
    ctx.drawImage(image, 0, 0, fw, fh, pad, pad, fw, fh);
    ctx.shadowBlur = 16;
    ctx.drawImage(image, 0, 0, fw, fh, pad, pad, fw, fh);
    return canvas;
}

export function drawSweetyHologram(ctx, size, image, glows, mood, playbackLevel, elapsed, reduced) {
    const clock = faceClock(elapsed, reduced);
    const demo = demoSpeaking(reduced ? 0 : elapsed);
    const shownMood = demo ? demo.mood : mood;
    const level = demo ? demo.playbackLevel : playbackLevel;
    const accent = shownMood === 'error' ? layout.error : layout.accent;
    const { frameWidth: fw, frameHeight: fh, frames, eyes, mouth } = layout;
    const speaking = shownMood === 'speaking';
    const shape = mouthShape(speaking, level);
    const layers = mouthLayers(shape.openness);
    const pad = size * 0.03;
    const scale = Math.min((size - pad * 2) / fw, (size - pad * 2) / fh);
    const dw = fw * scale;
    const dh = fh * scale;
    const dx = (size - dw) / 2;
    const dy = (size - dh) / 2 + clock.floatY;
    const tilt = reduced ? 0 : (clock.breath - 0.5) * 0.05;
    const portraitAlpha = Math.min(1, Math.max(0.72, clock.flicker));

    ctx.clearRect(0, 0, size, size);
    ctx.save();
    for (const column of RAIN) {
        const head = rainHead(column, elapsed, reduced);
        const x = column.x * size;
        const y = head * (size + 40) - 20;
        ctx.globalAlpha = column.bright ? 0.42 : 0.16;
        ctx.strokeStyle = accent;
        ctx.lineWidth = column.bright ? 1.4 : 1;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x, y - column.length * size);
        ctx.stroke();
    }
    ctx.restore();

    if (!image) return;

    ctx.save();
    ctx.translate(dx + dw / 2, dy + dh / 2);
    ctx.rotate(tilt);
    ctx.translate(-(dx + dw / 2), -(dy + dh / 2));
    const glow = glows[shownMood === 'error' ? 'error' : 'idle'];
    if (glow) {
        ctx.globalAlpha = shownMood === 'idle' ? 0.55 + clock.breath * 0.35 : 0.9;
        const padPx = 56 * scale;
        ctx.drawImage(glow, dx - padPx, dy - padPx, dw + padPx * 2, dh + padPx * 2);
    }
    ctx.globalAlpha = portraitAlpha;
    ctx.drawImage(image, 0, 0, fw, fh, dx, dy, dw, dh);

    const scaleX = mouthScaleX(shape.width);
    const mouthW = mouth.w * dw * scaleX;
    const mouthH = mouth.h * dh;
    const mouthX = dx + (mouth.x + mouth.w / 2) * dw - mouthW / 2;
    const mouthY = dy + mouth.y * dh;
    const drawMouth = (name, alpha) => {
        const frame = frames[name] * fw;
        blitFeathered(
            ctx, image,
            frame + mouth.x * fw, mouth.y * fh, mouth.w * fw, mouth.h * fh,
            mouthX, mouthY, mouthW, mouthH,
            alpha * portraitAlpha,
        );
    };
    ctx.globalAlpha = 1;
    drawMouth('mid', layers.mid);
    drawMouth('open', layers.open);

    const lid = lidOpacity(clock.blink);
    if (lid > 0.02) {
        const frame = frames.closed * fw;
        blitFeathered(
            ctx, image,
            frame + eyes.x * fw, eyes.y * fh, eyes.w * fw, eyes.h * fh,
            dx + eyes.x * dw, dy + eyes.y * dh, eyes.w * dw, eyes.h * dh,
            lid * portraitAlpha,
        );
    }

    if (shownMood === 'listening') {
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.ellipse(dx + dw * 0.36, dy + dh * 0.30, dw * 0.07, dh * 0.035, 0, 0, Math.PI * 2);
        ctx.ellipse(dx + dw * 0.64, dy + dh * 0.30, dw * 0.07, dh * 0.035, 0, 0, Math.PI * 2);
        ctx.fill();
    }

    if (shownMood === 'error') {
        ctx.save();
        ctx.globalCompositeOperation = 'source-atop';
        ctx.globalAlpha = 0.42;
        ctx.fillStyle = layout.error;
        ctx.fillRect(dx, dy, dw, dh);
        ctx.restore();
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(dx, dy, dw, dh);
    ctx.clip();
    ctx.globalAlpha = 0.16;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1;
    const drift = clock.breath * 3;
    for (let y = dy + drift; y < dy + dh; y += 4) {
        ctx.beginPath();
        ctx.moveTo(dx, y);
        ctx.lineTo(dx + dw, y);
        ctx.stroke();
    }
    if (shownMood === 'thinking') {
        const band = dy + (reduced ? 0.2 : clock.shimmer) * dh;
        ctx.globalAlpha = 0.45;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(dx, band);
        ctx.lineTo(dx + dw, band);
        ctx.stroke();
    }
    ctx.restore();

    if (shownMood === 'listening') {
        const pulse = reduced ? 0 : clock.pulse;
        ctx.globalAlpha = (1 - pulse) * 0.4;
        ctx.strokeStyle = accent;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(dx + dw / 2, dy + dh / 2, dw * (0.48 + pulse * 0.04), dh * (0.5 + pulse * 0.03), 0, 0, Math.PI * 2);
        ctx.stroke();
    }
    ctx.restore();
}

export default function SweetyFace({ mood = 'idle', playbackLevel = 0, size = 280 }) {
    const canvasRef = useRef(null);
    const moodRef = useRef(mood);
    const levelRef = useRef(playbackLevel);
    const imageRef = useRef(null);
    const glowRef = useRef(null);
    moodRef.current = mood;
    levelRef.current = playbackLevel;
    const [reduced, setReduced] = useState(prefersReducedMotion);
    const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden);
    const [ready, setReady] = useState(false);

    useEffect(() => {
        const query = window.matchMedia('(prefers-reduced-motion: reduce)');
        const onMotion = () => setReduced(query.matches);
        const onHide = () => setHidden(document.hidden);
        onMotion();
        query.addEventListener('change', onMotion);
        document.addEventListener('visibilitychange', onHide);
        return () => {
            query.removeEventListener('change', onMotion);
            document.removeEventListener('visibilitychange', onHide);
        };
    }, []);

    useEffect(() => {
        const image = new Image();
        image.onload = () => {
            imageRef.current = image;
            glowRef.current = {
                idle: makeGlow(image, layout.accent),
                error: makeGlow(image, layout.error),
            };
            setReady(true);
        };
        image.src = sheetUrl;
    }, []);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !reduced || hidden) return undefined;
        drawSweetyHologram(
            prepareCanvas(canvas, size),
            size,
            imageRef.current,
            glowRef.current || {},
            mood,
            playbackLevel,
            0,
            true,
        );
        return undefined;
    }, [size, reduced, hidden, ready, mood, playbackLevel]);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || reduced || hidden) return undefined;
        const ctx = prepareCanvas(canvas, size);
        const started = performance.now();
        let frame = 0;
        const paint = (now) => {
            drawSweetyHologram(
                ctx,
                size,
                imageRef.current,
                glowRef.current || {},
                moodRef.current,
                levelRef.current,
                now - started,
                false,
            );
            frame = requestAnimationFrame(paint);
        };
        frame = requestAnimationFrame(paint);
        return () => cancelAnimationFrame(frame);
    }, [size, reduced, hidden, ready]);

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
