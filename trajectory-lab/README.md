# Trajectory Lab

A browser-based 2D multiplayer physics test. It uses:

- **Trystero** for peer-to-peer rooms and player movement messages.
- **Firebase Authentication + Cloud Firestore** for saving a username and ball color.
- A fixed **60 Hz simulation step** and a render cap of 60 FPS.
- A shared trajectory predictor which uses the same collision/gravity function as the actual ball simulation.

## Run it

This is a static ES-module website. It must be served over `http://localhost` or HTTPS; opening `index.html` directly with `file://` will block module imports.

With Python installed, open a terminal in this folder and run:

```bash
python -m http.server 8000
```

Then open `http://localhost:8000`.

You can also use the VS Code Live Server extension.

## Firebase setup

The Firebase project configuration supplied for this prototype is already in `js/firebase.js`.

1. Open the Firebase console for project `multiplayergame-70906`.
2. Enable **Authentication → Sign-in method → Anonymous**.
3. Create a **Cloud Firestore** database.
4. Open Firestore **Rules** and publish the contents of `firestore.rules`.
5. Reload the site. The profile panel should say `Cloud profile connected` after authentication. If Firebase is unavailable, the game still works and the profile is saved in this browser's `localStorage`.

The Firebase web API key is a public client identifier, not a database password. Firestore Security Rules are what protect user profile documents. Do not put admin/service-account credentials in browser code.

## Multiplayer rooms

- Click **Create room** to generate a six-character room code. The creator is the host.
- Share the room code and the password with your friends. The password must match exactly.
- Friends use the **Join room** fields.
- The host can change the map and reset everyone's local ball.
- If the host leaves, the connected peers elect a replacement using a stable user-ID sort.

Trystero discovers peers through public signaling relays and then attempts direct WebRTC connections. Some restrictive networks may require a TURN relay, which this starter project does not configure. The room password is used by Trystero to encrypt its signaling exchange; it is not a server-side account or an anti-cheat system.

## Controls

- **Mouse / touch:** press your ball, drag backwards to aim, release to launch.
- **A / D** or **left / right:** nudge horizontally.
- **Space / up arrow:** jump.
- **R:** ask the host to reset the round (or reset locally in solo mode).

The trajectory preview is computed by `predictTrajectory()` in `js/physics.js`. It calls the same `stepBody()` function used by the real simulation, so gravity, water drag, platforms and jump pads are reflected in the preview.

## Files

```text
index.html
style.css
js/
  main.js       UI, canvas renderer, input, game loop and room callbacks
  firebase.js   Firebase anonymous auth and saved profile access
  network.js    Trystero peer-to-peer room, presence and messages
  physics.js    Fixed-step ball physics and trajectory prediction
  player.js     Local/remote player models and ball rendering
  objects.js    Object type catalogue, map validation and object drawing
  maps.js       Map registry
maps/
  README.md     Instructions for creating and registering maps
  default.js    Playable sample course
  template.js   One-gray-box custom map starter
firestore.rules
```

## Making a custom map

1. Open the `maps/` folder. Copy `maps/template.js` and rename the copy, for example `my-map.js`.
2. Give the map a unique `id` and a readable `name`. Keep the world size at `1200 x 680` for the current canvas layout.
3. Add or move objects in its `objects` array. Each object uses `{ type, x, y, w, h, color }`.
4. Supported object types are exported from `js/objects.js`: `ground`, `platform`, `wall`, `water`, `jumpPad`. `player` is reserved for the automatically-created player ball.
5. Open `js/maps.js`, import your map file, and add it to the `maps` registry.

The `maps/README.md` file contains a full map example and copy/paste registration snippet.

Example:

```js
import myMap from '../maps/my-map.js';
maps.set(myMap.id, myMap);
```

## Prototype limitations

This is a client-hosted prototype, not a competitive authoritative server. Every player simulates their own ball and sends 20 snapshots per second; other clients interpolate/extrapolate those snapshots. The local physics is fixed at 60 Hz, but actual screen presentation still depends on the browser and device. Names/colors are profile preferences, not verified identities, and a modified client can send false movement data. For a public competitive game, move authoritative physics and room permissions to a trusted backend.
