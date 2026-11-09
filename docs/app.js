/* 持股雷達 前端：解密報告、顯示分析、編輯持股、訂閱推播 */
(() => {
'use strict';
const CFG = window.APP_CONFIG || {};
const $ = (s, el = document) => el.querySelector(s);
const app = $('#app');
const enc = new TextEncoder(), dec = new TextDecoder();
let REPORT = null, CHARTS = [];

// ---------- 儲存 ----------
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};
const getPw = () => store.get('pw') || sessionStorage.getItem('pw');

// ---------- 加解密（與 backend/crypto_box.py 相容）----------
const b64 = u8 => btoa(String.fromCharCode(...u8));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function key(pw, salt, iter) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function decryptBox(box, pw) {
  const k = await key(pw, unb64(box.salt), box.iter || 200000);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, k, unb64(box.ct));
  return JSON.parse(dec.decode(pt));
}
async function encryptBox(obj, pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const k = await key(pw, salt, 200000);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, enc.encode(JSON.stringify(obj))));
  return { v: 1, iter: 200000, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}

// ---------- 格式 ----------
const fmt = (n, d = 2) => n == null || isNaN(n) ? '—' : Number(n).toLocaleString('zh-TW', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmt0 = n => fmt(n, 0);
const cls = n => n > 0 ? 'up' : n < 0 ? 'down' : 'flat';
const sign = n => n > 0 ? '+' : '';
const pct = (n, d = 2) => n == null ? '—' : `${sign(n)}${fmt(n, d)}%`;
const money = n => {
  if (n == null) return '—';
  const a = Math.abs(n);
  if (a >= 1e8) return fmt(n / 1e8, 2) + ' 億';
  if (a >= 1e4) return fmt(n / 1e4, 1) + ' 萬';
  return fmt0(n);
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const trendBadge = t => `<span class="badge ${t === '多頭' ? 'b-bull' : t === '空頭' ? 'b-bear' : 'b-side'}">${esc(t)}</span>`;
const ICON = { danger: '🔴', warn: '🟠', buy: '🟢', info: '🔵' };
function toast(msg, ms = 2600) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), ms);
}

// ---------- 持股與進出記錄計算 ----------
const FEE_RATE = 0.001425, SELL_FEE_TAX = 0.001425 + 0.003;
const uid = () => Math.random().toString(36).slice(2, 9);
const today = () => { const d = new Date(Date.now() + 8 * 3600e3); return d.toISOString().slice(0, 10); };
function calcFee(price, shares, disc) {
  const amt = price * shares; if (!amt) return 0;
  return Math.max(shares >= 1000 ? 20 : 1, Math.floor(amt * FEE_RATE * (disc || 10) / 10));
}
const calcTax = (code, price, shares) => Math.floor(price * shares * (String(code).startsWith('00') ? 0.001 : 0.003));
const SIDE = { buy: '買進', sell: '賣出', init: '現有持股' };
// 依時間重播每筆買賣 → 剩餘股數、平均成本（含買進手續費）、已實現損益
function posOf(h) {
  let sh = 0, ct = 0, real = 0;
  const rows = (h.trades || []).map((t, i) => ({ ...t, _i: i }))
    .sort((a, b) => (a.side === 'init' ? '' : a.date || '').localeCompare(b.side === 'init' ? '' : b.date || '') || a._i - b._i)
    .map(t => {
      if (t.side === 'sell') {
        const avg = sh ? ct / sh : 0, q = Math.min(t.shares, sh);
        const pl = t.price * t.shares - (t.fee || 0) - (t.tax || 0) - avg * t.shares;
        real += pl; ct -= avg * q; sh -= q;
        if (sh <= 0) { sh = 0; ct = 0; }
        return { ...t, avg, pl: Math.round(pl) };
      }
      sh += t.shares; ct += t.price * t.shares + (t.side === 'buy' ? (t.fee || 0) : 0);
      return t;
    });
  return { shares: sh, cost: sh ? ct / sh : null, realized: Math.round(real), rows };
}
// 舊格式（只有 stocks）自動轉成「帳戶＋進出記錄」格式
function normPf(pf0) {
  const pf = structuredClone(pf0 || {});
  pf.settings = { stop_pct: 8, notify_days_before: 7, fee_discount: 10, ...(pf.settings || {}) };
  pf.accounts = pf.accounts || [];
  if (!pf.holdings) pf.holdings = (pf.stocks || []).map(s => ({
    id: uid(), account: null, code: s.code, name: s.name || '',
    trades: s.shares > 0 && s.cost ? [{ id: uid(), side: 'init', date: '', price: Number(s.cost), shares: Number(s.shares), fee: 0, tax: 0 }] : [],
  }));
  return pf;
}
// 存檔前：把計算結果寫回每個持倉，並產生後端用的「每檔合計」清單
function finalizePf(pf) {
  pf.version = 2;
  pf.holdings = pf.holdings.filter(h => /^\d{4,6}[A-Z]?$/.test(h.code));
  const by = {};
  pf.holdings.forEach(h => {
    const p = posOf(h);
    h.shares = p.shares; h.cost = p.cost == null ? null : +p.cost.toFixed(4); h.realized = p.realized;
    const b = by[h.code] || (by[h.code] = { code: h.code, name: h.name, shares: 0, ct: 0 });
    b.shares += p.shares; b.ct += (p.cost || 0) * p.shares;
  });
  pf.stocks = Object.values(by).map(b => ({ code: b.code, name: b.name, shares: b.shares, cost: b.shares ? +(b.ct / b.shares).toFixed(4) : null }));
  return pf;
}
const PF = () => normPf(REPORT.portfolio);
const acctName = (pf, id) => pf.accounts.find(a => a.id === id)?.name || '未分類';
const validAcct = (pf, id) => pf.accounts.some(a => a.id === id);
// 每個持倉 + 最新行情 → 損益
function positionsView(pf) {
  return pf.holdings.map(h => {
    const p = posOf(h), s = REPORT.stocks.find(x => x.code === h.code), t = s?.tech || {};
    const close = t.close, costT = p.cost ? p.cost * p.shares : 0;
    const value = close != null ? close * p.shares : null;
    return { h, p, s, t, acct: validAcct(pf, h.account) ? h.account : null, value, costT,
      gross: value != null && p.cost ? value - costT : null,
      pct: p.cost && close != null ? (close - p.cost) / p.cost * 100 : null,
      net: value != null && p.cost ? value * (1 - SELL_FEE_TAX) - costT : null,
      day: (t.chg || 0) * p.shares };
  });
}
function sumUp(list) {
  const o = { value: 0, cost: 0, pnl: 0, net: 0, day: 0, realized: 0 };
  list.forEach(x => {
    o.realized += x.p.realized;
    if (x.value == null || !x.p.shares) return;
    o.value += x.value; o.cost += x.costT; o.pnl += x.gross || 0; o.net += x.net || 0; o.day += x.day;
  });
  o.pct = o.cost ? o.pnl / o.cost * 100 : null;
  return o;
}
let ACCT = sessionStorage.getItem('acct') || 'all';
function acctChips(pf) {
  const groups = [...pf.accounts, ...(pf.holdings.some(h => !validAcct(pf, h.account)) && pf.accounts.length ? [{ id: 'none', name: '未分類' }] : [])];
  if (!groups.length) return '';
  if (ACCT !== 'all' && !groups.some(g => g.id === ACCT)) ACCT = 'all';
  return `<div class="switcher acct-chips">${[{ id: 'all', name: '全部' }, ...groups].map(g =>
    `<a href="#" data-acct="${g.id}" class="${g.id === ACCT ? 'on' : ''}">${esc(g.name)}</a>`).join('')}</div>`;
}
function bindAcctChips(rerender) {
  document.querySelectorAll('[data-acct]').forEach(a => a.onclick = e => {
    e.preventDefault(); ACCT = a.dataset.acct; sessionStorage.setItem('acct', ACCT); rerender();
  });
}
const inAcct = x => ACCT === 'all' || (ACCT === 'none' ? x.acct == null : x.acct === ACCT);

// ---------- 資料 ----------
async function loadReport(pw) {
  const r = await fetch('data/report.enc?t=' + Date.now(), { cache: 'no-store' });
  if (!r.ok) throw new Error('尚未產生報告（' + r.status + '）');
  return decryptBox(await r.json(), pw);
}

// ---------- GitHub API（儲存持股、訂閱、觸發更新）----------
const gh = {
  token: () => store.get('gh_token'),
  repo: () => store.get('gh_repo') || CFG.repo,
  async req(path, opt = {}) {
    const r = await fetch('https://api.github.com/repos/' + gh.repo() + path, {
      ...opt, headers: { Authorization: 'Bearer ' + gh.token(), Accept: 'application/vnd.github+json', ...(opt.headers || {}) },
    });
    if (!r.ok && r.status !== 404) throw new Error('GitHub ' + r.status + '：' + (await r.text()).slice(0, 120));
    return r;
  },
  async getJson(file) {
    const r = await gh.req('/contents/' + file + '?ref=' + (CFG.branch || 'main'));
    if (r.status === 404) return { sha: null, data: null };
    const j = await r.json();
    return { sha: j.sha, data: JSON.parse(atob(j.content.replace(/\n/g, ''))) };
  },
  async putJson(file, obj, sha, message) {
    const body = { message, content: btoa(JSON.stringify(obj)), branch: CFG.branch || 'main' };
    if (sha) body.sha = sha;
    await gh.req('/contents/' + file, { method: 'PUT', body: JSON.stringify(body) });
  },
  async dispatch() {
    const r = await gh.req('/actions/workflows/update.yml/dispatches', { method: 'POST', body: JSON.stringify({ ref: CFG.branch || 'main' }) });
    if (r.status === 404) throw new Error('找不到 workflow');
  },
};
const needGh = () => { if (!gh.token() || !gh.repo()) { toast('請先在設定頁填入 GitHub 金鑰'); location.hash = '#/settings'; return true; } return false; };

