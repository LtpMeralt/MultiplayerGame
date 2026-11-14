
import { initProfileStore } from './firebase.js';
import { connectRoom } from './network.js';
import {
    FIXED_DT,
    SIMULATION_HZ,
    predictTrajectory,
    stepBody
} from './physics.js';
import { normalizeMap, drawMap } from './objects.js';
import {
    LocalPlayer,
    RemotePlayer,
    drawPlayer
} from './player.js';
import { getMap } from './maps.js';

// ============================================================
// ELEMENTS
// ============================================================

const $ = id => document.getElementById(id);

const ui = {
    lobby: $('lobbyScreen'),
    game: $('gameScreen'),

    username: $('usernameInput'),
    color: $('colorInput'),
    avatar: $('avatarPreview'),

    saveProfile: $('saveProfileButton'),
    saveStatus: $('saveStatus'),

    createPassword: $('createPasswordInput'),
    publicRoom: $('publicRoomInput'),
    roomCode: $('roomCodeInput'),
    joinPassword: $('joinPasswordInput'),

    publicRoomList: $('publicRoomList'),
    refreshRooms: $('refreshRoomsButton'),

    createRoom: $('createRoomButton'),
    joinRoom: $('joinRoomButton'),
    solo: $('soloButton'),

    lobbyMessage: $('lobbyMessage'),

    connectionDot: $('connectionDot'),
    connectionText: $('connectionText'),

    leave: $('leaveRoomButton'),
    activeCode: $('activeRoomCode'),
    copyInvite: $('copyInviteButton'),
    hostBadge: $('hostBadge'),

    mapName: $('mapName'),
    playerCount: $('playerCount'),
    rosterCount: $('rosterCount'),
    roster: $('playerRoster'),

    hostPanel: $('hostPanel'),
    mapSelect: $('mapSelect'),
    resetRound: $('resetRoundButton'),

    networkStatus: $('networkStatus'),
    ping: $('pingLabel'),
    physics: $('physicsLabel'),

    canvas: $('gameCanvas'),
    canvasWrap: $('canvasWrap'),
    canvasHint: $('canvasHint'),

    toast: $('toast')
};

// ============================================================
// CONFIGURATION
// ============================================================

const DEFAULT_PROFILE = {
    name: 'Player',
    color: '#72e4c5'
};

const STATE_SEND_RATE = 20;

const MAX_FRAME_TIME = 0.1;
const MAX_SIMULATION_STEPS = 8;

// Player collision settings.
const PLAYER_RESTITUTION = 0.62;
const PLAYER_COLLISION_PASSES = 3;
const PLAYER_SEPARATION = 0.5;

// ============================================================
// STATE
// ============================================================

let profile = readLocalProfile();

let profileStore = null;

let publicRoomsUnsubscribe = null;
let publicRoomHeartbeat = null;

let activeRoomIsPublic = false;

let network = null;
let pendingRoster = null;

let roomCode = 'LOCAL';
let roomPassword = '';

let roomIsHost = true;
let roomMode = 'local';

let currentMap = normalizeMap(getMap('default'));

let localPlayer = null;

let remotePlayers = new Map();
let profiles = {};

let lastHostId = null;

let isAiming = false;

let aimPointer = {
    x: 0,
    y: 0
};

let movementKeys = new Set();

let stateSendAccumulator = 0;
let simulationAccumulator = 0;

let lastFrameTime = 0;
let lastRenderTime = 0;

let animationStarted = false;

let toastTimeout = null;

let dpr = 1;

// ============================================================
// INITIALIZATION
// ============================================================

syncProfileFields();

bootProfileStore();

ui.username.addEventListener(
    'input',
    updateAvatarPreview
);

ui.color.addEventListener(
    'input',
    updateAvatarPreview
);

ui.saveProfile.addEventListener(
    'click',
    saveProfile
);

ui.createRoom.addEventListener(
    'click',
    () => handleRoomEntry(true)
);

ui.joinRoom.addEventListener(
    'click',
    () => handleRoomEntry(false)
);

ui.solo.addEventListener(
    'click',
    () => startLocalGame().catch(console.error)
);

ui.leave.addEventListener(
    'click',
    leaveRoom
);

ui.copyInvite.addEventListener(
    'click',
    copyInvite
);

ui.resetRound.addEventListener(
    'click',
    hostResetRound
);

ui.mapSelect.addEventListener(
    'change',
    () => hostChangeMap(ui.mapSelect.value)
);

ui.roomCode.addEventListener('input', () => {
    ui.roomCode.value = ui.roomCode.value
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .slice(0, 12);
});

ui.refreshRooms?.addEventListener(
    'click',
    refreshPublicRooms
);

// Canvas input.

ui.canvas.addEventListener(
    'pointerdown',
    onPointerDown
);

ui.canvas.addEventListener(
    'pointermove',
    onPointerMove
);

ui.canvas.addEventListener(
    'pointerup',
    onPointerUp
);

ui.canvas.addEventListener(
    'pointercancel',
    onPointerCancel
);

ui.canvas.addEventListener(
    'contextmenu',
    event => event.preventDefault()
);

// Keyboard input.

window.addEventListener(
    'keydown',
    onKeyDown
);

window.addEventListener(
    'keyup',
    onKeyUp
);

window.addEventListener('blur', () => {
    movementKeys.clear();
    isAiming = false;
});

document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        movementKeys.clear();
        isAiming = false;
    }
});

