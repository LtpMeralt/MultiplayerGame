// The playable example map. Coordinates are in world pixels (1200 x 680).
export default {
  id: 'default',
  name: 'Test course',
  width: 1200,
  height: 680,
  background: '#101923',
  spawn: { x: 125, y: 540 },
  objects: [
    { type: 'ground', x: 0, y: 620, w: 1200, h: 60, color: '#687483' },
    { type: 'platform', x: 260, y: 510, w: 190, h: 18, color: '#8996a5' },
    { type: 'platform', x: 565, y: 425, w: 205, h: 18, color: '#8996a5' },
    { type: 'platform', x: 865, y: 510, w: 150, h: 18, color: '#8996a5' },
    { type: 'water', x: 455, y: 578, w: 210, h: 42, color: '#398fb8' },
    { type: 'jumpPad', x: 945, y: 575, w: 82, h: 45, color: '#f0b65e' },
    { type: 'wall', x: 1090, y: 405, w: 34, h: 215, color: '#8b97a6' }
  ]
};
