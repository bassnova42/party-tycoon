// 聚会模式手机端：扫码进房 → 起名选角色 → 等开局。对局动画都在大屏上，这里只放自己的东西。
import {
  CHARS, AVATAR_BONUS, PLAYER_COLORS, SQUARES, GROUPS, JAIL_FINE, BUILD_PER_STOP, mortgageValue, unmortgageCost,
  baseRent, HOUSE_MULT, AIRPORT_RENT, AIRPORTS,
} from '/shared/board.js';
import { legalActions, current, player, totalOwed, saleCost } from '/shared/engine.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n) => `$${Number(n).toLocaleString('en-US')}`;
// 震动：页面被点过之后浏览器才允许
const vib = (pattern) => navigator.userActivation?.hasBeenActive !== false && navigator.vibrate?.(pattern);

const CODE = (location.pathname.split('/')[2] || '').toUpperCase();
const KEY = `mf_phone_${CODE}`;
const S = { ws: null, room: null, me: null, denied: null, claim: new URLSearchParams(location.search).get('claim') || '', retry: 0, sending: false, motion: false,
  moneyQ: [], seenSeq: null, cashAnim: null, autoEndAt: 0 };

const getToken = () => { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } };
const setToken = (t) => { try { localStorage.setItem(KEY, t); } catch {} };

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 2400);
}

function connect() {
  if (S.denied || (S.ws && S.ws.readyState <= 1)) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = S.ws = new WebSocket(`${proto}://${location.host}/ws?party=phone&room=${CODE}&token=${getToken()}${S.claim ? `&claim=${S.claim}` : ''}`);
  ws.onopen = () => { S.retry = 0; };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === 'token') { setToken(m.token); S.claim = ''; }
    if (m.t === 'denied') { S.denied = m; render(); }
    // 抢购慢了一步（地已卖掉，或者别人抢购的动画正在演）：offerNews 会说是谁买走的，不再弹原话
    const late = S.lastAct === 'acceptOffer' && ['现在没有人在卖地', '等大屏演完'].includes(m.msg);
    if (m.t === 'error' && !late) toast(m.msg);
    if (m.t === 'error') { S.sending = false; render(); }
    if (m.t === 'room') {
      const before = S.room;
      S.room = m.room; S.me = m.me;
      S.sending = false;
      if (m.room.autoEnd && !S.autoEndAt) S.autoEndTotal = m.room.autoEnd.left;
      S.autoEndAt = m.room.autoEnd ? performance.now() + m.room.autoEnd.left : 0;
      const g = m.room.game;
      // 新的一步：记下跟我有关的钱，等大屏演完一起播
      if (g && g.seq !== S.seenSeq) {
        if (S.seenSeq != null) S.moneyQ.push(...(g.events || []).filter(e => e.k === 'money' && e.amount && (e.from === m.me || e.to === m.me)));
        S.seenSeq = g.seq;
      }
      // 大屏演完之前，钱数还按演之前的显示（扣钱要等本人在手机上点了、大屏上钱飞走才算）
      if (g && (!m.room.showing || !S.shownCash)) {
        const old = S.shownCash?.[m.me];
        S.shownCash = Object.fromEntries(g.players.map(p => [p.id, p.cash]));
        const now = S.shownCash[m.me];
        if (old != null && now != null && (old !== now || S.moneyQ.length)) playMoney(old, now, S.moneyQ.splice(0));
        else S.moneyQ = [];
      }
      if (!g) { S.shownCash = null; S.moneyQ = []; S.seenSeq = null; }
      buzz(before, m.room);
      offerNews(before?.game, m.room.game);
      render();
    }
  };
  ws.onclose = () => {
    if (S.denied) return;
    render();
    setTimeout(connect, Math.min(5000, 500 * 2 ** S.retry++));
  };
}

const send = (m) => S.ws?.readyState === 1 && S.ws.send(JSON.stringify(m));
const mySeat = () => S.room?.seats.find(s => s.id === S.me);