window.addEventListener(
    'resize',
    resizeCanvas
);

window.addEventListener('pagehide', () => {
    stopPublicRoomHeartbeat(true);
    network?.leave?.();
});

// ============================================================
// FIREBASE PROFILE STORE
// ============================================================

async function bootProfileStore() {
    try {
        profileStore = await initProfileStore();

        if (profileStore.ready) {
            startPublicRoomBrowser();

            const cloudProfile =
                await profileStore.loadProfile();

            if (
                cloudProfile &&
                !localStorage.getItem('trajectoryLabProfile')
            ) {
                profile = sanitizeProfile(cloudProfile);

                writeLocalProfile(profile);
                syncProfileFields();
            }

            ui.saveStatus.textContent =
                'Cloud profile connected';

        } else {
            ui.saveStatus.textContent =
                'Saved on this device';
        }

    } catch (error) {
        console.warn(
            'Profile initialization failed:',
            error
        );

        ui.saveStatus.textContent =
            'Saved on this device';
    }
}

// ============================================================
// SAVE PROFILE
// ============================================================

async function saveProfile() {
    profile = sanitizeProfile({
        name: ui.username.value,
        color: ui.color.value
    });

    syncProfileFields();
    writeLocalProfile(profile);

    localPlayer?.updateProfile(profile);
    network?.updateProfile(profile);

    ui.saveStatus.textContent = 'Saving…';

    if (profileStore?.ready) {
        try {
            await profileStore.saveProfile(profile);

            ui.saveStatus.textContent =
                'Saved to Firebase';

        } catch (error) {
            console.warn(
                'Firebase profile save failed:',
                error
            );

            ui.saveStatus.textContent =
                'Saved locally · cloud unavailable';
        }

    } else {
        ui.saveStatus.textContent =
            'Saved on this device';
    }

    showToast('Profile saved');
    renderRoster();
}

// ============================================================
// ROOM CREATION AND JOINING
// ============================================================

async function handleRoomEntry(
    create,
    requestedCode = null,
    requestedPassword = null
) {
    profile = sanitizeProfile({
        name: ui.username.value,
        color: ui.color.value
    });

    writeLocalProfile(profile);

    // Clean up any previous room.

    stopPublicRoomHeartbeat(true);

    if (network) {
        try {
            await network.leave();
        } catch (error) {
            console.warn(
                'Could not leave previous room:',
                error
            );
        }
    }

    network = null;

    remotePlayers.clear();
    profiles = {};

    pendingRoster = null;

    movementKeys.clear();
    isAiming = false;

    const code = create
        ? makeRoomCode()
        : String(
            requestedCode || ui.roomCode.value
        ).trim().toUpperCase();

    const password = create
        ? ui.createPassword.value
        : (requestedPassword ?? ui.joinPassword.value);

    activeRoomIsPublic =
        create && Boolean(ui.publicRoom?.checked);

    if (!create && code.length < 4) {
        setLobbyMessage(
            'Enter a room code with at least 4 characters.',
            true
        );

        return;
    }

    ui.createRoom.disabled = true;
    ui.joinRoom.disabled = true;

    setLobbyMessage(
        create
            ? 'Creating your room…'
            : 'Joining room…'
    );

    ui.networkStatus.textContent = 'Connecting…';

    if (ui.ping) {
        ui.ping.textContent = 'PING -- MS';
    }

    if (ui.physics) {
        ui.physics.textContent = 'CONNECTING';
    }

    try {
        const joinedNetwork = await connectRoom({
            code,
            password,
            profile,
            create,

            callbacks: {
                // Buffer early callbacks until network is assigned.
                onRoster: roster => {
                    pendingRoster = roster;

                    if (network) {
                        handleRoster(roster);
                        pendingRoster = null;
                    }
                },

                onPlayerState: handlePlayerState,

                onUserJoin: userId => {
                    const name =
                        profiles[userId]?.name || 'Player';

                    ui.networkStatus.textContent =
                        `${name} discovered`;
                },

                onUserLeave: userId => {
                    remotePlayers.delete(userId);
                    peerPingsChanged();

                    renderRoster();
                },

                onPeerConnection: ({
                    userId,
                    connected
                }) => {
                    const name =
                        profiles[userId]?.name || 'Player';

                    if (connected) {
                        ui.networkStatus.textContent =
                            `${name} connected`;

                        showToast(`${name} connected`);

                    } else {
                        ui.networkStatus.textContent =
                            `${name} disconnected`;

                        showToast(`${name} disconnected`);
                    }

                    updateOnlineStatus();
                },

                onEvent: handleRoomEvent,

                onMeta: handleRoomMeta,

                onStatus: message => {
                    ui.networkStatus.textContent = message;
                    showToast(message);
                },

                onPing: ({
                    average,
                    min,
                    max,
                    peers
                }) => {
                    if (!ui.ping) return;

                    if (
                        peers > 0 &&
                        Number.isFinite(average)
                    ) {
                        ui.ping.textContent =
                            `PING ${Math.round(average)} MS`;

                        ui.ping.title =
                            `Average ${Math.round(average)} ms · Minimum ${Math.round(min)} ms · Maximum ${Math.round(max)} ms · ${peers} peer(s)`;

                    } else {
                        ui.ping.textContent = 'PING -- MS';
                        ui.ping.title = 'Waiting for peer connection';
                    }
                },

                onError: error => {
                    console.error(
                        'Room network error:',
                        error
                    );
                }
            }
        });

        network = joinedNetwork;

        roomCode = code;
        roomPassword = password;

        roomMode = 'online';

        roomIsHost = network.isHost;
        lastHostId = network.hostId;

        if (pendingRoster) {
            handleRoster(pendingRoster);
            pendingRoster = null;
        }

        startGameScreen();

        setConnectionState(
            'WAITING FOR PEERS',
            false
        );

        ui.networkStatus.textContent =
            'Waiting for players…';

        if (ui.physics) {
            ui.physics.textContent = 'LOCAL PREDICTION';
        }

        setLobbyMessage(
            'Connected to the room.',
            false,
            true
        );

        showToast(
            create
                ? `Room ${code} created`
                : `Joined room ${code}`
        );

        if (create) {
            network.setMap('default');

            if (activeRoomIsPublic) {
                startPublicRoomHeartbeat();
            }
        }

    } catch (error) {
        console.error(
            'Room connection failed:',
            error
        );

        setLobbyMessage(
            `Could not join the room: ${error.message || 'connection failed'}`,
            true
        );

        if (network) {
            try {
                await network.leave();
            } catch (leaveError) {
                console.warn(leaveError);
            }
        }

        network = null;
        activeRoomIsPublic = false;

        remotePlayers.clear();
        profiles = {};

        if (ui.ping) {
            ui.ping.textContent = 'PING -- MS';
        }

        if (ui.physics) {
            ui.physics.textContent = 'READY';
        }

    } finally {
        ui.createRoom.disabled = false;
        ui.joinRoom.disabled = false;
    }
}

