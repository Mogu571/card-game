const SUPABASE_URL = 'https://fspxnnbkuxjnxnremdtp.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZzcHhubmJrdXhqbnhucmVtZHRwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIzNjY3NTEsImV4cCI6MjA5Nzk0Mjc1MX0.MCEUHHXxf41fzk-nv3lBK0sB04YnJfHr_zrTsZtNwg0';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const CRIMES = ['盗窃罪','诈骗罪','绑架罪','抢劫罪','洗钱罪','走私罪'];
const SKILL_DEFS = [
  {name:'无懈可击', desc:'抵消本轮所有已出技能牌效果'},
  {name:'隔岸观火', desc:'禁止指定玩家本轮投票'},
  {name:'借花献佛', desc:'翻转指定玩家本轮投票方向（不能用于自己）'},
  {name:'移花接木', desc:'与指定玩家各出一张牌互换'},
  {name:'同甘共苦', desc:'被判有罪时出牌，指定一人陪自己受罚'},
];
const VOTE_WEIGHTS = [1,1,2,2,3,3,1,1];

let mySeat = -1;
let myName = '';
let G = null;
let _mySelectedVoteCards = {};

// ─── 工具函数 ───────────────────────────────────────────────

function shuffle(a) {
  const arr = [...a];
  for (let i = arr.length-1; i > 0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    [arr[i],arr[j]] = [arr[j],arr[i]];
  }
  return arr;
}

function showError(msg) {
  const el = document.getElementById('join-error');
  el.textContent = msg;
  el.style.display = msg ? 'block' : 'none';
}

function addLog(msg, type='system') {
  if (!G.log) G.log = [];
  G.log.unshift({msg, type});
  if (G.log.length > 60) G.log.pop();
}

function isMyTurn() { return mySeat === G.currentOfficerIdx; }

function makeFreshLobby() {
  return {
    phase: 'lobby',
    players: [null, null, null, null],
    log: [],
    round: 0,
    totalRounds: 6,
    currentOfficerIdx: 0,
    trialTarget: null,
    revolver: null,
    revolverIdx: 0,
    extraVoteIdx: 0,
    extraSkillIdx: 0,
    extraVoteDeck: [],
    extraSkillDeck: [],
    _votesSubmitted: {},
    _selectedVotes: {}
  };
}

// ─── Supabase ────────────────────────────────────────────────

async function loadState() {
  const {data, error} = await sb.from('game_state').select('state').eq('id','main').single();
  if (error) { console.error(error); return null; }
  return data.state;
}

async function saveState(state) {
  const {error} = await sb.from('game_state')
    .update({state, updated_at: new Date().toISOString()})
    .eq('id','main');
  if (error) console.error('save error', error);
}

async function initRealtime() {
  const channel = sb.channel('game-room');
  channel.on('postgres_changes', {
    event: 'UPDATE', schema: 'public', table: 'game_state', filter: 'id=eq.main'
  }, payload => {
    G = payload.new.state;
    render();
  });
  await channel.subscribe(status => {
    const el = document.getElementById('conn-status');
    if (status === 'SUBSCRIBED') {
      el.textContent = '已连接';
      el.className = 'conn-status conn-ok';
    } else {
      el.textContent = '连接中...';
      el.className = 'conn-status conn-wait';
    }
  });

  G = await loadState();

  // 从 localStorage 恢复身份
  const savedSeat = localStorage.getItem('cg_seat');
  const savedName = localStorage.getItem('cg_name');
  if (savedSeat !== null && savedName) {
    const seat = parseInt(savedSeat);
    if (G && G.players && G.players[seat] && G.players[seat].name === savedName) {
      mySeat = seat;
      myName = savedName;
    } else {
      localStorage.removeItem('cg_seat');
      localStorage.removeItem('cg_name');
    }
  }
  render();
}

// ─── 大厅 ────────────────────────────────────────────────────

async function joinGame() {
  const name = document.getElementById('my-name').value.trim();
  const seat = parseInt(document.getElementById('my-seat').value);
  if (!name) { showError('请输入名字'); return; }

  G = await loadState();

  if (G && G.phase && G.phase !== 'lobby') {
    showError('游戏已经开始，无法加入');
    return;
  }

  if (!G || !G.players) {
    G = makeFreshLobby();
  }

  if (G.players[seat] && G.players[seat].name !== name) {
    showError(`座位 ${seat+1} 已被 "${G.players[seat].name}" 占用，请换一个座位`);
    return;
  }

  mySeat = seat;
  myName = name;
  showError('');
  localStorage.setItem('cg_seat', seat);
  localStorage.setItem('cg_name', name);

  G.players[seat] = {name, id:seat, hand:[], hp:4, score:0, blocked:false, voteFlipped:false};
  await saveState(G);
  render();
}