// ---------- 頁面 ----------
function destroyCharts() { CHARTS.forEach(c => c.remove()); CHARTS = []; }

function viewLock(err) {
  $('#tabbar').hidden = true;
  app.innerHTML = `
  <div class="card" style="margin-top:24px">
    <h3>🔒 請輸入 App 密碼</h3>
    <p class="muted small">你的持股資料是加密的，只有輸入正確密碼才能解開。</p>
    <form id="lockf">
      <input type="password" id="pw" autocomplete="current-password" placeholder="密碼" required>
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="remember" checked style="width:auto"> 在這台裝置記住密碼（點通知可直接打開）</label>
      <button class="primary" style="width:100%;margin-top:8px">解鎖</button>
      ${err ? `<p class="down small">${esc(err)}</p>` : ''}
    </form>
  </div>`;
  $('#lockf').onsubmit = async e => {
    e.preventDefault();
    const pw = $('#pw').value;
    try {
      REPORT = await loadReport(pw);
      if ($('#remember').checked) store.set('pw', pw); else sessionStorage.setItem('pw', pw);
      route();
    } catch (er) { viewLock(er.name === 'OperationError' ? '密碼錯誤' : er.message); }
  };
}

function viewHome() {
  const R = REPORT, pf = PF();
  const all = positionsView(pf), list = all.filter(inAcct);
  const S = sumUp(list);
  const codes = new Set(list.map(x => x.h.code));
  const alerts = [];
  R.stocks.filter(s => codes.has(s.code)).forEach(s => (s.tech?.signals || []).filter(x => x.level !== 'info')
    .filter(x => !x.account || ACCT === 'all' || x.account === ACCT).forEach(x => alerts.push({ s, x })));
  const soon = R.events.filter(e => e.days >= 0 && e.days <= 7 && codes.has(e.code));
  const live = list.filter(x => x.p.shares > 0 || !x.p.rows.length), closed = list.filter(x => !x.p.shares && x.p.rows.length);
  const groups = ACCT === 'all' && pf.accounts.length
    ? [...pf.accounts.map(a => ({ id: a.id, name: a.name })), { id: null, name: '未分類' }].map(g => ({ ...g, items: live.filter(x => x.acct === g.id) })).filter(g => g.items.length)
    : [{ id: '', name: '', items: live }];
  app.innerHTML = `
  ${acctChips(pf)}
  <div class="card">
    ${ACCT !== 'all' ? `<div class="muted small" style="margin-bottom:4px">📁 ${esc(ACCT === 'none' ? '未分類' : acctName(pf, ACCT))}</div>` : ''}
    <div class="row wrap">
      <div class="stat"><div class="label">未實現損益</div>
        <div class="value big ${cls(S.pnl)}">${sign(S.pnl)}${fmt0(S.pnl)}</div>
        <div class="${cls(S.pnl)} num">${pct(S.pct)}</div></div>
      <div class="stat" style="text-align:right"><div class="label">今日損益</div>
        <div class="value ${cls(S.day)}">${sign(S.day)}${fmt0(S.day)}</div></div>
    </div>
    <div class="grid2" style="margin-top:12px">
      <div class="stat"><div class="label">市值</div><div class="num">${fmt0(S.value)}</div></div>
      <div class="stat"><div class="label">成本</div><div class="num">${fmt0(S.cost)}</div></div>
      <div class="stat"><div class="label">已實現損益</div><div class="num ${cls(S.realized)}">${sign(S.realized)}${fmt0(S.realized)}</div></div>
      <div class="stat"><div class="label">現在全賣淨損益*</div><div class="num ${cls(S.net)}">${sign(S.net)}${fmt0(S.net)}</div></div>
    </div>
    <div class="muted small" style="margin-top:6px">* 扣除手續費 0.1425% 與證交稅 0.3% 的估計值；已實現損益來自「紀錄」裡的賣出記錄</div>
  </div>
  ${alerts.length ? `<div class="card"><h3>需要注意 <span class="muted">${alerts.length} 則</span></h3>
    ${alerts.slice(0, 8).map(({ s, x }) => `<a href="#/stock/${s.code}" class="sig ${x.level}" style="color:inherit">
      <span class="ic">${ICON[x.level]}</span><div><div class="t">${esc(s.name)}｜${esc(x.title)}</div><div class="d">${esc(x.detail)}</div></div></a>`).join('')}
  </div>` : ''}
  ${soon.length ? `<div class="card"><h3>📅 7 天內事件</h3>${soon.map(eventRow).join('')}</div>` : ''}
  ${groups.map(g => {
    const st = sumUp(g.items);
    return `<div class="grp-h"><h3>${g.name ? '📁 ' + esc(g.name) : '我的持股'}</h3>
      ${g.name ? `<span class="small num ${cls(st.pnl)}">${sign(st.pnl)}${fmt0(st.pnl)}（${pct(st.pct)}）</span>` : ''}</div>
      ${g.items.map(stockCard).join('')}`;
  }).join('') || '<p class="center muted">這個帳戶還沒有股票，到「設定」新增</p>'}
  ${closed.length ? `<p class="small muted center">已出清 ${closed.length} 檔（${closed.map(x => esc(x.h.name)).join('、')}），明細在「紀錄」</p>` : ''}
  <p class="disclaimer">技術與估值分析僅供參考，不構成投資建議。投資前請自行判斷風險。</p>`;
  bindAcctChips(viewHome);
}

function stockCard(x) {
  const { h, p, s, t } = x;
  if (!s) return `<div class="card stock"><div class="row"><div><span class="name">${esc(h.name)}</span><span class="code">${h.code}</span></div></div>
    <div class="meta muted">⏳ 新加入，雲端分析中（約 3～5 分鐘）</div></div>`;
  const top = (t.signals || []).filter(z => !z.account || z.account === h.account)[0];
  return `<a class="card stock" href="#/stock/${h.code}">
    <div class="row"><div><span class="name">${esc(s.name)}</span><span class="code">${h.code}</span> ${t.trend ? trendBadge(t.trend) : ''}</div>
      <div class="price num ${cls(t.chg)}">${fmt(t.close)}</div></div>
    <div class="row small"><span class="muted">${p.shares ? `${fmt0(p.shares)} 股・成本 ${fmt(p.cost)}` : '觀察中'}</span>
      <span class="num ${cls(t.chg)}">${sign(t.chg)}${fmt(t.chg)}（${pct(t.chg_pct)}）</span></div>
    ${x.gross != null && p.shares ? `<div class="row" style="margin-top:6px"><span class="small muted">損益</span>
      <span class="num ${cls(x.gross)}" style="font-weight:700">${sign(x.gross)}${fmt0(x.gross)}（${pct(x.pct)}）</span></div>` : ''}
    ${top ? `<div class="meta">${ICON[top.level]} ${esc(top.title)}</div>` : ''}
    ${s.chips ? `<div class="meta">🏦 ${esc(s.chips.verdict)}｜${esc(s.chips.verdict_note)}</div>` : ''}
    <div class="go">查看分析 ›</div>
    ${s.errors?.length ? `<div class="meta down">⚠️ ${esc(s.errors[0])}</div>` : ''}
  </a>`;
}

function eventRow(e) {
  const d = new Date(e.date + 'T00:00:00+08:00');
  return `<div class="event ${e.days <= 7 ? 'soon' : ''}">
    <div class="dd"><b>${d.getMonth() + 1}/${d.getDate()}</b><small>${e.days === 0 ? '今天' : e.days < 0 ? '已過' : e.days + ' 天後'}</small></div>
    <div><div><a href="#/stock/${e.code}">${esc(e.name || '')}</a> ${esc(e.title)}${e.estimated ? ' <span class="tag">預估</span>' : ''}</div>
      <div class="small muted">${esc(e.detail || '')}</div></div></div>`;
}

function viewEvents() {
  const evs = REPORT.events.filter(e => e.days >= -1);
  app.innerHTML = `<div class="card"><h3>📅 財報・除權息行事曆</h3>
    ${evs.length ? evs.map(eventRow).join('') : '<p class="muted">未來 90 天沒有事件</p>'}
    <p class="muted small">財報日期為法定公布截止日（Q1 5/15、Q2 8/14、Q3 11/14、年報 3/31），公司可能提早公布。事件前 7 天與前 1 天會推播提醒。</p></div>`;
}