// ============================================================
// PUBLIC ROOM BROWSER
// ============================================================

function startPublicRoomBrowser() {
    if (
        !profileStore?.ready ||
        !profileStore.watchPublicRooms ||
        publicRoomsUnsubscribe
    ) {
        return;
    }

    publicRoomsUnsubscribe =
        profileStore.watchPublicRooms(
            renderPublicRooms,
            error => {
                console.warn(
                    'Public room browser unavailable:',
                    error
                );

                if (ui.publicRoomList) {
                    ui.publicRoomList.innerHTML =
                        '<div class="room-empty">Room browser unavailable. Check Firestore rules.</div>';
                }
            }
        );
}

function refreshPublicRooms() {
    if (ui.publicRoomList) {
        ui.publicRoomList.innerHTML =
            '<div class="room-empty">Refreshing…</div>';
    }

    if (publicRoomsUnsubscribe) {
        publicRoomsUnsubscribe();
        publicRoomsUnsubscribe = null;
    }

    startPublicRoomBrowser();
}

function renderPublicRooms(rooms) {
    if (!ui.publicRoomList) return;

    ui.publicRoomList.replaceChildren();

    if (!rooms.length) {
        const empty = document.createElement('div');

        empty.className = 'room-empty';

        empty.textContent =
            'No public rooms right now. Make one and tick the public option!';

        ui.publicRoomList.append(empty);

        return;
    }

    for (const room of rooms) {
        const item = document.createElement('div');

        item.className = 'public-room-item';

        const info = document.createElement('div');

        info.className = 'public-room-info';

        const name = document.createElement('strong');

        name.textContent =
            room.name || `${room.hostName || 'Player'}’s room`;

        const meta = document.createElement('span');

        meta.textContent =
            `${room.code} · ${room.players || 1} player${room.players === 1 ? '' : 's'}${room.hasPassword ? ' · 🔒' : ''}`;

        info.append(name, meta);

        const join = document.createElement('button');

        join.type = 'button';
        join.className = 'button button-quiet room-join-button';
        join.textContent = 'Join';

        join.addEventListener('click', () => {
            const password = room.hasPassword
                ? window.prompt('This room needs a password:')
                : '';

            if (password === null) return;

            ui.roomCode.value = room.code;
            ui.joinPassword.value = password;

            handleRoomEntry(
                false,
                room.code,
                password
            );
        });

        item.append(info, join);

        ui.publicRoomList.append(item);
    }
}

// ============================================================
// PUBLIC ROOM PUBLISHING
// ============================================================

async function publishCurrentPublicRoom() {
    if (
        !profileStore?.ready ||
        !activeRoomIsPublic ||
        !network?.isHost
    ) {
        return;
    }

    await profileStore.publishRoom({
        code: roomCode,

        name: `${profile.name}’s room`,

        hostName: profile.name,

        players: Math.max(
            1,
            Object.keys(network.getRoster()).length
        ),

        hasPassword: Boolean(roomPassword)
    });
}

function startPublicRoomHeartbeat() {
    // Do not call stopPublicRoomHeartbeat here.
    // That would disable activeRoomIsPublic.

    if (publicRoomHeartbeat) {
        clearInterval(publicRoomHeartbeat);
    }

    publishCurrentPublicRoom().catch(error => {
        console.warn(
            'Could not publish public room:',
            error
        );
    });

    publicRoomHeartbeat = setInterval(() => {
        publishCurrentPublicRoom().catch(error => {
            console.warn(
                'Could not refresh public room:',
                error
            );
        });
    }, 8000);
}

