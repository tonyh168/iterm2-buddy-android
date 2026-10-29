'use strict';

/* ------------------------------------------------------------------ *
 * iTerm2 Mirror 前端
 * 数据源是 iTerm2 已经渲染好的 cell 网格，所以这里不做 VT 解析，
 * 直接按 (列, 行) 坐标把字符画到 canvas 上。
 * ------------------------------------------------------------------ */

const TOKEN = new URLSearchParams(location.search).get('t') || '';
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
const THEME = {
  bg: '#101014',
  fg: '#d8d8dc',
  cursor: 'rgba(120, 180, 255, 0.35)',
};

const $ = (id) => document.getElementById(id);
const el = {
  dot: $('dot'),
  stat: $('stat'),
  tabs: $('tabs'),
  wrap: $('termwrap'),
  canvas: $('term'),
  empty: $('empty'),
  keys: $('keys'),
  ime: $('ime'),
  send: $('send'),
  follow: $('follow'),
  fit: $('fit'),
  home: $('home'),
  size: $('size'),
  minimap: $('minimap'),
  mini: $('mini'),
  toast: $('toast'),
};

const ctx = el.canvas.getContext('2d', { alpha: false });
const mctx = el.mini.getContext('2d', { alpha: false });
const dpr = Math.min(window.devicePixelRatio || 1, 2.5);

const S = {
  panes: [],
  cur: null,
  grid: [],
  rowCount: 0,
  cursor: { x: 0, y: 0 },
  cols: 80,
  rows: 24,
  conn: 'wait',       // wait | on | off
  follow: true,
  fontSize: 13,
  cellW: 8,
  cellH: 17,
  miniDirty: true,
};

/* 字号低于这个值基本没法读，只适合看版式 */
const READABLE_PX = 8.5;

/* ---------------------------- 宽字符判定 ---------------------------- */

function isWide(ch) {
  const c = ch.codePointAt(0);
  if (c === undefined) return false;
  return (
    (c >= 0x1100 && c <= 0x115f) ||
    (c >= 0x2e80 && c <= 0x303e) ||
    (c >= 0x3041 && c <= 0x33ff) ||
    (c >= 0x3400 && c <= 0x4dbf) ||
    (c >= 0x4e00 && c <= 0x9fff) ||
    (c >= 0xa000 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe6f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) ||
    (c >= 0x1f300 && c <= 0x1f64f) ||
    (c >= 0x1f900 && c <= 0x1f9ff) ||
    (c >= 0x1f680 && c <= 0x1f6ff) ||
    (c >= 0x20000 && c <= 0x3fffd)
  );
}

/* ---------------------------- 尺寸计算 ---------------------------- */

function measureCell() {
  ctx.font = `${S.fontSize}px ${MONO}`;
  const w = ctx.measureText('M').width;
  S.cellW = w > 0 ? w : S.fontSize * 0.6;
  S.cellH = Math.round(S.fontSize * 1.32);
}

function layoutCanvas() {
  const cols = Math.max(S.cols, 1);
  const rows = Math.max(S.rowCount || S.rows || 1, 1);
  const w = Math.ceil(cols * S.cellW);
  const h = Math.ceil(rows * S.cellH);

  const pxW = Math.ceil(w * dpr);
  const pxH = Math.ceil(h * dpr);
  if (el.canvas.width !== pxW || el.canvas.height !== pxH) {
    el.canvas.width = pxW;
    el.canvas.height = pxH;
  }
  el.canvas.style.width = w + 'px';
  el.canvas.style.height = h + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.textBaseline = 'middle';
  requestAnimationFrame(updateMiniVisibility);
}

/* ------------------------------ 渲染 ------------------------------ */

let raf = 0;
function scheduleRender() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    draw();
  });
}

const fontCache = new Map();
function fontFor(bold, italic) {
  const k = (bold ? 1 : 0) + (italic ? 2 : 0);
  let f = fontCache.get(k);
  if (!f) {
    f = `${italic ? 'italic ' : ''}${bold ? '600' : '400'} ${S.fontSize}px ${MONO}`;
    fontCache.set(k, f);
  }
  return f;
}

function resolveColors(fg, bg, attrs) {
  let f = fg === '@rev' ? THEME.bg : fg || THEME.fg;
  let b = bg === '@rev' ? THEME.fg : bg || null;
  if (attrs & 8) {          // inverse
    const tf = f;
    f = b || THEME.bg;
    b = tf || THEME.fg;
  }
  return [f, b];
}