function tradeRow(t, h, pf, showStock = true) {
  const amt = t.price * t.shares;
  return `<div class="trade">
    <div class="tside ${t.side === 'sell' ? 'down' : t.side === 'buy' ? 'up' : ''}">${SIDE[t.side]}</div>
    <div class="tmain">
      ${showStock ? `<div><a href="#/stock/${h.code}"><b>${esc(h.name)}</b></a> <span class="muted small">${h.code}</span> <span class="tag">${esc(acctName(pf, h.account))}</span></div>` : ''}
      <div class="small">${fmt0(t.shares)} 股 × ${fmt(t.price)}${t.side === 'init' ? '（平均成本）' : `＝${fmt0(amt)}`}</div>
      ${t.side !== 'init' ? `<div class="small muted">${t.date || ''}${t.fee ? `・手續費 ${fmt0(t.fee)}` : ''}${t.tax ? `・交易稅 ${fmt0(t.tax)}` : ''}</div>` : ''}
    </div>
    <div class="tpl">${t.side === 'sell' ? `<div class="small muted">損益</div><b class="num ${cls(t.pl)}">${sign(t.pl)}${fmt0(t.pl)}</b>` : ''}</div>
  </div>`;
}
function viewTrades() {
  const pf = PF();
  const items = [];
  pf.holdings.forEach(h => { const acct = validAcct(pf, h.account) ? h.account : null; if (!inAcct({ acct })) return; posOf(h).rows.forEach(t => items.push({ t, h })); });
  items.sort((a, b) => (b.t.side === 'init' ? '' : b.t.date || '').localeCompare(a.t.side === 'init' ? '' : a.t.date || ''));
  const sells = items.filter(x => x.t.side === 'sell');
  const real = sells.reduce((a, x) => a + x.t.pl, 0), wins = sells.filter(x => x.t.pl > 0).length;
  const byMonth = {};
  items.forEach(x => { const k = x.t.side === 'init' ? '現有持股（期初）' : (x.t.date || '').slice(0, 7).replace('-', ' 年 ') + ' 月'; (byMonth[k] = byMonth[k] || []).push(x); });
  app.innerHTML = `
  ${acctChips(pf)}
  <div class="card">
    <div class="row wrap">
      <div class="stat"><div class="label">已實現損益</div><div class="value big ${cls(real)}">${sign(real)}${fmt0(real)}</div></div>
      <div class="stat" style="text-align:right"><div class="label">賣出 ${sells.length} 筆</div><div class="num">${sells.length ? `勝率 ${fmt0(wins / sells.length * 100)}%` : '—'}</div></div>
    </div>
    <p class="small muted" style="margin:6px 0 0">新增買賣：設定 → 帳戶與持股 → 點股票 → 加入一筆</p>
  </div>
  ${Object.entries(byMonth).map(([m, xs]) => {
    const r = xs.filter(x => x.t.side === 'sell').reduce((a, x) => a + x.t.pl, 0);
    return `<div class="card"><div class="row"><h3 style="margin:0">${esc(m)}</h3>${xs.some(x => x.t.side === 'sell') ? `<span class="small num ${cls(r)}">${sign(r)}${fmt0(r)}</span>` : ''}</div>
      ${xs.map(x => tradeRow(x.t, x.h, pf)).join('')}</div>`;
  }).join('') || '<p class="center muted">還沒有進出記錄</p>'}`;
  bindAcctChips(viewTrades);
}

