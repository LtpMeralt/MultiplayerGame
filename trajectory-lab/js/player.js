import { createBody } from './physics.js';

export class LocalPlayer {
  constructor(userId, profile, spawn) {
    this.userId = userId;
    this.name = profile.name;
    this.color = profile.color;
    this.body = createBody(spawn.x, spawn.y, 18);
    this.isLocal = true;
  }

  updateProfile(profile) {
    this.name = profile.name;
    this.color = profile.color;
  }

  launch(vx, vy) {
    this.body.vx = Math.max(-1850, Math.min(1850, vx));
    this.body.vy = Math.max(-1850, Math.min(1850, vy));
    this.body.onGround = false;
  }

  reset(spawn) {
    this.body = createBody(spawn.x, spawn.y, this.body.radius);
  }

  snapshot() {
    return {
      x: this.body.x,
      y: this.body.y,
      vx: this.body.vx,
      vy: this.body.vy,
      radius: this.body.radius,
      onGround: this.body.onGround
    };
  }
}

export class RemotePlayer {
  constructor(userId, profile = {}) {
    this.userId = userId;
    this.name = profile.name || 'Player';
    this.color = profile.color || '#91a0b2';
    this.snapshots = [];
    this.isLocal = false;
  }

  updateProfile(profile = {}) {
    if (typeof profile.name === 'string') this.name = profile.name;
    if (typeof profile.color === 'string') this.color = profile.color;
  }

  pushSnapshot(snapshot, receivedAt = performance.now()) {
    if (![snapshot.x, snapshot.y, snapshot.vx, snapshot.vy].every(Number.isFinite)) return;
    this.snapshots.push({
      x: snapshot.x,
      y: snapshot.y,
      vx: snapshot.vx,
      vy: snapshot.vy,
      receivedAt
    });
    if (this.snapshots.length > 3) this.snapshots.shift();
  }

  getVisualState(now = performance.now()) {
    if (this.snapshots.length === 0) return null;
    const bufferMs = 65;
    const renderTime = now - bufferMs;
    const first = this.snapshots[0];
    const last = this.snapshots[this.snapshots.length - 1];

    if (this.snapshots.length >= 2) {
      for (let i = 1; i < this.snapshots.length; i += 1) {
        const before = this.snapshots[i - 1];
        const after = this.snapshots[i];
        if (renderTime <= after.receivedAt) {
          const span = Math.max(1, after.receivedAt - before.receivedAt);
          const alpha = Math.max(0, Math.min(1, (renderTime - before.receivedAt) / span));
          return {
            x: lerp(before.x, after.x, alpha),
            y: lerp(before.y, after.y, alpha),
            radius: 18
          };
        }
      }
    }

    const ahead = Math.max(0, Math.min(0.12, (now - last.receivedAt) / 1000));
    return {
      x: last.x + last.vx * ahead,
      y: last.y + last.vy * ahead + 0.5 * 1450 * ahead * ahead,
      radius: 18
    };
  }
}

export function drawPlayer(ctx, player, position, { local = false, aiming = false } = {}) {
  if (!position) return;
  const radius = position.radius || 18;
  const color = player.color || '#91a0b2';

  ctx.save();
  // Soft contact shadow.
  ctx.globalAlpha = 0.24;
  ctx.fillStyle = '#000000';
  ctx.beginPath();
  ctx.ellipse(position.x + 3, position.y + radius + 8, radius * 1.05, 5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  const gradient = ctx.createRadialGradient(
    position.x - radius * 0.38, position.y - radius * 0.48, radius * 0.08,
    position.x, position.y, radius * 1.15
  );
  gradient.addColorStop(0, '#ffffff');
  gradient.addColorStop(0.15, color);
  gradient.addColorStop(1, shadeColor(color, -42));
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(position.x, position.y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = local ? 2.2 : 1.4;
  ctx.strokeStyle = local ? 'rgba(234,255,249,.9)' : 'rgba(232,240,248,.55)';
  ctx.stroke();

  ctx.globalAlpha = 0.25;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.ellipse(position.x - radius * 0.32, position.y - radius * 0.42, radius * 0.27, radius * 0.14, -0.65, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  if (aiming) {
    ctx.strokeStyle = 'rgba(236,255,250,.8)';
    ctx.lineWidth = 1.2;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.arc(position.x, position.y, radius + 6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  drawNameTag(ctx, player.name || 'Player', position.x, position.y - radius - 13, color, local);
  ctx.restore();
}

function drawNameTag(ctx, name, centerX, baselineY, color, local) {
  ctx.save();
  ctx.font = '600 13px Manrope, sans-serif';
  const textWidth = ctx.measureText(name).width;
  const width = Math.min(190, textWidth + 18);
  const height = 22;
  const x = centerX - width / 2;
  const y = baselineY - height + 2;
  ctx.fillStyle = 'rgba(7,11,17,.76)';
  roundedRect(ctx, x, y, width, height, 6);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x + 8, y + 11, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = local ? '#f2faf8' : '#dce5ee';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(name, centerX + 5, y + 11, width - 20);
  ctx.restore();
}

function shadeColor(hex, amount) {
  const clean = /^#[0-9a-f]{6}$/i.test(hex) ? hex.slice(1) : '72e4c5';
  const number = Number.parseInt(clean, 16);
  const r = Math.max(0, Math.min(255, (number >> 16) + amount));
  const g = Math.max(0, Math.min(255, ((number >> 8) & 255) + amount));
  const b = Math.max(0, Math.min(255, (number & 255) + amount));
  return `rgb(${r}, ${g}, ${b})`;
}

function roundedRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}