function render() {
  const app = $('app');
  if (!CODE) return (app.innerHTML = notice('1f914', '地址不对', '请扫大屏上的二维码进入房间'));
  if (S.denied) {
    const face = S.denied.reason === 'full' ? '1f62c' : S.denied.reason === 'started' ? '1f629' : '1f914';
    const free = S.denied.free || [];
    if (!free.length) return (app.innerHTML = notice(face, S.denied.msg, `房间 ${CODE}`));
    // 有人掉线了：刚才退出的人点自己的头像回到座位
    return (app.innerHTML = `${notice(face, S.denied.msg, '刚才掉线了？点你自己回到座位')}
      <div class="claim">${free.map(f => `<button class="char" data-claim="${f.id}">
        ${f.avatar ? `<img src="/avatars/${f.avatar}.webp" alt="">` : '<b>?</b>'}<span>${esc(f.name || '还没起名')}</span></button>`).join('')}</div>`);
  }
  if (!S.room) return (app.innerHTML = notice('1f914', '正在连接…', '手机和电脑要连同一个 Wi-Fi'));
  if (S.room.status === 'waiting') return renderPick(app);
  renderPlaying(app);
}

function notice(face, title, sub) {
  return `<section class="notice"><img src="/avatars/${face}.webp" alt=""><h1>${esc(title)}</h1><p>${esc(sub)}</p></section>`;
}

function header(r) {
  const offline = S.ws?.readyState !== 1;
  return `<header class="top">
    <span class="globe"></span><b>客厅大富翁</b>
    <span class="room">房间 ${esc(r.code)}${offline ? ' · <em>重连中</em>' : ''}</span>
  </header>`;
}

// 开局前：起名 + 选角色
function renderPick(app) {
  const r = S.room, me = mySeat();
  if (!me) return (app.innerHTML = notice('1f914', '正在进房…', `房间 ${r.code}`));
  const idx = r.seats.indexOf(me);
  const takenBy = Object.fromEntries(r.seats.filter(s => s.avatar && s !== me).map(s => [s.avatar, s]));
  const rest = `
    <h2 class="label">${me.ready ? '已选好，等大屏开局' : '选一个角色'} <span>${r.seats.length}/${r.max} 人在房间</span></h2>
    <div class="grid ${me.ready ? 'locked' : ''}">${CHARS.map(c => {
      const t = takenBy[c.code];
      const mine = me.avatar === c.code;
      return `<button class="char ${mine ? 'mine' : ''} ${t ? 'taken' : ''}" data-char="${c.code}" ${t || me.ready ? 'disabled' : ''}>
        <img src="/avatars/${c.code}.webp" alt=""><span>${t ? esc(t.name) : c.name}</span>
        ${AVATAR_BONUS[c.code] ? `<i class="bonus">+${money(AVATAR_BONUS[c.code])}</i>` : ''}</button>`;
    }).join('')}</div>
    <div class="dock">
      ${me.ready
        ? '<button class="btn" data-ready="0">改一改</button>'
        : `<button class="btn gold" data-ready="1" ${me.avatar ? '' : 'disabled'}>我选好了</button>`}
    </div>`;
  const av = me.avatar ? `<img src="/avatars/${me.avatar}.webp" alt="">` : '<span>?</span>';
  // 正在输名字（尤其是拼音选字中）：名字框不动，只换别的部分，否则键盘会收起、拼音会断
  const inp = $('name');
  if (inp && document.activeElement === inp && $('pickRest') && !me.ready) {
    app.querySelector('.me-av').innerHTML = av;
    inp.placeholder = me.avatar ? '' : '先选角色';
    $('pickRest').innerHTML = rest;
    return;
  }
  app.innerHTML = `
    ${header(r)}
    <section class="me" style="--c:${PLAYER_COLORS[idx % PLAYER_COLORS.length]}">
      <div class="me-av">${av}</div>
      <div class="me-main">
        <label for="name">你的名字</label>
        <input id="name" placeholder="${me.avatar ? '' : '先选角色'}" value="${esc(me.name)}" ${me.ready ? 'disabled' : ''} autocomplete="off" enterkeyhint="done">
      </div>
    </section>
    <div id="pickRest">${rest}</div>`;
}

