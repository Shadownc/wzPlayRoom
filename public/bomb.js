const bombPage = document.querySelector('#bombPage');
if (bombPage) {
  if (/^\/bomb\/?$/.test(location.pathname)) { document.querySelector('#home').hidden = true; document.querySelector('#gamePage').hidden = true; bombPage.hidden = false; }
  window.addEventListener('error', event => {
    const feedback = document.querySelector('#bombMessage');
    if (feedback) feedback.textContent = `游戏脚本错误：${event.message}`;
  });
  let bombSocket = null;
  let bombPlayer = 0;
  const setup = document.querySelector('#bombSetup');
  const table = document.querySelector('#bombTable');
  const message = document.querySelector('#bombMessage');
  const codeInput = document.querySelector('#bombCode');
  const status = document.querySelector('#bombStatus');
  let solo = false;
  let soloBomb = 0;
  let soloMin = 1;
  let soloMax = 100;
  function renderSolo() {
    table.hidden = false;
    setup.hidden = true;
    document.querySelector('#bombRange').textContent = `${soloMin} — ${soloMax}`;
    document.querySelector('#bombPlayers').replaceChildren();
    document.querySelector('#bombGuess').disabled = false;
    document.querySelector('#bombGuessForm').querySelector('button').disabled = false;
    document.querySelector('#bombStart').hidden = true;
    status.textContent = solo ? '单人练习：输入当前范围内的整数。' : '';
  }
  function startSolo() {
    solo = true;
    soloBomb = 1 + Math.floor(Math.random() * 100);
    soloMin = 1;
    soloMax = 100;
    renderSolo();
  }
  function enterBomb(create) {
    const code = create ? Math.random().toString(36).slice(2, 8).toUpperCase() : codeInput.value.trim().toUpperCase();
    if (code.length < 4) { message.textContent = '请输入至少 4 位房间码'; return; }
    bombSocket?.close();
    message.textContent = '正在连接…';
    bombSocket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/bomb-ws`);
    bombSocket.onopen = () => bombSocket.send(JSON.stringify({ type: 'join', room: code, create }));
    bombSocket.onerror = () => { message.textContent = '连接失败，请确认服务已启动'; };
    bombSocket.onmessage = event => {
      const data = JSON.parse(event.data);
      if (data.type === 'error') { if (!setup.hidden) message.textContent = data.message; else status.textContent = data.message; return; }
      bombPlayer = data.yourIndex;
      setup.hidden = true;
      table.hidden = false;
      document.querySelector('#bombRange').textContent = `${data.min} — ${data.max}`;
      document.querySelector('#bombPlayers').replaceChildren(...data.players.map((player, index) => {
        const item = document.createElement('li');
        item.textContent = `${player.name}${index === bombPlayer ? '（你）' : ''}${data.status === 'playing' && data.turn === index ? ' · 正在猜' : ''}`;
        item.classList.toggle('active', data.status === 'playing' && data.turn === index);
        return item;
      }));
      document.querySelector('#bombGuess').disabled = data.status !== 'playing' || data.turn !== bombPlayer;
      document.querySelector('#bombGuessForm').querySelector('button').disabled = document.querySelector('#bombGuess').disabled;
      document.querySelector('#bombStart').hidden = !(data.status === 'waiting' && bombPlayer === 0) && !(data.status === 'finished' && bombPlayer === 0);
      if (data.status === 'waiting') status.textContent = `房间码 ${data.room} · ${data.players.length} 人已加入，房主可以开始${data.players.length === 1 ? '单人练习' : ''}。`;
      else if (data.status === 'finished') status.textContent = data.loser === bombPlayer ? `你踩中炸弹 ${data.lastGuess.value}，输了！` : `${data.players[data.loser]?.name || '玩家'}踩中炸弹 ${data.lastGuess.value}，你赢了！`;
      else if (data.lastGuess) status.textContent = `${data.players[data.lastGuess.player].name} 猜了 ${data.lastGuess.value}，安全范围已缩小。`;
      else status.textContent = '游戏开始！轮到 ' + data.players[data.turn].name;
    };
  }
  document.querySelector('#bombSolo').addEventListener('click', startSolo);
  document.querySelector('#bombCreate').addEventListener('click', () => enterBomb(true));
  document.querySelector('#bombJoin').addEventListener('click', () => enterBomb(false));
  document.querySelector('#bombCode').addEventListener('keydown', event => { if (event.key === 'Enter') enterBomb(false); });
  document.querySelector('#bombGuessForm').addEventListener('submit', event => {
    event.preventDefault();
    const input = document.querySelector('#bombGuess');
    if (solo) {
      const guess = Number(input.value);
      if (!Number.isInteger(guess) || guess < soloMin || guess > soloMax) { status.textContent = `请输入 ${soloMin} 到 ${soloMax} 之间的整数。`; return; }
      if (guess === soloBomb) {
        status.textContent = `BOOM！炸弹是 ${soloBomb}。点击“再开一局”重新挑战。`;
        document.querySelector('#bombGuess').disabled = true;
        document.querySelector('#bombGuessForm').querySelector('button').disabled = true;
        document.querySelector('#bombStart').hidden = false;
      } else {
        if (guess < soloBomb) soloMin = guess;
        else soloMax = guess;
        renderSolo();
        status.textContent = `${guess} 安全！继续猜 ${soloMin} 到 ${soloMax}。`;
      }
      input.value = '';
      return;
    }
    if (bombSocket?.readyState === WebSocket.OPEN && input.value) bombSocket.send(JSON.stringify({ type: 'guess', value: input.value }));
    input.value = '';
  });
  document.querySelector('#bombStart').addEventListener('click', () => { if (solo) startSolo(); else bombSocket?.send(JSON.stringify({ type: 'start' })); });
}