function stopPublicRoomHeartbeat(removeListing) {
    if (publicRoomHeartbeat) {
        clearInterval(publicRoomHeartbeat);
    }

    publicRoomHeartbeat = null;

    if (
        removeListing &&
        activeRoomIsPublic &&
        profileStore?.ready
    ) {
        profileStore.removeRoom(roomCode).catch(error => {
            console.warn(
                'Could not remove public room:',
                error
            );
        });
    }

    activeRoomIsPublic = false;
}

// ============================================================
// LOCAL GAME
// ============================================================

async function startLocalGame() {
    stopPublicRoomHeartbeat(true);

    if (network) {
        try {
            await network.leave();
        } catch (error) {
            console.warn(error);
        }
    }

    network = null;

    profile = sanitizeProfile({
        name: ui.username.value,
        color: ui.color.value
    });

    writeLocalProfile(profile);

    roomMode = 'local';

    roomCode = 'LOCAL';
    roomPassword = '';

    roomIsHost = true;
    lastHostId = null;

    remotePlayers.clear();
    profiles = {};

    pendingRoster = null;

    movementKeys.clear();
    isAiming = false;

    currentMap = normalizeMap(
        getMap('default')
    );

    startGameScreen();

    setConnectionState('LOCAL MODE', false);

    if (ui.ping) {
        ui.ping.textContent = 'PING -- MS';
    }

    if (ui.physics) {
        ui.physics.textContent = 'LOCAL PHYSICS';
    }

    ui.networkStatus.textContent =
        'Local physics test';

    showToast('Local physics test started');
}

// ============================================================
// GAME SCREEN
// ============================================================

function startGameScreen() {
    ui.lobby.classList.add('hidden');
    ui.game.classList.remove('hidden');

    ui.activeCode.textContent = roomCode;

    ui.canvasHint.classList.remove('dismissed');

    ui.canvas.tabIndex = 0;

    const requestedMapId =
        network?.getMeta?.().mapId || 'default';

    currentMap = normalizeMap(
        getMap(requestedMapId)
    );

    localPlayer = new LocalPlayer(
        network?.userId || `local-${makeRoomCode()}`,
        profile,
        currentMap.spawn
    );

    remotePlayers.clear();

    if (network) {
        handleRoster(network.getRoster());
    }

    applyHostUI();
    updateMapUI();

    resizeCanvas();
    renderRoster();

    movementKeys.clear();

    ui.canvas.focus({
        preventScroll: true
    });

    simulationAccumulator = 0;
    stateSendAccumulator = 0;

    startAnimationLoop();
}

// ============================================================
// LEAVE ROOM
// ============================================================

async function leaveRoom() {
    stopPublicRoomHeartbeat(true);

    if (network) {
        try {
            await network.leave();
        } catch (error) {
            console.warn(error);
        }
    }

    network = null;

    remotePlayers.clear();
    profiles = {};

    pendingRoster = null;

    isAiming = false;
    movementKeys.clear();

    localPlayer = null;

    ui.game.classList.add('hidden');
    ui.lobby.classList.remove('hidden');

    setConnectionState(
        'LOCAL MODE',
        false
    );

    if (ui.ping) {
        ui.ping.textContent = 'PING -- MS';
    }

    if (ui.physics) {
        ui.physics.textContent = 'READY';
    }

    setLobbyMessage(
        'Create a room or join with a room code.'
    );
}

// ============================================================
// NETWORK ROSTER
// ============================================================

function handleRoster(roster) {
    profiles = roster || {};

    for (const [
        userId,
        playerProfile
    ] of Object.entries(profiles)) {
        if (userId === network?.userId) {
            continue;
        }

        let remote = remotePlayers.get(userId);

        if (!remote) {
            remote = new RemotePlayer(
                userId,
                playerProfile
            );

            remotePlayers.set(userId, remote);
        }

        remote.updateProfile(
            playerProfile || {}
        );
    }

    // Remove players no longer in the roster.

    for (const userId of [...remotePlayers.keys()]) {
        if (!(userId in profiles)) {
            remotePlayers.delete(userId);
        }
    }

    renderRoster();

    updateOnlineStatus();

    if (activeRoomIsPublic && network?.isHost) {
        publishCurrentPublicRoom().catch(error => {
            console.warn(
                'Public room update failed:',
                error
            );
        });
    }
}

function updateOnlineStatus() {
    if (roomMode !== 'online') return;

    const count = Object.keys(profiles).length;

    if (count > 1) {
        setConnectionState(
            'PEERS DISCOVERED',
            true
        );

        ui.networkStatus.textContent =
            `${count} players in room`;

    } else {
        setConnectionState(
            'WAITING FOR PEERS',
            false
        );

        ui.networkStatus.textContent =
            'Waiting for players…';
    }
}

function peerPingsChanged() {
    if (!network || !ui.ping) return;

    const value = network.getPing?.();

    ui.ping.textContent =
        Number.isFinite(value)
            ? `PING ${Math.round(value)} MS`
            : 'PING -- MS';
}

// ============================================================
// RECEIVE PLAYER STATE
// ============================================================

function handlePlayerState(userId, snapshot) {
    if (userId === network?.userId) return;

    let remote = remotePlayers.get(userId);

    if (!remote) {
        remote = new RemotePlayer(
            userId,
            profiles[userId] || {}
        );

        remotePlayers.set(userId, remote);
        renderRoster();
    }

    remote.pushSnapshot(
        snapshot,
        performance.now()
    );
}

// ============================================================
// ROOM METADATA
// ============================================================