// 震一下：开局、轮到我、要我确认
function buzz(before, room) {
  const g = room.game;
  if (!g) return;
  if (before?.status === 'waiting' && room.status === 'playing') return vib(200);
  const myTurn = (r) => r?.game?.status === 'playing' && !r.showing && current(r.game).id === S.me;
  if (myTurn(room) && !myTurn(before)) vib([120, 80, 120]);
  if (room.waitingFor?.pid === S.me && before?.waitingFor?.pid !== S.me) vib(150);
  if (g.offer && g.offer.from !== S.me && !before?.game?.offer) vib([60, 60, 60]);
}

// 出售结束时告诉没卖成 / 没抢到的人发生了什么
function offerNews(prev, g) {
  const o = prev?.offer;
  if (!o || !g || g.offer?.square === o.square) return;
  const sq = SQUARES[o.square];
  const owner = g.props[o.square]?.owner;
  const seller = player(g, o.from);
  if (owner && owner !== o.from) {
    const buyer = player(g, owner);
    if (owner === S.me) toast(`你买下了${sq.name}！`);
    else if (o.from === S.me) toast(`${buyer.name} 买下了你的${sq.name}`);
    else toast(`被 ${buyer.name} 抢先买走了${sq.name}`);
  } else if (o.from !== S.me) toast(`${seller.name} 收回了${sq.name}`);
  else toast(`没人买，${sq.name}还是你的`);
}

// 这块地现在的过路费（和大屏一样的算法）
function rentNow(g, idx) {
  const sq = SQUARES[idx], pr = g.props[idx];
  if (sq.type === 'country') return baseRent(sq) * HOUSE_MULT[pr.houses || 0];
  if (sq.type === 'airport') return AIRPORT_RENT[AIRPORTS.filter(i => g.props[i]?.owner === pr.owner).length];
  return 0;
}
const houseText = (n) => n === 5 ? '一座酒店' : n ? `${n} 栋房` : '';

const ART = { airport: '✈', utility: '⚡' };
function squareArt(sq) {
  if (sq.flag) return `<img class="flag" src="/flags/${sq.flag}.svg" alt="">`;
  return `<i class="sq-ic">${sq.util === 'water' ? '💧' : ART[sq.type] || ''}</i>`;
}

// 开局后：钱包、轮到我时的操作、要我确认的弹框、我的资产、出手顺序
function renderPlaying(app) {
  const r = S.room, g = r.game;
  const p = g && player(g, S.me);
  if (!p) return (app.innerHTML = notice('1f914', '你不在这局里', '等下一局吧'));
  const order = g.order.map(i => g.players[i]);
  const cur = current(g);
  const ended = g.status === 'ended';
  const myTurn = !ended && cur.id === p.id && !p.bankrupt;
  const locked = r.showing || r.paused || S.sending;
  const acts = myTurn && !locked ? legalActions(g, p.id) : [];
  const cash = (x) => S.shownCash?.[x.id] ?? x.cash;
  const has = (t, extra = {}) => acts.some(a => a.type === t && Object.entries(extra).every(([k, v]) => (a[k] || 0) === v));

  app.innerHTML = `
    ${header(r)}
    <section class="wallet ${myTurn ? 'turn' : ''}" style="--c:${p.color}">
      <img class="w-av" src="/avatars/${p.avatar}.webp" alt="">
      <div class="w-main">
        <div class="w-name">${esc(p.name)}${p.inJail ? '<em>在监狱</em>' : ''}${p.jailCards ? `<em>出狱卡 ×${p.jailCards}</em>` : ''}</div>
        <div class="w-cash ${S.cashAnim ? (S.cashAnim.to > S.cashAnim.from ? 'up' : 'down') : ''}" id="wCash">${p.bankrupt ? '已破产' : money(S.cashAnim ? tweenCash() : cash(p))}</div>
        ${p.owed.length ? `<div class="w-owe">欠 ${money(totalOwed(p))}</div>` : ''}
      </div>
    </section>
    ${!ended && r.waitingFor?.pid === p.id && !r.paused ? confirmHtml(r.waitingFor) : ''}
    ${!ended && g.offer && g.offer.from !== p.id && !p.bankrupt ? offerHtml(g, p, cash(p), r.showing || r.paused || S.sending) : ''}
    ${ended ? resultHtml(g, p) : r.paused ? '<section class="status"><b>已暂停</b><span>等主持人点「继续」</span></section>'
      : r.waitingFor?.pid === p.id ? ''
      : myTurn ? turnHtml(g, p, acts, has, locked)
      : `<section class="status">${p.bankrupt ? '<b>你已经出局了</b><span>看看大家怎么打</span>' : `<b>等待轮到你</b><span>现在是 ${esc(cur.name)} 的回合</span>`}</section>`}
    ${p.bankrupt || ended ? '' : assetsHtml(g, p, acts, myTurn)}
    <h2 class="label">出手顺序 <span>第 ${g.round} 轮</span></h2>
    <ol class="order">${order.map(o => `<li class="${o.id === p.id ? 'me' : ''} ${o.id === cur.id && !ended ? 'cur' : ''} ${o.bankrupt ? 'out' : ''}" style="--c:${o.color}"><img src="/avatars/${o.avatar}.webp" alt=""><span>${esc(o.name)}</span><b>${o.bankrupt ? '破产' : money(cash(o))}</b></li>`).join('')}</ol>`;
}

