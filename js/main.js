import { initProfileStore } from './firebase.js';
import { connectRoom } from './network.js';
import { FIXED_DT, SIMULATION_HZ, predictTrajectory, stepBody } from './physics.js';
import { normalizeMap, drawMap } from './objects.js';
import { LocalPlayer, RemotePlayer, drawPlayer } from './player.js';
import { getMap } from './maps.js';

const $ = id => document.getElementById(id);
const ui = {
  lobby: $('lobbyScreen'), game: $('gameScreen'),
  username: $('usernameInput'), color: $('colorInput'), avatar: $('avatarPreview'),
  saveProfile: $('saveProfileButton'), saveStatus: $('saveStatus'),
  createPassword: $('createPasswordInput'), publicRoom: $('publicRoomInput'), roomCode: $('roomCodeInput'), joinPassword: $('joinPasswordInput'),
  publicRoomList: $('publicRoomList'), refreshRooms: $('refreshRoomsButton'),
  createRoom: $('createRoomButton'), joinRoom: $('joinRoomButton'), solo: $('soloButton'),
  lobbyMessage: $('lobbyMessage'), connectionDot: $('connectionDot'), connectionText: $('connectionText'),
  leave: $('leaveRoomButton'), activeCode: $('activeRoomCode'), copyInvite: $('copyInviteButton'), hostBadge: $('hostBadge'),
  mapName: $('mapName'), playerCount: $('playerCount'), rosterCount: $('rosterCount'), roster: $('playerRoster'),
  hostPanel: $('hostPanel'), mapSelect: $('mapSelect'), resetRound: $('resetRoundButton'),
  networkStatus: $('networkStatus'), canvas: $('gameCanvas'), canvasWrap: $('canvasWrap'), canvasHint: $('canvasHint'), toast: $('toast')
};

const DEFAULT_PROFILE = { name: 'Player', color: '#72e4c5' };
let profile = readLocalProfile();
let profileStore = null;
let publicRoomsUnsubscribe = null;
let publicRoomHeartbeat = null;
let activeRoomIsPublic = false;
let network = null;
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
let aimPointer = { x: 0, y: 0 };
let stateSendAccumulator = 0;
let simulationAccumulator = 0;
let lastFrameTime = 0;
let lastRenderTime = 0;
let animationStarted = false;
let tickCounter = 0;
let toastTimeout = null;
let dpr = 1;

syncProfileFields();

// Start Firebase in the background so the local test still opens when Firebase
// has not been configured yet. LocalStorage is always used as an offline fallback.
bootProfileStore();

ui.username.addEventListener('input', () => updateAvatarPreview());
ui.color.addEventListener('input', () => updateAvatarPreview());
ui.saveProfile.addEventListener('click', saveProfile);
ui.createRoom.addEventListener('click', () => handleRoomEntry(true));
ui.joinRoom.addEventListener('click', () => handleRoomEntry(false));
ui.solo.addEventListener('click', () => startLocalGame());
ui.leave.addEventListener('click', leaveRoom);
ui.copyInvite.addEventListener('click', copyInvite);
ui.resetRound.addEventListener('click', hostResetRound);
ui.mapSelect.addEventListener('change', () => hostChangeMap(ui.mapSelect.value));
ui.roomCode.addEventListener('input', () => { ui.roomCode.value = ui.roomCode.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12); });
ui.refreshRooms?.addEventListener('click', refreshPublicRooms);

ui.canvas.addEventListener('pointerdown', onPointerDown);
ui.canvas.addEventListener('pointermove', onPointerMove);
ui.canvas.addEventListener('pointerup', onPointerUp);
ui.canvas.addEventListener('pointercancel', onPointerCancel);
ui.canvas.addEventListener('contextmenu', event => event.preventDefault());
window.addEventListener('keydown', onKeyDown);
window.addEventListener('resize', resizeCanvas);
window.addEventListener('beforeunload', () => { network?.leave?.(); });

