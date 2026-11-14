
import { joinRoom } from 'https://esm.run/@trystero-p2p/firebase@0.27.0';

// ============================================================
// CONFIGURATION
// ============================================================

const FIREBASE_DATABASE_URL =
    'https://multiplayergame-70906-default-rtdb.europe-west1.firebasedatabase.app';

const APP_ID = FIREBASE_DATABASE_URL;
const FIREBASE_PATH = '__trystero__';

const MAX_PLAYERS = 32;
const PING_INTERVAL = 2500;
const PING_TIMEOUT = 2000;

// ============================================================
// ROOM CONNECTION
// ============================================================

export async function connectRoom({
    code,
    password = '',
    profile,
    create = false,
    callbacks = {}
}) {
    const cleanCode = String(code)
        .trim()
        .toLowerCase();

    if (!cleanCode) {
        throw new Error('Room code is empty.');
    }

    const roomId = `multiplayer-game-${cleanCode}`;

    const config = {
        appId: APP_ID,
        maxUsers: MAX_PLAYERS,
        relayConfig: {
            firebasePath: FIREBASE_PATH
        }
    };

    if (password) {
        config.password = password;
    }

    // Firebase strategy: database URL is the appId.
    // Do not pass firebaseApp here.
    const room = joinRoom(config, roomId);

    let left = false;

    let pingHeartbeat = null;
    let metaHeartbeat = null;
    let hostDiscoveryHeartbeat = null;

    let pingInFlight = false;
    let stateInFlight = false;
    let queuedState = null;

    let roomMeta = {
        hostId: create ? null : null,
        mapId: 'default'
    };

    const peerPings = new Map();

    // ========================================================
    // PROFILE
    // ========================================================

    profile = {
        name: String(profile?.name || 'Player')
            .trim()
            .replace(/[<>\u0000-\u001f]/g, '')
            .slice(0, 18) || 'Player',

        color: /^#[0-9a-f]{6}$/i.test(profile?.color)
            ? profile.color
            : '#72e4c5'
    };

    // ========================================================
    // ERROR HANDLING
    // ========================================================

    room.onError(error => {
        const code = error?.code;

        let message =
            error?.message ||
            code ||
            'Unknown room error';

        if (code === 'decrypt-failed') {
            message = 'Wrong room password.';
        }

        if (code === 'peer-connect-failed') {
            message = error.turnConfigured
                ? 'Peer connection failed. Check your network.'
                : 'WebRTC connection failed. This network may require TURN.';
        }

        if (code === 'relay-failed') {
            message = 'Firebase signaling failed. Check Realtime Database rules.';
        }

        if (code === 'room-full') {
            message = `Room is full. Maximum ${MAX_PLAYERS} players.`;
        }

        if (code === 'banned') {
            message = 'You cannot join this room.';
        }

        callbacks.onStatus?.(message);
        callbacks.onError?.(error);
    });

    // ========================================================
    // INITIALIZE IDENTITY
    // ========================================================

    let self;

    try {
        self = await room.getSelf();
    } catch (error) {
        try {
            await room.leave();
        } catch {}

        throw error;
    }

    const { userId } = self;

    // ========================================================
    // PLAYER PRESENCE
    // ========================================================

    const presence = room.makeUserState(
        'player-profile',
        {
            name: profile.name,
            color: profile.color
        }
    );

    presence.set(profile).catch(error => {
        console.warn('Could not publish player profile:', error);
    });

    // ========================================================
    // NETWORK ACTIONS
    // ========================================================

    const stateAction = room.makeAction('orb-state');
    const eventAction = room.makeAction('orb-event');
    const metaAction = room.makeAction('orb-meta');

    // ========================================================
    // PLAYER DISCOVERY
    // ========================================================

    function getUsers() {
        return room.getUsers() || {};
    }

    function getUserIds() {
        return Object.keys(getUsers());
    }

    function getRoster() {
        return {
            ...(presence.getAll() || {}),
            [userId]: {
                name: profile.name,
                color: profile.color
            }
        };
    }

    function publishRoster() {
        if (left) return;

        callbacks.onRoster?.(getRoster());
    }

    presence.onChange(() => {
        publishRoster();
    }, {
        replay: true
    });

    // ========================================================
    // PING DISPLAY
    // ========================================================

    function publishPing() {
        if (left) return;

        const now = performance.now();

        // Ignore old measurements.
        const values = [...peerPings.values()]
            .filter(item => now - item.updatedAt < 8000)
            .map(item => item.rtt)
            .filter(Number.isFinite);

        if (!values.length) {
            callbacks.onPing?.({
                average: null,
                min: null,
                max: null,
                peers: 0
            });

            return;
        }

        const average =
            values.reduce((sum, value) => sum + value, 0) /
            values.length;

        callbacks.onPing?.({
            average,
            min: Math.min(...values),
            max: Math.max(...values),
            peers: values.length
        });
    }

    async function pingUser(targetId) {
        let timeoutId;

        try {
            const result = await Promise.race([
                room.ping(targetId),

                new Promise(resolve => {
                    timeoutId = setTimeout(
                        () => resolve(null),
                        PING_TIMEOUT
                    );
                })
            ]);

            return Number.isFinite(result) && result >= 0
                ? result
                : null;

        } catch {
            return null;

        } finally {
            clearTimeout(timeoutId);
        }
    }

    async function measurePing() {
        if (left || pingInFlight) return;

        pingInFlight = true;

        try {
            const users = getUserIds();
            const activeUsers = new Set(users);

            for (const id of [...peerPings.keys()]) {
                if (!activeUsers.has(id)) {
                    peerPings.delete(id);
                }
            }

            if (!users.length) {
                publishPing();
                return;
            }

            const results = await Promise.all(
                users.map(async targetId => ({
                    targetId,
                    rtt: await pingUser(targetId)
                }))
            );

            if (left) return;

            const currentlyConnected = new Set(getUserIds());

            for (const result of results) {
                if (!currentlyConnected.has(result.targetId)) {
                    peerPings.delete(result.targetId);
                    continue;
                }

                if (Number.isFinite(result.rtt)) {
                    peerPings.set(result.targetId, {
                        rtt: result.rtt,
                        updatedAt: performance.now()
                    });
                }
            }

            publishPing();

        } finally {
            pingInFlight = false;
        }
    }

    // ========================================================
    // HOST MANAGEMENT
    // ========================================================

    function getElectionCandidate() {
        return [
            userId,
            ...getUserIds()
        ].sort()[0];
    }

    function publishMeta() {
        if (left) return;

        callbacks.onMeta?.({
            ...roomMeta,
            isHost: roomMeta.hostId === userId
        });
    }

    function announceMeta() {
        if (left || roomMeta.hostId !== userId) {
            return;
        }

        metaAction.send({
            type: 'meta',
            hostId: userId,
            mapId: roomMeta.mapId
        }).catch(error => {
            console.warn('Could not announce host metadata:', error);
        });

        publishMeta();
    }

    function acceptMeta(data, fromId) {
        if (
            !data ||
            typeof data.hostId !== 'string' ||
            data.hostId !== fromId
        ) {
            return;
        }

        const users = getUsers();

        const currentHostIsConnected =
            roomMeta.hostId === userId ||
            Boolean(users[roomMeta.hostId]);

        const currentHostLeft =
            Boolean(roomMeta.hostId) &&
            !currentHostIsConnected;

        const isCurrentHost =
            fromId === roomMeta.hostId;

        const isSelfPromoting =
            currentHostLeft &&
            data.hostId === fromId &&
            fromId === getElectionCandidate();

        const firstHostClaim =
            !roomMeta.hostId &&
            data.hostId === fromId;

        if (
            !isCurrentHost &&
            !isSelfPromoting &&
            !firstHostClaim
        ) {
            return;
        }

        roomMeta = {
            hostId: data.hostId,

            mapId: typeof data.mapId === 'string'
                ? data.mapId
                : roomMeta.mapId
        };

        publishMeta();
    }

    function requestHost() {
        if (left || roomMeta.hostId) return;

        metaAction.send({
            type: 'who-host'
        }).catch(() => {});
    }

    metaAction.onMessage((data, context) => {
        if (!data || context.userId === userId) {
            return;
        }

        if (data.type === 'who-host') {
            if (roomMeta.hostId === userId) {
                metaAction.send({
                    type: 'meta',
                    hostId: userId,
                    mapId: roomMeta.mapId
                }, {
                    target: context.userId
                }).catch(() => {});
            }

            return;
        }

        if (data.type === 'meta') {
            acceptMeta(data, context.userId);
        }
    });

    // ========================================================
    // RECEIVE PLAYER STATES
    // ========================================================

    stateAction.onMessage((data, context) => {
        if (
            left ||
            !data ||
            context.userId === userId
        ) {
            return;
        }

        if (
            ![
                data.x,
                data.y,
                data.vx,
                data.vy
            ].every(Number.isFinite)
        ) {
            return;
        }

        callbacks.onPlayerState?.(
            context.userId,
            data
        );
    });

    // ========================================================
    // RECEIVE GAME EVENTS
    // ========================================================

    eventAction.onMessage((data, context) => {
        if (
            left ||
            !data ||
            context.userId === userId
        ) {
            return;
        }

        callbacks.onEvent?.(
            data,
            context.userId
        );
    });

    // ========================================================
    // USER JOIN
    // ========================================================

    room.onUserJoin(({ userId: joinedUserId }) => {
        if (left) return;

        callbacks.onUserJoin?.(joinedUserId);

        publishRoster();

        if (roomMeta.hostId === userId) {
            announceMeta();
        } else {
            requestHost();
        }

        setTimeout(() => {
            if (!left) measurePing();
        }, 300);

    }, {
        replay: true
    });

    // ========================================================
    // USER LEAVE
    // ========================================================

    room.onUserLeave(({ userId: leavingUserId }) => {
        if (left) return;

        callbacks.onUserLeave?.(leavingUserId);

        peerPings.delete(leavingUserId);

        publishRoster();
        publishPing();

        if (roomMeta.hostId === leavingUserId) {
            const candidate = getElectionCandidate();

            if (candidate === userId) {
                roomMeta = {
                    ...roomMeta,
                    hostId: userId
                };

                announceMeta();
            }
        }

        if (!roomMeta.hostId) {
            requestHost();
        }
    });

    // ========================================================
    // PEER CONNECTION EVENTS
    // ========================================================

    room.onPeerJoin(({
        userId: joinedUserId,
        peerId
    }) => {
        if (left) return;

        callbacks.onPeerConnection?.({
            userId: joinedUserId,
            peerId,
            connected: true
        });

        setTimeout(() => {
            if (!left) measurePing();
        }, 250);

    }, {
        replay: true
    });

    room.onPeerLeave(({
        userId: leavingUserId,
        peerId
    }) => {
        if (left) return;

        callbacks.onPeerConnection?.({
            userId: leavingUserId,
            peerId,
            connected: false
        });

        setTimeout(() => {
            if (!left) measurePing();
        }, 100);
    });

    // ========================================================
    // INITIAL ROOM SETUP
    // ========================================================

    if (create) {
        roomMeta.hostId = userId;
        announceMeta();
    } else {
        requestHost();
    }

    publishRoster();
    publishPing();

    // Retry host discovery until the host responds.
    hostDiscoveryHeartbeat = setInterval(() => {
        if (!roomMeta.hostId) {
            requestHost();
        } else if (hostDiscoveryHeartbeat) {
            clearInterval(hostDiscoveryHeartbeat);
            hostDiscoveryHeartbeat = null;
        }
    }, 1500);

    // Send host metadata periodically.
    metaHeartbeat = setInterval(() => {
        if (roomMeta.hostId === userId) {
            announceMeta();
        }
    }, 8000);

    // Peer-to-peer ping.
    pingHeartbeat = setInterval(
        measurePing,
        PING_INTERVAL
    );

    setTimeout(() => {
        if (!left) measurePing();
    }, 500);

    // ========================================================
    // NETWORK OBJECT
    // ========================================================

    function sendLatestState(snapshot) {
        if (left) return;

        queuedState = snapshot;

        if (stateInFlight) return;

        stateInFlight = true;

        async function pump() {
            while (!left && queuedState) {
                const next = queuedState;
                queuedState = null;

                try {
                    await stateAction.send(next);
                } catch (error) {
                    console.warn(
                        'Player state transmission failed:',
                        error
                    );
                }
            }

            stateInFlight = false;

            // Handle an update arriving as the pump finishes.
            if (!left && queuedState) {
                sendLatestState(queuedState);
            }
        }

        pump();
    }

    return {
        userId,

        get hostId() {
            return roomMeta.hostId;
        },

        get isHost() {
            return roomMeta.hostId === userId;
        },

        getRoster,

        getMeta() {
            return { ...roomMeta };
        },

        getPeerCount() {
            return getUserIds().length;
        },

        getPing() {
            const now = performance.now();

            const values = [...peerPings.values()]
                .filter(item => now - item.updatedAt < 8000)
                .map(item => item.rtt);

            if (!values.length) return null;

            return values.reduce(
                (sum, value) => sum + value,
                0
            ) / values.length;
        },

        sendState(snapshot) {
            sendLatestState(snapshot);
        },

        sendEvent(event) {
            if (left) return;

            eventAction.send(event).catch(error => {
                console.warn('Game event transmission failed:', error);
            });
        },

        setMap(mapId) {
            if (
                left ||
                roomMeta.hostId !== userId ||
                typeof mapId !== 'string'
            ) {
                return false;
            }

            roomMeta = {
                ...roomMeta,
                mapId
            };

            announceMeta();

            eventAction.send({
                type: 'map',
                mapId
            }).catch(error => {
                console.warn('Could not send map change:', error);
            });

            return true;
        },

        resetRound() {
            if (
                left ||
                roomMeta.hostId !== userId
            ) {
                return false;
            }

            eventAction.send({
                type: 'reset'
            }).catch(error => {
                console.warn('Could not send round reset:', error);
            });

            return true;
        },

        updateProfile(nextProfile) {
            if (left) return;

            profile = {
                name: String(nextProfile?.name || 'Player')
                    .trim()
                    .slice(0, 18),

                color: /^#[0-9a-f]{6}$/i.test(nextProfile?.color)
                    ? nextProfile.color
                    : '#72e4c5'
            };

            presence.set(profile).catch(error => {
                console.warn('Could not update profile:', error);
            });

            publishRoster();
        },

        async leave() {
            if (left) return;

            left = true;

            if (pingHeartbeat) {
                clearInterval(pingHeartbeat);
            }

            if (metaHeartbeat) {
                clearInterval(metaHeartbeat);
            }

            if (hostDiscoveryHeartbeat) {
                clearInterval(hostDiscoveryHeartbeat);
            }

            pingHeartbeat = null;
            metaHeartbeat = null;
            hostDiscoveryHeartbeat = null;

            peerPings.clear();
            queuedState = null;

            try {
                await presence.clear();
            } catch (error) {
                console.warn('Could not clear presence:', error);
            }

            await room.leave();
        }
    };
}