async function hostStartGame() {
  if (mySeat !== 0) return;
  G = await loadState();
  if (!G.players.every(p=>p!==null)) { alert('还有空位未就座！'); return; }

  let uid = 0;
  const nextId = () => 'card_' + (uid++);

  const deck = [];
  for (let i=0;i<6;i++) deck.push({type:'role',role:'police',name:'警察牌'+(i+1),id:nextId()});
  for (let i=0;i<6;i++) deck.push({type:'role',role:'criminal',name:'罪犯牌',crime:CRIMES[i],id:nextId()});
  VOTE_WEIGHTS.forEach((w,i)=>deck.push({type:'vote',weight:w,gang:i<4?'A帮':'B帮',name:(i<4?'A帮':'B帮')+' 权重'+w,id:nextId()}));
  for (let k=0;k<8;k++) {
    const s = SKILL_DEFS[k % SKILL_DEFS.length];
    deck.push({...s, type:'skill', id:nextId()});
  }

  const firstDeal = shuffle(deck);
  G.players.forEach(p=>{ if(p) p.hand=[]; });
  firstDeal.forEach((card,ci)=>{ G.players[ci%4].hand.push(card); });

  const extraVote = [];
  for (let r=0;r<20;r++) {
    VOTE_WEIGHTS.forEach((w,i)=>extraVote.push({type:'vote',weight:w,gang:i<4?'A帮':'B帮',name:(i<4?'A帮':'B帮')+' 权重'+w,id:nextId()}));
  }
  const extraSkill = [];
  for (let r=0;r<20;r++) {
    SKILL_DEFS.forEach(s=>extraSkill.push({...s,type:'skill',id:nextId()}));
  }

  G.revolver = shuffle([true,true,true,false,false,false]);
  G.revolverIdx = 0;
  G.phase = 'skill';
  G.round = 1;
  G.currentOfficerIdx = 0;
  G.trialTarget = null;
  G.log = [
    {msg:'游戏开始！共6轮抓捕行动。',type:'system'},
    {msg:'第1轮：'+G.players[0].name+' 担任警察行动。',type:'police'}
  ];
  G.extraVoteDeck = shuffle(extraVote);
  G.extraSkillDeck = shuffle(extraSkill);
  G.extraVoteIdx = 0;
  G.extraSkillIdx = 0;
  G._votesSubmitted = {};
  G._selectedVotes = {};
  await saveState(G);
  render();
}

async function resetGame() {
  mySeat = -1; myName = '';
  document.getElementById('my-name').value = '';
  localStorage.removeItem('cg_seat');
  localStorage.removeItem('cg_name');
  G = makeFreshLobby();
  await saveState(G);
  render();
}

// ─── 渲染 ────────────────────────────────────────────────────

function render() {
  if (!G) return;

  if (mySeat === -1) {
    document.getElementById('join-screen').style.display = 'block';
    document.getElementById('game-screen').style.display = 'none';
    document.getElementById('end-screen').style.display = 'none';
    renderLobby();
    return;
  }

  if (G.phase === 'ended') {
    document.getElementById('join-screen').style.display = 'none';
    document.getElementById('game-screen').style.display = 'none';
    document.getElementById('end-screen').style.display = 'block';
    renderEndScreen();
    return;
  }

  if (G.phase === 'lobby') {
    document.getElementById('join-screen').style.display = 'block';
    document.getElementById('game-screen').style.display = 'none';
    document.getElementById('end-screen').style.display = 'none';
    renderLobby();
    return;
  }

  document.getElementById('join-screen').style.display = 'none';
  document.getElementById('game-screen').style.display = 'block';
  document.getElementById('end-screen').style.display = 'none';
  renderPhaseBar();
  renderPlayers();
  renderRevolver();
  renderLog();
  renderAction();
}

