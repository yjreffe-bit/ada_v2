/**
 * Dragon Ball Super – Stickman Animation Renderer
 * Consumes dbs_stickman_animation_template.json and renders to HTML5 Canvas.
 * Usage: Open dbs_player.html in a browser, or run via Node.js with canvas package.
 */

'use strict';

// ─── Utility helpers ────────────────────────────────────────────────────────

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const deg2rad = (d) => (d * Math.PI) / 180;
const easeInOut = (t) => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;

// ─── Stickman Renderer ──────────────────────────────────────────────────────

class StickmanRenderer {
  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} charDef  – character definition from JSON
   */
  constructor(ctx, charDef) {
    this.ctx = ctx;
    this.def = charDef;
    this.x = charDef.start_position.x;
    this.y = charDef.start_position.y;
    this.visible = false;
    this.currentPose = null;
    this.poseProgress = 0; // 0–1
    this.auraActive = false;
    this.auraPhase = 0;
  }

  /** Draw the stickman at (this.x, this.y) with the given joint angles */
  draw(angles = {}) {
    if (!this.visible) return;
    const { ctx, def } = this;
    const s = def.stickman;
    const scale = def.scale || 1;
    const color = def.color;
    const sw = (def.stroke_width || 3) * scale;

    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.scale(scale, scale);

    // Aura glow
    if (this.auraActive) {
      this._drawAura(s, def.aura_color);
    }

    ctx.strokeStyle = color;
    ctx.lineWidth = sw;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const lean = deg2rad(angles.body_lean || 0);
    const headY = -(s.body_length + s.head_radius);

    // Head
    ctx.beginPath();
    ctx.arc(0, headY + (angles.head_y_offset || 0), s.head_radius, 0, Math.PI * 2);
    ctx.stroke();

    // Eyes (small dots)
    ctx.fillStyle = def.eye_color || color;
    const eyeOffX = s.head_radius * 0.35;
    const eyeOffY = headY - s.head_radius * 0.1 + (angles.head_y_offset || 0);
    ctx.beginPath();
    ctx.arc(-eyeOffX, eyeOffY, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(eyeOffX, eyeOffY, 2.5, 0, Math.PI * 2);
    ctx.fill();

    // Body
    ctx.beginPath();
    ctx.moveTo(0, -s.body_length);
    ctx.lineTo(Math.sin(lean) * s.body_length * 0.3, 0);
    ctx.stroke();

    // Shoulder point
    const shoulderY = -s.body_length * 0.75;

    // Left arm
    const laAngle = deg2rad(angles.left_arm || -20);
    ctx.beginPath();
    ctx.moveTo(0, shoulderY);
    ctx.lineTo(
      Math.cos(laAngle) * s.arm_length,
      shoulderY + Math.sin(laAngle) * s.arm_length
    );
    ctx.stroke();

    // Right arm
    const raAngle = deg2rad(angles.right_arm || 20);
    ctx.beginPath();
    ctx.moveTo(0, shoulderY);
    ctx.lineTo(
      Math.cos(raAngle) * s.arm_length,
      shoulderY + Math.sin(raAngle) * s.arm_length
    );
    ctx.stroke();

    // Hip point
    const hipY = 0;

    // Left leg
    const llAngle = deg2rad(angles.left_leg || 15);
    ctx.beginPath();
    ctx.moveTo(0, hipY);
    ctx.lineTo(
      Math.cos(llAngle + Math.PI / 2) * s.leg_length,
      hipY + Math.sin(llAngle + Math.PI / 2) * s.leg_length
    );
    ctx.stroke();

    // Right leg
    const rlAngle = deg2rad(angles.right_leg || -15);
    ctx.beginPath();
    ctx.moveTo(0, hipY);
    ctx.lineTo(
      Math.cos(rlAngle + Math.PI / 2) * s.leg_length,
      hipY + Math.sin(rlAngle + Math.PI / 2) * s.leg_length
    );
    ctx.stroke();

    ctx.restore();
  }

  _drawAura(s, auraColor) {
    const { ctx } = this;
    this.auraPhase += 0.08;
    const flicker = 0.7 + 0.3 * Math.sin(this.auraPhase);
    const grad = ctx.createRadialGradient(0, -s.body_length / 2, 10, 0, -s.body_length / 2, 90 * flicker);
    grad.addColorStop(0, auraColor + 'CC');
    grad.addColorStop(0.5, auraColor + '66');
    grad.addColorStop(1, auraColor + '00');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.ellipse(0, -s.body_length / 2, 55 * flicker, 100 * flicker, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  /** Interpolate pose keyframes at a given progress (0–1) */
  getPoseAngles(poseId, progress, posesLib) {
    const pose = posesLib[poseId];
    if (!pose || !pose.keyframes.length) return {};
    const kfs = pose.keyframes;
    if (kfs.length === 1) return this._kfToAngles(kfs[0]);

    const totalFrames = kfs[kfs.length - 1].frame;
    const currentFrame = progress * totalFrames;

    let i = 0;
    while (i < kfs.length - 2 && kfs[i + 1].frame <= currentFrame) i++;
    const kfA = kfs[i];
    const kfB = kfs[i + 1];
    const t = (currentFrame - kfA.frame) / (kfB.frame - kfA.frame);
    const et = easeInOut(clamp(t, 0, 1));

    return {
      body_lean:    lerp(kfA.body?.lean || 0,              kfB.body?.lean || 0,              et),
      head_y_offset:lerp(kfA.head?.y_offset || 0,          kfB.head?.y_offset || 0,          et),
      left_arm:     lerp(kfA.arms?.left_angle || -20,      kfB.arms?.left_angle || -20,      et),
      right_arm:    lerp(kfA.arms?.right_angle || 20,      kfB.arms?.right_angle || 20,      et),
      left_leg:     lerp(kfA.legs?.left_angle || 15,       kfB.legs?.left_angle || 15,       et),
      right_leg:    lerp(kfA.legs?.right_angle || -15,     kfB.legs?.right_angle || -15,     et),
    };
  }

  _kfToAngles(kf) {
    return {
      body_lean:     kf.body?.lean || 0,
      head_y_offset: kf.head?.y_offset || 0,
      left_arm:      kf.arms?.left_angle || -20,
      right_arm:     kf.arms?.right_angle || 20,
      left_leg:      kf.legs?.left_angle || 15,
      right_leg:     kf.legs?.right_angle || -15,
    };
  }
}

// ─── Effect Renderer ────────────────────────────────────────────────────────

class EffectRenderer {
  constructor(ctx) {
    this.ctx = ctx;
    this.activeEffects = [];
  }

  spawn(effectDef, x, y, color = '#FFD700') {
    this.activeEffects.push({
      def: effectDef,
      x, y, color,
      startTime: performance.now(),
      duration: effectDef.duration_ms || 400,
    });
  }

  update() {
    const now = performance.now();
    this.activeEffects = this.activeEffects.filter(e => {
      const elapsed = now - e.startTime;
      const t = clamp(elapsed / e.duration, 0, 1);
      this._renderEffect(e, t);
      return t < 1;
    });
  }

  _renderEffect(e, t) {
    const { ctx } = this;
    const { def, x, y, color } = e;
    ctx.save();
    ctx.translate(x, y);

    for (const shape of (def.shapes || [])) {
      const alpha = shape.opacity * (1 - t);
      ctx.globalAlpha = clamp(alpha, 0, 1);
      const shapeColor = shape.color === 'character_aura_color' ? color : shape.color;

      switch (shape.type) {
        case 'starburst':
          this._drawStarburst(shape, t, shapeColor);
          break;
        case 'ring':
          this._drawRing(shape, t, shapeColor);
          break;
        case 'circle':
          this._drawCircle(shape, t, shapeColor);
          break;
        case 'lines':
        case 'arc_lines':
          this._drawLines(shape, t, shapeColor);
          break;
        case 'particle_burst':
          this._drawParticleBurst(shape, t, shapeColor, e.startTime);
          break;
        case 'spark_burst':
          this._drawSparkBurst(shape, t, shapeColor, e.startTime);
          break;
        case 'radial_lines':
          this._drawRadialLines(shape, t, shapeColor);
          break;
        case 'glow':
          this._drawGlow(shape, t, shapeColor);
          break;
        case 'flame_aura':
          this._drawFlameAura(shape, t, shapeColor, e.startTime);
          break;
        case 'afterimage':
          // handled by character renderer
          break;
        default:
          break;
      }
    }

    ctx.globalAlpha = 1;
    ctx.restore();
  }

  _drawStarburst(shape, t, color) {
    const { ctx } = this;
    const scale = t < 0.3 ? t / 0.3 : 1 - (t - 0.3) / 0.7;
    const r1 = shape.inner_radius * scale;
    const r2 = shape.outer_radius * scale;
    const spikes = shape.spikes || 8;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < spikes * 2; i++) {
      const angle = (i * Math.PI) / spikes;
      const r = i % 2 === 0 ? r2 : r1;
      if (i === 0) ctx.moveTo(Math.cos(angle) * r, Math.sin(angle) * r);
      else ctx.lineTo(Math.cos(angle) * r, Math.sin(angle) * r);
    }
    ctx.closePath();
    ctx.stroke();
  }

  _drawRing(shape, t, color) {
    const { ctx } = this;
    const r = shape.radius * (0.5 + t * 0.5);
    ctx.strokeStyle = color;
    ctx.lineWidth = shape.stroke_width || 2;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  _drawCircle(shape, t, color) {
    const { ctx } = this;
    const r = shape.radius * (t < 0.3 ? t / 0.3 : 1);
    if (shape.fill) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  _drawLines(shape, t, color) {
    const { ctx } = this;
    const count = shape.count || 6;
    const len = shape.length * (t < 0.3 ? t / 0.3 : 1 - (t - 0.3) / 0.7);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(angle) * len, Math.sin(angle) * len);
      ctx.stroke();
    }
  }

  _drawParticleBurst(shape, t, color, startTime) {
    const { ctx } = this;
    const count = shape.count || 20;
    const maxR = shape.max_radius || 100;
    ctx.fillStyle = color;
    for (let i = 0; i < count; i++) {
      const seed = (startTime + i * 137.5) % 1000;
      const angle = (seed / 1000) * Math.PI * 2;
      const speed = 0.5 + (seed % 100) / 100 * 0.5;
      const r = maxR * t * speed;
      const px = Math.cos(angle) * r;
      const py = Math.sin(angle) * r;
      const size = 3 * (1 - t);
      ctx.beginPath();
      ctx.arc(px, py, size, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  _drawSparkBurst(shape, t, color, startTime) {
    const { ctx } = this;
    const count = shape.count || 15;
    const maxR = shape.max_radius || 60;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    for (let i = 0; i < count; i++) {
      const seed = (startTime + i * 97.3) % 1000;
      const angle = (seed / 1000) * Math.PI * 2;
      const speed = 0.4 + (seed % 100) / 100 * 0.6;
      const r = maxR * t * speed;
      const px = Math.cos(angle) * r;
      const py = Math.sin(angle) * r;
      ctx.beginPath();
      ctx.moveTo(px * 0.5, py * 0.5);
      ctx.lineTo(px, py);
      ctx.stroke();
    }
  }

  _drawRadialLines(shape, t, color) {
    const { ctx } = this;
    const count = shape.count || 20;
    ctx.strokeStyle = color;
    ctx.lineWidth = shape.stroke_width || 1.5;
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      const len = lerp(shape.length_min || 60, shape.length_max || 200, (i % 3) / 2);
      ctx.beginPath();
      ctx.moveTo(Math.cos(angle) * 20, Math.sin(angle) * 20);
      ctx.lineTo(Math.cos(angle) * len, Math.sin(angle) * len);
      ctx.stroke();
    }
  }

  _drawGlow(shape, t, color) {
    const { ctx } = this;
    const r = shape.radius;
    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
    grad.addColorStop(0, color + 'AA');
    grad.addColorStop(1, color + '00');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
  }

  _drawFlameAura(shape, t, color, startTime) {
    const { ctx } = this;
    const phase = (performance.now() - startTime) / 200;
    const h = shape.height || 120;
    const w = shape.width || 60;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    for (let i = 0; i < 5; i++) {
      const offset = (i / 5) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      for (let y = 0; y <= h; y += 5) {
        const wave = Math.sin(phase + offset + y * 0.1) * (w / 2) * (1 - y / h);
        ctx.lineTo(wave, -y);
      }
      ctx.stroke();
    }
  }
}

// ─── Text Overlay Renderer ──────────────────────────────────────────────────

class TextOverlayRenderer {
  constructor(ctx) {
    this.ctx = ctx;
    this.activeOverlays = [];
  }

  show(overlayDef, data, duration = 2000) {
    this.activeOverlays.push({
      def: overlayDef,
      data,
      startTime: performance.now(),
      duration,
    });
  }

  update() {
    const now = performance.now();
    this.activeOverlays = this.activeOverlays.filter(o => {
      const elapsed = now - o.startTime;
      const t = clamp(elapsed / o.duration, 0, 1);
      this._renderOverlay(o, t);
      return t < 1;
    });
  }

  _renderOverlay(o, t) {
    const { ctx } = this;
    const { def, data } = o;
    const text = data.text || def.text || '';
    const subText = data.sub_text || def.sub_text || '';

    let alpha = 1;
    if (t < 0.1) alpha = t / 0.1;
    else if (t > 0.8) alpha = (1 - t) / 0.2;

    ctx.save();
    ctx.globalAlpha = alpha;

    const pos = def.position || { x: 960, y: 540 };
    ctx.textAlign = def.align || 'center';

    // Main text
    ctx.font = `bold ${def.font_size || 72}px ${def.font_family || 'Impact, sans-serif'}`;
    ctx.strokeStyle = def.stroke_color || '#000000';
    ctx.lineWidth = def.stroke_width || 4;
    ctx.strokeText(text, pos.x, pos.y);
    ctx.fillStyle = def.color || '#FFFFFF';
    ctx.fillText(text, pos.x, pos.y);

    // Sub text
    if (subText) {
      ctx.font = `bold ${def.sub_font_size || 36}px ${def.font_family || 'Impact, sans-serif'}`;
      ctx.strokeStyle = def.stroke_color || '#000000';
      ctx.lineWidth = (def.stroke_width || 4) * 0.7;
      ctx.strokeText(subText, pos.x, pos.y + (def.font_size || 72) * 0.8);
      ctx.fillStyle = def.sub_color || def.color || '#FFD700';
      ctx.fillText(subText, pos.x, pos.y + (def.font_size || 72) * 0.8);
    }

    ctx.restore();
  }
}

// ─── Screen Shake ───────────────────────────────────────────────────────────

class ScreenShake {
  constructor() {
    this.intensity = 0;
    this.decay = 0.85;
  }

  trigger(intensity) {
    this.intensity = Math.max(this.intensity, intensity);
  }

  getOffset() {
    if (this.intensity < 0.1) return { x: 0, y: 0 };
    const x = (Math.random() * 2 - 1) * this.intensity;
    const y = (Math.random() * 2 - 1) * this.intensity;
    this.intensity *= this.decay;
    return { x, y };
  }
}

// ─── Main Animation Engine ──────────────────────────────────────────────────

class DBSAnimationEngine {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} template  – parsed JSON template
   */
  constructor(canvas, template) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.template = template;
    this.currentTimeSec = 0;
    this.playing = false;
    this.lastTimestamp = null;
    this.fps = template.meta.fps || 60;

    canvas.width  = template.meta.resolution.width;
    canvas.height = template.meta.resolution.height;

    // Sub-systems
    this.effectRenderer  = new EffectRenderer(this.ctx);
    this.textRenderer    = new TextOverlayRenderer(this.ctx);
    this.screenShake     = new ScreenShake();

    // Build character map
    this.characters = {};
    for (const [id, def] of Object.entries(template.characters)) {
      this.characters[id] = new StickmanRenderer(this.ctx, def);
    }

    // Event queue – flatten all timeline events with absolute timestamps
    this.eventQueue = this._buildEventQueue();
    this.processedEvents = new Set();

    this._raf = null;
  }

  _buildEventQueue() {
    const queue = [];
    for (const seg of this.template.timeline.segments) {
      for (const ev of seg.events) {
        queue.push({ ...ev, abs_time_sec: ev.time_sec });
      }
    }
    return queue.sort((a, b) => a.abs_time_sec - b.abs_time_sec);
  }

  play() {
    this.playing = true;
    this.lastTimestamp = null;
    this._raf = requestAnimationFrame(this._loop.bind(this));
  }

  pause() {
    this.playing = false;
    if (this._raf) cancelAnimationFrame(this._raf);
  }

  seek(timeSec) {
    this.currentTimeSec = timeSec;
    this.processedEvents.clear();
    // Re-process all events up to this time
    for (const ev of this.eventQueue) {
      if (ev.abs_time_sec <= timeSec) {
        this._dispatchEvent(ev, true /* silent */);
      }
    }
  }

  _loop(timestamp) {
    if (!this.playing) return;
    if (this.lastTimestamp === null) this.lastTimestamp = timestamp;
    const delta = (timestamp - this.lastTimestamp) / 1000;
    this.lastTimestamp = timestamp;
    this.currentTimeSec += delta;

    if (this.currentTimeSec >= this.template.meta.duration_seconds) {
      this.currentTimeSec = 0;
      this.processedEvents.clear();
      for (const char of Object.values(this.characters)) {
        char.visible = false;
        char.auraActive = false;
      }
    }

    // Dispatch pending events
    for (const ev of this.eventQueue) {
      const key = `${ev.abs_time_sec}_${ev.type}_${ev.character || ''}_${ev.effect_id || ''}`;
      if (!this.processedEvents.has(key) && ev.abs_time_sec <= this.currentTimeSec) {
        this.processedEvents.add(key);
        this._dispatchEvent(ev, false);
      }
    }

    this._render();
    this._raf = requestAnimationFrame(this._loop.bind(this));
  }

  _dispatchEvent(ev, silent = false) {
    switch (ev.type) {
      case 'character_enter': {
        const char = this.characters[ev.character];
        if (char) {
          char.visible = true;
          if (ev.target_position) {
            char.x = ev.target_position.x;
            char.y = ev.target_position.y;
          }
        }
        break;
      }
      case 'pose': {
        const char = this.characters[ev.character];
        if (char) char.currentPose = ev.pose_id;
        break;
      }
      case 'effect': {
        if (!silent) {
          const effectDef = this.template.effects_library[ev.effect_id];
          if (effectDef) {
            let x = 960, y = 540;
            if (ev.position === 'on_character') {
              const char = this.characters[ev.character];
              if (char) { x = char.x; y = char.y - 60; }
            } else if (ev.position) {
              x = ev.position.x; y = ev.position.y;
            }
            const charColor = ev.character ? this.template.characters[ev.character]?.aura_color : '#FFD700';
            this.effectRenderer.spawn(effectDef, x, y, charColor);
            if (effectDef.screen_shake) {
              this.screenShake.trigger(effectDef.screen_shake.intensity);
            }
            if (ev.effect_id === 'aura_flare' && ev.character) {
              const char = this.characters[ev.character];
              if (char) char.auraActive = true;
            }
          }
        }
        break;
      }
      case 'text_overlay': {
        if (!silent) {
          const overlayDef = this.template.text_overlays[ev.overlay_id];
          if (overlayDef) {
            this.textRenderer.show(overlayDef, ev.data || {}, overlayDef.duration_ms || 2000);
          }
        }
        break;
      }
      case 'move': {
        const char = this.characters[ev.character];
        if (char && ev.target_position) {
          char.x = ev.target_position.x;
          char.y = ev.target_position.y;
        }
        break;
      }
      case 'camera_change': {
        // Camera handled in render
        this._currentCamera = ev.preset;
        break;
      }
      case 'combo_sequence': {
        if (!silent) {
          const attacker = this.characters[ev.attacker];
          const defender = this.characters[ev.defender];
          if (attacker && defender && ev.combo) {
            ev.combo.forEach((hit, i) => {
              setTimeout(() => {
                attacker.currentPose = hit.pose;
                const effectDef = this.template.effects_library[hit.effect];
                if (effectDef && hit.hit_position) {
                  this.effectRenderer.spawn(effectDef, hit.hit_position.x, hit.hit_position.y);
                  if (effectDef.screen_shake) {
                    this.screenShake.trigger(effectDef.screen_shake.intensity);
                  }
                }
              }, hit.delay_ms);
            });
          }
        }
        break;
      }
      case 'ki_blast_exchange': {
        if (!silent && ev.fighters && ev.fighters.length >= 2) {
          const blasts = ev.blasts_per_fighter || 3;
          const interval = ev.interval_ms || 400;
          const effectDef = this.template.effects_library[ev.blast_effect || 'ki_blast'];
          if (effectDef) {
            for (let i = 0; i < blasts * 2; i++) {
              setTimeout(() => {
                const fighterId = ev.fighters[i % 2];
                const char = this.characters[fighterId];
                if (char) {
                  const tx = i % 2 === 0 ? char.x + 200 : char.x - 200;
                  this.effectRenderer.spawn(effectDef, tx, char.y - 30);
                }
              }, i * interval);
            }
          }
        }
        break;
      }
      case 'beam_clash': {
        if (!silent) {
          const clashPos = ev.clash_position || { x: 960, y: 540 };
          const explosionDef = this.template.effects_library['explosion_large'];
          if (explosionDef) {
            this.effectRenderer.spawn(explosionDef, clashPos.x, clashPos.y);
            this.screenShake.trigger(15);
          }
        }
        break;
      }
      case 'all_characters_pose': {
        if (ev.characters) {
          ev.characters.forEach(id => {
            const char = this.characters[id];
            if (char) char.currentPose = ev.pose_id;
          });
        }
        break;
      }
      default:
        break;
    }
  }

  _render() {
    const { ctx, canvas, template } = this;
    const shake = this.screenShake.getOffset();

    ctx.save();
    ctx.translate(shake.x, shake.y);

    // Background
    ctx.fillStyle = template.meta.background_color || '#FFFFFF';
    ctx.fillRect(-shake.x, -shake.y, canvas.width + Math.abs(shake.x) * 2, canvas.height + Math.abs(shake.y) * 2);

    // Ground line
    ctx.strokeStyle = '#DDDDDD';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 620);
    ctx.lineTo(canvas.width, 620);
    ctx.stroke();

    // Draw characters
    for (const char of Object.values(this.characters)) {
      if (!char.visible) continue;
      const angles = char.currentPose
        ? char.getPoseAngles(char.currentPose, (this.currentTimeSec % 1), template.animation_poses)
        : {};
      char.draw(angles);
    }

    // Draw effects
    this.effectRenderer.update();

    // Draw text overlays
    this.textRenderer.update();

    // Color legend
    this._drawColorLegend();

    // Timeline progress bar
    this._drawProgressBar();

    ctx.restore();
  }

  _drawColorLegend() {
    const { ctx, template } = this;
    const legend = template.color_legend;
    if (!legend || !legend.display) return;

    const x = legend.position.x;
    let y = legend.position.y;
    const pad = legend.padding || 10;
    const lineH = 22;
    const boxW = 220;
    const boxH = pad * 2 + legend.entries.length * lineH;

    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.07)';
    ctx.beginPath();
    ctx.roundRect(x, y, boxW, boxH, legend.border_radius || 8);
    ctx.fill();

    y += pad;
    for (const entry of legend.entries) {
      // Color dot
      ctx.fillStyle = entry.color;
      ctx.beginPath();
      ctx.arc(x + pad + 6, y + 8, 6, 0, Math.PI * 2);
      ctx.fill();

      // Label
      ctx.fillStyle = '#333333';
      ctx.font = '11px Arial, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(entry.label, x + pad + 18, y + 13);
      y += lineH;
    }
    ctx.restore();
  }

  _drawProgressBar() {
    const { ctx, canvas, template } = this;
    const total = template.meta.duration_seconds;
    const progress = this.currentTimeSec / total;
    const barH = 4;
    const barY = canvas.height - barH;

    ctx.fillStyle = '#EEEEEE';
    ctx.fillRect(0, barY, canvas.width, barH);

    ctx.fillStyle = '#1E90FF';
    ctx.fillRect(0, barY, canvas.width * progress, barH);

    // Time label
    const mins = Math.floor(this.currentTimeSec / 60);
    const secs = Math.floor(this.currentTimeSec % 60).toString().padStart(2, '0');
    ctx.fillStyle = '#555555';
    ctx.font = '12px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`${mins}:${secs} / 4:00`, canvas.width - 10, canvas.height - 8);
  }
}

// ─── Export ─────────────────────────────────────────────────────────────────

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DBSAnimationEngine,
    StickmanRenderer,
    EffectRenderer,
    TextOverlayRenderer,
    ScreenShake,
  };
}

// Browser auto-init (when loaded via <script> tag alongside dbs_player.html)
if (typeof window !== 'undefined') {
  window.DBSAnimationEngine = DBSAnimationEngine;
}
