
import { createBody, stepBody } from './physics.js';

const WALK_SPEED = 390;
const GROUND_ACCELERATION = 2200;
const AIR_ACCELERATION = 900;
const MAX_LAUNCH_SPEED = 1850;
const MAX_REMOTE_CORRECTION = 220;

export class LocalPlayer {
    constructor(userId, profile, spawn) {
        this.userId = userId;
        this.name = profile?.name || 'Player';
        this.color = profile?.color || '#72e4c5';

        this.body = createBody(spawn.x, spawn.y, 18);

        this.isLocal = true;
        this.sequence = 0;
    }

    updateProfile(profile) {
        this.name = profile?.name || this.name;
        this.color = profile?.color || this.color;
    }

    move(direction, dt) {
        if (!direction) return;

        const acceleration = this.body.onGround
            ? GROUND_ACCELERATION
            : AIR_ACCELERATION;

        const speed = this.body.vx * direction;

        if (speed < WALK_SPEED) {
            this.body.vx += direction * acceleration * dt;

            this.body.vx = Math.max(
                -MAX_LAUNCH_SPEED,
                Math.min(MAX_LAUNCH_SPEED, this.body.vx)
            );
        }
    }

    jump() {
        if (!this.body.onGround) return false;

        this.body.vy = -760;
        this.body.onGround = false;

        return true;
    }

    launch(vx, vy) {
        this.body.vx = Math.max(
            -MAX_LAUNCH_SPEED,
            Math.min(MAX_LAUNCH_SPEED, vx)
        );

        this.body.vy = Math.max(
            -MAX_LAUNCH_SPEED,
            Math.min(MAX_LAUNCH_SPEED, vy)
        );

        this.body.onGround = false;
    }

    reset(spawn) {
        this.body = createBody(
            spawn.x,
            spawn.y,
            this.body.radius
        );
    }

    snapshot() {
        this.sequence += 1;

        return {
            sequence: this.sequence,

            x: this.body.x,
            y: this.body.y,

            vx: this.body.vx,
            vy: this.body.vy,

            radius: this.body.radius,

            onGround: this.body.onGround,
            inWater: this.body.inWater
        };
    }
}

// ============================================================
// REMOTE PLAYER
// ============================================================

export class RemotePlayer {
    constructor(userId, profile = {}) {
        this.userId = userId;

        this.name = profile.name || 'Player';
        this.color = profile.color || '#91a0b2';

        this.body = null;

        this.correctionX = 0;
        this.correctionY = 0;

        this.correctionVX = 0;
        this.correctionVY = 0;

        this.lastSequence = -1;
        this.lastSnapshotAt = 0;

        this.isLocal = false;
    }

    updateProfile(profile = {}) {
        if (typeof profile.name === 'string') {
            this.name = profile.name;
        }

        if (
            typeof profile.color === 'string' &&
            /^#[0-9a-f]{6}$/i.test(profile.color)
        ) {
            this.color = profile.color;
        }
    }

    pushSnapshot(snapshot, receivedAt = performance.now()) {
        if (
            !snapshot ||
            ![
                snapshot.x,
                snapshot.y,
                snapshot.vx,
                snapshot.vy
            ].every(Number.isFinite)
        ) {
            return;
        }

        if (Number.isFinite(snapshot.sequence)) {
            if (snapshot.sequence <= this.lastSequence) {
                return;
            }

            this.lastSequence = snapshot.sequence;
        }

        // First snapshot initializes the predicted body.
        if (!this.body) {
            this.body = createBody(
                snapshot.x,
                snapshot.y,
                Number.isFinite(snapshot.radius)
                    ? snapshot.radius
                    : 18
            );

            this.body.vx = snapshot.vx;
            this.body.vy = snapshot.vy;

            this.body.onGround = Boolean(snapshot.onGround);
            this.body.inWater = Boolean(snapshot.inWater);

            this.lastSnapshotAt = receivedAt;

            return;
        }

        const dx = snapshot.x - this.body.x;
        const dy = snapshot.y - this.body.y;

        const error = Math.hypot(dx, dy);

        // Large corrections happen after resets or major divergence.
        if (error > MAX_REMOTE_CORRECTION) {
            this.body.x = snapshot.x;
            this.body.y = snapshot.y;

            this.correctionX = 0;
            this.correctionY = 0;
        } else {
            // Gradual positional reconciliation.
            this.correctionX += dx * 0.58;
            this.correctionY += dy * 0.58;
        }

        // Correct velocity gradually as well.
        this.correctionVX +=
            (snapshot.vx - this.body.vx) * 0.32;

        this.correctionVY +=
            (snapshot.vy - this.body.vy) * 0.32;

        this.body.radius = Number.isFinite(snapshot.radius)
            ? snapshot.radius
            : 18;

        this.lastSnapshotAt = receivedAt;
    }