function draw() {
  const cw = S.cellW;
  const ch = S.cellH;
  const cols = Math.max(S.cols, 1);
  const rows = Math.max(S.rowCount || S.rows || 1, 1);

  // 背景
  ctx.fillStyle = THEME.bg;
  ctx.fillRect(0, 0, cols * cw, rows * ch);

  const grid = S.grid;

  // 第一遍：背景色块
  for (let y = 0; y < grid.length; y++) {
    const runs = grid[y];
    if (!runs || !runs.length) continue;
    for (let i = 0; i < runs.length; i++) {
      const r = runs[i];
      const bg = r[4];
      if (!bg) continue;
      const [_, f] = resolveColors(r[3], bg, r[5] | 0);
      ctx.fillStyle = f;
      ctx.fillRect(r[0] * cw, y * ch, r[2] * cw, ch);
    }
  }

  // 第二遍：文字
  ctx.textBaseline = 'middle';
  const baseY = ch * 0.56;

  for (let y = 0; y < grid.length; y++) {
    const runs = grid[y];
    if (!runs || !runs.length) continue;
    const py = y * ch;

    for (let i = 0; i < runs.length; i++) {
      const r = runs[i];
      const text = r[1];
      if (!text) continue;
      const attrs = r[5] | 0;
      const [fc] = resolveColors(r[3], r[4], attrs);

      const bold = !!(attrs & 1);
      const italic = !!(attrs & 2);
      const underline = !!(attrs & 4);
      const faint = !!(attrs & 16);
      const strike = !!(attrs & 32);

      ctx.font = fontFor(bold, italic);
      ctx.fillStyle = fc;
      if (faint) ctx.globalAlpha = 0.55;

      // 先用本地判定算出这一段的总列宽，若与后端给的视觉列宽不符，
      // 按比例缩放，保证该段严格落在终端预期的列范围内（不串列）
      let localW = 0;
      let pw = false;
      for (const c of text) {
        if (c === '\u0000') {
          if (!pw) localW += 1;
          pw = false;
        } else {
          const w = isWide(c) ? 2 : 1;
          localW += w;
          pw = w === 2;
        }
      }
      const wantW = r[2] | 0;
      const k = (localW > 0 && wantW > 0 && localW !== wantW) ? wantW / localW : 1;

      let cx = r[0];
      let prevWide = false;

      for (const c of text) {
        if (c === '\u0000') {
          // 空 cell：宽字符的占位格已被前一个字符覆盖，跳过；否则占 1 列
          if (!prevWide) cx += k;
          prevWide = false;
          continue;
        }
        const wide = isWide(c);
        const targetW = (wide ? 2 : 1) * cw * k;
        const x = cx * cw;

        ctx.fillText(c, x, py + baseY, targetW);

        if (underline) ctx.fillRect(x, py + ch - 2, targetW, 1);
        if (strike) ctx.fillRect(x, py + ch * 0.5, targetW, 1);

        cx += (wide ? 2 : 1) * k;
        prevWide = wide;
      }

      if (faint) ctx.globalAlpha = 1;
    }
  }

  // 光标
  const cy = S.cursor.y;
  const cxc = S.cursor.x;
  if (cy >= 0 && cy < rows && cxc >= 0 && cxc < cols) {
    ctx.fillStyle = THEME.cursor;
    ctx.fillRect(cxc * cw, cy * ch, cw, ch);
  }

  if (S.miniDirty) {
    S.miniDirty = false;
    renderMini();
  }
}

/* ---------------------------- 视口跟随 ---------------------------- */

let autoScrollAt = 0;

function followCursor() {
  if (!S.follow) return;
  const cw = S.cellW;
  const ch = S.cellH;
  const wrap = el.wrap;

  const yTop = S.cursor.y * ch;
  const yBot = yTop + ch;
  const viewTop = wrap.scrollTop;
  const viewBot = viewTop + wrap.clientHeight;

  let changed = false;
  if (yTop < viewTop + ch * 2) {
    wrap.scrollTop = Math.max(0, yTop - ch * 2);
    changed = true;
  } else if (yBot > viewBot - ch) {
    wrap.scrollTop = yBot - wrap.clientHeight + ch;
    changed = true;
  }

  const xLeft = S.cursor.x * cw;
  const xRight = xLeft + cw * 2;
  const hLeft = wrap.scrollLeft;
  const hRight = hLeft + wrap.clientWidth;

  if (xLeft < hLeft) {
    wrap.scrollLeft = Math.max(0, xLeft - cw * 3);
    changed = true;
  } else if (xRight > hRight) {
    wrap.scrollLeft = xRight - wrap.clientWidth + cw * 3;
    changed = true;
  }

  if (changed) autoScrollAt = Date.now();
}