async function bootProfileStore() {
  try {
    profileStore = await initProfileStore();
    if (profileStore.ready) {
      startPublicRoomBrowser();
      const cloudProfile = await profileStore.loadProfile();
      if (cloudProfile && !localStorage.getItem('trajectoryLabProfile')) {
        profile = sanitizeProfile(cloudProfile);
        writeLocalProfile(profile);
        syncProfileFields();
      }
      ui.saveStatus.textContent = 'Cloud profile connected';
    } else {
      ui.saveStatus.textContent = 'Saved on this device';
    }
  } catch (error) {
    console.warn(error);
    ui.saveStatus.textContent = 'Saved on this device';
  }
}

async function saveProfile() {
  profile = sanitizeProfile({ name: ui.username.value, color: ui.color.value });
  syncProfileFields();
  writeLocalProfile(profile);
  localPlayer?.updateProfile(profile);
  network?.updateProfile(profile);
  ui.saveStatus.textContent = 'Saving…';
  if (profileStore?.ready) {
    try {
      await profileStore.saveProfile(profile);
      ui.saveStatus.textContent = 'Saved to Firebase';
    } catch (error) {
      console.warn('Firebase profile save failed:', error);
      ui.saveStatus.textContent = 'Saved locally · cloud unavailable';
    }
  } else {
    ui.saveStatus.textContent = 'Saved on this device';
  }
  showToast('Profile saved');
  renderRoster();
}

async function handleRoomEntry(create, requestedCode = null, requestedPassword = null) {
  profile = sanitizeProfile({ name: ui.username.value, color: ui.color.value });
  writeLocalProfile(profile);
  network?.leave?.();
  network = null;

  const code = create ? makeRoomCode() : String(requestedCode || ui.roomCode.value).trim().toUpperCase();
  const password = create ? ui.createPassword.value : (requestedPassword ?? ui.joinPassword.value);
  activeRoomIsPublic = create && Boolean(ui.publicRoom?.checked);
  if (!create && code.length < 4) {
    setLobbyMessage('Enter a room code with at least 4 characters.', true);
    return;
  }

  ui.createRoom.disabled = true;
  ui.joinRoom.disabled = true;
  setLobbyMessage(create ? 'Creating your room…' : 'Joining room…');

  try {
    network = await connectRoom({
      code,
      password,
      profile,
      create,
      callbacks: {
        onRoster: handleRoster,
        onPlayerState: handlePlayerState,
        onUserLeave: userId => remotePlayers.delete(userId),
        onEvent: handleRoomEvent,
        onMeta: handleRoomMeta,
        onStatus: message => { ui.networkStatus.textContent = message; showToast(message); }
      }
    });
    roomCode = code;
    roomPassword = password;
    roomMode = 'online';
    roomIsHost = network.isHost;
    lastHostId = network.hostId;
    startGameScreen();
    setConnectionState('CONNECTING', false);
    ui.networkStatus.textContent = 'Waiting for peers…';
    setLobbyMessage('Connected to the room.', false, true);
    showToast(create ? `Room ${code} created` : `Joined room ${code}`);
    if (create) {
      network.setMap('default');
      if (activeRoomIsPublic) startPublicRoomHeartbeat();
    } else {
      // The host sends its room metadata when a peer asks who is hosting.
      setTimeout(() => {
        if (network) ui.networkStatus.textContent = Object.keys(network.getRoster()).length > 1 ? 'Peer connection starting…' : 'Waiting for host…';
      }, 900);
    }
  } catch (error) {
    console.error('Room connection failed:', error);
    setLobbyMessage(`Could not join the room: ${error.message || 'connection failed'}`, true);
    network?.leave?.();
    network = null;
  } finally {
    ui.createRoom.disabled = false;
    ui.joinRoom.disabled = false;
  }
}

