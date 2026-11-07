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
  const R = REPORT, S = R.summary;
  const alerts = [];
  R.stocks.forEach(s => (s.tech?.signals || []).filter(x => x.level !== 'info').forEach(x => alerts.push({ s, x })));
  const soon = R.events.filter(e => e.days >= 0 && e.days <= 7);
  app.innerHTML = `
  <div class="card">
    <div class="row wrap">
      <div class="stat"><div class="label">未實現損益（含息前）</div>
        <div class="value big ${cls(S.pnl)}">${sign(S.pnl)}${fmt0(S.pnl)}</div>
        <div class="${cls(S.pnl)} num">${pct(S.pnl_pct)}</div></div>
      <div class="stat" style="text-align:right"><div class="label">今日損益</div>
        <div class="value ${cls(S.day)}">${sign(S.day)}${fmt0(S.day)}</div></div>
    </div>
    <div class="grid3" style="margin-top:12px">
      <div class="stat"><div class="label">市值</div><div class="num">${fmt0(S.value)}</div></div>
      <div class="stat"><div class="label">成本</div><div class="num">${fmt0(S.cost)}</div></div>
      <div class="stat"><div class="label">賣出淨損益*</div><div class="num ${cls(S.net)}">${sign(S.net)}${fmt0(S.net)}</div></div>
    </div>
    <div class="muted small" style="margin-top:6px">* 扣除手續費 0.1425% 與證交稅 0.3% 的估計值</div>
  </div>
  ${alerts.length ? `<div class="card"><h3>需要注意 <span class="muted">${alerts.length} 則</span></h3>
    ${alerts.slice(0, 8).map(({ s, x }) => `<a href="#/stock/${s.code}" class="sig ${x.level}" style="color:inherit">
      <span class="ic">${ICON[x.level]}</span><div><div class="t">${esc(s.name)}｜${esc(x.title)}</div><div class="d">${esc(x.detail)}</div></div></a>`).join('')}
  </div>` : ''}
  ${soon.length ? `<div class="card"><h3>📅 7 天內事件</h3>${soon.map(eventRow).join('')}</div>` : ''}
  <h3 style="margin:16px 4px 8px">我的持股</h3>
  ${R.stocks.map(stockCard).join('')}
  <p class="disclaimer">技術與估值分析僅供參考，不構成投資建議。投資前請自行判斷風險。</p>`;
}

function stockCard(s) {
  const t = s.tech || {}, p = t.pnl;
  const top = (t.signals || [])[0];
  return `<a class="card stock" href="#/stock/${s.code}">
    <div class="row"><div><span class="name">${esc(s.name)}</span><span class="code">${s.code}</span> ${t.trend ? trendBadge(t.trend) : ''}</div>
      <div class="price num ${cls(t.chg)}">${fmt(t.close)}</div></div>
    <div class="row small"><span class="muted">${s.shares ? `${fmt0(s.shares)} 股・成本 ${fmt(s.cost)}` : '觀察中'}</span>
      <span class="num ${cls(t.chg)}">${sign(t.chg)}${fmt(t.chg)}（${pct(t.chg_pct)}）</span></div>
    ${p ? `<div class="row" style="margin-top:6px"><span class="small muted">損益</span>
      <span class="num ${cls(p.gross)}" style="font-weight:700">${sign(p.gross)}${fmt0(p.gross)}（${pct(p.pct)}）</span></div>` : ''}
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

let STOCK_TAB = sessionStorage.getItem('tab') || 'trend';
const STOCK_TABS = [['trend', '走勢訊號'], ['chips', '法人籌碼'], ['fin', '財報估值'], ['news', '新聞事件']];
function viewStock(code) {
  const s = REPORT.stocks.find(x => x.code === code);
  if (!s) { app.innerHTML = '<p class="center muted">找不到這檔股票</p>'; return; }
  const t = s.tech || {}, p = t.pnl, v = s.valuation, f = s.financials, rv = s.revenue, c = s.competitiveness;
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
      <div class="nm">${n.important ? '<span class="tag imp">重要</span>' : ''}${n.tone === '正面' ? '<span class="tag pos">正面</span>' : n.tone === '負面' ? '<span class="tag neg">負面</span>' : ''}${n.cats.map(x => `<span class="tag">${esc(x)}</span>`).join('')}
      ${esc(n.source)}・${new Date(n.ts * 1000).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div></a>`).join('') || '<p class="muted">近 7 天沒有可信來源的重要新聞</p>'}
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
    ${p ? `<div class="grid3" style="margin-top:12px">
      <div class="stat"><div class="label">持有</div><div class="num">${fmt0(s.shares)} 股</div></div>
      <div class="stat"><div class="label">成本</div><div class="num">${fmt(s.cost)}</div></div>
      <div class="stat"><div class="label">損益</div><div class="num ${cls(p.gross)}" style="font-weight:700">${sign(p.gross)}${fmt0(p.gross)}<br>${pct(p.pct)}</div></div>
    </div>` : ''}
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
  if (REPORT && t.pnl) { const s = REPORT.stocks.find(x => x.tech === t); if (s?.cost) candle.createPriceLine({ price: s.cost, color: css('--text2'), lineStyle: 1, lineWidth: 1, axisLabelVisible: true, title: '成本' }); }
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