/* --------------------------- 缩略导航条 --------------------------- */

/* 272 列塞不进手机屏，字必然小到看不清。
   所以不去假装"适配"，而是给一张全局缩略图：
   你能看到内容分布（表格在哪、文字块在哪），点一下就跳过去。 */

let miniScaleX = 1;
let miniScaleY = 1;

function layoutMini() {
  const w = el.mini.clientWidth;
  const h = el.mini.clientHeight;
  if (!w || !h) return;
  const pw = Math.ceil(w * dpr);
  const ph = Math.ceil(h * dpr);
  if (el.mini.width !== pw || el.mini.height !== ph) {
    el.mini.width = pw;
    el.mini.height = ph;
  }
  const cols = Math.max(S.cols, 1);
  const rows = Math.max(S.rowCount || S.rows || 1, 1);
  miniScaleX = w / cols;
  miniScaleY = h / rows;
  mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function renderMini() {
  if (el.minimap.classList.contains('hide')) return;
  const w = el.mini.clientWidth;
  const h = el.mini.clientHeight;
  if (!w || !h) return;

  mctx.fillStyle = '#0b0b10';
  mctx.fillRect(0, 0, w, h);

  const sx = w / Math.max(S.cols, 1);
  const sy = h / Math.max(S.rowCount || S.rows || 1, 1);
  const grid = S.grid;

  // 用色块表现内容分布：有文字的地方才有痕迹
  for (let y = 0; y < grid.length; y++) {
    const runs = grid[y];
    if (!runs || !runs.length) continue;
    const py = y * sy;
    const rh = Math.max(sy, 0.8);
    for (let i = 0; i < runs.length; i++) {
      const r = runs[i];
      const text = r[1];
      if (!text) continue;
      // 纯空格不画，否则整片都是底色
      let ink = false;
      for (let k = 0; k < text.length; k++) {
        const c = text.charCodeAt(k);
        if (c !== 32 && c !== 0) { ink = true; break; }
      }
      if (!ink) continue;
      const fg = r[3];
      mctx.fillStyle = fg && fg.startsWith('#') ? fg : '#9aa2b1';
      mctx.globalAlpha = 0.85;
      mctx.fillRect(r[0] * sx, py, Math.max(r[2] * sx, 0.7), rh);
    }
  }
  mctx.globalAlpha = 1;

  // 光标位置
  if (S.cursor.y >= 0) {
    mctx.fillStyle = '#4a9eff';
    mctx.fillRect(S.cursor.x * sx - 0.5, S.cursor.y * sy - 0.5, Math.max(sx * 2, 2), Math.max(sy, 2));
  }

  drawMiniViewport();
}

function drawMiniViewport() {
  const w = el.mini.clientWidth;
  const h = el.mini.clientHeight;
  if (!w || !h) return;
  const wrap = el.wrap;
  const sw = wrap.scrollWidth || 1;
  const sh = wrap.scrollHeight || 1;

  const vx = (wrap.scrollLeft / sw) * w;
  const vy = (wrap.scrollTop / sh) * h;
  const vw = Math.max((wrap.clientWidth / sw) * w, 10);
  const vh = Math.max((wrap.clientHeight / sh) * h, 4);

  mctx.strokeStyle = '#4a9eff';
  mctx.lineWidth = 1.2;
  mctx.strokeRect(
    Math.min(vx, w - vw) + 0.5,
    Math.min(vy, h - vh) + 0.5,
    vw - 1,
    vh - 1
  );
  mctx.fillStyle = 'rgba(74, 158, 255, 0.12)';
  mctx.fillRect(Math.min(vx, w - vw) + 0.5, Math.min(vy, h - vh) + 0.5, vw - 1, vh - 1);
}

/** 让缩略图只在内容超出视口时出现 */
function updateMiniVisibility() {
  const wrap = el.wrap;
  const need = wrap.scrollWidth > wrap.clientWidth + 2 || wrap.scrollHeight > wrap.clientHeight + 2;
  el.minimap.classList.toggle('hide', !need);
  if (need) {
    layoutMini();
    renderMini();
  }
}

/* 在缩略图上定位：把点击处映射成滚动位置 */
function miniJump(clientX, clientY) {
  const rect = el.mini.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  if (!w || !h) return;
  const fx = Math.min(Math.max((clientX - rect.left) / w, 0), 1);
  const fy = Math.min(Math.max((clientY - rect.top) / h, 0), 1);

  const wrap = el.wrap;
  wrap.scrollLeft = fx * (wrap.scrollWidth - wrap.clientWidth);
  wrap.scrollTop = fy * (wrap.scrollHeight - wrap.clientHeight);
  autoScrollAt = Date.now();
  setFollow(false);
  drawMiniViewport();
}

let miniDragging = false;

el.minimap.addEventListener('pointerdown', (e) => {
  miniDragging = true;
  el.minimap.setPointerCapture?.(e.pointerId);
  miniJump(e.clientX, e.clientY);
  e.preventDefault();
});

el.minimap.addEventListener('pointermove', (e) => {
  if (!miniDragging) return;
  miniJump(e.clientX, e.clientY);
  e.preventDefault();
});

const miniEnd = (e) => {
  miniDragging = false;
  try { el.minimap.releasePointerCapture?.(e.pointerId); } catch (_) {}
};
el.minimap.addEventListener('pointerup', miniEnd);
el.minimap.addEventListener('pointercancel', miniEnd);

/* ------------------------------ 提示 ------------------------------ */

let toastTimer = 0;
function showToast(msg, ms) {
  el.toast.textContent = msg;
  el.toast.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('on'), ms || 2600);
}