function renderLobby() {
  if (!G) return;
  const el = document.getElementById('lobby-players');
  if (!el) return;
  const rows = [0,1,2,3].map(i => {
    const p = G.players ? G.players[i] : null;
    return `<div class="seat-item">
      <span style="font-size:13px;color:#aaa;min-width:48px">座位 ${i+1}</span>
      ${p
        ? `<span class="seat-name">${p.name}</span>${i===mySeat?'<span class="badge badge-me">我</span>':''}`
        : `<span class="seat-empty">空位</span>`}
    </div>`;
  }).join('');
  el.innerHTML = rows;

  const filled = G.players && G.players.every(p => p !== null);
  const btn = document.getElementById('start-btn');
  if (btn) {
    btn.disabled = !(filled && mySeat === 0);
    btn.title = filled ? (mySeat===0 ? '' : '只有座位1可以开始') : '还有空位未就座';
  }
}

function renderPhaseBar() {
  ['skill','arrest','vote','punish'].forEach(p => {
    const el = document.getElementById('ph-'+p);
    if (el) el.classList.toggle('active', p === G.phase);
  });
}

function renderPlayers() {
  const grid = document.getElementById('players-grid');
  if (!grid || !G.players) return;
  grid.innerHTML = G.players.map((p,i) => {
    if (!p) return `<div class="player-card"><div class="player-name" style="color:#aaa">座位${i+1}（空）</div></div>`;
    const isTurn = i === G.currentOfficerIdx;
    const isTried = G.trialTarget && G.trialTarget.playerId === i;
    const isMe = i === mySeat;
    let cls = 'player-card';
    if (isTurn) cls += ' current-turn';
    if (isTried) cls += ' being-tried';
    if (isMe) cls += ' is-me';
    const hpDots = Array.from({length:4},(_,hi)=>`<div class="hp-pip${hi<p.hp?'':' empty'}"></div>`).join('');

    let handHtml = '';
    if (isMe) {
      const roleCards = p.hand.filter(c=>c.type==='role').map(c=>{
        const cls2 = c.role==='criminal'?'card card-criminal':'card card-role';
        return `<span class="${cls2}">${c.role==='criminal'?'罪犯('+c.crime+')':c.name}</span>`;
      }).join('');
      const voteCards = p.hand.filter(c=>c.type==='vote').map(c=>`<span class="card card-vote">${c.name}</span>`).join('');
      const skillCards = p.hand.filter(c=>c.type==='skill').map(c=>`<span class="card card-skill" title="${c.desc}">${c.name}</span>`).join('');
      handHtml = `
        <div class="hand-area"><div class="hand-label">角色牌 (${p.hand.filter(c=>c.type==='role').length})</div>
          <div class="cards-row">${roleCards||'<span style="font-size:11px;color:#ccc">无</span>'}</div>
        </div>
        <div class="hand-area" style="margin-top:5px"><div class="hand-label">投票牌 (${p.hand.filter(c=>c.type==='vote').length})</div>
          <div class="cards-row">${voteCards||'<span style="font-size:11px;color:#ccc">无</span>'}</div>
        </div>
        <div class="hand-area" style="margin-top:5px"><div class="hand-label">技能牌 (${p.hand.filter(c=>c.type==='skill').length})</div>
          <div class="cards-row">${skillCards||'<span style="font-size:11px;color:#ccc">无</span>'}</div>
        </div>`;
    } else {
      const roles = p.hand.filter(c=>c.type==='role').length;
      const votes = p.hand.filter(c=>c.type==='vote').length;
      const skills = p.hand.filter(c=>c.type==='skill').length;
      handHtml = `<div class="hand-area" style="margin-top:4px">
        <div class="cards-row">
          ${roles>0?`<span class="card card-hidden">角色牌 ×${roles}</span>`:''}
          ${votes>0?`<span class="card card-hidden">投票牌 ×${votes}</span>`:''}
          ${skills>0?`<span class="card card-hidden">技能牌 ×${skills}</span>`:''}
          ${roles+votes+skills===0?'<span style="font-size:11px;color:#ccc">无手牌</span>':''}
        </div></div>`;
    }

    return `<div class="${cls}">
      <div class="player-name">
        ${p.name}
        ${isTurn?'<span class="badge badge-turn">警察</span>':''}
        ${isMe?'<span class="badge badge-me">我</span>':''}
        ${p.blocked?'<span class="badge badge-blocked">禁投票</span>':''}
        ${p.voteFlipped?'<span class="badge badge-flipped">票翻转</span>':''}
        <span style="font-size:11px;color:#aaa;margin-left:auto">积分: ${p.score}</span>
      </div>
      <div class="hp-bar">${hpDots}</div>
      <div style="font-size:11px;color:#aaa;margin-bottom:4px">${p.hp}/4 体力</div>
      ${handHtml}
    </div>`;
  }).join('');
}