function handleRoomMeta(meta) {
    if (!meta) return;

    const previousHostId = lastHostId;

    lastHostId = meta.hostId;

    roomIsHost = Boolean(meta.isHost);

    applyHostUI();

    if (
        meta.mapId &&
        meta.mapId !== currentMap.id
    ) {
        currentMap = normalizeMap(
            getMap(meta.mapId)
        );

        localPlayer?.reset(currentMap.spawn);

        updateMapUI();
        resizeCanvas();
    }

    if (
        previousHostId &&
        previousHostId !== meta.hostId
    ) {
        showToast(
            roomIsHost
                ? 'You are now the host'
                : 'Room host changed'
        );
    }
}

// ============================================================
// GAME EVENTS
// ============================================================

function handleRoomEvent(event, senderId) {
    if (!event) return;

    // Host-only round reset.

    if (
        event.type === 'reset' &&
        senderId === lastHostId
    ) {
        localPlayer?.reset(
            currentMap.spawn
        );

        isAiming = false;

        ui.canvasHint.classList.remove(
            'dismissed'
        );

        showToast('Host reset the round');
    }

    // Host-only map change.

    if (
        event.type === 'map' &&
        senderId === lastHostId &&
        typeof event.mapId === 'string'
    ) {
        currentMap = normalizeMap(
            getMap(event.mapId)
        );

        localPlayer?.reset(
            currentMap.spawn
        );

        updateMapUI();
        resizeCanvas();

        showToast(
            `Map changed to ${currentMap.name}`
        );
    }
}

// ============================================================
// LOCAL PLAYER COLLISIONS
// ============================================================

function resolvePlayerCollisions() {
    const players = [];

    if (localPlayer?.body) {
        players.push([
            localPlayer.userId,
            localPlayer.body
        ]);
    }

    for (const remote of remotePlayers.values()) {
        if (remote.body) {
            players.push([
                remote.userId,
                remote.body
            ]);
        }
    }

    // Consistent ordering on every client.

    players.sort(([idA], [idB]) => {
        return idA.localeCompare(idB);
    });

    for (
        let pass = 0;
        pass < PLAYER_COLLISION_PASSES;
        pass++
    ) {
        for (let i = 0; i < players.length; i++) {
            for (
                let j = i + 1;
                j < players.length;
                j++
            ) {
                const bodyA = players[i][1];
                const bodyB = players[j][1];

                let dx = bodyB.x - bodyA.x;
                let dy = bodyB.y - bodyA.y;

                let distance = Math.hypot(dx, dy);

                const minimumDistance =
                    bodyA.radius + bodyB.radius;

                if (distance >= minimumDistance) {
                    continue;
                }

                if (distance < 0.0001) {
                    dx = 1;
                    dy = 0;
                    distance = 1;
                }

                const nx = dx / distance;
                const ny = dy / distance;

                // Separate the balls.

                const overlap =
                    minimumDistance - distance;

                const correction =
                    overlap * PLAYER_SEPARATION * 0.5 + 0.005;

                bodyA.x -= nx * correction;
                bodyA.y -= ny * correction;

                bodyB.x += nx * correction;
                bodyB.y += ny * correction;

                // Relative velocity along the contact normal.

                const relativeVelocity =
                    (bodyB.vx - bodyA.vx) * nx +
                    (bodyB.vy - bodyA.vy) * ny;

                // Equal-mass collision impulse.

                if (relativeVelocity < 0) {
                    const impulse =
                        -(1 + PLAYER_RESTITUTION) *
                        relativeVelocity * 0.5;

                    bodyA.vx -= impulse * nx;
                    bodyA.vy -= impulse * ny;

                    bodyB.vx += impulse * nx;
                    bodyB.vy += impulse * ny;
                }

                // Approximate support from another ball.
                // Only mark the body as grounded when it is
                // actually resting above the other body.

                const verticalTolerance = 0.72;

                if (
                    ny > verticalTolerance &&
                    Math.abs(bodyA.vy - bodyB.vy) < 100
                ) {
                    bodyA.onGround = true;
                }

                if (
                    ny < -verticalTolerance &&
                    Math.abs(bodyA.vy - bodyB.vy) < 100
                ) {
                    bodyB.onGround = true;
                }
            }
        }
    }
}

// ============================================================
// HOST CONTROLS
// ============================================================

function applyHostUI() {
    ui.hostBadge.textContent =
        roomIsHost ? 'HOST' : 'PLAYER';

    ui.hostBadge.classList.toggle(
        'host-badge',
        roomIsHost
    );

    ui.hostPanel.classList.toggle(
        'disabled',
        !roomIsHost
    );

    ui.mapSelect.disabled = !roomIsHost;

    ui.resetRound.disabled = !roomIsHost;

    ui.mapSelect.value = currentMap.id;
}

function hostResetRound() {
    if (
        roomMode === 'online' &&
        !roomIsHost
    ) {
        return;
    }

    localPlayer?.reset(
        currentMap.spawn
    );

    isAiming = false;

    ui.canvasHint.classList.remove(
        'dismissed'
    );

    if (network) {
        network.resetRound();
    }

    showToast('Round reset');
}

function hostChangeMap(mapId) {
    if (
        roomMode === 'online' &&
        !roomIsHost
    ) {
        ui.mapSelect.value = currentMap.id;
        return;
    }

    currentMap = normalizeMap(
        getMap(mapId)
    );

    localPlayer?.reset(
        currentMap.spawn
    );

    updateMapUI();
    resizeCanvas();

    if (network) {
        network.setMap(mapId);
    }

    showToast(
        `Loaded ${currentMap.name}`
    );
}

