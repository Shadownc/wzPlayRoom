const SIZE = 15;
const lobby = document.querySelector('#home');
const gamePage = document.querySelector('#gamePage');
const boardEl = document.querySelector('#board');
const turnText = document.querySelector('#turnText');
const turnIcon = document.querySelector('#turnIcon');
const onlineSetup = document.querySelector('#onlineSetup');
const difficulty = document.querySelector('#difficulty');
const roomMessage = document.querySelector('#roomMessage');
let board, mode = 'ai', turn = 1, over = false, humanSide = 1, socket = null, roomCode = '', onlineSide = null;

function gameRoute(nextMode = mode) { return `#game/gomoku/${nextMode}`; }

function resetBoard() { board = Array.from({ length: SIZE }, () => Array(SIZE).fill(0)); turn = 1; over = false; lastStone = null; render(); updateTurn(); }
function render() {
  boardEl.replaceChildren();
  for (let y=0;y<SIZE;y++) for (let x=0;x<SIZE;x++) {
    const cell = document.createElement('button'); cell.type='button'; cell.className='cell'; cell.setAttribute('role','gridcell'); cell.setAttribute('aria-label', `${y+1} 行 ${x+1} 列${board[y][x] ? board[y][x]===1?'黑子':'白子' : '空位'}`);
    if (board[y][x]) cell.classList.add(board[y][x]===1?'black':'white');
    if (board[y][x] && board[y][x]===lastStone?.side && x===lastStone.x && y===lastStone.y) cell.classList.add('last-move');
    cell.addEventListener('click', () => play(x,y)); boardEl.append(cell);
  }
}
let lastStone = null;
function setMode(next) {
  mode=next; document.querySelectorAll('.mode-tab').forEach(tab=>tab.classList.toggle('active',tab.dataset.mode===mode));
  onlineSetup.hidden=mode!=='online'; difficulty.hidden=mode!=='ai';
  document.querySelector('#gameHint').textContent=mode==='online'?'创建房间后，把房间码发给好友。':'先连成五子的一方获胜。';
  document.querySelector('#blackLabel').textContent=mode==='local'?'黑方':'你 · 黑棋';
  document.querySelector('#whiteLabel').textContent=mode==='local'?'白方':mode==='ai'?'AI · 白棋':'好友 · 白棋';
  if (socket) { socket.close(); socket=null; }
  roomCode=''; onlineSide=null; resetBoard();
  if (location.hash !== gameRoute(next)) history.replaceState(null, '', gameRoute(next));
}
function openGame(startMode='ai') { lobby.hidden=true; gamePage.hidden=false; window.scrollTo(0,0); if(location.hash !== gameRoute(startMode)) history.pushState(null, '', gameRoute(startMode)); setMode(startMode); }
function closeGame() { if(socket){socket.close();socket=null;} lobby.hidden=false; gamePage.hidden=true; window.scrollTo(0,0); if(location.hash !== '#home') history.pushState(null, '', '#home'); }
function syncRoute() {
  const match = location.hash.match(/^#game\/gomoku\/(ai|local|online)$/);
  if (match) {
    lobby.hidden=true; gamePage.hidden=false;
    if (mode !== match[1]) setMode(match[1]);
  } else {
    if (socket) { socket.close(); socket=null; }
    gamePage.hidden=true; lobby.hidden=false;
  }
}
function updateTurn() {
  if(over) return;
  const current=mode==='online' ? (onlineSide===null?'等待连接房间…':turn===onlineSide+1?'你的回合':'对手落子中') : mode==='local' ? (turn===1?'黑方回合':'白方回合') : turn===humanSide?'你的回合':'AI 思考中';
  turnText.textContent=current; turnIcon.classList.toggle('white-turn',turn===2); turnIcon.textContent=turn===1?'●':'○';
}
function hasWon(x,y,side) { for(const [dx,dy] of [[1,0],[0,1],[1,1],[1,-1]]) { let count=1; for(const sign of [-1,1]){let cx=x+dx*sign,cy=y+dy*sign;while(cx>=0&&cx<SIZE&&cy>=0&&cy<SIZE&&board[cy][cx]===side){count++;cx+=dx*sign;cy+=dy*sign;}} if(count>=5)return true;} return false; }
function finish(side) { over=true; turnText.textContent=side===0?'平局':mode==='local'?(side===1?'黑方获胜':'白方获胜'):side===(mode==='online'?onlineSide+1:humanSide)?'你赢了':'你输了'; }
function play(x,y) {
  if(over||board[y][x])return;
  if(mode==='online') { if(!socket||socket.readyState!==WebSocket.OPEN||onlineSide===null||turn!==onlineSide+1)return; socket.send(JSON.stringify({type:'move',x,y})); return; }
  if(mode==='ai'&&turn!==humanSide)return;
  place(x,y,turn);
  if(mode==='ai'&&!over){turn=2;updateTurn();setTimeout(aiMove,180);}
}
function place(x,y,side) { if(board[y][x]||over)return;board[y][x]=side;lastStone={x,y,side};render();if(hasWon(x,y,side)){finish(side);return;}if(board.every(row=>row.every(Boolean))){finish(0);return;}turn=3-side;updateTurn(); }
function scoreAt(x,y,side) { if(board[y][x])return -1;let score=0;for(const[dx,dy]of[[1,0],[0,1],[1,1],[1,-1]]){let own=0,open=0,blocked=0;for(const sign of[-1,1]){let cx=x+dx*sign,cy=y+dy*sign;while(cx>=0&&cx<SIZE&&cy>=0&&cy<SIZE&&board[cy][cx]===side){own++;cx+=dx*sign;cy+=dy*sign;}if(cx<0||cx>=SIZE||cy<0||cy>=SIZE||board[cy][cx]===3-side)blocked++;else open++;}let n=own+1;score+=n>=5?100000:n===4?(open===2?12000:1800):n===3?(open===2?900:100):n===2?(open===2?80:12):open*2;if(blocked===2)score*=.2;}return score;}
function aiMove() { if(over||mode!=='ai')return;let candidates=[];for(let y=0;y<SIZE;y++)for(let x=0;x<SIZE;x++)if(!board[y][x]){let near=false;for(let yy=Math.max(0,y-2);yy<=Math.min(SIZE-1,y+2);yy++)for(let xx=Math.max(0,x-2);xx<=Math.min(SIZE-1,x+2);xx++)if(board[yy][xx])near=true;if(near||board.every(row=>row.every(v=>!v)))candidates.push({x,y,attack:scoreAt(x,y,2),defend:scoreAt(x,y,1)});}const level=document.querySelector('#level').value;let best=candidates.map(c=>({...c,value:c.attack*0.9+c.defend*(level==='easy'?.7:1.08)+Math.random()*(level==='hard'?0:24)})).sort((a,b)=>b.value-a.value)[0];if(best)place(best.x,best.y,2);}
function connect(create) {
  const input=document.querySelector('#roomCode');
  const code=create?Math.random().toString(36).slice(2,8).toUpperCase():input.value.trim().toUpperCase();
  if(code.length<4){roomMessage.textContent='请输入至少 4 位房间码。';return;}
  if(socket)socket.close();
  roomCode=code;roomMessage.textContent='正在连接服务器…';
  const createButton=document.querySelector('#createRoom'),joinButton=document.querySelector('#joinRoom');
  createButton.disabled=true;joinButton.disabled=true;
  socket=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/ws`);
  socket.onopen=()=>{roomMessage.textContent='服务器已连接，正在进入房间…';socket.send(JSON.stringify({type:'join',room:code,create}));};
  socket.onmessage=(event)=>{
    const data=JSON.parse(event.data);
    if(data.type==='error'){roomMessage.textContent=data.message;socket.close();return;}
    if(data.type==='opponent-left'){roomMessage.textContent='好友已离开，房间仍为你保留。';return;}
    if(data.type==='state'){
      onlineSide=data.yourSide;board=data.board.map(row=>row.slice());turn=data.turn+1;over=data.winner!==null;lastStone=null;
      for(let y=0;y<SIZE;y++)for(let x=0;x<SIZE;x++)if(board[y][x])lastStone={x,y,side:board[y][x]};
      render();input.value=code;input.classList.add('room-code-ready');
      roomMessage.textContent=data.players===1?`房间码 ${code} 已创建，发给好友即可加入。`:`已加入房间 ${code}，对局开始。`;
      if(over)finish(data.winner==='draw'?0:data.winner+1);else updateTurn();
    }
  };
  socket.onerror=()=>{roomMessage.textContent='无法连接对战服务。请确认双方访问同一服务器地址，并检查服务器 WebSocket 连接。';createButton.disabled=false;joinButton.disabled=false;};
  socket.onclose=()=>{createButton.disabled=false;joinButton.disabled=false;if(roomCode&&roomMessage.textContent==='服务器已连接，正在进入房间…')roomMessage.textContent='连接已关闭，请重试。';};
}
document.querySelector('#openGame').addEventListener('click',()=>openGame('ai'));
document.querySelector('#quickAi').addEventListener('click',()=>openGame('ai'));
document.querySelector('#backLobby').addEventListener('click',closeGame);
document.querySelectorAll('.mode-tab').forEach(tab=>tab.addEventListener('click',()=>{const next=tab.dataset.mode;if(location.hash!==gameRoute(next))history.pushState(null,'',gameRoute(next));setMode(next);}));
document.querySelector('#restart').addEventListener('click',()=>{if(mode==='online'&&socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'restart'}));else resetBoard();});
document.querySelector('#createRoom').addEventListener('click',()=>connect(true));
document.querySelector('#joinRoom').addEventListener('click',()=>connect(false));
document.querySelector('#copyRoom').addEventListener('click',async()=>{const code=document.querySelector('#roomCode').value.trim();if(!code)return;try{await navigator.clipboard.writeText(code);roomMessage.textContent=`房间码 ${code} 已复制，发给好友即可加入。`;}catch{document.querySelector('#roomCode').select();roomMessage.textContent='已选中房间码，请复制后发给好友。';}});
document.querySelector('#roomCode').addEventListener('keydown',event=>{if(event.key==='Enter')connect(false);});
document.querySelectorAll('.filter').forEach(button=>button.addEventListener('click',()=>{document.querySelectorAll('.filter').forEach(item=>item.classList.toggle('active',item===button));document.querySelectorAll('.game-entry').forEach(item=>item.classList.toggle('filtered-out',button.dataset.filter!=='all'&&item.dataset.category!==button.dataset.filter));}));
window.addEventListener('hashchange',syncRoute);
window.addEventListener('popstate',syncRoute);
if (!location.hash) history.replaceState(null, '', '#home');
syncRoute();
if (gamePage.hidden) resetBoard();