function startPublicRoomBrowser() {
  if (!profileStore?.ready || !profileStore.watchPublicRooms || publicRoomsUnsubscribe) return;
  publicRoomsUnsubscribe = profileStore.watchPublicRooms(renderPublicRooms, error => {
    console.warn('Public room browser unavailable:', error);
    if (ui.publicRoomList) ui.publicRoomList.innerHTML = '<div class="room-empty">Room browser unavailable. Check Firestore rules.</div>';
  });
}

function refreshPublicRooms() {
  if (ui.publicRoomList) ui.publicRoomList.innerHTML = '<div class="room-empty">Refreshing…</div>';
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
    empty.textContent = 'No public rooms right now. Make one and tick the public option!';
    ui.publicRoomList.append(empty);
    return;
  }
  for (const room of rooms) {
    const item = document.createElement('div');
    item.className = 'public-room-item';
    const info = document.createElement('div');
    info.className = 'public-room-info';
    const name = document.createElement('strong');
    name.textContent = room.name || `${room.hostName || 'Player'}’s room`;
    const meta = document.createElement('span');
    meta.textContent = `${room.code} · ${room.players || 1} player${room.players === 1 ? '' : 's'}${room.hasPassword ? ' · 🔒' : ''}`;
    info.append(name, meta);
    const join = document.createElement('button');
    join.type = 'button';
    join.className = 'button button-quiet room-join-button';
    join.textContent = 'Join';
    join.addEventListener('click', () => {
      const password = room.hasPassword ? window.prompt('This room needs a password:') : '';
      if (password === null) return;
      ui.roomCode.value = room.code;
      ui.joinPassword.value = password;
      handleRoomEntry(false, room.code, password);
    });
    item.append(info, join);
    ui.publicRoomList.append(item);
  }
}

async function publishCurrentPublicRoom() {
  if (!profileStore?.ready || !activeRoomIsPublic || !network?.isHost) return;
  await profileStore.publishRoom({
    code: roomCode,
    name: `${profile.name}’s room`,
    hostName: profile.name,
    players: Math.max(1, Object.keys(network.getRoster()).length),
    hasPassword: Boolean(roomPassword)
  });
}

function startPublicRoomHeartbeat() {
  stopPublicRoomHeartbeat(false);
  publishCurrentPublicRoom().catch(error => console.warn('Could not publish room:', error));
  publicRoomHeartbeat = setInterval(() => {
    publishCurrentPublicRoom().catch(error => console.warn('Could not refresh room listing:', error));
  }, 30000);
}

function stopPublicRoomHeartbeat(removeListing) {
  if (publicRoomHeartbeat) clearInterval(publicRoomHeartbeat);
  publicRoomHeartbeat = null;
  if (removeListing && activeRoomIsPublic && profileStore?.ready) {
    profileStore.removeRoom(roomCode).catch(error => console.warn('Could not remove public room:', error));
  }
  activeRoomIsPublic = false;
}

function startLocalGame() {
  network?.leave?.();
  network = null;
  profile = sanitizeProfile({ name: ui.username.value, color: ui.color.value });
  writeLocalProfile(profile);
  roomMode = 'local';
  roomCode = 'LOCAL';
  roomPassword = '';
  roomIsHost = true;
  lastHostId = null;
  remotePlayers.clear();
  profiles = {};
  currentMap = normalizeMap(getMap('default'));
  startGameScreen();
  setConnectionState('LOCAL MODE', false);
  ui.networkStatus.textContent = 'Local physics test';
  showToast('Local physics test started');
}

function startGameScreen() {
  ui.lobby.classList.add('hidden');
  ui.game.classList.remove('hidden');
  ui.activeCode.textContent = roomCode;
  ui.canvasHint.classList.remove('dismissed');
  const requestedMapId = network?.getMeta?.().mapId || 'default';
  currentMap = normalizeMap(getMap(requestedMapId));
  localPlayer = new LocalPlayer(network?.userId || `local-${makeRoomCode()}`, profile, currentMap.spawn);
  remotePlayers.clear();
  if (network) handleRoster(network.getRoster());
  applyHostUI();
  updateMapUI();
  resizeCanvas();
  renderRoster();
  startAnimationLoop();
}

