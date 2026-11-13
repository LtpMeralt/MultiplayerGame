// Shared object catalogue for the map editor / custom map scripts.
// A map object is a plain object: { type, x, y, w, h, color, ... }.
export const OBJECT_TYPES = Object.freeze({
  ground:   { label: 'Ground',   solid: true,  defaultColor: '#687483', description: 'Solid floor or large block.' },
  platform: { label: 'Platform', solid: true,  defaultColor: '#8996a5', description: 'A platform the ball can land on.' },
  wall:     { label: 'Wall',     solid: true,  defaultColor: '#8b97a6', description: 'A solid wall or obstacle.' },
  water:    { label: 'Water',    solid: false, defaultColor: '#398fb8', description: 'A slow, low-gravity zone.' },
  jumpPad:  { label: 'Jump pad', solid: true,  defaultColor: '#f0b65e', description: 'Launches a ball upward on contact.' },
  player:   { label: 'Player',   solid: false, defaultColor: '#72e4c5', description: 'A player ball. Created automatically.' }
});

export function normalizeMap(map) {
  if (!map || !Array.isArray(map.objects)) throw new TypeError('A map needs an objects array.');
  const width = Number.isFinite(map.width) ? map.width : 1200;
  const height = Number.isFinite(map.height) ? map.height : 680;
  const objects = map.objects.map((object, index) => {
    if (!OBJECT_TYPES[object.type] || object.type === 'player') {
      throw new TypeError(`Unknown map object type at index ${index}: ${object.type}`);
    }
    const x = Number(object.x), y = Number(object.y), w = Number(object.w), h = Number(object.h);
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) {
      throw new TypeError(`Map object ${index} has invalid x/y/w/h values.`);
    }
    return { ...object, x, y, w, h, color: object.color || OBJECT_TYPES[object.type].defaultColor };
  });
  return { ...map, width, height, objects, spawn: map.spawn || { x: 125, y: height - 140 } };
}

export function getSolidObjects(map) {
  return map.objects.filter(object => OBJECT_TYPES[object.type]?.solid);
}

export function isPointInObject(x, y, object) {
  return x >= object.x && x <= object.x + object.w && y >= object.y && y <= object.y + object.h;
}

export function isBodyInWater(body, map) {
  return map.objects.some(object => object.type === 'water' && isPointInObject(body.x, body.y, object));
}

export function drawMap(ctx, map) {
  for (const object of map.objects) {
    const { x, y, w, h, type, color } = object;
    if (type === 'water') {
      ctx.save();
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.48;
      ctx.fillRect(x, y, w, h);
      ctx.globalAlpha = 0.75;
      ctx.strokeStyle = '#83d8f0';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let waveX = x + 8; waveX < x + w - 3; waveX += 22) {
        ctx.moveTo(waveX, y + 7);
        ctx.quadraticCurveTo(waveX + 6, y + 2, waveX + 12, y + 7);
        ctx.quadraticCurveTo(waveX + 17, y + 12, waveX + 22, y + 7);
      }
      ctx.stroke();
      ctx.restore();
      continue;
    }

    if (type === 'jumpPad') {
      ctx.save();
      ctx.fillStyle = '#573d2b';
      roundedRect(ctx, x, y + 5, w, h - 5, 7);
      ctx.fill();
      ctx.fillStyle = color;
      roundedRect(ctx, x + 3, y, w - 6, 13, 5);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.65)';
      ctx.fillRect(x + 12, y + 4, w - 24, 2);
      ctx.restore();
      continue;
    }

    ctx.save();
    ctx.fillStyle = color;
    roundedRect(ctx, x, y, w, h, type === 'ground' ? 3 : 5);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.12)';
    ctx.fillRect(x + 3, y + 2, Math.max(0, w - 6), Math.min(3, h - 2));
    ctx.fillStyle = 'rgba(0,0,0,.14)';
    ctx.fillRect(x + 2, y + h - 3, Math.max(0, w - 4), 2);
    ctx.restore();
  }
}

function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}
