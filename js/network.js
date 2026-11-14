
import { joinRoom } from 'https://esm.run/trystero@0.27.0';

// ============================================================
// SETTINGS
// ============================================================

const APP_ID = 'ltpmer-multiplayer-game-v1';

// Small P2P rooms work better than a 32-player full mesh.
const MAX_PLAYERS = 8;

const PING_INTERVAL = 5000;
const PING_TIMEOUT = 2500;

// Replace these with your Metered values.
const METERED_APP_DOMAIN = 'ltpmergames.metered.live';
const METERED_CREDENTIAL_API_KEY = 'b2ea10eb9c6e474f6da23c9fc5198cb2abf9';

// ============================================================
// TURN CONFIGURATION
// ============================================================

async function loadTurnConfig() {
    if (
        METERED_APP_DOMAIN.startsWith('YOUR_') ||
        METERED_CREDENTIAL_API_KEY.startsWith('YOUR_')
    ) {
        throw new Error(
            'TURN is not configured. Add your Metered domain and credential API key in network.js.'
        );
    }

    const endpoint = new URL(
        `https://${METERED_APP_DOMAIN}/api/v1/turn/credentials`
    );

    endpoint.searchParams.set(
        'apiKey',
        METERED_CREDENTIAL_API_KEY
    );

    endpoint.searchParams.set('region', 'global');

    const response = await fetch(endpoint, {
        cache: 'no-store'
    });

    if (!response.ok) {
        throw new Error(
            `TURN credential request failed: HTTP ${response.status}`
        );
    }

    const iceServers = await response.json();

    if (!Array.isArray(iceServers)) {
        throw new Error('Invalid TURN server response.');
    }

    // Trystero supplies its own default STUN servers.
    // We only add TURN entries here.
    const turnServers = iceServers.filter(server => {
        const urls = Array.isArray(server.urls)
            ? server.urls
            : [server.urls];

        return urls.some(url =>
            typeof url === 'string' &&
            /^turns?:/i.test(url)
        );
    });

    if (!turnServers.length) {
        throw new Error(
            'No TURN servers were returned. Check your Metered credential.'
        );
    }

    console.log(
        `[NETWORK] Loaded ${turnServers.length} global TURN entries.`
    );

    return turnServers;
}

// ============================================================
// CONNECT
// ============================================================

