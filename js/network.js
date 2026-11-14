import { joinRoom } from 'https://esm.run/trystero?v=2';

const APP_ID = 'ltpmer-multiplayer-game-v1';

export async function connectRoom({ code, password = '', profile, create = false, callbacks = {} }) {
  const roomId = `multiplayer-game-${String(code).toLowerCase()}`;
  const config = { appId: APP_ID };
  if (password) config.password = password;

  const room = joinRoom(config, roomId);

  room.onError(error => {
    const message = error?.code === 'decrypt-failed'
      ? 'Wrong room password.'
      : error?.code === 'peer-connect-failed'
        ? 'Could not connect to a player. Their network may block peer connections.'
        : error?.message || error?.code || 'Unknown room error';
    callbacks.onStatus?.(message);
    callbacks.onError?.(error);
  });

  const { userId } = await room.getSelf();
  const presence = room.makeUserState('player-profile', {
    name: profile.name,
    color: profile.color
  });
  presence.set({ name: profile.name, color: profile.color });

  const stateAction = room.makeAction('orb-state');
  const eventAction = room.makeAction('orb-event');
  const metaAction = room.makeAction('orb-meta');
  const pingAction = room.makeAction('orb-ping');

  let roomMeta = {
    hostId: create ? userId : null,
    mapId: 'default'
  };
  let left = false;
  let pingSequence = 0;
  let pingHeartbeat = null;
  const pendingPings = new Map();
  const peerPings = new Map();

  const checkDuplicateName = incomingRoster => {
    const myLowerName = profile.name.trim().toLowerCase();
    for (const [id, data] of Object.entries(incomingRoster)) {
      if (id !== userId && data?.name?.trim().toLowerCase() === myLowerName) return true;
    }
    return false;
  };

  const getRoster = () => {
    const roster = presence.getAll() || {};
    return { ...roster, [userId]: { name: profile.name, color: profile.color } };
  };

  const publishRoster = () => {
    const roster = getRoster();
    if (checkDuplicateName(roster)) {
      callbacks.onStatus?.('Username already taken in this room.');
      room.leave();
      throw new Error('Username taken');
    }
    callbacks.onRoster?.(roster);
  };

  const publishMeta = () => callbacks.onMeta?.({ ...roomMeta, isHost: roomMeta.hostId === userId });

  const publishPing = () => {
    const values = [...peerPings.values()];
    if (!values.length) {
      callbacks.onPing?.({ average: null, min: null, max: null, peers: 0 });
      return;
    }
    const average = values.reduce((sum, value) => sum + value, 0) / values.length;
    callbacks.onPing?.({
      average,
      min: Math.min(...values),
      max: Math.max(...values),
      peers: values.length
    });
  };

  const sendPings = () => {
    if (left) return;
    const peers = room.getPeers();
    for (const peerId of peers) {
      const id = String(++pingSequence);
      const key = `${peerId}:${id}`;
      pendingPings.set(key, performance.now());
      pingAction.send({ type: 'ping', id }, { target: peerId }).catch(() => {
        pendingPings.delete(key);
      });
    }

    // Prevent old unanswered pings from accumulating after a peer disconnects.
    if (pendingPings.size > 64) pendingPings.clear();
    for (const peerId of [...peerPings.keys()]) {
      if (!peers.includes(peerId)) peerPings.delete(peerId);
    }
    publishPing();
  };

  pingAction.onMessage((data, context) => {
    if (!data || context.userId === userId) return;

    if (data.type === 'ping' && typeof data.id === 'string') {
      pingAction.send({ type: 'pong', id: data.id }, { target: context.userId }).catch(() => {});
      return;
    }

    if (data.type === 'pong' && typeof data.id === 'string') {
      const key = `${context.userId}:${data.id}`;
      const startedAt = pendingPings.get(key);
      if (startedAt === undefined) return;
      pendingPings.delete(key);
      peerPings.set(context.userId, Math.max(0, performance.now() - startedAt));
      publishPing();
    }
  });

  presence.onChange(() => publishRoster());

  stateAction.onMessage((data, context) => {
    if (!data || context.userId === userId) return;
    callbacks.onPlayerState?.(context.userId, data);
  });
  eventAction.onMessage((data, context) => {
    if (!data || context.userId === userId) return;
    callbacks.onEvent?.(data, context.userId);
  });

  function acceptMeta(data, fromId) {
    if (!data || typeof data.hostId !== 'string') return;
    const currentHostLeft = roomMeta.hostId && !room.getUsers()[roomMeta.hostId];
    const isCurrentHost = fromId === roomMeta.hostId;
    const isSelfPromoting = data.hostId === fromId && currentHostLeft;
    const firstHostClaim = !roomMeta.hostId && data.hostId === fromId;
    if (!isCurrentHost && !isSelfPromoting && !firstHostClaim) return;
    roomMeta = {
      hostId: data.hostId,
      mapId: typeof data.mapId === 'string' ? data.mapId : roomMeta.mapId
    };
    publishMeta();
  }

  metaAction.onMessage((data, context) => {
    if (data?.type === 'who-host') {
      if (roomMeta.hostId === userId) {
        metaAction.send({ type: 'meta', hostId: roomMeta.hostId, mapId: roomMeta.mapId }, { target: context.userId }).catch(() => {});
      }
      return;
    }
    if (data?.type === 'meta') acceptMeta(data, context.userId);
  });

  const announceMeta = () => {
    if (left || roomMeta.hostId !== userId) return;
    metaAction.send({ type: 'meta', hostId: roomMeta.hostId, mapId: roomMeta.mapId }).catch(() => {});
    publishMeta();
  };

  room.onUserJoin(peerId => {
    presence.set({ name: profile.name, color: profile.color });
    publishRoster();
    if (roomMeta.hostId === userId) announceMeta();
    sendPings();
  });

  room.onUserLeave(({ userId: leavingId }) => {
    publishRoster();
    callbacks.onUserLeave?.(leavingId);
    peerPings.delete(leavingId);
    for (const key of [...pendingPings.keys()]) {
      if (key.startsWith(`${leavingId}:`)) pendingPings.delete(key);
    }
    publishPing();
    if (roomMeta.hostId === leavingId) {
      const candidates = [userId, ...room.getPeers()].sort();
      if (candidates[0] === userId) {
        roomMeta = { ...roomMeta, hostId: userId };
        announceMeta();
      }
    }
  });

  if (create) announceMeta();
  else metaAction.send({ type: 'who-host' }).catch(() => {});

  pingHeartbeat = setInterval(sendPings, 1000);
  setTimeout(sendPings, 250);

  const heartbeat = setInterval(() => {
    if (roomMeta.hostId === userId) announceMeta();
    publishRoster();
  }, 2500);

  // Force an initial broadcast right after joining.
  setTimeout(() => {
    presence.set({ name: profile.name, color: profile.color });
    publishRoster();
  }, 300);

  return {
    userId,
    get hostId() { return roomMeta.hostId; },
    get isHost() { return roomMeta.hostId === userId; },
    getRoster,
    getMeta: () => ({ ...roomMeta }),
    getPing: () => {
      const values = [...peerPings.values()];
      return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    },
    sendState(snapshot) {
      if (!left) stateAction.send(snapshot).catch(() => {});
    },
    sendEvent(event) {
      if (!left) eventAction.send(event).catch(() => {});
    },
    setMap(mapId) {
      if (roomMeta.hostId !== userId) return false;
      roomMeta = { ...roomMeta, mapId };
      announceMeta();
      eventAction.send({ type: 'map', mapId }).catch(() => {});
      return true;
    },
    resetRound() {
      if (roomMeta.hostId !== userId) return false;
      eventAction.send({ type: 'reset' }).catch(() => {});
      return true;
    },
    updateProfile(nextProfile) {
      presence.set({ name: nextProfile.name, color: nextProfile.color });
      publishRoster();
    },
    async leave() {
      if (left) return;
      left = true;
      clearInterval(heartbeat);
      if (pingHeartbeat) clearInterval(pingHeartbeat);
      pendingPings.clear();
      peerPings.clear();
      await room.leave();
    }
  };
}