function renderRevolver() {
  const el = document.getElementById('revolver-display');
  if (!el || !G.revolver) return;
  let html = G.revolver.map((live,i)=>{
    const fired = i < G.revolverIdx;
    const cls = fired?'bullet fired':(live?'bullet live':'bullet empty');
    return `<div class="${cls}" title="${fired?'已击发':(live?'子弹':'空槽')}">${fired?'×':(live?'!':'○')}</div>`;
  }).join('');
  html += `<span style="font-size:12px;color:#aaa;margin-left:8px">当前:${G.revolverIdx+1}/6　! 子弹　○ 空槽　× 已击发</span>`;
  el.innerHTML = html;
}

function renderLog() {
  const el = document.getElementById('log-area');
  if (!el || !G.log) return;
  el.innerHTML = G.log.map(l=>`<div class="log-item log-${l.type}">${l.msg}</div>`).join('');
}

function renderEndScreen() {
  const sorted = [...G.players].filter(Boolean).sort((a,b)=>b.score-a.score);
  document.getElementById('final-scores').innerHTML = sorted.map((p,i)=>
    `<div class="score-row">
      <span>${i+1}. ${p.name}</span>
      <span style="font-weight:500">${p.score} 分</span>
      <span style="font-size:12px;color:#aaa">体力 ${p.hp}/4</span>
    </div>`
  ).join('');
}