function updateMapUI() {
    ui.mapName.textContent =
        currentMap.name.toUpperCase();

    ui.mapSelect.value = currentMap.id;

    ui.activeCode.textContent = roomCode;

    applyHostUI();
}

// ============================================================
// ROSTER DISPLAY
// ============================================================

function renderRoster() {
    if (!ui.roster) return;

    ui.roster.replaceChildren();

    const roster = network
        ? network.getRoster()
        : {
            [localPlayer?.userId || 'local']: profile
        };

    const entries = Object.entries(
        roster || {}
    );

    if (!entries.length) {
        entries.push([
            localPlayer?.userId || 'local',
            profile
        ]);
    }

    const myId =
        network?.userId ||
        localPlayer?.userId;

    entries.sort(([idA], [idB]) => {
        if (idA === myId) return -1;
        if (idB === myId) return 1;
        return idA.localeCompare(idB);
    });

    for (const [
        userId,
        rawItem
    ] of entries) {
        const item = rawItem || {};

        const isMe = userId === myId;

        const wrapper = document.createElement('div');

        wrapper.className = 'roster-item';

        const ball = document.createElement('span');

        ball.className = 'roster-ball';

        ball.style.background =
            item.color || '#91a0b2';

        ball.style.color =
            item.color || '#91a0b2';

        const name = document.createElement('span');

        name.className = 'roster-name';

        name.textContent =
            `${item.name || 'Player'}${isMe ? ' (you)' : ''}`;

        const role = document.createElement('span');

        role.className = 'roster-role';

        role.textContent =
            userId === lastHostId ||
            (roomMode === 'local' && isMe)
                ? 'HOST'
                : '';

        wrapper.append(
            ball,
            name,
            role
        );

        ui.roster.append(wrapper);
    }

    const count = entries.length;

    ui.rosterCount.textContent =
        String(count).padStart(2, '0');

    ui.playerCount.textContent =
        `${count} PLAYER${count === 1 ? '' : 'S'}`;
}

// ============================================================
// MOUSE INPUT
// ============================================================

function onPointerDown(event) {
    if (
        !localPlayer ||
        ui.game.classList.contains('hidden')
    ) {
        return;
    }

    if (event.button !== 0) return;

    const point = canvasToWorld(event);

    const body = localPlayer.body;

    const distance = Math.hypot(
        point.x - body.x,
        point.y - body.y
    );

    if (distance > body.radius * 2.3) {
        return;
    }

    isAiming = true;

    aimPointer = point;

    ui.canvas.focus({
        preventScroll: true
    });

    ui.canvas.setPointerCapture?.(
        event.pointerId
    );

    ui.canvasHint.classList.add(
        'dismissed'
    );

    event.preventDefault();
}

function onPointerMove(event) {
    if (!isAiming) return;

    aimPointer = canvasToWorld(event);

    event.preventDefault();
}

function onPointerUp(event) {
    if (!isAiming || !localPlayer) {
        return;
    }

    aimPointer = canvasToWorld(event);

    const velocity = getAimVelocity(
        localPlayer.body,
        aimPointer
    );

    if (
        Math.hypot(
            velocity.x,
            velocity.y
        ) > 35
    ) {
        localPlayer.launch(
            velocity.x,
            velocity.y
        );

        showToast('Launched');
    }

    isAiming = false;

    event.preventDefault();
}

function onPointerCancel() {
    isAiming = false;
}

// ============================================================
// AIM PHYSICS
// ============================================================

function getAimVelocity(body, pointer) {
    const dx = body.x - pointer.x;
    const dy = body.y - pointer.y;

    const pullLength = Math.hypot(dx, dy);

    const limited = Math.min(
        pullLength,
        310
    );

    const scale = pullLength > 0
        ? (limited / pullLength) * 4.25
        : 0;

    return {
        x: dx * scale,
        y: dy * scale
    };
}

// ============================================================
// KEYBOARD INPUT
// ============================================================

function onKeyDown(event) {
    if (
        !localPlayer ||
        ui.game.classList.contains('hidden') ||
        isTypingTarget(event.target)
    ) {
        return;
    }

    const code = event.code;

    // W / Arrow Up = ground-only jump.

    if (
        code === 'KeyW' ||
        code === 'ArrowUp'
    ) {
        event.preventDefault();

        if (
            !event.repeat &&
            localPlayer.jump()
        ) {
            ui.canvasHint.classList.add(
                'dismissed'
            );
        }

        return;
    }

    // A / D = continuous movement.

    if (
        code === 'KeyA' ||
        code === 'KeyD' ||
        code === 'ArrowLeft' ||
        code === 'ArrowRight'
    ) {
        event.preventDefault();

        movementKeys.add(code);

        return;
    }

    // R = reset.

    if (code === 'KeyR') {
        event.preventDefault();
        hostResetRound();
    }
}

function onKeyUp(event) {
    movementKeys.delete(event.code);
}

function isTypingTarget(target) {
    return (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target?.isContentEditable === true
    );
}

// ============================================================
// CANVAS COORDINATES
// ============================================================

function canvasToWorld(event) {
    const rect = ui.canvas.getBoundingClientRect();

    const x =
        (event.clientX - rect.left) *
        (currentMap.width / rect.width);

    const y =
        (event.clientY - rect.top) *
        (currentMap.height / rect.height);

    return { x, y };
}

