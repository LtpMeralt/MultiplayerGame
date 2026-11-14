
import { joinRoom } from 'https://esm.run/@trystero-p2p/firebase@0.27.0';

const FIREBASE_DATABASE_URL =
    'https://multiplayergame-70906-default-rtdb.europe-west1.firebasedatabase.app';

const APP_ID = FIREBASE_DATABASE_URL;
const FIREBASE_PATH = '__trystero__';
const MAX_PLAYERS = 32;

export async function connectRoom({
    code,
    password = '',
    profile,
    create = false,
    callbacks = {}
}) {
    const roomId = `multiplayer-game-${String(code).trim().toLowerCase()}`;

    const config = {
        appId: APP_ID,
        maxUsers: MAX_PLAYERS,
        relayConfig: {
            firebasePath: FIREBASE_PATH
        }
    };

    if (password) config.password = password;

    const room = joinRoom(config, roomId);

    let left = false;
    let metaHeartbeat = null;
    let pingHeartbeat = null;
    let pingInFlight = false;

    let stateInFlight = false;
    let queuedState = null;

    const peerPings = new Map();

    room.onError(error => {
        let message = error?.message || error?.code || 'Unknown room error';

        if (error?.code === 'decrypt-failed') {
            message = 'Wrong room password.';
        } else if (error?.code === 'peer-connect-failed') {
            message = error?.turnConfigured
                ? 'Peer connection failed. Check the other player’s network.'
                : 'Players found, but this network may require a TURN relay.';
        } else if (error?.code === 'relay-failed') {
            message = 'Firebase signaling failed. Check Realtime Database rules.';
        } else if (error?.code === 'room-full') {
            message = `Room is full. Maximum: ${MAX_PLAYERS} players.`;
        }

        callbacks.onStatus?.(message);
        callbacks.onError?.(error);
    });

    const { userId } = await room.getSelf();

    const presence = room.makeUserState('player-profile', {
        name: 'Player',
        color: '#72e4c5'
    });

    presence.set({
        name: profile.name,
        color: profile.color
    });

    const stateAction = room.makeAction('orb-state');
    const eventAction = room.makeAction('orb-event');
    const metaAction = room.makeAction('orb-meta');

    let roomMeta = {
        hostId: create ? userId : null,
        mapId: 'default'
    };

    function getUserIds() {
        return Object.keys(room.getUsers?.() || {});
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
        if (!left) callbacks.onRoster?.(getRoster());
    }

    function publishMeta() {
        callbacks.onMeta?.({
            ...roomMeta,
            isHost: roomMeta.hostId === userId
        });
    }

    function publishPing() {
        const values = [...peerPings.values()].filter(Number.isFinite);

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

    // Use Trystero's built-in RTT measurement.
    async function measurePing() {
        if (left || pingInFlight) return;

        pingInFlight = true;

        try {
            const userIds = getUserIds();
            const activeUsers = new Set(userIds);

            for (const id of [...peerPings.keys()]) {
                if (!activeUsers.has(id)) {
                    peerPings.delete(id);
                }
            }

            if (!userIds.length) {
                publishPing();
                return;
            }

            const results = await Promise.all(
                userIds.map(async targetId => {
                    try {
                        const rtt = await room.ping(targetId);
                        return [targetId, Number(rtt)];
                    } catch {
                        return [targetId, null];
                    }
                })
            );

            if (left) return;

            for (const [targetId, rtt] of results) {
                if (Number.isFinite(rtt) && rtt >= 0) {
                    peerPings.set(targetId, rtt);
                }
            }

            publishPing();
        } finally {
            pingInFlight = false;
        }
    }

    function announceMeta() {
        if (left || roomMeta.hostId !== userId) return;

        metaAction.send({
            type: 'meta',
            hostId: roomMeta.hostId,
            mapId: roomMeta.mapId
        }).catch(() => {});

        publishMeta();
    }

    function acceptMeta(data, fromId) {
        if (!data || typeof data.hostId !== 'string') return;

        const users = room.getUsers?.() || {};

        const hostIsPresent =
            roomMeta.hostId === userId ||
            Boolean(users[roomMeta.hostId]);

        const currentHostLeft =
            Boolean(roomMeta.hostId) && !hostIsPresent;

        const isCurrentHost = fromId === roomMeta.hostId;

        const isSelfPromoting =
            data.hostId === fromId && currentHostLeft;

        const firstHostClaim =
            !roomMeta.hostId && data.hostId === fromId;

        if (!isCurrentHost && !isSelfPromoting && !firstHostClaim) {
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

    // Replay existing profiles too, not only future changes.
    presence.onChange(() => publishRoster(), {
        replay: true
    });

    stateAction.onMessage((data, context) => {
        if (!data || context.userId === userId) return;

        callbacks.onPlayerState?.(context.userId, data);
    });

    eventAction.onMessage((data, context) => {
        if (!data || context.userId === userId) return;

        callbacks.onEvent?.(data, context.userId);
    });

    metaAction.onMessage((data, context) => {
        if (data?.type === 'who-host') {
            if (roomMeta.hostId === userId) {
                metaAction.send({
                    type: 'meta',
                    hostId: roomMeta.hostId,
                    mapId: roomMeta.mapId
                }, {
                    target: context.userId
                }).catch(() => {});
            }

            return;
        }

        if (data?.type === 'meta') {
            acceptMeta(data, context.userId);
        }
    });

    room.onUserJoin(({ userId: joinedUserId }) => {
        publishRoster();

        callbacks.onUserJoin?.(joinedUserId);

        if (roomMeta.hostId === userId) {
            announceMeta();
        }

        setTimeout(measurePing, 250);
    }, {
        replay: true
    });

    room.onUserLeave(({ userId: leavingUserId }) => {
        callbacks.onUserLeave?.(leavingUserId);

        peerPings.delete(leavingUserId);

        setTimeout(() => {
            if (left) return;

            publishRoster();
            publishPing();

            if (roomMeta.hostId === leavingUserId) {
                const candidates = [
                    userId,
                    ...getUserIds()
                ].sort();

                if (candidates[0] === userId) {
                    roomMeta = {
                        ...roomMeta,
                        hostId: userId
                    };

                    announceMeta();
                }
            }
        }, 0);
    });

    room.onPeerJoin(({ userId: joinedUserId, peerId }) => {
        callbacks.onPeerConnection?.({
            userId: joinedUserId,
            peerId,
            connected: true
        });

        setTimeout(measurePing, 200);
    }, {
        replay: true
    });

    room.onPeerLeave(({ userId: leftUserId, peerId }) => {
        callbacks.onPeerConnection?.({
            userId: leftUserId,
            peerId,
            connected: false
        });
    });

    if (create) {
        announceMeta();
    } else {
        metaAction.send({
            type: 'who-host'
        }).catch(() => {});
    }

    publishRoster();
    publishPing();

    pingHeartbeat = setInterval(measurePing, 3000);
    setTimeout(measurePing, 700);

    metaHeartbeat = setInterval(() => {
        if (roomMeta.hostId === userId) {
            announceMeta();
        }
    }, 8000);

    // Coalesce state updates instead of allowing a slow peer
    // to create an ever-growing queue of outdated positions.
    function sendLatestState(snapshot) {
        if (left) return;

        queuedState = snapshot;

        if (stateInFlight) return;

        stateInFlight = true;

        const pump = () => {
            if (left || !queuedState) {
                stateInFlight = false;
                return;
            }

            const next = queuedState;
            queuedState = null;

            stateAction.send(next)
                .catch(() => {})
                .finally(() => {
                    if (queuedState && !left) {
                        pump();
                    } else {
                        stateInFlight = false;
                    }
                });
        };

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

        getMeta: () => ({ ...roomMeta }),

        getPeerCount: () => getUserIds().length,

        getPing: () => {
            const values = [...peerPings.values()].filter(Number.isFinite);

            return values.length
                ? values.reduce((a, b) => a + b, 0) / values.length
                : null;
        },

        sendState(snapshot) {
            sendLatestState(snapshot);
        },

        sendEvent(event) {
            if (!left) {
                eventAction.send(event).catch(() => {});
            }
        },

        setMap(mapId) {
            if (roomMeta.hostId !== userId) return false;

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
            if (roomMeta.hostId !== userId) return false;

            eventAction.send({
                type: 'reset'
            }).catch(() => {});

            return true;
        },

        updateProfile(nextProfile) {
            profile = {
                name: nextProfile.name,
                color: nextProfile.color
            };

            presence.set(profile);
            publishRoster();
        },

        async leave() {
            if (left) return;

            left = true;

            if (metaHeartbeat) clearInterval(metaHeartbeat);
            if (pingHeartbeat) clearInterval(pingHeartbeat);

            peerPings.clear();
            queuedState = null;

            await room.leave();
        }
    };
}