// 大屏弹框在等我确认：付钱、收下、知道了
function confirmHtml(w) {
  return `
    <section class="confirm tone-${esc(w.tone)}">
      <div class="cf-title">${esc(w.title)}</div>
      ${w.lines.map(l => `<p>${esc(l)}</p>`).join('')}
      ${w.amount ? `<div class="cf-amt">${money(w.amount)}</div>` : ''}
      <button class="btn gold big" data-ack>${esc(w.button)}</button>
      <div class="cf-hint">大屏在等你点</div>
    </section>`;
}

function turnHtml(g, p, acts, has, locked) {
  if (locked) return '<section class="status turn"><b>轮到你了</b><span>先看大屏…</span></section>';
  const b = [];
  let hint = '';
  let selling = '';
  if (g.offer?.from === p.id) {
    const sq = SQUARES[g.offer.square];
    selling = `<div class="selling">${squareArt(sq)}<div><b>正在出售${esc(sq.name)}</b><span>要价 ${money(g.offer.price)} · 大家在手机上抢购</span></div>
      ${has('cancelOffer') ? '<button class="sbtn" data-act="cancelOffer">收回</button>' : ''}</div>`;
  }
  if (g.phase === 'roll') {
    hint = p.inJail ? `在监狱里（第 ${p.jailTurns + 1} 回合）：交 ${money(JAIL_FINE)}、用出狱卡，或者掷出双数出狱` : g.rollAgain ? '掷出双数，再掷一次！' : '掷骰子出发';
    if (has('roll')) b.push(`<button class="btn gold big dice-btn" data-act="roll">🎲 ${p.inJail ? '掷骰子碰运气' : '掷骰子'}</button>`);
    if (has('payJail')) b.push(`<button class="btn" data-act="payJail">交 ${money(JAIL_FINE)} 出狱</button>`);
    if (has('useCard')) b.push('<button class="btn" data-act="useCard">用出狱卡</button>');
    if (has('roll') && S.motion) hint += ' · 摇一摇手机也能掷';
  }
  if (g.phase === 'buy') {
    const sq = SQUARES[g.pending.square];
    hint = `停在了${esc(sq.name)}，还没有主人`;
    b.push(`<div class="buy-card">${squareArt(sq)}<div><b>${esc(sq.name)}</b><span>${sq.group ? GROUPS[sq.group].name : sq.type === 'airport' ? '机场' : '公司'} · 地价 ${money(sq.price)}</span></div></div>`);
    b.push(`<button class="btn gold big" data-act="buy" ${has('buy', { build: 0 }) ? '' : 'disabled'}>买下 ${money(sq.price)}</button>`);
    if (sq.type === 'country') {
      for (let n = 1; n <= BUILD_PER_STOP; n++) {
        b.push(`<button class="btn" data-act="buy" data-build="${n}" ${has('buy', { build: n }) ? '' : 'disabled'}>买下 + 盖 ${n} 栋 ${money(sq.price + n * GROUPS[sq.group].house)}</button>`);
      }
    }
    b.push('<button class="btn ghost" data-act="skip">不买</button>');
  }
  const stopSq = g.stop?.square;
  if (stopSq != null && has('build', { square: stopSq })) {
    const sq = SQUARES[stopSq], pr = g.props[stopSq];
    hint = `停在自己的${esc(sq.name)}，这次还能盖 ${BUILD_PER_STOP - g.stop.built} 栋`;
    b.unshift(`<button class="btn gold big" data-act="build" data-sq="${stopSq}">${pr.houses === 4 ? '升级酒店' : '加盖一栋'} ${money(GROUPS[sq.group].house)}</button>`);
  }
  if (g.phase === 'manage' && !hint) hint = '可以在下面卖房、贷款，然后结束回合';
  if (g.phase === 'debt') {
    hint = `钱不够，欠 ${money(totalOwed(p))}：在下面卖房或抵押贷款凑钱`;
    if (has('payDebt')) b.push(`<button class="btn gold big" data-act="payDebt">还清 ${money(totalOwed(p))}</button>`);
    if (has('bankrupt')) b.push('<button class="btn danger" data-act="bankrupt" data-confirm="确定宣告破产？会直接出局。">宣告破产</button>');
  }
  if (has('end')) b.push('<button class="btn big" data-act="end">结束回合</button>');
  if (has('end') && S.room.autoEnd?.pid === p.id) {
    const left = Math.max(0, S.autoEndAt - performance.now());
    b.push(`<div class="autoend"><i style="--ms:${left}ms;--from:${Math.min(1, left / (S.autoEndTotal || left || 1))}"></i><span><b id="aeLeft">${aeLeft()}</b> 秒后自动结束回合</span><button class="sbtn" data-hold>等一下</button></div>`);
  }
  return `<section class="actions"><div class="a-head"><b>轮到你了</b><span>${hint}</span></div>${selling}${b.join('')}</section>`;
}

