import defaultMap from '../maps/default.js';
import templateMap from '../maps/template.js';

const maps = new Map([
  ['default', defaultMap],
  ['template', templateMap]
]);

export function getMap(id = 'default') {
  return maps.get(id) || defaultMap;
}

export function getMapOptions() {
  return [...maps.values()].map(({ id, name }) => ({ id, name }));
}

// Register an additional imported map here:
// import myMap from '../maps/my-map.js';
// maps.set(myMap.id, myMap);