/* ------------------------------ 连接 ------------------------------ */

let ws = null;
let retry = 0;
let timer = 0;
let pingTimer = 0;

function setConn(state, text) {
  S.conn = state;
  el.dot.className = 'dot ' + (state === 'on' ? 'on' : state === 'off' ? 'off' : 'wait');
  el.stat.textContent = text;
}

function connect() {
  clearTimeout(timer);
  clearInterval(pingTimer);

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const qs = TOKEN ? `?t=${encodeURIComponent(TOKEN)}` : '';
  const url = `${proto}://${location.host}/ws${qs}`;

  setConn('wait', retry ? '重连中…' : '连接中…');
  try {
    ws = new WebSocket(url);
  } catch (e) {
    setConn('off', '连接失败');
    return scheduleRetry();
  }

  ws.onopen = () => {
    retry = 0;
    setConn('on', '已连接');
    if (S.cur) send({ type: 'sub', sid: S.cur });
    pingTimer = setInterval(() => send({ type: 'ping', t: Date.now() }), 25000);
  };

  ws.onclose = () => {
    setConn('off', '已断开');
    clearInterval(pingTimer);
    scheduleRetry();
  };

  ws.onerror = () => {};

  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    onMessage(m);
  };
}

function scheduleRetry() {
  retry = Math.min(retry + 1, 6);
  const wait = Math.min(500 * Math.pow(1.7, retry), 5000);
  timer = setTimeout(connect, wait);
}

function send(obj) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

/* ---------------------------- 消息处理 ---------------------------- */

function onMessage(m) {
  switch (m.type) {
    case 'meta':
      S.panes = m.panes || [];
      renderTabs();
      if (!S.panes.length) {
        S.cur = null;
        S.grid = [];
        S.rowCount = 0;
        el.empty.classList.remove('hide');
        el.empty.textContent = m.online === false ? 'iTerm2 连接中断，正在重试…' : '没有找到 pane';
        layoutCanvas();
        draw();
      } else if (!S.cur || !S.panes.some((p) => p.sid === S.cur)) {
        selectPane(S.panes[0].sid);
      }
      updateStatus();
      break;

    case 'full':
      if (m.sid !== S.cur) break;
      S.cols = m.cols || S.cols;
      S.rows = m.rows_count || m.rows || S.rows;
      S.grid = (m.rows || []).map((r) => r || []);
      S.rowCount = S.grid.length;
      S.cursor = m.cursor || { x: 0, y: 0 };
      el.empty.classList.add('hide');
      measureCell();
      layoutCanvas();
      S.miniDirty = true;
      draw();
      requestAnimationFrame(followCursor);
      updateStatus();
      break;

    case 'delta':
      if (m.sid !== S.cur) break;
      if (!S.rowCount) { send({ type: 'sub', sid: S.cur }); break; }
      const rows = m.rows || [];
      for (const chg of rows) {
        if (chg.y >= 0 && chg.y < S.grid.length) S.grid[chg.y] = chg.r || [];
      }
      if (m.cursor) S.cursor = m.cursor;
      S.miniDirty = true;
      scheduleRender();
      requestAnimationFrame(followCursor);
      updateStatus();
      break;

    case 'pong':
      break;

    case 'error':
      setConn('off', m.msg || '错误');
      break;
  }
}