let STOCK_TAB = sessionStorage.getItem('tab') || 'trend';
const STOCK_TABS = [['trend', '走勢訊號'], ['chips', '法人籌碼'], ['fin', '財報估值'], ['news', '新聞事件']];
function viewStock(code) {
  const s = REPORT.stocks.find(x => x.code === code);
  if (!s) { app.innerHTML = '<p class="center muted">找不到這檔股票</p>'; return; }
  const t = s.tech || {}, v = s.valuation, f = s.financials, rv = s.revenue, c = s.competitiveness;
  const pf = PF(), mine = positionsView(pf).filter(x => x.h.code === code);
  const held = mine.filter(x => x.p.shares > 0), trades = mine.flatMap(x => x.p.rows.map(r => ({ t: r, h: x.h })));
  const panes = {
    trend: () => `
  <div class="card"><h3>走勢圖 <span class="muted small">日K・近一年</span></h3>
    <div class="legend" id="lg"></div>
    <div class="chart" id="ck"></div>
    <div class="seg"><button data-sub="macd" class="primary">MACD</button><button data-sub="kd">KD</button><button data-sub="vol">成交量</button></div>
    <div class="legend" id="lg2"></div>
    <div class="chart sub" id="cs"></div>
  </div>
  <div class="card"><h3>買賣訊號</h3>
    ${(t.signals || []).length ? t.signals.map(x => `<div class="sig ${x.level}"><span class="ic">${ICON[x.level]}</span><div><div class="t">${esc(x.title)}</div><div class="d">${esc(x.detail)}</div></div></div>`).join('') : '<p class="muted">今日無特別訊號</p>'}
    <p class="small muted" style="margin:4px 0 0">趨勢判斷：${esc(t.trend_note || '')}｜均線：${esc(t.ma_state || '')}</p>
  </div>
  <div class="card"><h3>關鍵價位</h3>
    <dl class="levels">
      ${t.stop_price ? `<dt>停損參考</dt><dd class="down" style="font-weight:700">${fmt(t.stop_price)} <span class="muted small">（前低 ${fmt(t.last_low)} 或成本 -${fmt0(t.stop_pct)}%，取較高者）</span></dd>` : ''}
      <dt>壓力</dt><dd>${(t.resistance || []).map(x => fmt(x)).join('、') || '—'}</dd>
      <dt>支撐</dt><dd>${(t.support || []).map(x => fmt(x)).join('、') || '—'}</dd>
      <dt>前波高點</dt><dd>${fmt(t.last_high)}</dd>
      <dt>前波低點</dt><dd>${fmt(t.last_low)}</dd>
      <dt>均線</dt><dd class="small">5日 ${fmt(t.ma?.ma5)}｜10日 ${fmt(t.ma?.ma10)}｜月 ${fmt(t.ma?.ma20)}｜季 ${fmt(t.ma?.ma60)}</dd>
      <dt>買進參考</dt><dd>${t.buy_zone ? `<b>${fmt(t.buy_zone[0])} ～ ${fmt(t.buy_zone[1])}</b><br>` : ''}<span class="small">${esc(t.buy_note || '')}</span></dd>
    </dl>
    <h3 style="margin-top:14px">順勢做多檢查表</h3>
    <ul class="check">${(t.checklist || []).map(x => `<li>${x.ok ? '✅' : '⬜️'} ${esc(x.name)}</li>`).join('')}</ul>
  </div>
  <div class="card"><h3>每日行情 <span class="muted small">近 20 個交易日</span></h3>
    <div class="tbl-wrap"><table><tr><th>日期</th><th>開盤</th><th>最高</th><th>最低</th><th>收盤</th><th>漲跌</th><th>張數</th></tr>
    ${(() => { const b = t.series?.bars || []; return b.slice(-20).map((x, i, a) => { const pi = b.length - a.length + i - 1; const ch = pi >= 0 ? x[4] - b[pi][4] : 0;
      return `<tr><td>${x[0].slice(5)}</td><td>${fmt(x[1])}</td><td>${fmt(x[2])}</td><td>${fmt(x[3])}</td><td class="${cls(ch)}"><b>${fmt(x[4])}</b></td><td class="${cls(ch)}">${sign(ch)}${fmt(ch)}</td><td>${fmt0(x[5])}</td></tr>`; }).reverse().join(''); })()}
    </table></div></div>`,
    chips: () => chipsPane(s),
    fin: () => `
  ${v ? `<div class="card"><h3>EPS 與本益比估值</h3>
    <div class="row wrap"><div><div class="verdict ${v.status === '便宜' || v.status === '合理偏低' ? 'up' : v.status === '偏貴' || v.status === '昂貴' ? 'down' : ''}">${esc(v.status || '—')}</div>
      <div class="small muted">${esc(v.status_note || '')}</div></div></div>
    <div class="grid3" style="margin-top:10px">
      <div class="stat"><div class="label">近四季 EPS</div><div class="num">${fmt(v.eps_ttm)}</div></div>
      <div class="stat"><div class="label">本益比</div><div class="num">${fmt(v.per_now)} 倍</div></div>
      <div class="stat"><div class="label">殖利率</div><div class="num">${fmt(v.dividend_yield)}%</div></div>
      <div class="stat"><div class="label">最新季 EPS</div><div class="num">${fmt(v.last_q_eps)}</div></div>
      <div class="stat"><div class="label">年化 EPS</div><div class="num">${fmt(v.eps_annualized)}</div></div>
      <div class="stat"><div class="label">年化本益比</div><div class="num">${fmt(v.per_fwd)} 倍</div></div>
    </div>
    ${v.price_bands ? `<div class="tbl-wrap" style="margin-top:10px"><table>
      <tr><th>本益比河流</th><th>本益比</th><th>對應股價</th></tr>
      ${[['最低', 'min'], ['便宜（25%）', 'p25'], ['合理（中位）', 'p50'], ['偏貴（75%）', 'p75'], ['最高', 'max']].map(([n, k]) =>
        `<tr><td>${n}</td><td>${fmt(v.per_bands[k], 1)} 倍</td><td>${fmt(v.price_bands[k])}</td></tr>`).join('')}
      <tr><td><b>目前</b></td><td><b>${fmt(v.per_now, 1)} 倍</b></td><td><b>${fmt(t.close)}</b></td></tr>
    </table></div><p class="small muted">合理價區間 ${fmt(v.fair_range?.[0])} ～ ${fmt(v.fair_range?.[1])}｜基準：${esc(v.band_source || '')}</p>` : ''}
    ${v.growth_note ? `<p class="small" style="color:var(--warn)">💡 ${esc(v.growth_note)}</p>` : ''}
  </div>` : ''}

  ${f ? `<div class="card"><h3>財報比較 <span class="muted small">${f.cur_q} vs 上季 ${f.prev_q || '—'} / 去年同季 ${f.yago_q || '—'}</span></h3>
    <div class="row"><div class="verdict ${f.verdict === '進步' ? 'up' : f.verdict === '退步' ? 'down' : ''}">${f.verdict === '進步' ? '📈 ' : f.verdict === '退步' ? '📉 ' : ''}${esc(f.verdict)}</div>
      <div class="small muted">改善 ${f.better} 項・衰退 ${f.worse} 項</div></div>
    <div class="tbl-wrap"><table>
      <tr><th>項目</th><th>${f.cur_q}</th><th>季增<br>vs ${f.prev_q || '—'}</th><th>年增<br>vs ${f.yago_q || '—'}</th></tr>
      ${f.rows.map(r => {
        const val = r.kind === 'amount' ? money(r.cur) : r.kind === 'margin' ? fmt(r.cur) + '%' : fmt(r.cur);
        const ch = (x, base) => {
          if (r.kind !== 'margin' && base != null && r.cur != null && (base < 0 || r.cur < 0)) {
            const t = base < 0 && r.cur > 0 ? ['轉盈', 1] : base > 0 && r.cur < 0 ? ['轉虧', -1] : r.cur > base ? ['虧損縮小', 1] : ['虧損擴大', -1];
            return `<span class="chip ${cls(t[1])}">${t[0]}</span>`;
          }
          if (x == null) return '—';
          const txt = r.kind === 'margin' ? sign(x) + fmt(x, 1) + '點' : Math.abs(x) >= 1000 ? sign(x) + fmt(x / 100, 0) + '倍' : pct(x, 1);
          return `<span class="chip ${cls(x)}">${txt}</span>`;
        };
        return `<tr><td>${esc(r.name)}</td><td>${val}</td><td>${ch(r.qoq, r.prev)}</td><td>${ch(r.yoy, r.yago)}</td></tr>`;
      }).join('')}
    </table></div>
    <details style="margin-top:8px"><summary>近 8 季明細</summary><div class="tbl-wrap"><table>
      <tr><th>季度</th><th>營收</th><th>毛利率</th><th>營益率</th><th>EPS</th></tr>
      ${f.history.slice().reverse().map(h => `<tr><td>${h.q}</td><td>${money(h.revenue)}</td><td>${fmt(h.gross_margin)}%</td><td>${fmt(h.op_margin)}%</td><td>${fmt(h.eps)}</td></tr>`).join('')}
    </table></div></details>
    <p class="small muted">利潤率的變化以「百分點」表示；其他項目以 % 表示。紅色＝進步、綠色＝退步。</p>
  </div>` : ''}

  ${rv ? `<div class="card"><h3>月營收 <span class="muted small">今年累計年增 ${pct(rv.cum_yoy, 1)}</span></h3>
    <div class="tbl-wrap"><table><tr><th>月份</th><th>營收</th><th>月增</th><th>年增</th></tr>
    ${rv.months.slice(-6).reverse().map(m => `<tr><td>${m.ym}</td><td>${money(m.revenue)}</td><td class="${cls(m.mom)}">${pct(m.mom, 1)}</td><td class="${cls(m.yoy)}">${pct(m.yoy, 1)}</td></tr>`).join('')}
    </table></div></div>` : ''}` || '<p class="center muted">尚無財報資料</p>',
    news: () => `
  ${c ? `<div class="card"><h3>公司競爭力評估</h3>
    <div class="row"><div class="verdict">${esc(c.label)}</div><div class="muted small">${c.score} / 5</div></div>
    <div class="meter">${[1, 2, 3, 4, 5].map(i => `<i class="${i <= c.score ? 'on' : ''}"></i>`).join('')}</div>
    <ul class="reasons">${c.reasons.map(([k, txt]) => `<li class="${k === '+' ? 'p' : k === '-' ? 'n' : 'z'}">${esc(txt)}</li>`).join('')}</ul>
    ${c.topics.length ? `<p class="small muted" style="margin-bottom:0">近期新聞焦點：${c.topics.map(([n, k]) => `${esc(n)}(${k})`).join('、')}</p>` : ''}
    <p class="small muted" style="margin-top:4px">以營收、利潤率與可信新聞語氣綜合評分（規則式，非 AI）。</p>
  </div>` : ''}

  <div class="card news"><h3>可信新聞 <span class="muted small">近 7 天・已過濾 ${Object.values(s.news_dropped || {}).reduce((a, b) => a + b, 0)} 則</span></h3>
    ${(s.news || []).map(n => `<a href="${esc(n.url)}" target="_blank" rel="noopener">
      <div class="nt">${esc(n.title)}</div>
      <div class="nm">${n.important ? '<span class="tag imp">重要</span>' : ''}${n.tone === '正面' ? '<span class="tag pos">正面</span>' : n.tone === '負面' ? '<span class="tag neg">負面</span>' : ''}${n.cats.map(x => `<span class="tag">${esc(x)}</span>`).join('')}</div>
      <div class="ns">📰 ${esc(n.source || '來源不明')}　🕒 ${newsTime(n.ts)}</div></a>`).join('') || '<p class="muted">近 7 天沒有可信來源的重要新聞</p>'}
    <details><summary>過濾掉的新聞統計</summary><p class="small muted">${Object.entries(s.news_dropped || {}).map(([k, n]) => `${esc(k)} ${n} 則`).join('、')}</p></details>
  </div>

  ${s.events?.length ? `<div class="card"><h3>近期事件</h3>${s.events.map(e => eventRow({ ...e, name: '', code: s.code })).join('')}</div>` : ''}`,
  };
  app.innerHTML = `
  <div class="switcher">${REPORT.stocks.map(x => `<a href="#/stock/${x.code}" data-swap class="${x.code === code ? 'on' : ''}">${esc(x.name)} <small class="${cls(x.tech?.chg)}">${pct(x.tech?.chg_pct, 1)}</small></a>`).join('')}</div>
  <div class="card">
    <div class="row"><div><span style="font-size:20px;font-weight:800">${esc(s.name)}</span> <span class="muted">${s.code}</span></div>${trendBadge(t.trend || '—')}</div>
    <div class="row" style="margin-top:6px;align-items:flex-end">
      <div><div class="stat"><div class="value big num ${cls(t.chg)}">${fmt(t.close)}</div></div>
        <div class="num ${cls(t.chg)}">${sign(t.chg)}${fmt(t.chg)}（${pct(t.chg_pct)}）</div></div>
      <div class="small muted" style="text-align:right">${t.date || ''} 收盤<br>成交 ${fmt0(t.volume)} 張</div>
    </div>
    ${held.length ? `<div class="tbl-wrap" style="margin-top:12px"><table class="pos">
      <tr><th>帳戶</th><th>股數</th><th>成本</th><th>損益</th></tr>
      ${held.map(x => `<tr><td>${esc(acctName(pf, x.h.account))}</td><td>${fmt0(x.p.shares)}</td><td>${fmt(x.p.cost)}</td>
        <td class="${cls(x.gross)}"><b>${sign(x.gross)}${fmt0(x.gross)}</b><br><small>${pct(x.pct)}</small></td></tr>`).join('')}
    </table></div>
    ${(s.positions || []).filter(x => x.stop_price && x.account_name).length > 1 ? `<p class="small" style="margin:6px 0 0">停損參考：${s.positions.filter(x => x.stop_price).map(x => `${esc(x.account_name)} <b class="down">${fmt(x.stop_price)}</b>`).join('・')}</p>` : ''}` : ''}
    ${trades.length ? `<details style="margin-top:8px"><summary>這檔的進出記錄（${trades.length} 筆）</summary>
      ${trades.slice().reverse().map(x => tradeRow(x.t, x.h, pf, false).replace('<div class="tmain">', `<div class="tmain"><span class="tag">${esc(acctName(pf, x.h.account))}</span>`)).join('')}</details>` : ''}
  </div>
  <div class="stabs">${STOCK_TABS.map(([k, n]) => `<button data-tab="${k}">${n}</button>`).join('')}</div>
  <div id="tabbody"></div>
  <p class="disclaimer">技術、籌碼與估值分析僅供參考，不構成投資建議。</p>`;
  const render = tab => {
    if (!panes[tab]) tab = 'trend';
    STOCK_TAB = tab; sessionStorage.setItem('tab', tab);
    destroyCharts();
    $('#tabbody').innerHTML = panes[tab]();
    document.querySelectorAll('.stabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
    if (tab === 'trend') drawCharts(t);
    if (tab === 'chips') drawChips(s.chips);
  };
  document.querySelectorAll('.stabs button').forEach(b => b.onclick = () => {
    render(b.dataset.tab);
    const top = $('.stabs').offsetTop - 60;
    if (window.scrollY > top) window.scrollTo({ top, behavior: 'smooth' });
  });
  document.querySelectorAll('[data-swap]').forEach(a => a.onclick = e => { e.preventDefault(); location.replace(a.getAttribute('href')); });
  $('.switcher .on')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  render(STOCK_TAB);
}

function chipsPane(s) {
  const C = s.chips;
  if (!C) return '<div class="card"><p class="muted">尚無法人資料（下次更新後出現）</p></div>';
  const G = C.groups, H = C.holding;
  const n = x => x == null ? '—' : `<span class="${cls(x)}">${sign(x)}${fmt0(x)}</span>`;
  const streak = x => !x ? '—' : `<span class="${cls(x)}">${x > 0 ? '連買' : '連賣'} ${Math.abs(x)} 天</span>`;
  const NAMES = { foreign: '外資', trust: '投信', dealer: '自營商' };
  return `
  <div class="card"><h3>法人籌碼 <span class="muted small">${C.date}</span></h3>
    <div class="row"><div class="verdict ${C.verdict === '籌碼偏多' ? 'up' : C.verdict === '籌碼偏空' ? 'down' : ''}">${esc(C.verdict)}</div></div>
    <div class="small muted">${esc(C.verdict_note)}</div>
    <div class="tbl-wrap" style="margin-top:10px"><table>
      <tr><th>單位：張</th><th>今日</th><th>近 5 日</th><th>近 20 日</th><th>連續</th></tr>
      ${Object.entries(NAMES).map(([k, nm]) => `<tr><td>${nm}</td><td>${n(G[k].today)}</td><td>${n(G[k].sum5)}</td><td>${n(G[k].sum20)}</td><td>${streak(G[k].streak)}</td></tr>`).join('')}
    </table></div>
    ${H ? `<div class="grid3" style="margin-top:12px">
      <div class="stat"><div class="label">外資持股比例</div><div class="value num">${fmt(H.now)}%</div></div>
      <div class="stat"><div class="label">近 5 日變化</div><div class="value num ${cls(H.chg5)}">${sign(H.chg5)}${fmt(H.chg5)}</div></div>
      <div class="stat"><div class="label">近 20 日變化</div><div class="value num ${cls(H.chg20)}">${sign(H.chg20)}${fmt(H.chg20)}</div></div>
    </div><p class="small muted" style="margin:4px 0 0">持股比例變化單位為百分點；20 日減少超過 1 個百分點視為外資撤出。</p>` : ''}
  </div>
  ${C.signals.length ? `<div class="card"><h3>籌碼警示</h3>${C.signals.map(x => `<div class="sig ${x.level}"><span class="ic">${ICON[x.level]}</span><div><div class="t">${esc(x.title)}</div><div class="d">${esc(x.detail)}</div></div></div>`).join('')}</div>` : ''}
  <div class="card"><h3>每日買賣超 <span class="muted small">近 60 日・張</span></h3>
    <div class="seg"><button data-chip="foreign" class="primary">外資</button><button data-chip="trust">投信</button><button data-chip="dealer">自營商</button><button data-chip="total">合計</button></div>
    <div class="legend" id="lgc"></div>
    <div class="chart" id="cc" style="height:200px"></div>
    ${H ? `<h3 style="margin-top:14px">外資持股比例 <span class="muted small">%</span></h3><div class="legend" id="lgh"></div><div class="chart sub" id="ch" style="height:130px"></div>` : ''}
  </div>
  <div class="card"><h3>近 10 日明細 <span class="muted small">張</span></h3>
    <div class="tbl-wrap"><table><tr><th>日期</th><th>外資</th><th>投信</th><th>自營商</th><th>合計</th><th>收盤</th></tr>
    ${C.daily.slice(-10).reverse().map(r => `<tr><td>${r.date.slice(5)}</td><td>${n(r.foreign)}</td><td>${n(r.trust)}</td><td>${n(r.dealer)}</td><td><b>${n(r.total)}</b></td><td>${fmt(r.close)}</td></tr>`).join('')}
    </table></div>
    <p class="small muted">大買／大賣＝單日買賣超超過近 60 日平均的 2 倍，且占當日成交量一定比例（外資 5%、投信 1.5%）。</p>
  </div>`;
}

function drawChips(C) {
  if (!C || !window.LightweightCharts) return;
  const LC = window.LightweightCharts, up = css('--up'), dn = css('--down');
  const opt = h => ({ height: h, layout: { background: { color: 'transparent' }, textColor: css('--muted'), fontSize: 11 },
    grid: { vertLines: { visible: false }, horzLines: { color: css('--line') } }, rightPriceScale: { borderVisible: false },
    timeScale: { borderVisible: false }, crosshair: { mode: 0 }, handleScale: false, handleScroll: false, localization: { locale: 'zh-TW' } });
  const chart = LC.createChart($('#cc'), opt(200));
  CHARTS.push(chart);
  const hist = chart.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false, priceFormat: { type: 'volume' } });
  const NAMES = { foreign: '外資', trust: '投信', dealer: '自營商', total: '三大法人合計' };
  let key = 'foreign';
  const idx = {}; C.daily.forEach((r, i) => idx[r.date] = i);
  const L = i => { const r = C.daily[i]; if (r) $('#lgc').innerHTML = `<span>${r.date}</span><span>${NAMES[key]} <b class="${cls(r[key])}">${sign(r[key])}${fmt0(r[key])}</b> 張</span><span>收盤 ${fmt(r.close)}</span>`; };
  const set = k => {
    key = k;
    hist.setData(C.daily.map(r => ({ time: r.date, value: r[k], color: r[k] >= 0 ? up : dn })));
    chart.timeScale().fitContent(); L(C.daily.length - 1);
  };
  chart.subscribeCrosshairMove(p => L(p.time && idx[p.time] != null ? idx[p.time] : C.daily.length - 1));
  document.querySelectorAll('[data-chip]').forEach(b => b.onclick = () => {
    document.querySelectorAll('[data-chip]').forEach(x => x.classList.toggle('primary', x === b)); set(b.dataset.chip);
  });
  set('foreign');
  if (C.holding && $('#ch')) {
    const hc = LC.createChart($('#ch'), opt(130));
    CHARTS.push(hc);
    const line = hc.addLineSeries({ color: css('--ma5'), lineWidth: 2, priceLineVisible: false, lastValueVisible: true });
    line.setData(C.holding.series.map(([d, v]) => ({ time: d, value: v })));
    hc.timeScale().fitContent();
    const hs = C.holding.series, hi = {}; hs.forEach((x, i) => hi[x[0]] = i);
    const LH = i => { const x = hs[i]; if (x) $('#lgh').innerHTML = `<span>${x[0]}</span><span><i style="background:var(--ma5)"></i>外資持股 ${fmt(x[1])}%</span>`; };
    LH(hs.length - 1);
    hc.subscribeCrosshairMove(p => LH(p.time && hi[p.time] != null ? hi[p.time] : hs.length - 1));
  }
  const ro = new ResizeObserver(() => CHARTS.forEach(c => c.applyOptions && c.applyOptions({ width: c.chartElement?.().parentElement?.clientWidth })));
  ro.observe($('#cc'));
  CHARTS.push({ remove: () => ro.disconnect() });
}


