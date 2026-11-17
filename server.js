const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const { randomUUID } = require('node:crypto');
const flightEngine = import('./public/aeroplane/shared/engine.mjs');

const PORT = Number(process.env.PORT || 3007);
const ROOT = path.join(__dirname, 'public');
const rooms = new Map();
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.wav': 'audio/wav' };

const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const aeroplaneRoutes = {
    '/aeroplane': '/aeroplane/index.html',
    '/aeroplane/': '/aeroplane/index.html',
    '/aeroplane/game': '/aeroplane/game.html',
    '/aeroplane/stats': '/aeroplane/stats.html',
    '/aeroplane/replay': '/aeroplane/replay.html',
    '/aeroplane/spectate': '/aeroplane/spectate.html',
    '/aeroplane/admin': '/aeroplane/admin.html',
    '/game': '/aeroplane/game.html',
    '/stats': '/aeroplane/stats.html',
    '/replay': '/aeroplane/replay.html',
    '/spectate': '/aeroplane/spectate.html',
    '/admin': '/aeroplane/admin.html'
  };
  const aeroplanePath = aeroplaneRoutes[pathname] || pathname;
  const requested = pathname === '/' ? 'index.html' : aeroplanePath.replace(/^\/+/, '');
  const file = path.resolve(ROOT, requested);
  if (!file.startsWith(ROOT + path.sep) && file !== path.join(ROOT, 'index.html')) { res.writeHead(403).end(); return; }
  fs.readFile(file, (error, data) => {
    if (error) { res.writeHead(404).end('Not found'); return; }
    if (pathname === '/game' || pathname === '/stats' || pathname === '/replay' || pathname === '/spectate' || pathname === '/admin') {
      data = Buffer.from(data.toString('utf8').replaceAll('href="css/', 'href="/aeroplane/css/').replaceAll('src="./js/', 'src="/aeroplane/js/').replaceAll('href="./', 'href="/aeroplane/'));
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ noServer: true });
const flightWss = new WebSocketServer({ noServer: true });
server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const target = pathname === '/ws' ? wss : pathname === '/flight-ws' ? flightWss : null;
  if (!target) { socket.destroy(); return; }
  target.handleUpgrade(request, socket, head, client => target.emit('connection', client, request));
});
const flightRooms = new Map();
const flightSend = (socket, data) => { if (socket.readyState === 1) socket.send(JSON.stringify(data)); };
function flightRoomView(room) {
  return { code: room.code, name: room.name, status: room.status === 'playing' ? 'playing' : 'waiting', gameState: room.status, host: room.players[0]?.id, isPrivate: room.isPrivate, settings: room.settings, players: room.players.map(({ id, name, color, ready, socket, gameSocket }, index) => ({ id, nickname: name, name, color, team: room.settings.teamMode ? room.settings.teams[color] : null, ready, isReady: ready, isHost: index === 0, isAI: false, isConnected: Boolean(socket || gameSocket), emoji: 'smile' })) };
}
function normalizeFlightTeams(input) {
  const teams = {};
  for (const color of [1, 2, 3, 4]) teams[color] = Number(input?.[color]) === 2 ? 2 : 1;
  return teams;
}
function flightPublicRoomList() {
  return Array.from(flightRooms.values())
    .filter(room => !room.isPrivate && room.status === 'waiting')
    .map(room => ({ code: room.code, name: room.name, gameState: room.status, playerCount: room.players.length, maxPlayers: 4, pieceCount: room.settings.pieceCount, skillMode: room.settings.skillMode, happyMode: room.settings.happyMode, playerIds: room.players.map(player => player.id) }));
}
function flightBroadcastRoom(room, type = 'roomUpdated') {
  for (const player of room.players) {
    const message = { type, room: flightRoomView(room), playerId: player.id };
    if (player.socket) flightSend(player.socket, message);
    if (player.gameSocket && player.gameSocket !== player.socket) flightSend(player.gameSocket, message);
  }
}
async function flightBroadcastState(room, events = []) {
  const engine = await flightEngine;
  const snapshot = engine.toSnapshot(room.state, { gameSessionId: room.sessionId, seq: ++room.seq, events });
  for (const player of room.players) {
    const socket = player.gameSocket || player.socket;
    if (socket) flightSend(socket, { type: 'gameSnapshot', ...snapshot, playerId: player.id });
  }
}
flightWss.on('connection', socket => {
  socket.on('message', async raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const data = msg.data || msg;
    if (msg.type === 'ping') { flightSend(socket, { type: 'pong' }); return; }
    if (msg.type === 'listRooms') { flightSend(socket, { type: 'roomsList', rooms: flightPublicRoomList() }); return; }
    if (msg.type === 'rejoinGameSession') {
      const activeRoom = Array.from(flightRooms.values()).find(candidate => candidate.sessionId === (data.gameSessionId || msg.gameSessionId));
      const activePlayer = activeRoom?.players.find(candidate => candidate.id === (data.playerId || msg.playerId));
      if (!activeRoom || !activePlayer) { flightSend(socket, { type: 'error', message: '对局已不存在' }); return; }
      activePlayer.gameSocket = socket;
      socket.roomCode = activeRoom.code;
      socket.playerId = activePlayer.id;
      socket.socketRole = 'game';
      if (activeRoom.state) {
        const engine = await flightEngine;
        flightSend(socket, { type: 'gameSnapshot', ...engine.toSnapshot(activeRoom.state, { gameSessionId: activeRoom.sessionId, seq: activeRoom.seq, events: [] }), playerId: activePlayer.id });
      }
      flightBroadcastRoom(activeRoom, 'playerReconnected');
      return;
    }
    if (msg.type === 'createRoom' || msg.type === 'join_room' || msg.type === 'joinRoom') {
      const suppliedCode = String(data.roomCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
      let code = suppliedCode;
      if (msg.type === 'createRoom') {
        do { code = randomUUID().replace(/-/g, '').slice(0, 4).toUpperCase(); } while (flightRooms.has(code));
      }
      let room = flightRooms.get(code);
      if (!room && msg.type === 'createRoom') {
        const nickname = String(data.nickname || '玩家').trim().slice(0, 16) || '玩家';
        room = { code, name: `${nickname}的房间`, isPrivate: false, status: 'waiting', players: [], settings: { pieceCount: 4, happyMode: false, skillMode: false, initialEnergy: 0, takeoffRule: 'even', teamMode: false, teams: { 1: 1, 2: 2, 3: 1, 4: 2 } }, state: null, seq: 0, sessionId: randomUUID() };
        flightRooms.set(code, room);
      }
      if (!room) { flightSend(socket, { type: 'error', message: '房间不存在' }); return; }
      const requestedPlayerId = msg.playerId || data.playerId;
      const prior = room.players.find(p => p.id === requestedPlayerId);
      const player = prior || { id: msg.playerId || randomUUID(), name: String(data.nickname || data.name || '玩家').slice(0, 16), color: [1,2,3,4].find(c => !room.players.some(p => p.color === c)), ready: false, socket: null, gameSocket: null };
      if (prior && room.status === 'playing') { flightSend(socket, { type: 'error', message: '对局已开始，请从对局页面重连' }); return; }
      if (!prior && (room.status !== 'waiting' || room.players.length >= 4)) { flightSend(socket, { type: 'error', message: '房间已开始或人数已满' }); return; }
      player.socket = socket; socket.roomCode = code; socket.playerId = player.id; socket.socketRole = 'room';
      if (!prior) room.players.push(player);
      if (requestedPlayerId !== player.id) flightSend(socket, { type: 'identified', playerId: player.id });
      flightSend(socket, { type: msg.type === 'createRoom' ? 'roomCreated' : 'roomJoined', room: flightRoomView(room), playerId: player.id });
      flightSend(socket, { type: 'roomsList', rooms: flightPublicRoomList() });
      flightBroadcastRoom(room); if (room.state) await flightBroadcastState(room); return;
    }
    const room = flightRooms.get(socket.roomCode); if (!room) return;
    const player = room.players.find(p => p.id === socket.playerId); if (!player) return;
    if (msg.type === 'leave_room') { player.socket = null; flightBroadcastRoom(room, 'playerLeft'); return; }
    if (msg.type === 'toggle_ready') { player.ready = Boolean(data.isReady); flightBroadcastRoom(room, 'roomUpdated'); return; }
    if (msg.type === 'startGame') {
      if (room.players[0] !== player || room.players.length < 2) { flightSend(socket, { type: 'error', message: '至少两位玩家且需由房主开始' }); return; }
      const requestedSettings = data.settings || {};
      const teamModeRequested = typeof requestedSettings.teamMode === 'boolean' ? requestedSettings.teamMode : room.settings.teamMode;
      if (teamModeRequested && room.players.length !== 4) { flightSend(socket, { type: 'error', message: '组队对战需要四位玩家' }); return; }
      if (!room.players.every(p => p.ready || p === room.players[0])) { flightSend(socket, { type: 'error', message: '请等待所有玩家准备' }); return; }
      room.status = 'playing';
      const suppliedPieceCount = Number(requestedSettings.pieceCount ?? room.settings.pieceCount);
      room.settings = {
        pieceCount: Number.isInteger(suppliedPieceCount) && suppliedPieceCount >= 1 && suppliedPieceCount <= 4 ? suppliedPieceCount : room.settings.pieceCount,
        happyMode: typeof requestedSettings.happyMode === 'boolean' ? requestedSettings.happyMode : room.settings.happyMode,
        skillMode: typeof requestedSettings.skillMode === 'boolean' ? requestedSettings.skillMode : room.settings.skillMode,
        initialEnergy: [0, 15, 30, 50, 70, 100].includes(Number(requestedSettings.initialEnergy)) ? Number(requestedSettings.initialEnergy) : room.settings.initialEnergy,
        takeoffRule: requestedSettings.takeoffRule === 'six' ? 'six' : (room.settings.takeoffRule === 'six' ? 'six' : 'even'),
        teamMode: typeof requestedSettings.teamMode === 'boolean' ? requestedSettings.teamMode : room.settings.teamMode,
        teams: normalizeFlightTeams(requestedSettings.teams || room.settings.teams)
      };
      const { createState } = await flightEngine;
      const teams = room.settings.teamMode ? room.settings.teams : null;
      room.state = createState({ players: room.players.map(p => p.color), piecesPerPlayer: room.settings.pieceCount || 4, happy: !!room.settings.happyMode, skillMode: !!room.settings.skillMode, startEnergy: room.settings.initialEnergy || 0, takeoffRule: room.settings.takeoffRule, teams });
      room.state.teamMode = room.settings.teamMode;
      for (const p of room.players) if (p.socket) flightSend(p.socket, { type: 'gameStarted', gameSessionId: room.sessionId, roomCode: room.code, players: room.players.map(({id,name,color})=>({id,color,nickname:name,isAI:false,emoji:'smile'})), pieceCount: room.settings.pieceCount || 4, happyMode: !!room.settings.happyMode, skillMode: !!room.settings.skillMode, takeoffRule: room.settings.takeoffRule, teamMode: room.settings.teamMode, teams, isHost: p === room.players[0] });
      await flightBroadcastState(room); return;
    }
    if (msg.type === 'intent' && room.status === 'playing') {
      if (socket.socketRole !== 'game' || player.gameSocket !== socket) { flightSend(socket, { type: 'intentRejected', message: '对局连接已失效，请刷新重连' }); return; }
      if (room.state.currentPlayer !== player.color) { flightSend(socket, { type: 'intentRejected', message: '还没轮到你' }); return; }
      try {
        const { apply } = await flightEngine;
        const out = apply(room.state, player.color, data.intent);
        room.state = out.state; await flightBroadcastState(room, out.events);
      } catch (error) { flightSend(socket, { type: 'intentRejected', message: error.message }); }
    }
    if (msg.type === 'snapshotRequest' && room.state) { const engine = await flightEngine; flightSend(socket, { type: 'gameSnapshot', ...engine.toSnapshot(room.state, { gameSessionId: room.sessionId, seq: room.seq, events: [] }), playerId: player.id }); }
    if (msg.type === 'getReconnectInfo') { flightSend(socket, { type: 'reconnectInfo', canReconnect: !!room.state, roomCode: room.code }); return; }
    if (msg.type === 'update_nickname') { player.name = String(data.nickname || player.name).slice(0,16); flightBroadcastRoom(room); return; }
    if (msg.type === 'update_room_name') {
      if (room.players[0] !== player || room.status !== 'waiting') return;
      const name = String(data.name || '').trim().slice(0, 24);
      room.name = name || `${player.name}的房间`;
      flightSend(socket, { type: 'roomNameUpdated', name: room.name });
      flightBroadcastRoom(room);
      for (const peer of room.players) if (peer.socket) flightSend(peer.socket, { type: 'roomsList', rooms: flightPublicRoomList() });
      return;
    }
    if (msg.type === 'update_room_privacy' && room.players[0] === player && room.status === 'waiting') {
      room.isPrivate = Boolean(data.isPrivate);
      flightSend(socket, { type: 'roomPrivacyUpdated', isPrivate: room.isPrivate, room: flightRoomView(room) });
      for (const peer of room.players) if (peer.socket) flightSend(peer.socket, { type: 'roomsList', rooms: flightPublicRoomList() });
      return;
    }
    if (msg.type === 'toggle_ready') { player.ready = Boolean(data.isReady); flightBroadcastRoom(room); return; }
    if (msg.type === 'updateSettings' && room.players[0] === player && room.status === 'waiting') {
      const settings = data.settings || data;
      if ([1, 2, 3, 4].includes(Number(settings.pieceCount))) room.settings.pieceCount = Number(settings.pieceCount);
      if (typeof settings.happyMode === 'boolean') room.settings.happyMode = settings.happyMode;
      if (typeof settings.skillMode === 'boolean') room.settings.skillMode = settings.skillMode;
      if (settings.takeoffRule === 'six' || settings.takeoffRule === 'even') room.settings.takeoffRule = settings.takeoffRule;
      if (typeof settings.teamMode === 'boolean') room.settings.teamMode = settings.teamMode;
      if (settings.teams && typeof settings.teams === 'object') room.settings.teams = normalizeFlightTeams(settings.teams);
      if ([0, 15, 30, 50, 70, 100].includes(Number(settings.initialEnergy))) room.settings.initialEnergy = Number(settings.initialEnergy);
      flightSend(socket, { type: 'settingsUpdated', settings: room.settings, room: flightRoomView(room) });
      flightBroadcastRoom(room);
      for (const peer of room.players) if (peer.socket) flightSend(peer.socket, { type: 'roomsList', rooms: flightPublicRoomList() });
      return;
    }
    if (msg.type === 'chatMessage') { for (const p of room.players) if (p.socket) flightSend(p.socket, { type: 'chatMessage', playerId: player.id, playerName: player.name, message: String(data.message || '').slice(0,300) }); return; }
    if (msg.type === 'configure_piece_count' && room.players[0] === player && room.status === 'waiting') { room.settings.pieceCount = Math.max(1, Math.min(4, Number(data.pieceCount) || 4)); flightBroadcastRoom(room); return; }
  });
  socket.on('close', () => {
    const room = flightRooms.get(socket.roomCode); if (!room) return;
    const player = room.players.find(p => p.id === socket.playerId);
    if (player && socket.socketRole === 'game' && player.gameSocket === socket) player.gameSocket = null;
    else if (player && player.socket === socket) player.socket = null;
    flightBroadcastRoom(room, 'playerDisconnected');
    if (room.status === 'waiting' && !room.players.some(p => p.socket || p.gameSocket)) flightRooms.delete(room.code);
  });
});
const send = (socket, message) => { if (socket.readyState === 1) socket.send(JSON.stringify(message)); };
function roomState(room) { return { type: 'state', room: room.code, players: room.players.filter(Boolean).length, board: room.board, turn: room.turn, winner: room.winner, yourSide: null }; }
function broadcast(room) {
  room.players.forEach((player, side) => { if (player) send(player, { ...roomState(room), yourSide: side }); });
}
function wins(board, x, y, side) {
  for (const [dx, dy] of [[1,0],[0,1],[1,1],[1,-1]]) {
    let count = 1;
    for (const sign of [-1,1]) { let cx=x+dx*sign, cy=y+dy*sign; while (cx>=0&&cx<15&&cy>=0&&cy<15&&board[cy][cx]===side) { count++; cx+=dx*sign; cy+=dy*sign; } }
    if (count >= 5) return true;
  }
  return false;
}
wss.on('connection', (socket) => {
  socket.on('message', (raw) => {
    let message; try { message = JSON.parse(raw); } catch { return; }
    if (message.type === 'join') {
      const code = String(message.room || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
      if (code.length < 4) { send(socket, { type: 'error', message: '房间码至少需要 4 位' }); return; }
      let room = rooms.get(code);
      if (!room && message.create) { room = { code, players: [null, null], board: Array.from({ length: 15 }, () => Array(15).fill(0)), turn: 0, winner: null }; rooms.set(code, room); }
      if (!room) { send(socket, { type: 'error', message: '没有找到这个房间' }); return; }
      const side = room.players.findIndex((player) => !player);
      if (side < 0) { send(socket, { type: 'error', message: '房间已满' }); return; }
      room.players[side] = socket; socket.roomCode = code; socket.side = side; broadcast(room);
    }
    if (message.type === 'move') {
      const room = rooms.get(socket.roomCode); const { x, y } = message;
      if (!room || room.winner || room.turn !== socket.side || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x > 14 || y < 0 || y > 14 || room.board[y][x]) return;
      room.board[y][x] = socket.side + 1;
      if (wins(room.board, x, y, socket.side + 1)) room.winner = socket.side;
      else if (room.board.every((row) => row.every(Boolean))) room.winner = 'draw';
      else room.turn = 1 - room.turn;
      broadcast(room);
    }
    if (message.type === 'restart') {
      const room = rooms.get(socket.roomCode); if (!room || room.players.filter(Boolean).length < 2) return;
      room.board = Array.from({ length: 15 }, () => Array(15).fill(0)); room.turn = 0; room.winner = null; broadcast(room);
    }
  });
  socket.on('close', () => {
    const room = rooms.get(socket.roomCode); if (!room) return;
    room.players[socket.side] = null;
    room.players.forEach((player) => player && send(player, { type: 'opponent-left' }));
    if (!room.players.some(Boolean)) rooms.delete(room.code);
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`Playroom listening on ${PORT}`));