// 我的资产：轮到我时可以盖房、卖房、贷款、还贷
function assetsHtml(g, p, acts, myTurn) {
  const can = (type, i) => acts.some(a => a.type === type && a.square === i);
  const mine = Object.entries(g.props).filter(([, pr]) => pr.owner === p.id).map(([i, pr]) => [+i, pr]).sort((a, b) => a[0] - b[0]);
  if (!mine.length) return '<h2 class="label">我的资产</h2><p class="empty">还没有地产</p>';
  const rows = mine.map(([i, pr]) => {
    const sq = SQUARES[i];
    const houses = pr.houses === 5 ? '🏨' : '🏠'.repeat(pr.houses);
    const btns = [];
    if (sq.type === 'country') {
      const h = GROUPS[sq.group].house;
      if (can('build', i)) btns.push(`<button class="sbtn" data-act="build" data-sq="${i}">${pr.houses === 4 ? '升酒店' : '盖房'} ${money(h)}</button>`);
      if (pr.houses) btns.push(`<button class="sbtn" data-act="sell" data-sq="${i}" ${can('sell', i) ? '' : 'disabled'}>卖房 +${money(h / 2)}</button>`);
    }
    if (acts.some(a => a.type === 'offer' && a.square === i)) btns.push(`<button class="sbtn sale" data-sell="${i}">出售</button>`);
    if (g.offer?.square === i) btns.push('<span class="on-sale">出售中</span>');
    btns.push(pr.mortgaged
      ? `<button class="sbtn warn" data-act="unmortgage" data-sq="${i}" ${can('unmortgage', i) ? '' : 'disabled'}>还贷 ${money(unmortgageCost(sq))}</button>`
      : `<button class="sbtn" data-act="mortgage" data-sq="${i}" ${can('mortgage', i) ? '' : 'disabled'}>贷款 +${money(mortgageValue(sq))}</button>`);
    return `<li class="${pr.mortgaged ? 'mort' : ''}">
      <span class="a-band" style="--g:${sq.group ? GROUPS[sq.group].color : '#94a3b8'}"></span>${squareArt(sq)}
      <span class="a-name">${esc(sq.name)}${pr.mortgaged ? '<em>抵押中</em>' : ''}<small>${houses}</small></span>
      <span class="a-btns">${btns.join('')}</span></li>`;
  }).join('');
  return `<h2 class="label">我的资产 <span>${myTurn ? '' : '轮到你时才能办理'}</span></h2><ul class="assets">${rows}</ul>`;
}