// ---------- 圖表 ----------
function css(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
function drawCharts(t) {
  destroyCharts();
  if (!window.LightweightCharts || !t.series) return;
  const S = t.series, LC = window.LightweightCharts;
  const opt = h => ({
    height: h, layout: { background: { color: 'transparent' }, textColor: css('--muted'), fontSize: 11 },
    grid: { vertLines: { visible: false }, horzLines: { color: css('--line') } },
    rightPriceScale: { borderVisible: false }, timeScale: { borderVisible: false },
    crosshair: { mode: 0 }, handleScale: { axisPressedMouseMove: false }, localization: { locale: 'zh-TW' },
  });
  const up = css('--up'), dn = css('--down');
  const main = LC.createChart($('#ck'), opt(300));
  const candle = main.addCandlestickSeries({ upColor: up, downColor: dn, borderUpColor: up, borderDownColor: dn, wickUpColor: up, wickDownColor: dn, priceLineVisible: false });
  candle.setData(S.bars.map(b => ({ time: b[0], open: b[1], high: b[2], low: b[3], close: b[4] })));
  const MAS = [['ma5', '5日', '--ma5'], ['ma10', '10日', '--ma10'], ['ma20', '月線', '--ma20'], ['ma60', '季線', '--ma60']];
  const maSeries = MAS.map(([k, , c]) => {
    const s = main.addLineSeries({ color: css(c), lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    s.setData(S.bars.map((b, i) => S[k][i] == null ? { time: b[0] } : { time: b[0], value: S[k][i] }));
    return s;
  });
  const lastH = S.pivots_high.at(-1), lastL = S.pivots_low.at(-1);
  const markers = [
    lastH && { time: lastH[0], position: 'aboveBar', shape: 'arrowDown', color: css('--text2'), text: '前高 ' + fmt(lastH[1]) },
    lastL && { time: lastL[0], position: 'belowBar', shape: 'arrowUp', color: css('--text2'), text: '前低 ' + fmt(lastL[1]) },
  ].filter(Boolean).sort((x, y) => x.time < y.time ? -1 : 1);
  candle.setMarkers(markers);
  if (t.stop_price) candle.createPriceLine({ price: t.stop_price, color: dn, lineStyle: 2, lineWidth: 1, axisLabelVisible: true, title: '停損' });
  if (REPORT) {
    const s = REPORT.stocks.find(x => x.tech === t), pf = PF();
    const held = s ? positionsView(pf).filter(x => x.h.code === s.code && x.p.shares > 0) : [];
    held.forEach(x => candle.createPriceLine({ price: x.p.cost, color: css('--text2'), lineStyle: 1, lineWidth: 1, axisLabelVisible: true,
      title: held.length > 1 ? '成本・' + acctName(pf, x.h.account) : '成本' }));
  }
  const n = S.bars.length;
  main.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 90), to: n });

  const lg = $('#lg');
  const idx = {}; S.bars.forEach((b, i) => idx[b[0]] = i);
  const legend = i => {
    const b = S.bars[i]; if (!b) return;
    const ch = i > 0 ? b[4] - S.bars[i - 1][4] : 0;
    lg.innerHTML = `<span>${b[0]}</span><span>開 ${fmt(b[1])}</span><span>高 ${fmt(b[2])}</span><span>低 ${fmt(b[3])}</span><span class="${cls(ch)}">收 ${fmt(b[4])}</span>` +
      MAS.map(([k, name, c]) => `<span><i style="background:var(${c})"></i>${name} ${fmt(S[k][i])}</span>`).join('');
  };
  legend(n - 1);
  main.subscribeCrosshairMove(p => legend(p.time && idx[p.time] != null ? idx[p.time] : n - 1));

  let sub = null;
  const lg2 = $('#lg2');
  const drawSub = kind => {
    if (sub) { sub.remove(); CHARTS = CHARTS.filter(c => c !== sub); }
    sub = LC.createChart($('#cs'), { ...opt(110), timeScale: { visible: false } });
    CHARTS.push(sub);
    const T = S.bars.map(b => b[0]);
    let lines = [];
    if (kind === 'macd') {
      const h = sub.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
      h.setData(T.map((d, i) => ({ time: d, value: S.osc[i], color: S.osc[i] >= 0 ? up : dn })));
      lines = [['DIF', S.dif, '--ma5'], ['MACD', S.dea, '--ma10']];
    } else if (kind === 'kd') {
      lines = [['K', S.k, '--ma5'], ['D', S.d, '--ma10']];
    } else {
      const h = sub.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false, priceFormat: { type: 'volume' } });
      h.setData(S.bars.map((b, i) => ({ time: b[0], value: b[5], color: i && b[4] < S.bars[i - 1][4] ? dn : up })));
    }
    lines.forEach(([, data, c]) => {
      const s = sub.addLineSeries({ color: css(c), lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      s.setData(T.map((d, i) => ({ time: d, value: data[i] })));
    });
    const L = i => {
      lg2.innerHTML = kind === 'vol' ? `<span>成交量 ${fmt0(S.bars[i]?.[5])} 張</span>` :
        lines.map(([name, data, c]) => `<span><i style="background:var(${c})"></i>${name} ${fmt(data[i])}</span>`).join('') +
        (kind === 'macd' ? `<span>柱狀 ${fmt(S.osc[i], 3)}</span>` : '');
    };
    L(n - 1);
    sub.subscribeCrosshairMove(p => L(p.time && idx[p.time] != null ? idx[p.time] : n - 1));
    sub.timeScale().setVisibleLogicalRange(main.timeScale().getVisibleLogicalRange());
  };
  main.timeScale().subscribeVisibleLogicalRangeChange(r => { if (r && sub) sub.timeScale().setVisibleLogicalRange(r); });
  document.querySelectorAll('[data-sub]').forEach(btn => btn.onclick = () => {
    document.querySelectorAll('[data-sub]').forEach(b => b.classList.toggle('primary', b === btn));
    drawSub(btn.dataset.sub);
  });
  drawSub('macd');
  CHARTS.push(main);
  const ro = new ResizeObserver(() => { main.applyOptions({ width: $('#ck')?.clientWidth || 300 }); sub?.applyOptions({ width: $('#cs')?.clientWidth || 300 }); });
  ro.observe($('#ck'));
  CHARTS.push({ remove: () => ro.disconnect() });
}


