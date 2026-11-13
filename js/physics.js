import { getSolidObjects, isBodyInWater } from './objects.js';

export const SIMULATION_HZ = 60;
export const FIXED_DT = 1 / SIMULATION_HZ;
export const PHYSICS = Object.freeze({
  gravity: 1450,
  waterGravityScale: 0.24,
  airDrag: 0.10,
  waterDrag: 1.75,
  groundFriction: 5.5,
  wallRestitution: 0.48,
  bounceRestitution: 0.23,
  jumpPadVelocity: -1080,
  maxSpeed: 1850
});

export function createBody(x, y, radius = 18) {
  return { x, y, vx: 0, vy: 0, radius, onGround: false, inWater: false };
}

export function cloneBody(body) {
  return { ...body };
}

export function stepBody(body, map, dt = FIXED_DT) {
  const radius = body.radius;
  const solids = getSolidObjects(map);
  body.onGround = false;
  body.inWater = isBodyInWater(body, map);

  const gravityScale = body.inWater ? PHYSICS.waterGravityScale : 1;
  body.vy += PHYSICS.gravity * gravityScale * dt;
  const drag = body.inWater ? PHYSICS.waterDrag : PHYSICS.airDrag;
  const dragFactor = Math.exp(-drag * dt);
  body.vx *= dragFactor;
  body.vy *= body.inWater ? dragFactor : 1;

  body.vx = clamp(body.vx, -PHYSICS.maxSpeed, PHYSICS.maxSpeed);
  body.vy = clamp(body.vy, -PHYSICS.maxSpeed, PHYSICS.maxSpeed);

  // Horizontal movement and side collisions.
  const oldX = body.x;
  body.x += body.vx * dt;
  for (const object of solids) {
    if (!verticalOverlap(body.y, radius, object)) continue;
    const left = object.x;
    const right = object.x + object.w;
    if (body.vx > 0 && oldX + radius <= left + 1 && body.x + radius >= left) {
      body.x = left - radius;
      body.vx = -Math.abs(body.vx) * PHYSICS.wallRestitution;
    } else if (body.vx < 0 && oldX - radius >= right - 1 && body.x - radius <= right) {
      body.x = right + radius;
      body.vx = Math.abs(body.vx) * PHYSICS.wallRestitution;
    } else if (overlaps(body.x, body.y, radius, object)) {
      const pushLeft = body.x - (left - radius);
      const pushRight = (right + radius) - body.x;
      if (pushLeft < pushRight) body.x = left - radius;
      else body.x = right + radius;
      body.vx *= -PHYSICS.wallRestitution;
    }
  }

  // Vertical movement and top/bottom collisions. This is swept along Y so a fast
  // ball does not skip through the thin test platforms between fixed ticks.
  const oldY = body.y;
  body.y += body.vy * dt;
  for (const object of solids) {
    if (!horizontalOverlap(body.x, radius, object)) continue;
    const top = object.y;
    const bottom = object.y + object.h;

    if (body.vy >= 0 && oldY + radius <= top + 2 && body.y + radius >= top) {
      body.y = top - radius;
      if (object.type === 'jumpPad') {
        body.vy = PHYSICS.jumpPadVelocity;
        body.vx *= 1.08;
      } else if (Math.abs(body.vy) > 115) {
        body.vy = -Math.abs(body.vy) * PHYSICS.bounceRestitution;
        body.onGround = body.vy > -70;
      } else {
        body.vy = 0;
        body.onGround = true;
      }
    } else if (body.vy < 0 && oldY - radius >= bottom - 2 && body.y - radius <= bottom) {
      body.y = bottom + radius;
      body.vy = Math.abs(body.vy) * PHYSICS.bounceRestitution;
    } else if (overlaps(body.x, body.y, radius, object)) {
      if (body.vy >= 0) {
        body.y = top - radius;
        body.vy = 0;
        body.onGround = true;
      } else {
        body.y = bottom + radius;
        body.vy = 0;
      }
    }
  }

  if (body.onGround) body.vx *= Math.exp(-PHYSICS.groundFriction * dt);

  // Keep the ball inside the horizontal world bounds.
  if (body.x - radius < 0) {
    body.x = radius;
    body.vx = Math.abs(body.vx) * PHYSICS.wallRestitution;
  } else if (body.x + radius > map.width) {
    body.x = map.width - radius;
    body.vx = -Math.abs(body.vx) * PHYSICS.wallRestitution;
  }

  body.inWater = isBodyInWater(body, map);
  return body;
}

export function predictTrajectory(startBody, map, ticks = 150, sampleEvery = 3) {
  const predicted = cloneBody(startBody);
  const points = [{ x: predicted.x, y: predicted.y }];
  for (let tick = 1; tick <= ticks; tick += 1) {
    stepBody(predicted, map, FIXED_DT);
    if (tick % sampleEvery === 0) points.push({ x: predicted.x, y: predicted.y });
    if (predicted.y - predicted.radius > map.height + 120) break;
    if (predicted.onGround && Math.abs(predicted.vx) < 14 && tick > 18) break;
  }
  return points;
}

function verticalOverlap(centerY, radius, object) {
  return centerY + radius > object.y && centerY - radius < object.y + object.h;
}

function horizontalOverlap(centerX, radius, object) {
  return centerX + radius > object.x && centerX - radius < object.x + object.w;
}

function overlaps(x, y, radius, object) {
  return x + radius > object.x && x - radius < object.x + object.w &&
    y + radius > object.y && y - radius < object.y + object.h;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