// 别人挂出的地：谁先点谁买
function offerHtml(g, p, myCash, locked) {
  const o = g.offer, sq = SQUARES[o.square], pr = g.props[o.square];
  const seller = player(g, o.from);
  const afford = myCash >= o.price;
  return `
    <section class="offer" style="--c:${seller.color}">
      <div class="of-head"><img src="/avatars/${seller.avatar}.webp" alt=""><span>${esc(seller.name)} 在卖地</span></div>
      <div class="of-what">${squareArt(sq)}<div><b>${esc(sq.name)}</b>
        <span class="of-tags"><em>${pr.houses ? `连${houseText(pr.houses)}` : '空地'}</em>${pr.mortgaged ? '<em class="mort">抵押中</em>' : ''}<em>过路费 ${money(rentNow(g, o.square))}</em></span></div></div>
      <div class="of-price">${money(o.price)}</div>
      <button class="btn gold big" data-buy-offer="${o.square}" ${afford && !locked ? '' : 'disabled'}>${locked ? '看大屏…' : afford ? `抢购 ${money(o.price)}` : '钱不够'}</button>
      <div class="cf-hint">你有 ${money(myCash)}${pr.mortgaged ? ` · 买下后要自己还贷 ${money(unmortgageCost(sq))} 才能收租` : ''}</div>
    </section>`;
}

// 卖家定价面板：默认成本 + $100
function openSell(idx) {
  if (S.room?.autoEnd?.pid === S.me) send({ t: 'hold' });   // 要定价了，别自动结束
  const g = S.room.game, sq = SQUARES[idx], pr = g.props[idx];
  const cost = saleCost(g, idx);
  const h = GROUPS[sq.group]?.house || 0;
  S.pricing = { idx, cost, price: cost + 100 };
  const sheet = $('sheet');
  sheet.innerHTML = `
    <div class="sh-box">
      <div class="sh-head">${squareArt(sq)}<b>出售${esc(sq.name)}</b></div>
      <p class="sh-note">连地带房子一起卖给其他玩家，谁先点谁买。</p>
      <table class="sh-cost">
        <tr><td>地价</td><td>${money(sq.price)}</td></tr>
        ${pr.houses ? `<tr><td>${houseText(pr.houses)}（每栋 ${money(h)}）</td><td>${money(pr.houses * h)}</td></tr>` : ''}
        <tr class="sum"><td>成本</td><td>${money(cost)}</td></tr>
      </table>
      ${pr.mortgaged ? `<p class="sh-warn">这块地抵押中，买家接手后要自己还贷 ${money(unmortgageCost(sq))} 才能收租。</p>` : ''}
      <div class="stepper">
        <button class="sbtn" data-d="-100">-100</button><button class="sbtn" data-d="-10">-10</button>
        <input id="salePrice" inputmode="numeric" value="${S.pricing.price}" aria-label="要价">
        <button class="sbtn" data-d="10">+10</button><button class="sbtn" data-d="100">+100</button>
      </div>
      <div class="sh-diff" id="saleDiff"></div>
      <div class="sh-btns"><button class="btn ghost" data-sell-no>算了</button><button class="btn gold" data-sell-ok></button></div>
    </div>`;
  sheet.classList.add('show');
  showPrice();
}
function showPrice() {
  const { price, cost } = S.pricing;
  const d = price - cost;
  $('saleDiff').innerHTML = d >= 0 ? `比成本多赚 <b class="pos">${money(d)}</b>` : `比成本少 <b class="neg">${money(-d)}</b>`;
  document.querySelector('[data-sell-ok]').textContent = `挂出 ${money(price)}`;
}
function closeSell() {
  S.pricing = null;
  $('sheet').classList.remove('show');
}