// ---------- 股票代號自動帶出名稱 ----------
let STOCKS = null, STOCK_MAP = {};
async function loadStockList() {
  if (STOCKS) return;
  try {
    const j = await (await fetch('stocklist.json')).json();
    STOCKS = j.stocks; STOCKS.forEach(x => STOCK_MAP[x[0]] = x);
  } catch { STOCKS = []; }
}
function stockHint(code) {
  if (!code) return '';
  const x = STOCK_MAP[String(code).toUpperCase()];
  if (x) return `✓ ${esc(x[1])}・${x[2]}・${esc(x[3])}`;
  return STOCKS && /^\d{4,6}[A-Z]?$/.test(code) ? '<span class="down">找不到這個代號，請確認</span>' : '';
}
// 代號輸入：完全正確 → 呼叫 onPick；只打前幾碼 → 顯示建議
function suggest(inp, wrap, onPick) {
  const box = wrap.querySelector('.sugg'), hint = wrap.querySelector('.hint');
  const q = inp.value.trim().toUpperCase();
  const pick = x => { inp.value = x[0]; box.hidden = true; box.innerHTML = ''; hint.innerHTML = stockHint(x[0]); onPick(x); };
  if (STOCK_MAP[q]) return pick(STOCK_MAP[q]);
  hint.innerHTML = stockHint(q);
  const list = !q || !STOCKS ? [] : STOCKS.filter(x => x[0].startsWith(q)).slice(0, 8);
  box.innerHTML = list.map(x => `<button type="button" data-c="${x[0]}"><b>${x[0]}</b> ${esc(x[1])} <small class="muted">${x[2]}・${esc(x[3])}</small></button>`).join('');
  box.hidden = !list.length;
  box.querySelectorAll('button').forEach(b => b.onpointerdown = e => { e.preventDefault(); pick(STOCK_MAP[b.dataset.c]); });
}

