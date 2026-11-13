import { joinRoom } from 'https://esm.run/@trystero-p2p/firebase';

const APP_ID = 'https://multiplayergame-70906-default-rtdb.europe-west1.firebasedatabase.app/:1';

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

  let roomMeta = {
    hostId: create ? userId : null,
    mapId: 'default'
  };
  let left = false;

  const getRoster = () => {
    const roster = presence.getAll() || {};
    return { ...roster, [userId]: { name: profile.name, color: profile.color } };
  };
  const publishRoster = () => callbacks.onRoster?.(getRoster());
  const publishMeta = () => callbacks.onMeta?.({ ...roomMeta, isHost: roomMeta.hostId === userId });

  presence.onChange(publishRoster);
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

  room.onUserJoin(() => {
    publishRoster();
    if (roomMeta.hostId === userId) announceMeta();
  });

  room.onUserLeave(({ userId: leavingId }) => {
    publishRoster();
    callbacks.onUserLeave?.(leavingId);
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

  const heartbeat = setInterval(() => {
    if (roomMeta.hostId === userId) announceMeta();
    publishRoster();
  }, 2500);

  return {
    userId,
    get hostId() { return roomMeta.hostId; },
    get isHost() { return roomMeta.hostId === userId; },
    getRoster,
    getMeta: () => ({ ...roomMeta }),
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
      await room.leave();
    }
  };
}