function updateStatus() {
  if (S.conn !== 'on') return;
  const p = S.panes.find((x) => x.sid === S.cur);
  if (p) {
    setConn('on', `${S.cols}×${S.rowCount} · 光标 ${S.cursor.x},${S.cursor.y}`);
  }
}

/* ------------------------------ tab ------------------------------ */

function paneLabel(p, i) {
  const t = (p.title || '').replace(/\s+/g, ' ').trim();
  if (t) return t;
  if (p.job) return p.job;
  return 'pane ' + (i + 1);
}

function renderTabs() {
  el.tabs.innerHTML = '';
  S.panes.forEach((p, i) => {
    const b = document.createElement('button');
    b.className = 'tab' + (p.sid === S.cur ? ' cur' : '');
    b.setAttribute('role', 'tab');

    if (p.active) {
      const pin = document.createElement('span');
      pin.className = 'pin';
      b.appendChild(pin);
    }
    const idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = String(i + 1);
    b.appendChild(idx);

    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = paneLabel(p, i);
    b.appendChild(nm);

    b.onclick = () => selectPane(p.sid);
    el.tabs.appendChild(b);
  });
}

function selectPane(sid) {
  if (sid === S.cur && S.rowCount) return;
  // 切 pane 时丢掉未发送的草稿，避免发到错误的终端
  el.ime.value = '';
  autoGrow();
  S.cur = sid;
  S.grid = [];
  S.rowCount = 0;
  S.cursor = { x: 0, y: 0 };
  const p = S.panes.find((x) => x.sid === sid);
  if (p) S.cols = p.cols || S.cols;
  el.empty.classList.remove('hide');
  el.empty.textContent = '读取中…';
  layoutCanvas();
  draw();
  renderTabs();
  send({ type: 'sub', sid });
}

/* ------------------------------ 输入 ------------------------------ */

/* 输入框是本地草稿：打字时不发，按回车才把整行送进终端。
   这样用户能看见自己在打什么（终端字号在手机上太小）。
   代价是 Tab 补全需要先把草稿发出去，见 keyWithFlush。 */

let composing = false;

function sendText(t) {
  if (!t || !S.cur) return;
  send({ type: 'input', data: t });
}

function sendKey(k) {
  if (!S.cur) return;
  send({ type: 'key', key: k });
}

function autoGrow() {
  el.ime.style.height = 'auto';
  el.ime.style.height = Math.min(el.ime.scrollHeight, window.innerHeight * 0.3) + 'px';
}

/** 把输入框里的草稿送进终端并清空。返回是否真有内容被发送。 */
function flushIme() {
  const v = el.ime.value;
  if (!v) return false;
  sendText(v);
  el.ime.value = '';
  autoGrow();
  return true;
}

/** 发特殊键前先把草稿补发出去，保证 Tab 补全、方向键作用在正确的行上。 */
function keyWithFlush(k) {
  flushIme();
  sendKey(k);
}

el.ime.addEventListener('compositionstart', () => { composing = true; });
el.ime.addEventListener('compositionupdate', () => { composing = true; });
el.ime.addEventListener('compositionend', () => {
  composing = false;
  autoGrow();
});

// 打字只更新高度，不发往终端。
// iOS 上回车有时不走 keydown 而是往 value 里插 \n，这里一并兜住。
el.ime.addEventListener('input', () => {
  const v = el.ime.value;
  if (v.indexOf('\n') !== -1) {
    const before = v.slice(0, v.indexOf('\n'));
    el.ime.value = '';
    if (before) sendText(before);
    sendKey('enter');
    autoGrow();
    return;
  }
  autoGrow();
});

