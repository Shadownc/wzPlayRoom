const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 3007);
const ROOT = path.join(__dirname, 'public');
const rooms = new Map();
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(ROOT, requested);
  if (!file.startsWith(ROOT + path.sep) && file !== path.join(ROOT, 'index.html')) { res.writeHead(403).end(); return; }
  fs.readFile(file, (error, data) => {
    if (error) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: '/ws' });
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