export async function connectRoom({
    code,
    password = '',
    profile,
    create = false,
    callbacks = {}
}) {
    const cleanCode = String(code || '')
        .trim()
        .toUpperCase();

    if (cleanCode.length < 4) {
        throw new Error('Invalid room code.');
    }

    const roomId =
        `multiplayer-game-${cleanCode.toLowerCase()}`;

    // Fetch TURN before creating peer connections.
    const turnConfig = await loadTurnConfig();

    const config = {
        appId: APP_ID,
        maxUsers: MAX_PLAYERS,
        turnConfig,

        // Multiple Nostr relays for signaling redundancy.
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

    let pingTimer = null;
    let metaTimer = null;
    let discoveryTimer = null;

    let pingInFlight = false;
    let stateSending = false;
    let queuedState = null;

    let roomMeta = {
        hostId: null,
        mapId: 'default'
    };

    const peerPings = new Map();

    let currentProfile = {
        name: String(profile?.name || 'Player')
            .trim()
            .slice(0, 18) || 'Player',

        color: /^#[0-9a-f]{6}$/i.test(profile?.color)
            ? profile.color
            : '#72e4c5'
    };

    // ========================================================
    // ERRORS
    // ========================================================

    room.onError(error => {
        if (left) return;

        const code = error?.code;
        let message = error?.message || code || 'Unknown error';

        if (code === 'decrypt-failed') {
            message = 'Wrong room password.';
        }

        if (code === 'peer-connect-failed') {
            message = error.turnConfigured
                ? 'Peer connection failed even with TURN configured.'
                : 'Peer connection failed: TURN is not configured.';
        }

        if (code === 'relay-failed') {
            message = 'A signaling relay failed. Other relays may still work.';
        }

        if (code === 'room-full') {
            message = `Room full. Maximum ${MAX_PLAYERS} players.`;
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
    // PRESENCE
    // ========================================================

    const presence = room.makeUserState(
        'player-profile',
        currentProfile
    );

    Promise.resolve(presence.set(currentProfile))
        .catch(error => console.warn('Presence error:', error));

    function getUsers() {
        return room.getUsers?.() || {};
    }

    function getUserIds() {
        return Object.keys(getUsers());
    }

    function getRoster() {
        return {
            ...(presence.getAll?.() || {}),
            [userId]: { ...currentProfile }
        };
    }

    function publishRoster() {
        if (!left) {
            callbacks.onRoster?.(getRoster());
        }
    }

    presence.onChange(() => {
        publishRoster();
    });

    // ========================================================
    // ACTION CHANNELS
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
            .filter(item => now - item.at < 12000)
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

        callbacks.onPing?.({
            average: values.reduce((a, b) => a + b, 0) / values.length,
            min: Math.min(...values),
            max: Math.max(...values),
            peers: values.length
        });
    }

    async function pingWithTimeout(targetId) {
        let timeout;

        try {
            const result = await Promise.race([
                room.ping(targetId),

                new Promise(resolve => {
                    timeout = setTimeout(
                        () => resolve(null),
                        PING_TIMEOUT
                    );
                })
            ]);

            return Number.isFinite(result)
                ? result
                : null;
        } catch {
            return null;
        } finally {
            clearTimeout(timeout);
        }
    }

    async function measurePing() {
        if (left || pingInFlight) return;

        pingInFlight = true;

        try {
            const ids = getUserIds();
            const active = new Set(ids);

            for (const id of [...peerPings.keys()]) {
                if (!active.has(id)) {
                    peerPings.delete(id);
                }
            }

            if (!ids.length) {
                publishPing();
                return;
            }

            const results = await Promise.all(
                ids.map(async targetId => ({
                    targetId,
                    rtt: await pingWithTimeout(targetId)
                }))
            );

            if (left) return;

            const stillActive = new Set(getUserIds());

            for (const result of results) {
                if (!stillActive.has(result.targetId)) {
                    peerPings.delete(result.targetId);
                } else if (Number.isFinite(result.rtt)) {
                    peerPings.set(result.targetId, {
                        rtt: result.rtt,
                        at: performance.now()
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

    function electionCandidate(excludedId = null) {
        return [
            userId,
            ...getUserIds().filter(id => id !== excludedId)
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
        if (left || roomMeta.hostId !== userId) return;

        metaAction.send({
            type: 'meta',
            hostId: userId,
            mapId: roomMeta.mapId
        }).catch(() => {});

        publishMeta();
    }

    function requestHost() {
        if (left || roomMeta.hostId) return;

        metaAction.send({
            type: 'who-host'
        }).catch(() => {});
    }

    function electHost(excludedId) {
        if (left) return;

        if (electionCandidate(excludedId) !== userId) {
            return;
        }

        roomMeta = {
            ...roomMeta,
            hostId: userId
        };

        announceMeta();
    }

    function acceptMeta(data, fromId) {
        if (
            !data ||
            data.hostId !== fromId ||
            typeof data.hostId !== 'string'
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

        const validHost =
            fromId === roomMeta.hostId ||
            (
                !roomMeta.hostId &&
                fromId === electionCandidate()
            ) ||
            (
                hostHasLeft &&
                fromId === electionCandidate(roomMeta.hostId)
            );

        if (!validHost) return;

        roomMeta = {
            hostId: data.hostId,
            mapId: typeof data.mapId === 'string'
                ? data.mapId
                : roomMeta.mapId
        };

        publishMeta();
    }

    metaAction.onMessage((data, context) => {
        if (left || !data || context.userId === userId) return;

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

        if (![data.x, data.y, data.vx, data.vy]
            .every(Number.isFinite)) {
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
    // USER JOIN / LEAVE
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
    });

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

    // Individual connection events.
    if (typeof room.onPeerJoin === 'function') {
        room.onPeerJoin(({ userId: peerUserId, peerId }) => {
            if (left) return;

            callbacks.onPeerConnection?.({
                userId: peerUserId,
                peerId,
                connected: true
            });

            setTimeout(() => {
                if (!left) measurePing();
            }, 250);
        });
    }

    if (typeof room.onPeerLeave === 'function') {
        room.onPeerLeave(({ userId: peerUserId, peerId }) => {
            if (left) return;

            callbacks.onPeerConnection?.({
                userId: peerUserId,
                peerId,
                connected: false
            });
        });
    }

    // ========================================================
    // INITIALIZATION
    // ========================================================

    if (create) {
        roomMeta.hostId = userId;
        announceMeta();
    } else {
        requestHost();
    }

    publishRoster();
    publishPing();

    discoveryTimer = setInterval(() => {
        if (!roomMeta.hostId) {
            requestHost();
        } else {
            clearInterval(discoveryTimer);
            discoveryTimer = null;
        }
    }, 1500);

    metaTimer = setInterval(() => {
        if (roomMeta.hostId === userId) {
            announceMeta();
        }
    }, 8000);

    pingTimer = setInterval(
        measurePing,
        PING_INTERVAL
    );

    setTimeout(() => {
        if (!left) measurePing();
    }, 700);

    // ========================================================
    // LATEST-STATE SENDING
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
                    console.warn('State send failed:', error);
                }
            }
        } finally {
            stateSending = false;

            if (!left && queuedState !== null) {
                void flushStateQueue();
            }
        }
    }

    function sendState(snapshot) {
        if (left) return;

        queuedState = snapshot;
        void flushStateQueue();
    }

    // ========================================================
    // PUBLIC NETWORK API
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
            return getUserIds().length;
        },

        getPing() {
            const now = performance.now();

            const values = [...peerPings.values()]
                .filter(item => now - item.at < 12000)
                .map(item => item.rtt);

            if (!values.length) return null;

            return values.reduce((a, b) => a + b, 0) / values.length;
        },

        sendState,

        sendEvent(event) {
            if (!left) {
                eventAction.send(event).catch(() => {});
            }
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
            }).catch(() => {});

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
            }).catch(() => {});

            return true;
        },

        updateProfile(nextProfile) {
            if (left) return;

            currentProfile = {
                name: String(nextProfile?.name || 'Player')
                    .trim()
                    .slice(0, 18) || 'Player',

                color: /^#[0-9a-f]{6}$/i.test(nextProfile?.color)
                    ? nextProfile.color
                    : '#72e4c5'
            };

            Promise.resolve(
                presence.set(currentProfile)
            ).catch(error => console.warn(error));

            publishRoster();
        },

        async leave() {
            if (left) return;

            left = true;

            if (pingTimer) clearInterval(pingTimer);
            if (metaTimer) clearInterval(metaTimer);
            if (discoveryTimer) clearInterval(discoveryTimer);

            pingTimer = null;
            metaTimer = null;
            discoveryTimer = null;

            peerPings.clear();
            queuedState = null;

            try {
                await room.leave();
            } catch (error) {
                console.warn('Room leave failed:', error);
            }
        }
    };
}