el.ime.addEventListener('keydown', (e) => {
  if (composing) return;
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    flushIme();
    sendKey('enter');
  }
});

el.send.textContent = '发送';
el.send.onclick = () => {
  flushIme();
  sendKey('enter');
  el.ime.focus();
};

const KEYS = [
  ['Esc', 'esc'], ['Tab', 'tab'], ['⇧Tab', 'shift-tab'],
  ['⌃C', 'ctrl-c'], ['⌃D', 'ctrl-d'], ['⌃R', 'ctrl-r'],
  ['⌃L', 'ctrl-l'], ['⌃Z', 'ctrl-z'], ['⌃U', 'ctrl-u'],
  ['↑', 'up'], ['↓', 'down'], ['←', 'left'], ['→', 'right'],
  ['⌫', 'backspace'],
];

KEYS.forEach(([label, key]) => {
  const b = document.createElement('button');
  b.textContent = label;
  b.onclick = () => {
    if (key === 'ctrl-c' || key === 'ctrl-d') {
      // 中断类按键：丢掉草稿，直接发信号
      el.ime.value = '';
      autoGrow();
      sendKey(key);
      return;
    }
    if (key === 'backspace') {
      // 草稿里还有字就先删草稿，符合"删我刚打的"直觉
      if (el.ime.value) {
        el.ime.value = el.ime.value.slice(0, -1);
        autoGrow();
        return;
      }
      sendKey(key);
      return;
    }
    if (key === 'up' || key === 'down' || key === 'left' || key === 'right') {
      // 方向键作用在终端命令行上，草稿必须先落地
      keyWithFlush(key);
      return;
    }
    keyWithFlush(key);
  };
  el.keys.appendChild(b);
});

/* --------------------------- 缩放 / 平移 --------------------------- */

let pinchStart = 0;
let pinchFont = 0;

el.wrap.addEventListener('touchstart', (e) => {
  if (e.touches.length === 2) {
    const [a, b] = e.touches;
    pinchStart = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    pinchFont = S.fontSize;
  }
}, { passive: true });

el.wrap.addEventListener('touchmove', (e) => {
  if (e.touches.length === 2 && pinchStart > 0) {
    const [a, b] = e.touches;
    const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const ratio = d / pinchStart;
    const next = Math.max(6, Math.min(26, pinchFont * ratio));
    if (Math.abs(next - S.fontSize) > 0.4) {
      S.fontSize = next;
      measureCell();
      fontCache.clear();
      layoutCanvas();
      draw();
    }
    e.preventDefault();
  }
}, { passive: false });

el.wrap.addEventListener('touchend', (e) => {
  if (e.touches.length < 2) pinchStart = 0;
}, { passive: true });

el.wrap.addEventListener('wheel', (e) => {
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    S.fontSize = Math.max(6, Math.min(26, S.fontSize * (e.deltaY < 0 ? 1.08 : 0.93)));
    measureCell();
    fontCache.clear();
    layoutCanvas();
    draw();
  }
}, { passive: false });

el.wrap.addEventListener('scroll', () => {
  drawMiniViewport();
  // 程序化滚动后短时间内的事件不算"用户操作"
  if (Date.now() - autoScrollAt < 200) return;
  if (S.follow) setFollow(false);
});

function setFollow(on) {
  S.follow = on;
  el.follow.classList.toggle('on', on);
}
el.follow.onclick = () => {
  setFollow(!S.follow);
  if (S.follow) followCursor();
};
el.home.onclick = () => {
  el.wrap.scrollLeft = 0;
  autoScrollAt = Date.now();
  setFollow(false);
};

/* 全览：把整屏（宽和高）都缩进视口，看清版式。
   列数多的时候字号必然小到不可读，对话框明确说明这一点。 */
