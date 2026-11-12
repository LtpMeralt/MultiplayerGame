import { joinRoom, selfId } from 'https://unpkg.com/trystero@0.19.0/firebase.mjs';
import { createDefaultMap } from './mapTemplate.js';
import { Player } from './player.js';

const firebaseConfig = {
  apiKey: "AIzaSyC2fDuaCFka3q-3MuGoMWCxQnwzXSiaUig",
  authDomain: "multiplayergame-70906.firebaseapp.com",
  projectId: "multiplayergame-70906",
  storageBucket: "multiplayergame-70906.firebasestorage.app",
  messagingSenderId: "449303847814",
  appId: "1:449303847814:web:a5e5915e47aad5e4110207",
  measurementId: "G-ET0ZR25PQE"
};

const colors = ['#ff4444', '#44ff44', '#4444ff', '#ffff44', '#ff44ff', '#44ffff'];
const randomColor = colors[Math.floor(Math.random() * colors.length)];

let room;
let players = {};
let localKeys = {};
let isHost = false;
let objects = createDefaultMap();

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

document.getElementById('createBtn').onclick = () => startSession(true);
document.getElementById('joinBtn').onclick = () => startSession(false);

function startSession(creating) {
    const username = document.getElementById('usernameInput').value || 'Guest';
    const roomCode = document.getElementById('roomInput').value || 'defaultRoom';
    const password = document.getElementById('passInput').value;

    isHost = creating;

    room = joinRoom(firebaseConfig, { appId: 'physics-game-v1', password: password }, roomCode);

    document.getElementById('menu').style.display = 'none';
    document.getElementById('game-container').style.display = 'block';
    document.getElementById('roomDisplay').innerText = roomCode;

    const [sendInput, getInputs] = room.makeAction('input');
    const [sendState, getState] = room.makeAction('state');

    players[selfId] = new Player(selfId, username, randomColor);

    room.onPeerJoin(peerId => {
        if (isHost) {
            sendState({ players: serializePlayers() }, peerId);
        }
    });

    room.onPeerLeave(peerId => {
        delete players[peerId];
    });

    if (isHost) {
        getInputs((data, peerId) => {
            if (players[peerId]) {
                players[peerId].keys = data;
            }
        });
    } else {
        getState(data => {
            deserializePlayers(data.players);
        });
    }

    // Input listeners
    window.addEventListener('keydown', e => localKeys[e.code] = true);
    window.addEventListener('keyup', e => localKeys[e.code] = false);

    // 60 FPS Fixed Game Loop
    const fps = 60;
    const interval = 1000 / fps;
    let lastTime = performance.now();

    function gameLoop(now) {
        requestAnimationFrame(gameLoop);
        let delta = now - lastTime;
        if (delta >= interval) {
            lastTime = now - (delta % interval);

            ctx.clearRect(0, 0, canvas.width, canvas.height);

            // Draw objects
            objects.forEach(obj => obj.draw(ctx));

            if (isHost) {
                // Host physics calculations
                if (players[selfId]) {
                    players[selfId].update(localKeys, objects);
                }
                for (let id in players) {
                    if (id !== selfId && players[id].keys) {
                        players[id].update(players[id].keys, objects);
                    }
                }
                sendState({ players: serializePlayers() });
            } else {
                // Client sends local keys to host
                sendInput(localKeys);
            }

            // Draw players
            for (let id in players) {
                players[id].draw(ctx);
            }
        }
    }

    requestAnimationFrame(gameLoop);
}

function serializePlayers() {
    let data = {};
    for (let id in players) {
        let p = players[id];
        data[id] = { x: p.x, y: p.y, vx: p.vx, vy: p.vy, username: p.username, color: p.color };
    }
    return data;
}

function deserializePlayers(data) {
    for (let id in data) {
        if (!players[id]) {
            players[id] = new Player(id, data[id].username, data[id].color);
        }
        players[id].x = data[id].x;
        players[id].y = data[id].y;
        players[id].vx = data[id].vx;
        players[id].vy = data[id].vy;
    }
}