function resultHtml(g, p) {
  const k = g.ranking.findIndex(x => x.id === p.id);
  const me = g.ranking[k];
  const win = g.winner === p.id;
  return `
    <section class="result ${win ? 'win' : ''}">
      <img src="/avatars/${win ? '1f973' : k === g.ranking.length - 1 ? '1f62d' : '1f914'}.webp" alt="">
      <b>${win ? '你赢了！' : `第 ${k + 1} 名`}</b>
      <span>${me.bankrupt ? '破产出局' : `净资产 ${money(me.worth)}`} · 共 ${g.ranking.length} 人</span>
    </section>`;
}

// 摇一摇掷骰：加速度突然变大算一次；iPhone 要先在点击里请求权限，http 下拿不到数据就只用按钮
let lastShake = 0;
function onMotion(e) {
  const a = e.acceleration?.x != null ? e.acceleration : null;
  const g = e.accelerationIncludingGravity;
  if (!a && !g) return;
  if (!S.motion) { S.motion = true; render(); }
  const mag = a ? Math.hypot(a.x, a.y, a.z) : Math.abs(Math.hypot(g.x, g.y, g.z) - 9.8);
  if (mag < 15 || Date.now() - lastShake < 800) return;
  lastShake = Date.now();
  const r = S.room, gm = r?.game;
  if (!gm || gm.status !== 'playing' || r.showing || r.paused || S.sending) return;
  if (current(gm).id !== S.me || !legalActions(gm, S.me).some(x => x.type === 'roll')) return;
  doAct({ type: 'roll' });
}
let motionAsked = false;
function askMotion() {
  if (motionAsked) return;
  motionAsked = true;
  const req = window.DeviceMotionEvent?.requestPermission;
  if (req) req.call(DeviceMotionEvent).then(st => { if (st === 'granted') addEventListener('devicemotion', onMotion); }).catch(() => {});
  else addEventListener('devicemotion', onMotion);
}

function doAct(action) {
  if (S.sending) return;
  S.sending = true;
  S.lastAct = action.type;
  send({ t: 'act', action });
  vib(30);
  render();
  setTimeout(() => { if (S.sending) { S.sending = false; render(); } }, 4000);
}

document.addEventListener('click', (e) => {
  askMotion();
  const ac = e.target.closest('[data-act]');
  if (ac && !ac.disabled) {
    if (ac.dataset.confirm && !confirm(ac.dataset.confirm)) return;
    const action = { type: ac.dataset.act };
    if (ac.dataset.sq) action.square = +ac.dataset.sq;
    if (ac.dataset.build) action.build = +ac.dataset.build;
    return doAct(action);
  }
  if (e.target.closest('[data-ack]')) { send({ t: 'ack' }); vib(30); return; }
  const sell = e.target.closest('[data-sell]');
  if (sell) return openSell(+sell.dataset.sell);
  const d = e.target.closest('[data-d]');
  if (d && S.pricing) {
    S.pricing.price = Math.max(10, S.pricing.price + +d.dataset.d);
    $('salePrice').value = S.pricing.price;
    return showPrice();
  }
  if (e.target.closest('[data-sell-no]') || e.target.id === 'sheet') return closeSell();
  if (e.target.closest('[data-sell-ok]') && S.pricing) {
    const { idx, price } = S.pricing;
    closeSell();
    return doAct({ type: 'offer', square: idx, price });
  }
  const buyOffer = e.target.closest('[data-buy-offer]');
  if (buyOffer && !buyOffer.disabled) {
    const o = S.room?.game?.offer;
    if (!o || o.square !== +buyOffer.dataset.buyOffer) return;
    if (!confirm(`花 ${money(o.price)} 买下${SQUARES[o.square].name}？`)) return;
    return doAct({ type: 'acceptOffer' });
  }
  if (e.target.closest('[data-hold]')) { send({ t: 'hold' }); vib(15); return; }
  const cl = e.target.closest('[data-claim]');
  if (cl) { S.claim = cl.dataset.claim; S.denied = null; render(); return connect(); }
  const ch = e.target.closest('[data-char]');
  if (ch && !ch.disabled) { send({ t: 'pick', code: ch.dataset.char }); vib(15); return; }
  const rd = e.target.closest('[data-ready]');
  if (rd && !rd.disabled) {
    const inp = $('name');
    if (inp && rd.dataset.ready === '1') send({ t: 'name', v: inp.value });
    send({ t: 'ready', v: rd.dataset.ready === '1' });
  }
});

