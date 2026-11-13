# Maps folder

Put every custom map JavaScript file in this folder. The game loads maps through the registry at `../js/maps.js`.

## Make a new map

1. Copy `template.js` in this folder.
2. Rename the copy, for example `my-map.js`.
3. Change its `id` to a unique lowercase id and change its `name`.
4. Add, remove, or move entries in the `objects` array.
5. Open `../js/maps.js` and add an import and a registry entry.
6. Refresh the game. The map will appear in the host map selector.

Example registration in `js/maps.js`:

```js
import myMap from '../maps/my-map.js';

const maps = new Map([
  ['default', defaultMap],
  ['template', templateMap],
  [myMap.id, myMap]
]);
```

## Map format

```js
export default {
  id: 'my-map',
  name: 'My Map',
  width: 1200,
  height: 680,
  background: '#101923',
  spawn: { x: 125, y: 540 },
  objects: [
    { type: 'ground', x: 0, y: 620, w: 1200, h: 60, color: '#687483' },
    { type: 'platform', x: 260, y: 510, w: 190, h: 18 },
    { type: 'wall', x: 900, y: 350, w: 30, h: 270 },
    { type: 'water', x: 455, y: 578, w: 210, h: 42 },
    { type: 'jumpPad', x: 945, y: 575, w: 82, h: 45 }
  ]
};
```

## Supported object types

- `ground` — solid block or floor.
- `platform` — solid platform.
- `wall` — solid obstacle.
- `water` — low-gravity / drag zone.
- `jumpPad` — launches a ball upward when it touches the pad.
- `player` — reserved for the game; do not put it in a map's `objects` array.

Object coordinates are measured from the top-left corner. Each object needs positive `w` and `h`. Colors are optional; defaults are in `../js/objects.js`.

The included `default.js` is the playable sample course. `template.js` is intentionally just one gray box, ready to duplicate.