async function leaveRoom() {
  stopPublicRoomHeartbeat(true);
  if (network) {
    try { await network.leave(); } catch (error) { console.warn(error); }
  }
  network = null;
  remotePlayers.clear();
  profiles = {};
  isAiming = false;
  localPlayer = null;
  ui.game.classList.add('hidden');
  ui.lobby.classList.remove('hidden');
  setConnectionState('LOCAL MODE', false);
  setLobbyMessage('Create a room or join with a room code.');
}

function handleRoster(roster) {
  profiles = roster || {};
  for (const [userId, playerProfile] of Object.entries(profiles)) {
    if (userId === network?.userId) continue;
    let remote = remotePlayers.get(userId);
    if (!remote) {
      remote = new RemotePlayer(userId, playerProfile);
      remotePlayers.set(userId, remote);
    }
    remote.updateProfile(playerProfile || {});
  }
  for (const userId of [...remotePlayers.keys()]) {
    if (!(userId in profiles)) remotePlayers.delete(userId);
  }
  renderRoster();
  const count = Object.keys(profiles).length || 1;
  if (activeRoomIsPublic && network?.isHost) publishCurrentPublicRoom().catch(error => console.warn('Public room update failed:', error));
  ui.networkStatus.textContent = count > 1 ? `${count} players in room` : (network ? 'Waiting for players…' : 'Local physics test');
  if (roomMode === 'online') setConnectionState(count > 1 ? 'PEER CONNECTED' : 'WAITING FOR PEERS', count > 1);
}

function handlePlayerState(userId, snapshot) {
  let remote = remotePlayers.get(userId);
  if (!remote) {
    remote = new RemotePlayer(userId, profiles[userId] || {});
    remotePlayers.set(userId, remote);
  }
  remote.pushSnapshot(snapshot, performance.now());
}

function handleRoomMeta(meta) {
  const previousHostId = lastHostId;
  lastHostId = meta.hostId;
  roomIsHost = Boolean(meta.isHost);
  applyHostUI();
  if (meta.mapId && meta.mapId !== currentMap.id) {
    currentMap = normalizeMap(getMap(meta.mapId));
    localPlayer?.reset(currentMap.spawn);
    updateMapUI();
    resizeCanvas();
  }
  if (previousHostId && previousHostId !== meta.hostId) {
    showToast(roomIsHost ? 'You are now the host' : 'Room host changed');
  }
}

// loop through all other players and resolve overlaps + bounce
const allPlayers = getRoster(); // or your active player positions map
for (const [id, pData] of Object.entries(allPlayers)) {
  if (id === localUserId) continue;
  const remoteBall = remotePlayerPositions[id];
  if (!remoteBall) continue;

  const dx = remoteBall.x - localBall.x;
  const dy = remoteBall.y - localBall.y;
  const dist = Math.hypot(dx, dy);
  const minDist = localBall.radius + remoteBall.radius;

  if (dist < minDist && dist > 0) {
    const overlap = minDist - dist;
    const nx = dx / dist;
    const ny = dy / dist;

    // Separate them so they don't stick
    localBall.x -= nx * overlap * 0.5;
    localBall.y -= ny * overlap * 0.5;

    // Simple elastic velocity swap/bounce response
    const kx = localBall.vx - remoteBall.vx;
    const ky = localBall.vy - remoteBall.vy;
    const p = 2 * (nx * kx + ny * ky) / 2;

    localBall.vx -= p * nx * 0.8;
    localBall.vy -= p * ny * 0.8;
  }
}

function handleRoomEvent(event, senderId) {
  if (event.type === 'reset' && senderId === lastHostId) {
    localPlayer?.reset(currentMap.spawn);
    isAiming = false;
    ui.canvasHint.classList.remove('dismissed');
    showToast('Host reset the round');
  }
  if (event.type === 'map' && senderId === lastHostId && typeof event.mapId === 'string') {
    currentMap = normalizeMap(getMap(event.mapId));
    localPlayer?.reset(currentMap.spawn);
    updateMapUI();
    resizeCanvas();
    showToast(`Map changed to ${currentMap.name}`);
  }
}