function renderAction() {
  const title = document.getElementById('action-title');
  const content = document.getElementById('action-content');
  if (!title || !content || !G) return;
  const officer = G.players[G.currentOfficerIdx];

  if (G.phase === 'skill') {
    title.textContent = `技能牌阶段 — 第${G.round}轮，${officer.name} 为警察`;
    const mySkills = G.players[mySeat] ? G.players[mySeat].hand.filter(c=>c.type==='skill') : [];
    content.innerHTML = `
      <div class="my-action-hint">任意玩家可出技能牌，完成后由警察点击"进入抓捕"。</div>
      <div class="action-area">
        <div class="action-row">
          <span class="action-label">我的技能牌</span>
          <select id="skill-select">
            <option value="">— 选择技能牌 —</option>
            ${mySkills.map(s=>`<option value="${s.id}">${s.name} — ${s.desc}</option>`).join('')}
          </select>
        </div>
        <div class="action-row">
          <span class="action-label">目标玩家</span>
          <select id="skill-target">
            ${G.players.map((p,i)=>p?`<option value="${i}">${p.name}${i===mySeat?' (我)':''}</option>`:'').join('')}
          </select>
        </div>
        <div class="action-row" id="trade-row" style="display:none">
          <span class="action-label">我的牌</span>
          <select id="trade-my-card"></select>
          <span class="action-label" style="min-width:56px">对方的牌</span>
          <select id="trade-their-card"></select>
        </div>
        <div class="action-row">
          <button onclick="useSkill()">出牌</button>
          ${isMyTurn()?`<button class="primary" onclick="advancePhase('arrest')">跳过，进入抓捕 →</button>`:''}
        </div>
      </div>`;
    document.getElementById('skill-select').addEventListener('change', onSkillSelectChange);
    document.getElementById('skill-target').addEventListener('change', onSkillTargetChange);
  }

  else if (G.phase === 'arrest') {
    title.textContent = `抓捕阶段 — ${officer.name} 指定目标`;
    if (!isMyTurn()) {
      content.innerHTML = `<div class="waiting-hint">等待 ${officer.name} 执行抓捕...</div>`;
      return;
    }
    const targets = G.players.filter((p,i)=>p&&i!==mySeat);
    content.innerHTML = `
      <div class="my-action-hint">你是本轮警察，选择目标并猜测罪名。</div>
      <div class="action-area">
        <div class="action-row">
          <span class="action-label">抓捕对象</span>
          <select id="arrest-target" onchange="updateArrestCards()">
            ${targets.map(p=>`<option value="${p.id}">${p.name}</option>`).join('')}
          </select>
        </div>
        <div class="action-row">
          <span class="action-label">指定角色牌</span>
          <select id="arrest-card"></select>
        </div>
        <div class="action-row">
          <span class="action-label">猜测罪名</span>
          <select id="arrest-crime">${CRIMES.map(c=>`<option value="${c}">${c}</option>`).join('')}</select>
        </div>
        <div class="action-row">
          <button class="primary" onclick="doArrest()">执行抓捕</button>
        </div>
      </div>`;
    updateArrestCards();
  }

  else if (G.phase === 'vote') {
    if (!G.trialTarget) return;
    const defendant = G.players[G.trialTarget.playerId];
    const card = defendant.hand[G.trialTarget.cardIdx];
    const isGuilty = card && card.role === 'criminal';
    title.textContent = `审判投票 — 被告：${defendant.name}`;
    const me = G.players[mySeat];
    const myVotes = me ? me.hand.filter(c=>c.type==='vote') : [];
    const amBlocked = me && me.blocked;
    const alreadyVoted = G._votesSubmitted && G._votesSubmitted[mySeat] !== undefined;
    const submitted = G._votesSubmitted ? Object.keys(G._votesSubmitted).map(Number) : [];
    const statusLine = G.players.filter(Boolean).map(p=>
      `${p.name}: ${submitted.includes(p.id)?'已投':'待投'}`
    ).join('　');

    _mySelectedVoteCards = {};
    content.innerHTML = `
      <div class="info-box">
        被指控牌：<strong>${card?card.name:'?'}</strong>　
        ${isGuilty
          ? `<span style="background:#FCEBEB;color:#791F1F;font-size:11px;padding:2px 7px;border-radius:8px">罪名：${card.crime}</span>`
          : `<span style="background:#EEEDFE;color:#3C3489;font-size:11px;padding:2px 7px;border-radius:8px">警察牌</span>`}
        　${G.trialTarget.guessCorrect!==undefined
          ?(G.trialTarget.guessCorrect
            ?'<span style="color:#27500A;font-size:12px">✓ 猜中罪名，罪犯受审</span>'
            :'<span style="color:#D85A30;font-size:12px">✗ 猜错罪名，警察受审</span>'):''}
      </div>
      <div style="font-size:12px;color:#888;margin-bottom:8px">${statusLine}</div>
      ${amBlocked
        ? `<div class="waiting-hint">你被【隔岸观火】禁止本轮投票。<button style="margin-left:8px" onclick="submitMyVote()">确认</button></div>`
        : alreadyVoted
          ? `<div class="waiting-hint">你已提交投票，等待其他玩家...</div>`
          : myVotes.length === 0
            ? `<div class="waiting-hint">你没有投票牌，弃权。<button style="margin-left:8px" onclick="submitMyVote()">确认弃权</button></div>`
            : `<div class="my-action-hint">点击选择要投出的票（可多选），然后选方向提交。</div>
               <div class="action-area">
                 <div class="vote-block">
                   <div class="cards-row" style="margin-bottom:8px">
                     ${myVotes.map(v=>`<span class="card card-vote" id="vcard-${v.id}" onclick="toggleVoteCard('${v.id}')">${v.name}</span>`).join('')}
                   </div>
                   <div class="action-row">
                     <span style="font-size:13px;color:#666">投票方向：</span>
                     <select id="my-vote-dir"><option value="guilty">有罪</option><option value="innocent">无罪</option></select>
                     <button class="primary" onclick="submitMyVote()">提交投票</button>
                   </div>
                 </div>
               </div>`}`;
  }

  else if (G.phase === 'punish') {
    if (!G.trialTarget) return;
    const defendant = G.players[G.trialTarget.playerId];
    const isDefendant = G.trialTarget.playerId === mySeat;
    const isSGTCTarget = G.trialTarget.sgtcTarget === mySeat;
    const verdict = G.trialTarget.verdict;
    title.textContent = `惩罚阶段 — ${defendant.name}`;
    const hasSGTC = defendant.hand.some(c=>c.name==='同甘共苦');

    content.innerHTML = `
      <div class="info-box">
        判决：<strong class="${verdict==='guilty'?'verdict-guilty':'verdict-innocent'}">${verdict==='guilty'?'有罪':'无罪'}</strong>
        ${verdict==='innocent'?'　本轮无惩罚。':''}
      </div>
      ${verdict==='guilty'?`
        ${isDefendant&&hasSGTC?`
          <div class="my-action-hint">你持有【同甘共苦】，可出牌拉一人陪罚。</div>
          <div class="action-row" style="margin-bottom:10px">
            <select id="sgts-target">
              ${G.players.filter((p,i)=>p&&i!==mySeat).map(p=>`<option value="${p.id}">${p.name}</option>`).join('')}
            </select>
            <button onclick="useSGTC()">出【同甘共苦】</button>
          </div>`:''}
        ${isDefendant?`
          <div class="my-action-hint">你是被告，请扣动扳机。</div>
          <div class="action-row" style="margin-bottom:8px">
            <button class="danger" onclick="shootRevolver(${G.trialTarget.playerId})">向自己扣动扳机</button>
          </div>`:''}
        ${isSGTCTarget?`
          <div class="my-action-hint">你被【同甘共苦】拉来陪罚，请扣动扳机。</div>
          <div class="action-row" style="margin-bottom:8px">
            <button class="danger" onclick="shootRevolver(${mySeat})">向自己扣动扳机</button>
          </div>`:''}
        ${!isDefendant&&!isSGTCTarget?`<div class="waiting-hint">等待 ${defendant.name} 扣动扳机...</div>`:''}
      `:''}
      ${isMyTurn()?`
        <div class="action-row" style="margin-top:12px">
          <button class="primary" onclick="nextRound()">结束本轮，进入下一轮 →</button>
        </div>`
        :`<div style="font-size:12px;color:#aaa;margin-top:12px">等待 ${officer.name} 结束本轮...</div>`}`;
  }
}

