// CUSTOM MAP TEMPLATE
// Copy this file into a new file in this same maps/ folder, for example:
//   maps/my-map.js
// Then register it in js/maps.js (see maps/README.md).
// Coordinates are world pixels. The game world is 1200 x 680.
export default {
  id: 'template',
  name: 'Gray box template',
  width: 1200,
  height: 680,
  background: '#d7dadd',
  spawn: { x: 550, y: 390 },
  objects: [
    { type: 'ground', x: 500, y: 470, w: 200, h: 90, color: '#858b91' }
  ]
};