function newsTime(ts) {
  const d = new Date(ts * 1000), p = n => String(n).padStart(2, '0');
  const h = (Date.now() - d) / 3600e3;
  const ago = h < 1 ? '剛剛' : h < 24 ? `${Math.floor(h)} 小時前` : `${Math.floor(h / 24)} 天前`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${'日一二三四五六'[d.getDay()]}）${p(d.getHours())}:${p(d.getMinutes())}・${ago}`;
}

// ---------- 設定 ----------
let DRAFT = null, OPEN = null, SIDE_SEL = null, DIRTY = false;
// 數字欄位：點進去時整格選取，直接打新數字就會取代，不用先刪掉 0
function selectOnFocus(root = document) {
  root.querySelectorAll('input.num').forEach(inp => inp.onfocus = () => {
    if (inp.value === '0') inp.value = '';
    setTimeout(() => { try { inp.setSelectionRange(0, inp.value.length); } catch { inp.select(); } }, 0);
  });
}
function viewSettings() {
  const pf = DRAFT || (DRAFT = normPf(REPORT.portfolio));
  const set = pf.settings;
  const pushState = 'Notification' in window ? Notification.permission : 'unsupported';
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  app.innerHTML = `
  <div class="card"><h3>帳戶與持股</h3>
    <p class="small muted">點股票可以加入買進／賣出記錄，App 會自動算出股數、平均成本與已實現損益。</p>
    <div id="hold"></div>
    <div class="addacct"><input id="newacct" placeholder="新帳戶名稱，例：元大 小明"><button id="addacct">＋ 新增帳戶</button></div>
    <button class="primary" id="save" style="width:100%;margin-top:12px">儲存並更新</button>
    <p class="small muted center" id="dirty" hidden style="color:var(--warn)">有尚未儲存的變更</p>
  </div>
  <div class="card"><h3>警示與費用設定</h3>
    <div class="grid2">
      <div><label>停損比例（%）</label><input id="stop" value="${set.stop_pct}" inputmode="decimal" class="num"></div>
      <div><label>事件提前幾天通知</label><input id="nd" value="${set.notify_days_before}" inputmode="numeric" pattern="[0-9]*" class="num"></div>
      <div><label>手續費折數（6 折填 6，無折扣填 10）</label><input id="disc" value="${set.fee_discount}" inputmode="decimal" class="num"></div>
    </div>
  </div>
  <div class="card"><h3>通知</h3>
    <p class="small">目前狀態：<b>${pushState === 'granted' ? '已開啟' : pushState === 'denied' ? '已封鎖（請到系統設定開啟）' : pushState === 'unsupported' ? '此瀏覽器不支援' : '未開啟'}</b></p>
    ${!standalone && /iPhone|iPad/.test(navigator.userAgent) ? '<p class="small" style="color:var(--warn)">iPhone 需先用 Safari「分享 → 加入主畫面」，從主畫面圖示打開後才能開啟通知。</p>' : ''}
    <button id="push" class="primary">在這台裝置開啟通知</button>
    <button id="testpush">測試通知</button>
  </div>
  <div class="card"><h3>雲端連線（GitHub）</h3>
    <p class="small muted">用來儲存持股、通知訂閱，並在按「立即更新」時觸發雲端重新分析。</p>
    <label>Repository（帳號/專案名）</label><input id="repo" value="${esc(gh.repo() || '')}" placeholder="yourname/stock-tracker">
    <label>GitHub 金鑰（Fine-grained token）</label><input id="tok" type="password" value="${esc(gh.token() || '')}" placeholder="github_pat_...">
    <div class="row" style="margin-top:10px"><button id="savegh">儲存連線</button><button id="refresh" class="primary">立即更新資料</button></div>
  </div>
  <div class="card"><button id="logout" style="width:100%">登出（清除此裝置的密碼）</button></div>
  <p class="disclaimer">最後更新：${esc(REPORT.generated)}</p>`;

  const dirty = () => { DIRTY = true; $('#dirty').hidden = false; };
  const acctOpts = sel => (validAcct(pf, sel) ? '' : '<option value="">（未分類）</option>') +
    pf.accounts.map(a => `<option value="${a.id}" ${a.id === sel ? 'selected' : ''}>${esc(a.name)}</option>`).join('');

  const holdRow = h => {
    const p = posOf(h), open = OPEN === h.id;
    return `<div class="hrow ${open ? 'open' : ''}" data-h="${h.id}">
      <div class="hrow-top" data-toggle>
        <div>${h.code ? `<b>${esc(h.name)}</b> <span class="muted small">${h.code}</span>` : '<b class="muted">新股票</b>'}</div>
        <div class="small muted">${p.shares ? `${fmt0(p.shares)} 股・均價 ${fmt(p.cost)}` : p.rows.length ? '已出清' : '觀察中'} <span class="chev">${open ? '⌃' : '›'}</span></div>
      </div>
      ${open ? holdEditor(h, p) : ''}
    </div>`;
  };
  const holdEditor = (h, p) => {
    const side = SIDE_SEL || (p.rows.length ? 'buy' : 'init');
    return `<div class="hedit">
      ${!h.code ? `<div class="codewrap"><label>股票代號</label>
        <input data-code inputmode="numeric" pattern="[0-9]*" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="例：2330">
        <div class="hint small muted"></div><div class="sugg" hidden></div></div>` : ''}
      <div class="row small" style="margin:6px 0"><span>帳戶</span><select data-move>${acctOpts(h.account)}</select></div>
      ${p.rows.length ? `<div class="hsum small">持有 <b>${fmt0(p.shares)}</b> 股・平均成本 <b>${fmt(p.cost)}</b>（含手續費）・已實現 <b class="${cls(p.realized)}">${sign(p.realized)}${fmt0(p.realized)}</b></div>
      <div class="tlist">${p.rows.slice().reverse().map(t => `<div class="tl">
        <span class="${t.side === 'sell' ? 'down' : t.side === 'buy' ? 'up' : ''}">${SIDE[t.side]}</span>
        <span class="small">${t.side === 'init' ? '' : esc(t.date) + '　'}${fmt0(t.shares)} 股 @ ${fmt(t.price)}${t.side === 'sell' ? `　<b class="${cls(t.pl)}">${sign(t.pl)}${fmt0(t.pl)}</b>` : ''}</span>
        <button class="mini" data-deltr="${t.id}">✕</button></div>`).join('')}</div>` : ''}
      <div class="tform">
        <div class="seg">${['init', 'buy', 'sell'].map(k => `<button type="button" data-side="${k}" class="${k === side ? 'primary' : ''}">${SIDE[k]}</button>`).join('')}</div>
        <p class="small muted" style="margin:4px 0">${side === 'init' ? '已經持有的股票：填券商 App 上的平均成本與股數' : side === 'buy' ? '新買進一筆' : '賣出一筆（會自動算出這筆賺賠）'}</p>
        <div class="grid2">
          ${side !== 'init' ? `<div><label>日期</label><input type="date" id="t_date" value="${today()}"></div>` : ''}
          <div><label>${side === 'init' ? '平均成本' : '成交價'}</label><input id="t_price" inputmode="decimal" class="num" placeholder="0"></div>
          <div><label>股數</label><input id="t_shares" inputmode="numeric" pattern="[0-9]*" class="num" placeholder="0"></div>
          ${side !== 'init' ? `<div><label>手續費</label><input id="t_fee" inputmode="numeric" pattern="[0-9]*" class="num" placeholder="自動"></div>` : ''}
          ${side === 'sell' ? `<div><label>交易稅</label><input id="t_tax" inputmode="numeric" pattern="[0-9]*" class="num" placeholder="自動"></div>` : ''}
        </div>
        <div class="small muted" id="t_prev"></div>
        <button class="primary" id="t_add" style="width:100%;margin-top:6px">加入這筆</button>
      </div>
      <div class="row" style="margin-top:10px"><button class="danger" data-delh>刪除這檔</button><button data-close>收合</button></div>
    </div>`;
  };

  const renderHold = () => {
    const groups = pf.accounts.map(a => ({ ...a, items: pf.holdings.filter(h => h.account === a.id) }));
    const un = pf.holdings.filter(h => !validAcct(pf, h.account));
    if (un.length || !pf.accounts.length) groups.push({ id: null, name: pf.accounts.length ? '未分類' : '我的持股', items: un });
    $('#hold').innerHTML = groups.map(g => `<div class="acct" data-a="${g.id ?? ''}">
      <div class="acct-h"><b>📁 ${esc(g.name)}</b><span class="muted small">${g.items.length} 檔</span>
        ${g.id ? `<button class="mini" data-ren>改名</button>${g.items.length ? '' : '<button class="mini danger" data-delacct>刪除帳戶</button>'}` : ''}</div>
      ${g.id === null && pf.accounts.length && un.length ? `<div class="row small moveall">把這 ${un.length} 檔全部移到 <select data-moveall>${pf.accounts.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select><button class="mini primary" data-moveall-go>移動</button></div>` : ''}
      ${g.items.map(holdRow).join('')}
      ${g.id || !pf.accounts.length ? `<button class="addh" data-addh="${g.id ?? ''}">＋ 在「${esc(g.name)}」新增股票</button>` : ''}
    </div>`).join('');
    bindHold();
  };

  const bindHold = () => {
    const root = $('#hold');
    root.querySelectorAll('[data-toggle]').forEach(el => el.onclick = () => {
      const id = el.parentElement.dataset.h; OPEN = OPEN === id ? null : id; SIDE_SEL = null; renderHold();
      root.querySelector('.hrow.open')?.scrollIntoView({ block: 'nearest' });
    });
    root.querySelectorAll('[data-addh]').forEach(b => b.onclick = () => {
      const h = { id: uid(), account: b.dataset.addh || null, code: '', name: '', trades: [] };
      pf.holdings.push(h); OPEN = h.id; SIDE_SEL = null; dirty(); renderHold();
      root.querySelector('.hrow.open [data-code]')?.focus();
    });
    root.querySelectorAll('[data-ren]').forEach(b => b.onclick = () => {
      const a = pf.accounts.find(x => x.id === b.closest('.acct').dataset.a);
      const hd = b.closest('.acct-h');
      hd.innerHTML = `<input value="${esc(a.name)}" data-renin style="flex:1"><button class="mini primary" data-renok>確定</button>`;
      const inp = hd.querySelector('input'); inp.focus(); inp.select();
      hd.querySelector('[data-renok]').onclick = () => { if (inp.value.trim()) { a.name = inp.value.trim(); dirty(); } renderHold(); };
    });
    root.querySelectorAll('[data-delacct]').forEach(b => b.onclick = () => {
      pf.accounts = pf.accounts.filter(x => x.id !== b.closest('.acct').dataset.a); dirty(); renderHold();
    });
    root.querySelector('[data-moveall-go]')?.addEventListener('click', () => {
      const to = root.querySelector('[data-moveall]').value;
      pf.holdings.forEach(h => { if (!validAcct(pf, h.account)) h.account = to; }); dirty(); renderHold();
    });
    const row = root.querySelector('.hrow.open');
    if (!row) return;
    const h = pf.holdings.find(x => x.id === row.dataset.h);
    selectOnFocus(row);
    const codeIn = row.querySelector('[data-code]');
    if (codeIn) {
      const wrap = row.querySelector('.codewrap');
      codeIn.oninput = () => suggest(codeIn, wrap, x => {
        if (pf.holdings.some(o => o !== h && o.code === x[0] && o.account === h.account)) {
          wrap.querySelector('.hint').innerHTML += ' <span class="down">（這個帳戶已經有這檔，請直接點那檔加記錄）</span>'; return;
        }
        h.code = x[0]; h.name = x[1]; dirty(); renderHold(); $('#hold .hrow.open #t_price')?.focus();
      });
      codeIn.onblur = () => setTimeout(() => { const bx = wrap.querySelector('.sugg'); if (bx) bx.hidden = true; }, 200);
    }
    row.querySelector('[data-move]').onchange = e => { h.account = e.target.value || null; dirty(); renderHold(); };
    row.querySelectorAll('[data-side]').forEach(b => b.onclick = () => { SIDE_SEL = b.dataset.side; renderHold(); });
    row.querySelectorAll('[data-deltr]').forEach(b => b.onclick = () => {
      if (!b.dataset.confirm) { b.dataset.confirm = 1; b.textContent = '確定刪除'; b.classList.add('danger'); return; }
      h.trades = h.trades.filter(t => t.id !== b.dataset.deltr); dirty(); renderHold();
    });
    row.querySelector('[data-close]').onclick = () => { OPEN = null; renderHold(); };
    row.querySelector('[data-delh]').onclick = e => {
      const b = e.target;
      if (!b.dataset.confirm) { b.dataset.confirm = 1; b.textContent = h.trades.length ? '確定刪除（含所有記錄）？' : '確定刪除？'; return; }
      pf.holdings = pf.holdings.filter(x => x !== h); OPEN = null; dirty(); renderHold();
    };
    const side = SIDE_SEL || (posOf(h).rows.length ? 'buy' : 'init');
    const val = id => { const el = row.querySelector('#' + id); return el && el.value !== '' ? Number(el.value) : null; };
    const auto = () => {
      const pr = val('t_price'), sh = val('t_shares');
      if (!pr || !sh || side === 'init') { $('#t_prev').textContent = ''; return; }
      const fee = val('t_fee') ?? calcFee(pr, sh, Number($('#disc').value) || set.fee_discount);
      const tax = side === 'sell' ? (val('t_tax') ?? calcTax(h.code, pr, sh)) : 0;
      if (row.querySelector('#t_fee')) row.querySelector('#t_fee').placeholder = '自動 ' + fee;
      if (row.querySelector('#t_tax')) row.querySelector('#t_tax').placeholder = '自動 ' + tax;
      const amt = pr * sh;
      $('#t_prev').innerHTML = side === 'buy' ? `成交金額 ${fmt0(amt)}＋手續費 ${fmt0(fee)}＝應付 <b>${fmt0(amt + fee)}</b>`
        : `成交金額 ${fmt0(amt)}－手續費 ${fmt0(fee)}－交易稅 ${fmt0(tax)}＝應收 <b>${fmt0(amt - fee - tax)}</b>`;
    };
    row.querySelectorAll('.tform input').forEach(i => i.addEventListener('input', auto));
    row.querySelector('#t_add').onclick = () => {
      if (!h.code) return toast('請先輸入股票代號');
      const pr = val('t_price'), sh = val('t_shares');
      if (!pr || !sh || sh <= 0) return toast('請填價格與股數');
      const p = posOf(h);
      if (side === 'sell' && sh > p.shares) return toast(`賣出股數超過持有（目前 ${fmt0(p.shares)} 股）`);
      const disc = Number($('#disc').value) || set.fee_discount;
      const t = { id: uid(), side, date: side === 'init' ? '' : (row.querySelector('#t_date').value || today()), price: pr, shares: sh,
        fee: side === 'init' ? 0 : (val('t_fee') ?? calcFee(pr, sh, disc)),
        tax: side === 'sell' ? (val('t_tax') ?? calcTax(h.code, pr, sh)) : 0 };
      h.trades.push(t); SIDE_SEL = side === 'init' ? 'buy' : side; dirty(); renderHold();
      toast(`已加入：${SIDE[side]} ${fmt0(sh)} 股（記得按「儲存並更新」）`);
    };
  };
  renderHold();
  selectOnFocus(app);

  $('#addacct').onclick = () => {
    const n = $('#newacct').value.trim(); if (!n) return toast('請輸入帳戶名稱');
    pf.accounts.push({ id: uid(), name: n }); $('#newacct').value = ''; dirty(); renderHold();
  };
  ['stop', 'nd', 'disc'].forEach(id => $('#' + id).addEventListener('input', dirty));
  loadStockList();
  $('#save').onclick = async () => {
    if (needGh()) return;
    set.stop_pct = Number($('#stop').value) || 8;
    set.notify_days_before = Number($('#nd').value) || 7;
    set.fee_discount = Number($('#disc').value) || 10;
    const out = finalizePf(structuredClone(pf));
    const btn = $('#save'); btn.disabled = true; btn.textContent = '儲存中…';
    try {
      const cur = await gh.getJson('config/portfolio.enc');
      await gh.putJson('config/portfolio.enc', await encryptBox(out, getPw()), cur.sha, '更新持股');
      await gh.dispatch();
      REPORT.portfolio = out; DRAFT = null; DIRTY = false;
      $('#dirty').hidden = true;
      toast('✅ 已儲存，雲端分析中，約 3～5 分鐘後自動更新');
      waitForUpdate();
    } catch (e) { toast('儲存失敗：' + e.message, 5000); }
    btn.disabled = false; btn.textContent = '儲存並更新';
  };
  if (DIRTY) dirty();
  $('#savegh').onclick = () => { store.set('gh_repo', $('#repo').value.trim()); store.set('gh_token', $('#tok').value.trim()); toast('已儲存'); };
  $('#refresh').onclick = async () => {
    if (needGh()) return;
    try { await gh.dispatch(); toast('已觸發更新，約 3～5 分鐘完成，不用重複按'); waitForUpdate(); } catch (e) { toast(e.message, 5000); }
  };
  $('#push').onclick = () => enablePush().catch(e => toast('開啟失敗：' + e.message, 5000));
  $('#testpush').onclick = async () => {
    const reg = await navigator.serviceWorker?.ready;
    if (Notification.permission !== 'granted' || !reg) return toast('請先開啟通知');
    reg.showNotification('持股雷達測試', { body: '通知正常運作！點我打開台積電', data: { url: './#/stock/2330' }, icon: 'icon-192.png' });
  };
  $('#logout').onclick = () => { store.set('pw', null); sessionStorage.clear(); REPORT = null; DRAFT = null; route(); };
}

function urlB64ToU8(s) {
  const pad = '='.repeat((4 - s.length % 4) % 4);
  return Uint8Array.from(atob((s + pad).replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
}
async function enablePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('此瀏覽器不支援推播（iPhone 需從主畫面打開）');
  if (needGh()) return;
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('未允許通知');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToU8(CFG.vapidPublicKey) });
  const j = sub.toJSON();
  const cur = await gh.getJson('config/subscriptions.enc');
  const list = cur.data ? await decryptBox(cur.data, getPw()) : [];
  if (!list.some(x => x.endpoint === j.endpoint)) {
    list.push({ endpoint: j.endpoint, keys: j.keys, ua: navigator.userAgent.slice(0, 80), added: new Date().toISOString() });
    await gh.putJson('config/subscriptions.enc', await encryptBox(list, getPw()), cur.sha, '新增通知裝置');
  }
  toast('✅ 這台裝置已開啟通知');
  viewSettings();
}

async function waitForUpdate() {
  const before = REPORT.generated;
  for (let i = 0; i < 24; i++) {
    await new Promise(r => setTimeout(r, 15000));
    try {
      const r = await loadReport(getPw());
      if (r.generated !== before) { REPORT = r; toast('✅ 資料已更新'); if (!location.hash.includes('settings') || !DIRTY) { DRAFT = null; route(); } return; }
    } catch {}
  }
}

// ---------- 路由與返回 ----------
const SCROLL = {};
let CUR_HASH = null, LAST_LIST = '#/', FROM_LIST = false;
function goBack() {
  if (FROM_LIST && history.length > 1) history.back();
  else location.replace(LAST_LIST || '#/');
}
async function route() {
  destroyCharts();
  if (CUR_HASH != null) SCROLL[CUR_HASH] = window.scrollY;
  const prev = CUR_HASH;
  CUR_HASH = location.hash || '#/';
  const pw = getPw();
  if (!REPORT) {
    if (!pw) return viewLock();
    try { REPORT = await loadReport(pw); } catch (e) { return viewLock(e.name === 'OperationError' ? '密碼已變更，請重新輸入' : e.message); }
  }
  $('#tabbar').hidden = false;
  $('#updated').textContent = '更新於 ' + REPORT.generated;
  const h = CUR_HASH.replace(/^#\/?/, '');
  const isStock = h.startsWith('stock/');
  const tab = h.startsWith('events') ? 'events' : h.startsWith('settings') ? 'settings' : h.startsWith('trades') ? 'trades' : 'home';
  if (isStock) {
    const prevIsStock = prev && prev.includes('stock/');
    if (!prevIsStock) FROM_LIST = prev != null && !prev.includes('settings');
  } else { LAST_LIST = CUR_HASH; FROM_LIST = false; }
  $('#back').hidden = !isStock;
  $('#brand').hidden = isStock;
  document.querySelectorAll('.tabbar a').forEach(a => a.classList.toggle('on', !isStock && a.dataset.tab === tab));
  if (isStock) { viewStock(h.slice(6)); window.scrollTo(0, 0); }
  else {
    if (tab === 'events') viewEvents(); else if (tab === 'settings') viewSettings(); else if (tab === 'trades') viewTrades(); else viewHome();
    window.scrollTo(0, SCROLL[CUR_HASH] || 0);
  }
}
window.addEventListener('hashchange', route);
$('#back').onclick = e => { e.preventDefault(); goBack(); };
// 從螢幕左邊緣往右滑＝返回
let sx = null, sy = 0;
document.addEventListener('touchstart', e => { const t = e.touches[0]; sx = t.clientX < 28 ? t.clientX : null; sy = t.clientY; }, { passive: true });
document.addEventListener('touchend', e => {
  if (sx == null) return;
  const t = e.changedTouches[0];
  if (t.clientX - sx > 70 && Math.abs(t.clientY - sy) < 60 && location.hash.includes('stock/')) goBack();
  sx = null;
}, { passive: true });
// 從背景回來時自動抓最新資料
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !REPORT) return;
  try { const r = await loadReport(getPw()); if (r.generated !== REPORT.generated) { REPORT = r; if (!location.hash.includes('settings')) route(); } } catch {}
});
navigator.serviceWorker?.addEventListener('message', e => { if (e.data?.url) location.href = e.data.url; });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
route();
})();