// ─── 技能牌操作 ──────────────────────────────────────────────

function onSkillSelectChange() {
  const sid = document.getElementById('skill-select')?.value;
  const mySkills = G.players[mySeat]?.hand.filter(c=>c.type==='skill') || [];
  const skill = mySkills.find(s=>s.id===sid);
  const tradeRow = document.getElementById('trade-row');
  if (!tradeRow) return;
  if (skill && skill.name==='移花接木') { tradeRow.style.display='flex'; updateTradeCards(); }
  else tradeRow.style.display = 'none';
}

function onSkillTargetChange() {
  const sid = document.getElementById('skill-select')?.value;
  const skill = G.players[mySeat]?.hand.find(c=>c.id===sid);
  if (skill && skill.name==='移花接木') updateTradeCards();
}

function updateTradeCards() {
  const tid = parseInt(document.getElementById('skill-target')?.value);
  const myEl = document.getElementById('trade-my-card');
  const theirEl = document.getElementById('trade-their-card');
  if (!myEl||!theirEl||isNaN(tid)) return;
  myEl.innerHTML = G.players[mySeat].hand.map(c=>`<option value="${c.id}">${c.name}</option>`).join('');
  theirEl.innerHTML = G.players[tid].hand.map(c=>`<option value="${c.id}">[${G.players[tid].name}] ${c.name}</option>`).join('');
}

async function useSkill() {
  const sid = document.getElementById('skill-select')?.value;
  if (!sid) { alert('请选择技能牌'); return; }
  const user = G.players[mySeat];
  const skillIdx = user.hand.findIndex(c=>c.id===sid);
  if (skillIdx===-1) return;
  const skill = user.hand[skillIdx];
  const tid = parseInt(document.getElementById('skill-target')?.value);
  const target = G.players[tid];

  if (skill.name==='无懈可击') {
    G.players.forEach(p=>{ if(p){p.blocked=false;p.voteFlipped=false;} });
    addLog(`${user.name} 出【无懈可击】— 所有技能效果抵消！`,'skill');
    user.hand.splice(skillIdx,1);
  } else if (skill.name==='隔岸观火') {
    target.blocked = true;
    addLog(`${user.name} 对 ${target.name} 出【隔岸观火】— 禁止投票！`,'skill');
    user.hand.splice(skillIdx,1);
  } else if (skill.name==='借花献佛') {
    if (tid===mySeat) { alert('借花献佛不能用于自己！'); return; }
    target.voteFlipped = true;
    addLog(`${user.name} 对 ${target.name} 出【借花献佛】— 投票翻转！`,'skill');
    user.hand.splice(skillIdx,1);
  } else if (skill.name==='移花接木') {
    const myCardId = document.getElementById('trade-my-card')?.value;
    const theirCardId = document.getElementById('trade-their-card')?.value;
    if (!myCardId||!theirCardId) { alert('请选择要交换的牌'); return; }
    const myI = user.hand.findIndex(c=>c.id===myCardId);
    const theirI = target.hand.findIndex(c=>c.id===theirCardId);
    if (myI===-1||theirI===-1) { alert('找不到指定的牌'); return; }
    const tmp = user.hand[myI];
    user.hand[myI] = target.hand[theirI];
    target.hand[theirI] = tmp;
    addLog(`${user.name} 与 ${target.name} 用【移花接木】互换了一张牌！`,'skill');
    user.hand.splice(user.hand.findIndex(c=>c.id===sid),1);
  } else if (skill.name==='同甘共苦') {
    addLog(`${user.name} 保留【同甘共苦】，可在惩罚阶段使用。`,'skill');
    await saveState(G);
    render();
    return;
  }
  await saveState(G);
  render();
}