function applyHostUI() {
  ui.hostBadge.textContent = roomIsHost ? 'HOST' : 'PLAYER';
  ui.hostBadge.classList.toggle('host-badge', roomIsHost);
  ui.hostPanel.classList.toggle('disabled', !roomIsHost);
  ui.mapSelect.disabled = !roomIsHost;
  ui.resetRound.disabled = !roomIsHost;
  ui.mapSelect.value = currentMap.id;
}

function hostResetRound() {
  if (roomMode === 'online' && !roomIsHost) return;
  localPlayer?.reset(currentMap.spawn);
  isAiming = false;
  ui.canvasHint.classList.remove('dismissed');
  if (network) network.resetRound();
  showToast('Round reset');
}

function hostChangeMap(mapId) {
  if (roomMode === 'online' && !roomIsHost) {
    ui.mapSelect.value = currentMap.id;
    return;
  }
  currentMap = normalizeMap(getMap(mapId));
  localPlayer?.reset(currentMap.spawn);
  updateMapUI();
  resizeCanvas();
  if (network) network.setMap(mapId);
  showToast(`Loaded ${currentMap.name}`);
}

function updateMapUI() {
  ui.mapName.textContent = currentMap.name.toUpperCase();
  ui.mapSelect.value = currentMap.id;
  ui.activeCode.textContent = roomCode;
  applyHostUI();
}

function renderRoster() {
  if (!ui.roster) return;
  ui.roster.replaceChildren();
  const roster = network ? network.getRoster() : { [localPlayer?.userId || 'local']: profile };
  const entries = Object.entries(roster || {});
  if (entries.length === 0) entries.push([localPlayer?.userId || 'local', profile]);
  entries.sort(([idA], [idB]) => idA === (network?.userId || localPlayer?.userId) ? -1 : idB === (network?.userId || localPlayer?.userId) ? 1 : 0);

  for (const [userId, item] of entries) {
    const isMe = userId === (network?.userId || localPlayer?.userId);
    const wrapper = document.createElement('div');
    wrapper.className = 'roster-item';
    const ball = document.createElement('span');
    ball.className = 'roster-ball';
    ball.style.background = item.color || '#91a0b2';
    ball.style.color = item.color || '#91a0b2';
    const name = document.createElement('span');
    name.className = 'roster-name';
    name.textContent = `${item.name || 'Player'}${isMe ? ' (you)' : ''}`;
    const role = document.createElement('span');
    role.className = 'roster-role';
    role.textContent = userId === lastHostId || (roomMode === 'local' && isMe) ? 'HOST' : '';
    wrapper.append(ball, name, role);
    ui.roster.append(wrapper);
  }
  const count = entries.length;
  ui.rosterCount.textContent = String(count).padStart(2, '0');
  ui.playerCount.textContent = `${count} PLAYER${count === 1 ? '' : 'S'}`;
}

function onPointerDown(event) {
  if (!localPlayer || ui.game.classList.contains('hidden')) return;
  const point = canvasToWorld(event);
  const body = localPlayer.body;
  const distance = Math.hypot(point.x - body.x, point.y - body.y);
  if (distance > body.radius * 2.3) return;
  isAiming = true;
  aimPointer = point;
  ui.canvas.setPointerCapture?.(event.pointerId);
  ui.canvasHint.classList.add('dismissed');
  event.preventDefault();
}

function onPointerMove(event) {
  if (!isAiming) return;
  aimPointer = canvasToWorld(event);
  event.preventDefault();
}