// ---------- 設定 ----------
function viewSettings() {
  const pf = structuredClone(REPORT.portfolio);
  const set = pf.settings || (pf.settings = { stop_pct: 8, notify_days_before: 7 });
  const rows = () => pf.stocks.map((s, i) => `<div class="hold-row" data-i="${i}">
      <div><label>代號</label><input data-k="code" value="${esc(s.code)}" inputmode="numeric"></div>
      <div><label>名稱</label><input data-k="name" value="${esc(s.name || '')}"></div>
      <div><label>平均成本</label><input data-k="cost" value="${s.cost ?? ''}" inputmode="decimal"></div>
      <div><label>股數</label><input data-k="shares" value="${s.shares ?? ''}" inputmode="numeric"></div>
      <button class="danger" data-del="${i}">刪除</button></div>`).join('');
  const pushState = 'Notification' in window ? Notification.permission : 'unsupported';
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  app.innerHTML = `
  <div class="card"><h3>我的持股</h3>
    <p class="small muted">股數填 0 代表只觀察不持有。1 張 = 1000 股。</p>
    <div id="rows">${rows()}</div>
    <div class="row"><button id="add">＋ 新增股票</button><button class="primary" id="save">儲存並更新</button></div>
  </div>
  <div class="card"><h3>警示設定</h3>
    <div class="grid2">
      <div><label>停損比例（%）</label><input id="stop" value="${set.stop_pct}" inputmode="decimal"></div>
      <div><label>事件提前幾天通知</label><input id="nd" value="${set.notify_days_before}" inputmode="numeric"></div>
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

  const bind = () => {
    document.querySelectorAll('.hold-row input').forEach(inp => inp.oninput = () => {
      const i = +inp.closest('.hold-row').dataset.i, k = inp.dataset.k;
      pf.stocks[i][k] = (k === 'cost' || k === 'shares') ? (inp.value === '' ? null : Number(inp.value)) : inp.value.trim();
    });
    document.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
      const i = +b.dataset.del;
      if (b.dataset.confirm) { pf.stocks.splice(i, 1); $('#rows').innerHTML = rows(); bind(); }
      else { b.dataset.confirm = 1; b.textContent = '確定刪除？'; }
    });
  };
  bind();
  $('#add').onclick = () => { pf.stocks.push({ code: '', name: '', cost: null, shares: 0 }); $('#rows').innerHTML = rows(); bind(); };
  $('#save').onclick = async () => {
    if (needGh()) return;
    pf.stocks = pf.stocks.filter(s => /^\d{4,6}[A-Z]?$/.test(s.code));
    set.stop_pct = Number($('#stop').value) || 8;
    set.notify_days_before = Number($('#nd').value) || 7;
    const btn = $('#save'); btn.disabled = true; btn.textContent = '儲存中…';
    try {
      const cur = await gh.getJson('config/portfolio.enc');
      await gh.putJson('config/portfolio.enc', await encryptBox(pf, getPw()), cur.sha, '更新持股');
      await gh.dispatch();
      REPORT.portfolio = pf;
      toast('已儲存，雲端分析中，約 2～3 分鐘後下拉重新整理');
      waitForUpdate();
    } catch (e) { toast('儲存失敗：' + e.message, 5000); }
    btn.disabled = false; btn.textContent = '儲存並更新';
  };
  $('#savegh').onclick = () => { store.set('gh_repo', $('#repo').value.trim()); store.set('gh_token', $('#tok').value.trim()); toast('已儲存'); };
  $('#refresh').onclick = async () => {
    if (needGh()) return;
    try { await gh.dispatch(); toast('已觸發更新，約 2～3 分鐘完成'); waitForUpdate(); } catch (e) { toast(e.message, 5000); }
  };
  $('#push').onclick = () => enablePush().catch(e => toast('開啟失敗：' + e.message, 5000));
  $('#testpush').onclick = async () => {
    const reg = await navigator.serviceWorker?.ready;
    if (Notification.permission !== 'granted' || !reg) return toast('請先開啟通知');
    reg.showNotification('持股雷達測試', { body: '通知正常運作！點我打開台積電', data: { url: './#/stock/2330' }, icon: 'icon-192.png' });
  };
  $('#logout').onclick = () => { store.set('pw', null); sessionStorage.clear(); REPORT = null; route(); };
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
      if (r.generated !== before) { REPORT = r; toast('✅ 資料已更新'); route(); return; }
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
  const tab = h.startsWith('events') ? 'events' : h.startsWith('settings') ? 'settings' : 'home';
  if (isStock) {
    const prevIsStock = prev && prev.includes('stock/');
    if (!prevIsStock) FROM_LIST = prev != null && !prev.includes('settings');
  } else { LAST_LIST = CUR_HASH; FROM_LIST = false; }
  $('#back').hidden = !isStock;
  $('#brand').hidden = isStock;
  document.querySelectorAll('.tabbar a').forEach(a => a.classList.toggle('on', !isStock && a.dataset.tab === tab));
  if (isStock) { viewStock(h.slice(6)); window.scrollTo(0, 0); }
  else {
    if (tab === 'events') viewEvents(); else if (tab === 'settings') viewSettings(); else viewHome();
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
  try { const r = await loadReport(getPw()); if (r.generated !== REPORT.generated) { REPORT = r; route(); } } catch {}
});
navigator.serviceWorker?.addEventListener('message', e => { if (e.data?.url) location.href = e.data.url; });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
route();
})();