// ============================================================
// RESIZE
// ============================================================

function resizeCanvas() {
    if (!ui.canvas) return;

    dpr = Math.min(
        window.devicePixelRatio || 1,
        2
    );

    const width = currentMap.width;
    const height = currentMap.height;

    if (
        ui.canvas.width !== Math.round(width * dpr) ||
        ui.canvas.height !== Math.round(height * dpr)
    ) {
        ui.canvas.width = Math.round(width * dpr);
        ui.canvas.height = Math.round(height * dpr);
    }
}

// ============================================================
// ANIMATION LOOP
// ============================================================

function startAnimationLoop() {
    if (animationStarted) return;

    animationStarted = true;

    lastFrameTime = performance.now();
    lastRenderTime = 0;

    requestAnimationFrame(frame);
}

function frame(now) {
    if (ui.game.classList.contains('hidden')) {
        animationStarted = false;
        return;
    }

    const elapsed = Math.min(
        MAX_FRAME_TIME,
        Math.max(
            0,
            (now - lastFrameTime) / 1000
        )
    );

    lastFrameTime = now;

    simulationAccumulator += elapsed;

    let steps = 0;

    while (
        simulationAccumulator >= FIXED_DT &&
        steps < MAX_SIMULATION_STEPS
    ) {
        updateSimulation(FIXED_DT);

        simulationAccumulator -= FIXED_DT;

        steps++;
    }

    // Avoid an unlimited catch-up loop after a lag spike.

    if (steps === MAX_SIMULATION_STEPS) {
        simulationAccumulator = Math.min(
            simulationAccumulator,
            FIXED_DT
        );
    }

    if (
        now - lastRenderTime >=
        1000 / SIMULATION_HZ - 0.4
    ) {
        renderFrame(now);
        lastRenderTime = now;
    }

    requestAnimationFrame(frame);
}

// ============================================================
// PHYSICS SIMULATION
// ============================================================

function updateSimulation(dt) {
    if (!localPlayer) return;

    const movingRight =
        movementKeys.has('KeyD') ||
        movementKeys.has('ArrowRight');

    const movingLeft =
        movementKeys.has('KeyA') ||
        movementKeys.has('ArrowLeft');

    const horizontalInput =
        (movingRight ? 1 : 0) -
        (movingLeft ? 1 : 0);

    // 1. Move our own ball locally.

    localPlayer.move(
        horizontalInput,
        dt
    );

    stepBody(
        localPlayer.body,
        currentMap,
        dt
    );

    // 2. Simulate all remote players locally.

    for (const remote of remotePlayers.values()) {
        remote.simulate(
            dt,
            currentMap
        );
    }

    // 3. Resolve collisions locally on every client.

    resolvePlayerCollisions();

    // 4. Respawn the local ball.

    if (
        localPlayer.body.y -
        localPlayer.body.radius >
        currentMap.height + 180
    ) {
        localPlayer.reset(
            currentMap.spawn
        );

        isAiming = false;
    }

    // 5. Send our own physics snapshot.

    if (network) {
        stateSendAccumulator += dt;

        if (
            stateSendAccumulator >=
            1 / STATE_SEND_RATE
        ) {
            stateSendAccumulator = 0;

            network.sendState(
                localPlayer.snapshot()
            );
        }
    }
}

// ============================================================
// RENDER
// ============================================================

function renderFrame(now) {
    const ctx = ui.canvas.getContext('2d');

    if (!ctx) return;

    ctx.setTransform(
        dpr,
        0,
        0,
        dpr,
        0,
        0
    );

    ctx.clearRect(
        0,
        0,
        currentMap.width,
        currentMap.height
    );

    ctx.fillStyle =
        currentMap.background || '#101923';

    ctx.fillRect(
        0,
        0,
        currentMap.width,
        currentMap.height
    );

    drawGrid(ctx);

    drawMap(
        ctx,
        currentMap
    );

    if (isAiming && localPlayer) {
        drawAimPreview(ctx);
    }

    // Draw predicted remote players.

    for (const remote of remotePlayers.values()) {
        const position =
            remote.getVisualState(now);

        if (position) {
            drawPlayer(
                ctx,
                remote,
                position,
                { local: false }
            );
        }
    }

    // Draw local player.

    if (localPlayer) {
        drawPlayer(
            ctx,
            localPlayer,
            localPlayer.body,
            {
                local: true,
                aiming: isAiming
            }
        );
    }
}

// ============================================================
// GRID
// ============================================================

function drawGrid(ctx) {
    ctx.save();

    ctx.strokeStyle =
        'rgba(178,198,218,.055)';

    ctx.lineWidth = 1;

    ctx.beginPath();

    for (
        let x = 0;
        x <= currentMap.width;
        x += 40
    ) {
        ctx.moveTo(x + 0.5, 0);

        ctx.lineTo(
            x + 0.5,
            currentMap.height
        );
    }

    for (
        let y = 0;
        y <= currentMap.height;
        y += 40
    ) {
        ctx.moveTo(0, y + 0.5);

        ctx.lineTo(
            currentMap.width,
            y + 0.5
        );
    }

    ctx.stroke();

    ctx.restore();
}

// ============================================================
// AIM PREVIEW
// ============================================================