async function advancePhase(ph) {
  G.phase = ph;
  await saveState(G);
  render();
}

// ─── 抓捕 ────────────────────────────────────────────────────

function updateArrestCards() {
  const el = document.getElementById('arrest-target');
  if (!el) return;
  const tid = parseInt(el.value);
  const target = G.players[tid];
  const cardSel = document.getElementById('arrest-card');
  if (!cardSel||!target) return;
  const rolecards = target.hand.filter(c=>c.type==='role');
  cardSel.innerHTML = rolecards.length>0
    ? rolecards.map((c,i)=>`<option value="${target.hand.indexOf(c)}">角色牌 ${i+1}</option>`).join('')
    : '<option value="">此玩家无角色牌</option>';
}

async function doArrest() {
  const tidEl = document.getElementById('arrest-target');
  const cardOptEl = document.getElementById('arrest-card');
  const guessedCrime = document.getElementById('arrest-crime')?.value;
  if (!tidEl||!cardOptEl) return;
  const tid = parseInt(tidEl.value);
  const cardIdx = parseInt(cardOptEl.value);
  const officer = G.players[mySeat];
  const target = G.players[tid];
  const card = target.hand[cardIdx];
  if (!card||card.type!=='role') { alert('请选择有效的角色牌'); return; }

  const isCriminal = card.role==='criminal';
  const guessCorrect = isCriminal && card.crime===guessedCrime;
  let defendantPid, trialCardIdx;

  if (isCriminal&&guessCorrect) {
    defendantPid=tid; trialCardIdx=cardIdx;
    addLog(`${officer.name} 抓捕 ${target.name}，指控【${guessedCrime}】— 正确！${target.name} 受审。`,'crime');
  } else if (isCriminal&&!guessCorrect) {
    defendantPid=mySeat;
    trialCardIdx=G.players[mySeat].hand.findIndex(c=>c.type==='role');
    addLog(`${officer.name} 抓捕 ${target.name}，指控【${guessedCrime}】— 错误！${officer.name} 受审。`,'crime');
  } else {
    defendantPid=mySeat;
    trialCardIdx=G.players[mySeat].hand.findIndex(c=>c.type==='role');
    addLog(`${officer.name} 抓捕 ${target.name}，但对方是警察牌！${officer.name} 受审。`,'crime');
  }

  G.trialTarget = {playerId:defendantPid, cardIdx:trialCardIdx, guessCorrect, verdict:null, sgtcTarget:undefined};
  G._votesSubmitted = {};
  G._selectedVotes = {};
  G.phase = 'vote';
  await saveState(G);
  render();
}

// ─── 投票 ────────────────────────────────────────────────────

function toggleVoteCard(vid) {
  const el = document.getElementById('vcard-'+vid);
  if (_mySelectedVoteCards[vid]) {
    delete _mySelectedVoteCards[vid];
    if (el) el.classList.remove('selected');
  } else {
    _mySelectedVoteCards[vid] = true;
    if (el) el.classList.add('selected');
  }
}

