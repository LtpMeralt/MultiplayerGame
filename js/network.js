
import { joinRoom } from 'https://esm.run/trystero@0.27.0';

// ============================================================
// CONFIGURATION
// ============================================================

const APP_ID = 'ltpmer-multiplayer-game-v1';

const MAX_PLAYERS = 32;

const PING_INTERVAL = 5000;
const PING_TIMEOUT = 2500;

// ============================================================
// CONNECT ROOM
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
        .toUpperCase();

    if (!cleanCode) {
        throw new Error('Room code is empty.');
    }

    const roomId = `multiplayer-game-${cleanCode.toLowerCase()}`;

    const config = {
        appId: APP_ID,
        maxUsers: MAX_PLAYERS,

        relayConfig: {
            redundancy: 5,
            warnOnRelayFailure: false
        }
    };

    if (password) {
        config.password = password;
    }

    const room = joinRoom(config, roomId);

    let left = false;

    let pingHeartbeat = null;
    let metaHeartbeat = null;
    let hostDiscoveryHeartbeat = null;
    let hostMonitor = null;

    let pingInFlight = false;

    let stateSending = false;
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
        if (left) return;

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
                : 'Direct connection failed. This network may require TURN.';
        }

        if (code === 'relay-failed') {
            message = 'All signaling relays failed. Check your internet connection.';
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
    // IDENTITY
    // ========================================================

    let identity;

    try {
        identity = await room.getSelf();
    } catch (error) {
        try {
            await room.leave();
        } catch {}

        throw error;
    }

    const { userId } = identity;

    // ========================================================
    // PLAYER PRESENCE
    // ========================================================

    const presence = room.makeUserState(
        'player-profile',
        profile
    );

    presence.set(profile);

    function getUsers() {
        return room.getUsers() || {};
    }

    function getRoster() {
        return {
            ...presence.getAll(),
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
    // ACTIONS
    // ========================================================

    const stateAction = room.makeAction('orb-state');
    const eventAction = room.makeAction('orb-event');
    const metaAction = room.makeAction('orb-meta');

    // ========================================================
    // PING
    // ========================================================

    function publishPing() {
        if (left) return;

        const now = performance.now();

        const values = [...peerPings.values()]
            .filter(item => now - item.updatedAt < 12000)
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

        const average = values.reduce(
            (sum, value) => sum + value,
            0
        ) / values.length;

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
            const users = getUsers();
            const activeUsers = new Set(Object.keys(users));

            for (const id of peerPings.keys()) {
                if (!activeUsers.has(id)) {
                    peerPings.delete(id);
                }
            }

            if (!activeUsers.size) {
                publishPing();
                return;
            }

            const results = await Promise.all(
                [...activeUsers].map(async targetId => ({
                    targetId,
                    rtt: await pingUser(targetId)
                }))
            );

            if (left) return;

            const stillActive = new Set(
                Object.keys(getUsers())
            );

            for (const result of results) {
                if (!stillActive.has(result.targetId)) {
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

    function getElectionCandidate(excludedId = null) {
        const candidates = [
            userId,
            ...Object.keys(getUsers()).filter(
                id => id !== excludedId
            )
        ];

        return [...new Set(candidates)].sort()[0];
    }

    function publishMeta() {
        if (left) return;

        callbacks.onMeta?.({
            ...roomMeta,
            isHost: roomMeta.hostId === userId
        });
    }

    function announceMeta() {
        if (
            left ||
            roomMeta.hostId !== userId
        ) {
            return;
        }

        metaAction.send({
            type: 'meta',
            hostId: userId,
            mapId: roomMeta.mapId
        }).catch(error => {
            console.warn('Host metadata send failed:', error);
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

        const hostIsPresent =
            roomMeta.hostId === userId ||
            Boolean(users[roomMeta.hostId]);

        const hostHasLeft =
            Boolean(roomMeta.hostId) &&
            !hostIsPresent;

        const isCurrentHost =
            fromId === roomMeta.hostId;

        const isValidMigration =
            hostHasLeft &&
            fromId === getElectionCandidate(roomMeta.hostId);

        const isFirstHost =
            !roomMeta.hostId &&
            fromId === getElectionCandidate() &&
            data.hostId === fromId;

        if (
            !isCurrentHost &&
            !isValidMigration &&
            !isFirstHost
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

    function electHost(excludedId = null) {
        if (left) return;

        const candidate = getElectionCandidate(excludedId);

        if (candidate !== userId) return;

        roomMeta = {
            ...roomMeta,
            hostId: userId
        };

        announceMeta();
    }

    metaAction.onMessage((data, context) => {
        if (
            left ||
            !data ||
            context.userId === userId
        ) {
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
    // PLAYER STATE
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
    // GAME EVENTS
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

        publishRoster();

        callbacks.onUserJoin?.(joinedUserId);

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
            electHost(leavingUserId);
        }

    });

    // ========================================================
    // PEER CONNECTION
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
        }, 300);

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

    // Repeated host discovery for late signaling events.
    hostDiscoveryHeartbeat = setInterval(() => {
        if (left) return;

        if (!roomMeta.hostId) {
            requestHost();
        } else {
            clearInterval(hostDiscoveryHeartbeat);
            hostDiscoveryHeartbeat = null;
        }
    }, 1500);

    // Detect host disconnects that do not deliver a clean leave event.
    hostMonitor = setInterval(() => {
        if (left || !roomMeta.hostId) return;

        if (
            roomMeta.hostId !== userId &&
            !getUsers()[roomMeta.hostId]
        ) {
            electHost(roomMeta.hostId);
        }
    }, 4000);

    // Host metadata heartbeat.
    metaHeartbeat = setInterval(() => {
        if (roomMeta.hostId === userId) {
            announceMeta();
        }
    }, 8000);

    // Ping heartbeat.
    pingHeartbeat = setInterval(
        measurePing,
        PING_INTERVAL
    );

    setTimeout(() => {
        if (!left) measurePing();
    }, 700);

    // ========================================================
    // STATE SENDING
    // ========================================================

    async function flushStateQueue() {
        if (left || stateSending) return;

        stateSending = true;

        try {
            while (!left && queuedState !== null) {
                const snapshot = queuedState;
                queuedState = null;

                try {
                    await stateAction.send(snapshot);
                } catch (error) {
                    console.warn(
                        'Player state transmission failed:',
                        error
                    );
                }
            }
        } finally {
            stateSending = false;

            if (!left && queuedState !== null) {
                void flushStateQueue();
            }
        }
    }

    function sendLatestState(snapshot) {
        if (left) return;

        queuedState = snapshot;

        void flushStateQueue();
    }

    // ========================================================
    // RETURN NETWORK API
    // ========================================================

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
            return Object.keys(getUsers()).length;
        },

        getPing() {
            const now = performance.now();

            const values = [...peerPings.values()]
                .filter(item => now - item.updatedAt < 12000)
                .map(item => item.rtt)
                .filter(Number.isFinite);

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
                console.warn(
                    'Game event transmission failed:',
                    error
                );
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
                console.warn(
                    'Map change transmission failed:',
                    error
                );
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
                console.warn(
                    'Round reset transmission failed:',
                    error
                );
            });

            return true;
        },

        updateProfile(nextProfile) {
            if (left) return;

            profile = {
                name: String(nextProfile?.name || 'Player')
                    .trim()
                    .replace(/[<>\u0000-\u001f]/g, '')
                    .slice(0, 18) || 'Player',

                color: /^#[0-9a-f]{6}$/i.test(nextProfile?.color)
                    ? nextProfile.color
                    : '#72e4c5'
            };

            presence.set(profile);
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

            if (hostMonitor) {
                clearInterval(hostMonitor);
            }

            pingHeartbeat = null;
            metaHeartbeat = null;
            hostDiscoveryHeartbeat = null;
            hostMonitor = null;

            peerPings.clear();
            queuedState = null;

            try {
                presence.clear();
            } catch (error) {
                console.warn(
                    'Could not clear player presence:',
                    error
                );
            }

            try {
                await room.leave();
            } catch (error) {
                console.warn(
                    'Could not leave Trystero room:',
                    error
                );
            }
        }
    };
}