function drawAimPreview(ctx) {
    const body = localPlayer.body;

    const velocity = getAimVelocity(
        body,
        aimPointer
    );

    const pullDistance = Math.hypot(
        body.x - aimPointer.x,
        body.y - aimPointer.y
    );

    if (pullDistance < 3) return;

    const predictionBody = {
        ...body,
        vx: velocity.x,
        vy: velocity.y,
        onGround: false
    };

    const trajectory = predictTrajectory(
        predictionBody,
        currentMap,
        150,
        3
    );

    ctx.save();

    ctx.lineWidth = 2;

    ctx.strokeStyle =
        'rgba(114,228,197,.64)';

    ctx.setLineDash([5, 7]);

    ctx.beginPath();

    trajectory.forEach((point, index) => {
        if (index === 0) {
            ctx.moveTo(
                point.x,
                point.y
            );
        } else {
            ctx.lineTo(
                point.x,
                point.y
            );
        }
    });

    ctx.stroke();

    ctx.setLineDash([]);

    trajectory.forEach((point, index) => {
        if (index % 2 !== 0) return;

        const alpha = Math.max(
            0.1,
            0.72 -
            index / trajectory.length * 0.65
        );

        ctx.globalAlpha = alpha;

        ctx.fillStyle = '#a4f6df';

        ctx.beginPath();

        ctx.arc(
            point.x,
            point.y,
            Math.max(
                2,
                4 - index / trajectory.length * 2
            ),
            0,
            Math.PI * 2
        );

        ctx.fill();
    });

    ctx.globalAlpha = 1;

    ctx.strokeStyle =
        'rgba(255,255,255,.55)';

    ctx.lineWidth = 1.3;

    ctx.beginPath();

    ctx.moveTo(
        body.x,
        body.y
    );

    ctx.lineTo(
        aimPointer.x,
        aimPointer.y
    );

    ctx.stroke();

    ctx.fillStyle = '#edfef8';

    ctx.beginPath();

    ctx.arc(
        aimPointer.x,
        aimPointer.y,
        5,
        0,
        Math.PI * 2
    );

    ctx.fill();

    ctx.restore();
}

// ============================================================
// COPY INVITE
// ============================================================

function copyInvite() {
    const invite =
        `Multiplayer game room\nCode: ${roomCode}\nPassword: ${roomPassword || '(no password)'}`;

    if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(invite)
            .then(() => {
                showToast('Room invite copied');
            })
            .catch(() => {
                showToast(invite);
            });

    } else {
        showToast(
            'Clipboard unavailable. Room code: ' +
            roomCode
        );
    }
}

// ============================================================
// CONNECTION UI
// ============================================================

function setConnectionState(label, online) {
    if (ui.connectionText) {
        ui.connectionText.textContent = label;
    }

    ui.connectionDot?.classList.toggle(
        'online',
        online
    );
}

function setLobbyMessage(
    message,
    error = false,
    good = false
) {
    ui.lobbyMessage.textContent = message;

    ui.lobbyMessage.classList.toggle(
        'error',
        error
    );

    ui.lobbyMessage.classList.toggle(
        'good',
        good
    );
}

// ============================================================
// TOAST
// ============================================================

function showToast(message) {
    ui.toast.textContent = message;

    ui.toast.classList.add('show');

    clearTimeout(toastTimeout);

    toastTimeout = setTimeout(() => {
        ui.toast.classList.remove('show');
    }, 2100);
}

// ============================================================
// AVATAR
// ============================================================

function updateAvatarPreview() {
    if (!ui.avatar) return;

    const color =
        /^#[0-9a-f]{6}$/i.test(ui.color.value)
            ? ui.color.value
            : DEFAULT_PROFILE.color;

    const preview =
        ui.avatar.querySelector('span');

    if (preview) {
        preview.style.background = color;
    }

    ui.avatar.style.borderColor =
        `${color}66`;

    ui.avatar.style.background =
        `${color}14`;
}

// ============================================================
// PROFILE UI
// ============================================================

function syncProfileFields() {
    ui.username.value = profile.name;
    ui.color.value = profile.color;

    updateAvatarPreview();
}

function sanitizeProfile(value) {
    const name = String(value.name || 'Player')
        .trim()
        .replace(/[<>\u0000-\u001f]/g, '')
        .slice(0, 18) || 'Player';

    const color =
        /^#[0-9a-f]{6}$/i.test(value.color)
            ? value.color
            : DEFAULT_PROFILE.color;

    return {
        name,
        color
    };
}

// ============================================================
// LOCAL STORAGE
// ============================================================

function readLocalProfile() {
    try {
        const saved = JSON.parse(
            localStorage.getItem(
                'trajectoryLabProfile'
            ) || 'null'
        );

        return saved
            ? sanitizeProfile(saved)
            : { ...DEFAULT_PROFILE };

    } catch {
        return { ...DEFAULT_PROFILE };
    }
}

function writeLocalProfile(nextProfile) {
    try {
        localStorage.setItem(
            'trajectoryLabProfile',
            JSON.stringify(nextProfile)
        );
    } catch (error) {
        console.warn(
            'Could not save local profile:',
            error
        );
    }
}

// ============================================================
// ROOM CODE GENERATION
// ============================================================

function makeRoomCode() {
    const alphabet =
        'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

    const bytes = new Uint8Array(6);

    crypto.getRandomValues(bytes);

    return [...bytes]
        .map(value =>
            alphabet[value % alphabet.length]
        )
        .join('');
}