let nameTimer;
document.addEventListener('input', (e) => {
  if (e.target.id === 'salePrice' && S.pricing) {
    S.pricing.price = Math.max(1, Math.round(+e.target.value.replace(/\D/g, '')) || 1);
    return showPrice();
  }
  if (e.target.id !== 'name' || e.isComposing) return;   // 拼音还没选字，先别发
  clearTimeout(nameTimer);
  nameTimer = setTimeout(() => send({ t: 'name', v: e.target.value }), 400);
});

document.addEventListener('compositionend', (e) => {
  if (e.target.id !== 'name') return;
  clearTimeout(nameTimer);
  nameTimer = setTimeout(() => send({ t: 'name', v: e.target.value }), 400);
});
// 名字输完再刷新一次，显示服务器截好的名字
document.addEventListener('focusout', (e) => {
  if (e.target.id !== 'name' || e.target.disabled) return;
  clearTimeout(nameTimer);
  const me = mySeat(), v = [...e.target.value.trim()].slice(0, 6).join('');
  if (me && v && v !== me.name) { me.name = v; send({ t: 'name', v }); }
  setTimeout(render, 0);
});
document.addEventListener('keydown', (e) => { if (e.target.id === 'name' && e.key === 'Enter' && !e.isComposing) e.target.blur(); });

// ---------- 钱的变化：钱数滚动 + 每一笔一张小卡（谁、为什么、多少） ----------
const aeLeft = () => Math.max(1, Math.ceil((S.autoEndAt - performance.now()) / 1000));
function tweenCash() {
  const a = S.cashAnim, t = Math.min(1, (performance.now() - a.start) / a.dur);
  return Math.round(a.from + (a.to - a.from) * (1 - (1 - t) ** 3));
}

function moneyCard(e) {
  const g = S.room.game, other = e.from === S.me ? e.to : e.from;
  const o = other ? player(g, other) : null;
  const gain = e.to === S.me;
  const who = o ? (gain ? `${esc(o.name)} 付给你` : `你付给 ${esc(o.name)}`) : (gain ? '银行付给你' : '你付给银行');
  const el = document.createElement('div');
  el.className = `mcard ${gain ? 'up' : 'down'}`;
  el.innerHTML = `<img src="/avatars/${o ? o.avatar : '1f4b0'}.webp" alt=""><div><b>${who}</b><span>${esc(e.why || '')}</span></div><em>${gain ? '+' : '−'}${money(Math.abs(e.amount))}</em>`;
  return el;
}

function playMoney(from, to, items) {
  const feed = $('money');
  items.slice(-4).forEach((e, k) => setTimeout(() => {
    const el = moneyCard(e);
    feed.append(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 400); }, 3200);
  }, k * 450));
  if (from === to) return;
  vib(to > from ? [30, 40, 30] : 60);
  S.cashAnim = { from, to, start: performance.now(), dur: Math.min(1600, 600 + items.length * 250) };
  const tick = () => {
    const el = $('wCash');
    if (!S.cashAnim) return;
    if (el) el.textContent = money(tweenCash());
    if (performance.now() - S.cashAnim.start < S.cashAnim.dur) return requestAnimationFrame(tick);
    S.cashAnim = null;
    el?.classList.remove('up', 'down');
    render();
  };
  requestAnimationFrame(tick);
}

// 自动结束回合的倒数
setInterval(() => { const el = $('aeLeft'); if (el) el.textContent = aeLeft(); }, 250);

// 锁屏回来立刻重连
document.addEventListener('visibilitychange', () => { if (!document.hidden) connect(); });

render();
connect();