function onPointerUp(event) {
  if (!isAiming || !localPlayer) return;
  aimPointer = canvasToWorld(event);
  const velocity = getAimVelocity(localPlayer.body, aimPointer);
  if (Math.hypot(velocity.x, velocity.y) > 35) {
    localPlayer.launch(velocity.x, velocity.y);
    showToast('Launched');
  }
  isAiming = false;
  event.preventDefault();
}

function onPointerCancel() {
  isAiming = false;
}

function getAimVelocity(body, pointer) {
  const dx = body.x - pointer.x;
  const dy = body.y - pointer.y;
  const pullLength = Math.hypot(dx, dy);
  const limited = Math.min(pullLength, 310);
  const scale = pullLength > 0 ? (limited / pullLength) * 4.25 : 0;
  return { x: dx * scale, y: dy * scale };
}

function onKeyDown(event) {
  if (!localPlayer || ui.game.classList.contains('hidden') || isTypingTarget(event.target)) return;
  const key = event.key.toLowerCase();
  if (key === 'w' || key === 'arrowup') {
    event.preventDefault();
    if (!event.repeat) {
      localPlayer.launch(localPlayer.body.vx, -820);
      ui.canvasHint.classList.add('dismissed');
    }
  } else if (key === 'a' || key === 'arrowleft') {
    localPlayer.body.vx -= 235;
  } else if (key === 'd' || key === 'arrowright') {
    localPlayer.body.vx += 235;
  } else if (key === 'r') {
    hostResetRound();
  }
}

function isTypingTarget(target) {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

function canvasToWorld(event) {
  const rect = ui.canvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) * (currentMap.width / rect.width);
  const y = (event.clientY - rect.top) * (currentMap.height / rect.height);
  return { x, y };
}

function resizeCanvas() {
  if (!ui.canvas) return;
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = currentMap.width;
  const height = currentMap.height;
  if (ui.canvas.width !== Math.round(width * dpr) || ui.canvas.height !== Math.round(height * dpr)) {
    ui.canvas.width = Math.round(width * dpr);
    ui.canvas.height = Math.round(height * dpr);
  }
}

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
  const elapsed = Math.min(0.1, Math.max(0, (now - lastFrameTime) / 1000));
  lastFrameTime = now;
  simulationAccumulator += elapsed;

  let steps = 0;
  while (simulationAccumulator >= FIXED_DT && steps < 8) {
    updateSimulation(FIXED_DT);
    simulationAccumulator -= FIXED_DT;
    steps += 1;
  }
  // Render at no more than 60 frames per second, even on high-refresh displays.
  if (now - lastRenderTime >= 1000 / SIMULATION_HZ - 0.4) {
    renderFrame(now);
    lastRenderTime = now;
  }
  requestAnimationFrame(frame);
}

function updateSimulation(dt) {
  if (!localPlayer) return;
  stepBody(localPlayer.body, currentMap, dt);
  if (localPlayer.body.y - localPlayer.body.radius > currentMap.height + 180) {
    localPlayer.reset(currentMap.spawn);
  }

  tickCounter += 1;
  if (network) {
    stateSendAccumulator += dt;
    if (stateSendAccumulator >= 1 / 20) {
      stateSendAccumulator = 0;
      network.sendState(localPlayer.snapshot());
    }
  }
}

function renderFrame(now) {
  const ctx = ui.canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, currentMap.width, currentMap.height);
  ctx.fillStyle = currentMap.background || '#101923';
  ctx.fillRect(0, 0, currentMap.width, currentMap.height);
  drawGrid(ctx);
  drawMap(ctx, currentMap);

  if (isAiming && localPlayer) drawAimPreview(ctx);
  for (const remote of remotePlayers.values()) {
    const position = remote.getVisualState(now);
    if (position) drawPlayer(ctx, remote, position, { local: false });
  }
  if (localPlayer) drawPlayer(ctx, localPlayer, localPlayer.body, { local: true, aiming: isAiming });
}