    simulate(dt, map) {
        if (!this.body) return;

        // This client runs the remote player's physics locally.
        stepBody(this.body, map, dt);

        // Reconcile prediction errors without snapping every update.
        const blend = 1 - Math.exp(-15 * dt);

        const dx = this.correctionX * blend;
        const dy = this.correctionY * blend;

        const dvx = this.correctionVX * blend;
        const dvy = this.correctionVY * blend;

        this.body.x += dx;
        this.body.y += dy;

        this.body.vx += dvx;
        this.body.vy += dvy;

        this.correctionX -= dx;
        this.correctionY -= dy;

        this.correctionVX -= dvx;
        this.correctionVY -= dvy;
    }

    getVisualState() {
        return this.body;
    }
}

// ============================================================
// PLAYER RENDERING
// ============================================================

export function drawPlayer(
    ctx,
    player,
    position,
    { local = false, aiming = false } = {}
) {
    if (!position) return;

    const radius = position.radius || 18;
    const color = player.color || '#91a0b2';

    ctx.save();

    // Ground shadow.
    ctx.globalAlpha = 0.24;
    ctx.fillStyle = '#000000';

    ctx.beginPath();

    ctx.ellipse(
        position.x + 3,
        position.y + radius + 8,
        radius * 1.05,
        5,
        0,
        0,
        Math.PI * 2
    );

    ctx.fill();

    ctx.globalAlpha = 1;

    // Ball gradient.
    const gradient = ctx.createRadialGradient(
        position.x - radius * 0.38,
        position.y - radius * 0.48,
        radius * 0.08,
        position.x,
        position.y,
        radius * 1.15
    );

    gradient.addColorStop(0, '#ffffff');
    gradient.addColorStop(0.15, color);
    gradient.addColorStop(1, shadeColor(color, -42));

    ctx.fillStyle = gradient;

    ctx.beginPath();

    ctx.arc(
        position.x,
        position.y,
        radius,
        0,
        Math.PI * 2
    );

    ctx.fill();

    ctx.lineWidth = local ? 2.2 : 1.4;

    ctx.strokeStyle = local
        ? 'rgba(234,255,249,.9)'
        : 'rgba(232,240,248,.55)';

    ctx.stroke();

    // Highlight.
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = '#ffffff';

    ctx.beginPath();

    ctx.ellipse(
        position.x - radius * 0.32,
        position.y - radius * 0.42,
        radius * 0.27,
        radius * 0.14,
        -0.65,
        0,
        Math.PI * 2
    );

    ctx.fill();

    ctx.globalAlpha = 1;

    if (aiming) {
        ctx.strokeStyle = 'rgba(236,255,250,.8)';
        ctx.lineWidth = 1.2;

        ctx.setLineDash([3, 4]);

        ctx.beginPath();

        ctx.arc(
            position.x,
            position.y,
            radius + 6,
            0,
            Math.PI * 2
        );

        ctx.stroke();

        ctx.setLineDash([]);
    }

    drawNameTag(
        ctx,
        player.name || 'Player',
        position.x,
        position.y - radius - 13,
        color,
        local
    );

    ctx.restore();
}

function drawNameTag(
    ctx,
    name,
    centerX,
    baselineY,
    color,
    local
) {
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

    ctx.fillText(
        name,
        centerX + 5,
        y + 11,
        width - 20
    );

    ctx.restore();
}

function shadeColor(hex, amount) {
    const clean = /^#[0-9a-f]{6}$/i.test(hex)
        ? hex.slice(1)
        : '72e4c5';

    const number = Number.parseInt(clean, 16);

    const r = Math.max(
        0,
        Math.min(255, (number >> 16) + amount)
    );

    const g = Math.max(
        0,
        Math.min(255, ((number >> 8) & 255) + amount)
    );

    const b = Math.max(
        0,
        Math.min(255, (number & 255) + amount)
    );

    return `rgb(${r}, ${g}, ${b})`;
}

function roundedRect(ctx, x, y, width, height, radius) {
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, radius);
}