el.fit.onclick = () => {
  const cols = Math.max(S.cols, 1);
  const rows = Math.max(S.rowCount || S.rows || 1, 1);
  const availW = el.wrap.clientWidth - 2;
  const availH = el.wrap.clientHeight - 2;
  const perW = S.cellW / S.fontSize;    // 每单位字号对应的字符宽
  const perH = S.cellH / S.fontSize;    // 每单位字号对应的行高

  const byW = availW / cols / perW;
  const byH = availH / rows / perH;
  const size = Math.min(byW, byH);

  S.fontSize = Math.max(1.8, Math.min(26, size));
  measureCell();
  fontCache.clear();
  layoutCanvas();
  draw();
  setFollow(false);
  el.wrap.scrollLeft = 0;
  el.wrap.scrollTop = 0;

  if (S.fontSize < READABLE_PX) {
    showToast(`${cols} 列 × ${rows} 行整屏装下需要 ${S.fontSize.toFixed(1)}px 字号，只够看版式。要读内容请双击放大，或用底部缩略图跳转。`, 4600);
  } else {
    showToast(`已全览 ${cols} 列（${S.fontSize.toFixed(1)}px）`, 1800);
  }
  requestAnimationFrame(updateMiniVisibility);
};

const SIZES = [11, 13, 15, 18, 21];
el.size.onclick = () => {
  let i = SIZES.findIndex((v) => v >= S.fontSize - 0.5);
  if (i < 0) i = 0;
  S.fontSize = SIZES[(i + 1) % SIZES.length];
  measureCell();
  fontCache.clear();
  layoutCanvas();
  draw();
  followCursor();
};

el.wrap.addEventListener('click', (e) => {
  if (e.target === el.canvas) el.ime.focus();
});

/* --------------------------- 双击放大 --------------------------- */

/* 272 列在手机上一屏只有 1/5，靠拖很难对准。
   双击某处 → 放大到可读字号并把那一格居中；再双击 → 缩回默认。 */

const ZOOM_IN = 16;
const ZOOM_OUT = 13;

function cellAt(clientX, clientY) {
  const rect = el.canvas.getBoundingClientRect();
  const x = (clientX - rect.left) / S.cellW;
  const y = (clientY - rect.top) / S.cellH;
  return { x, y };
}

function centerOn(cellX, cellY) {
  const wrap = el.wrap;
  wrap.scrollLeft = Math.max(0, cellX * S.cellW - wrap.clientWidth / 2);
  wrap.scrollTop = Math.max(0, cellY * S.cellH - wrap.clientHeight / 2);
  autoScrollAt = Date.now();
}

function toggleZoom(clientX, clientY) {
  const c = cellAt(clientX, clientY);
  const zoomed = S.fontSize >= ZOOM_IN - 0.5;
  S.fontSize = zoomed ? ZOOM_OUT : ZOOM_IN;
  measureCell();
  fontCache.clear();
  layoutCanvas();
  draw();
  requestAnimationFrame(() => {
    centerOn(c.x, c.y);
    drawMiniViewport();
  });
  if (!zoomed) setFollow(false);
}

let lastTap = 0;
let lastTapX = 0;
let lastTapY = 0;

el.wrap.addEventListener('touchend', (e) => {
  if (e.changedTouches.length !== 1 || e.touches.length > 0) return;
  const t = e.changedTouches[0];
  const now = Date.now();
  const dx = Math.abs(t.clientX - lastTapX);
  const dy = Math.abs(t.clientY - lastTapY);

  if (now - lastTap < 320 && dx < 40 && dy < 40) {
    lastTap = 0;
    toggleZoom(t.clientX, t.clientY);
    e.preventDefault();
    return;
  }
  lastTap = now;
  lastTapX = t.clientX;
  lastTapY = t.clientY;
}, { passive: false });

/* 桌面端双击同样生效 */
el.canvas.addEventListener('dblclick', (e) => {
  toggleZoom(e.clientX, e.clientY);
});

/* ---------------------------- 视口高度 ---------------------------- */

function fixHeight() {
  const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  document.documentElement.style.setProperty('--vh', h + 'px');
}

window.addEventListener('resize', () => {
  fixHeight();
  layoutCanvas();
  draw();
  requestAnimationFrame(updateMiniVisibility);
});

if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => {
    fixHeight();
    setTimeout(() => {
      layoutCanvas();
      draw();
      updateMiniVisibility();
    }, 60);
  });
}

// 旋屏后缩略图宽度变了，需要重排
window.addEventListener('orientationchange', () => {
  setTimeout(() => {
    layoutCanvas();
    draw();
    updateMiniVisibility();
  }, 260);
});

/* ------------------------------ 启动 ------------------------------ */

measureCell();
fixHeight();
layoutCanvas();
draw();
autoGrow();
connect();
requestAnimationFrame(updateMiniVisibility);