function drawGrid(ctx) {
  ctx.save();
  ctx.strokeStyle = 'rgba(178,198,218,.055)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= currentMap.width; x += 40) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, currentMap.height);
  }
  for (let y = 0; y <= currentMap.height; y += 40) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(currentMap.width, y + 0.5);
  }
  ctx.stroke();
  ctx.restore();
}

function drawAimPreview(ctx) {
  const body = localPlayer.body;
  const velocity = getAimVelocity(body, aimPointer);
  const pullDistance = Math.hypot(body.x - aimPointer.x, body.y - aimPointer.y);
  if (pullDistance < 3) return;
  const predictionBody = { ...body, vx: velocity.x, vy: velocity.y, onGround: false };
  const trajectory = predictTrajectory(predictionBody, currentMap, 150, 3);

  // The dotted line is generated by the exact same fixed-step collision and
  // gravity function used after release, rather than a separate visual guess.
  ctx.save();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(114,228,197,.64)';
  ctx.setLineDash([5, 7]);
  ctx.beginPath();
  trajectory.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.stroke();
  ctx.setLineDash([]);
  trajectory.forEach((point, index) => {
    if (index % 2 !== 0) return;
    const alpha = Math.max(0.1, 0.72 - index / trajectory.length * 0.65);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#a4f6df';
    ctx.beginPath();
    ctx.arc(point.x, point.y, Math.max(2, 4 - index / trajectory.length * 2), 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.globalAlpha = 1;

  ctx.strokeStyle = 'rgba(255,255,255,.55)';
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  ctx.moveTo(body.x, body.y);
  ctx.lineTo(aimPointer.x, aimPointer.y);
  ctx.stroke();
  ctx.fillStyle = '#edfef8';
  ctx.beginPath();
  ctx.arc(aimPointer.x, aimPointer.y, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function copyInvite() {
  const invite = `Multiplayer game room\nCode: ${roomCode}\nPassword: ${roomPassword || '(no password)'}`;
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(invite).then(() => showToast('Room invite copied')).catch(() => showToast(invite));
  } else {
    showToast('Clipboard unavailable. Room code: ' + roomCode);
  }
}

function setConnectionState(label, online) {
  ui.connectionText.textContent = label;
  ui.connectionDot.classList.toggle('online', online);
}

function setLobbyMessage(message, error = false, good = false) {
  ui.lobbyMessage.textContent = message;
  ui.lobbyMessage.classList.toggle('error', error);
  ui.lobbyMessage.classList.toggle('good', good);
}

function showToast(message) {
  ui.toast.textContent = message;
  ui.toast.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => ui.toast.classList.remove('show'), 2100);
}

function updateAvatarPreview() {
  const color = /^#[0-9a-f]{6}$/i.test(ui.color.value) ? ui.color.value : DEFAULT_PROFILE.color;
  ui.avatar.querySelector('span').style.background = color;
  ui.avatar.style.borderColor = `${color}66`;
  ui.avatar.style.background = `${color}14`;
}

function syncProfileFields() {
  ui.username.value = profile.name;
  ui.color.value = profile.color;
  updateAvatarPreview();
}

function sanitizeProfile(value) {
  const name = String(value.name || 'Player').trim().replace(/[<>\u0000-\u001f]/g, '').slice(0, 18) || 'Player';
  const color = /^#[0-9a-f]{6}$/i.test(value.color) ? value.color : DEFAULT_PROFILE.color;
  return { name, color };
}

function readLocalProfile() {
  try {
    const saved = JSON.parse(localStorage.getItem('trajectoryLabProfile') || 'null');
    return saved ? sanitizeProfile(saved) : { ...DEFAULT_PROFILE };
  } catch {
    return { ...DEFAULT_PROFILE };
  }
}

function writeLocalProfile(nextProfile) {
  try { localStorage.setItem('trajectoryLabProfile', JSON.stringify(nextProfile)); }
  catch (error) { console.warn('Could not save the local profile:', error); }
}

function makeRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return [...bytes].map(value => alphabet[value % alphabet.length]).join('');
}