async function submitMyVote() {
  const me = G.players[mySeat];
  if (!G._votesSubmitted) G._votesSubmitted = {};
  const myVotes = me ? me.hand.filter(c=>c.type==='vote') : [];
  const dirEl = document.getElementById('my-vote-dir');
  let baseDir = dirEl ? dirEl.value : 'guilty';
  let guiltyW = 0, innocentW = 0;

  myVotes.forEach(v => {
    if (_mySelectedVoteCards[v.id]) {
      let dir = baseDir;
      if (me.voteFlipped) dir = dir==='guilty'?'innocent':'guilty';
      if (dir==='guilty') guiltyW += v.weight;
      else innocentW += v.weight;
      addLog(`${me.name} 投【${v.name}】→ ${dir==='guilty'?'有罪':'无罪'}${me.voteFlipped?' (翻转)':''}`,'vote');
    }
  });

  G._votesSubmitted[mySeat] = {guiltyW, innocentW};
  _mySelectedVoteCards = {};

  const allVoted = G.players.every((p,i)=>!p||p.blocked||G._votesSubmitted[i]!==undefined);
  if (allVoted) {
    let totalGuilty=0, totalInnocent=0;
    Object.values(G._votesSubmitted).forEach(v=>{totalGuilty+=v.guiltyW;totalInnocent+=v.innocentW;});
    const verdict = (totalGuilty===0&&totalInnocent===0)?'innocent':(totalGuilty>=totalInnocent?'guilty':'innocent');
    G.trialTarget.verdict = verdict;
    addLog(`投票汇总 — 有罪权重 ${totalGuilty} vs 无罪权重 ${totalInnocent} → 判决：${verdict==='guilty'?'有罪':'无罪'}`,'vote');
    G.players.forEach(p=>{ if(p){p.blocked=false;p.voteFlipped=false;} });
    G.phase = 'punish';
  }
  await saveState(G);
  render();
}

// ─── 惩罚 ────────────────────────────────────────────────────

async function useSGTC() {
  const selEl = document.getElementById('sgts-target');
  if (!selEl) return;
  const tid = parseInt(selEl.value);
  const defendant = G.players[mySeat];
  const skillIdx = defendant.hand.findIndex(c=>c.name==='同甘共苦');
  if (skillIdx===-1) return;
  defendant.hand.splice(skillIdx,1);
  G.trialTarget.sgtcTarget = tid;
  addLog(`${defendant.name} 出【同甘共苦】— ${G.players[tid].name} 也要受罚！`,'skill');
  await saveState(G);
  render();
}

async function shootRevolver(targetPid) {
  const chamber = G.revolver[G.revolverIdx%6];
  const target = G.players[targetPid];
  if (chamber) {
    target.hp = Math.max(0, target.hp-2);
    addLog(`${target.name} 中弹！体力 -2（剩余 ${target.hp}/4）`,'crime');
    if (target.hp<=0) {
      target.score -= 1;
      target.hp = 4;
      addLog(`${target.name} 体力耗尽，扣 1 分，体力重置为 4`,'system');
    }
  } else {
    addLog(`${target.name} 扣动扳机 — 空弹槽，安全！`,'system');
  }
  G.revolverIdx = (G.revolverIdx+1)%6;
  await saveState(G);
  render();
}

// ─── 下一轮 ──────────────────────────────────────────────────

async function nextRound() {
  G.players.forEach(p=>{ if(p){p.blocked=false;p.voteFlipped=false;} });
  G.trialTarget = null;
  G._votesSubmitted = {};
  G._selectedVotes = {};

  const dealCount = 2;
  for (let i=0;i<4;i++) {
    if (!G.players[i]) continue;
    for (let d=0;d<dealCount;d++) {
      if (G.extraVoteIdx<G.extraVoteDeck.length) {
        G.players[i].hand.push(G.extraVoteDeck[G.extraVoteIdx]);
        G.extraVoteIdx++;
      }
      if (G.extraSkillIdx<G.extraSkillDeck.length) {
        G.players[i].hand.push(G.extraSkillDeck[G.extraSkillIdx]);
        G.extraSkillIdx++;
      }
    }
  }
  addLog(`每人补发 ${dealCount} 张投票牌和 ${dealCount} 张技能牌。`,'system');

  G.currentOfficerIdx = (G.currentOfficerIdx+1)%4;
  G.round++;
  if (G.round>G.totalRounds) {
    G.phase = 'ended';
    addLog('六轮结束，游戏结束！','system');
  } else {
    G.phase = 'skill';
    addLog(`第${G.round}轮：${G.players[G.currentOfficerIdx].name} 担任警察行动。`,'police');
  }
  await saveState(G);
  render();
}

// ─── 启动 ────────────────────────────────────────────────────
initRealtime();
