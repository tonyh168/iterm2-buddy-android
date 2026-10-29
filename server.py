#!/usr/bin/env python3
"""
iTerm2 Mirror
=============
把本机 iTerm2 的每个 pane（session）映射成浏览器里的一个 tab。

数据流：
    iTerm2 (unix socket / Python API)
        -> ScreenStreamer 事件驱动读屏（含样式）
        -> 按 cell 编码成 style runs
        -> 逐行 diff，只推变化的行
        -> WebSocket
        -> 前端 canvas 按 cell 网格绘制

设计要点：
  * 不需要 xterm.js：数据源本来就是渲染好的 cell 网格
  * 不需要轮询：async_get() 阻塞到屏幕真的变化
  * 不改 PTY 尺寸：手机端做缩放/平移，避免打乱本地窗口
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import mimetypes
import os
import signal
import sys
import time
import unicodedata
from pathlib import Path
from typing import Any

import iterm2
from websockets.asyncio.server import serve
from websockets.datastructures import Headers
from websockets.http11 import Response

STATIC_DIR = Path(__file__).resolve().parent / "static"

log = logging.getLogger("mirror")

# --------------------------------------------------------------------------
# 颜色：把 iTerm2 的 CellStyle.Color 转成 CSS 颜色
# --------------------------------------------------------------------------

# iTerm2 默认（Light/Dark 之外的通用）16 色近似值。
# 前 16 色在真实终端里由用户主题决定，这里给一套深色主题常用值。
ANSI16 = (
    "#000000", "#c91b00", "#00c200", "#c7c400", "#0225c7", "#ca30c7", "#00c5c7", "#c7c7c7",
    "#686868", "#ff6e67", "#5ffa68", "#fffc67", "#6871ff", "#ff77ff", "#60fdff", "#ffffff",
)
_CUBE = (0, 95, 135, 175, 215, 255)


def _standard_to_hex(idx: int) -> str:
    """256 色板的 standard 色号 -> hex。"""
    if idx < 16:
        return ANSI16[idx]
    if idx < 232:
        n = idx - 16
        r, g, b = n // 36, (n % 36) // 6, n % 6
        return f"#{_CUBE[r]:02x}{_CUBE[g]:02x}{_CUBE[b]:02x}"
    v = 8 + 10 * (idx - 232)
    return f"#{v:02x}{v:02x}{v:02x}"


def color_hex(c) -> str | None:
    """CellStyle.Color -> '#rrggbb'；None 表示"用默认色"。"""
    if c is None:
        return None
    try:
        if c.is_rgb:
            rgb = c.rgb
            return f"#{rgb.red:02x}{rgb.green:02x}{rgb.blue:02x}"
        if c.is_standard:
            return _standard_to_hex(c.standard)
        if c.is_alternate:
            # DEFAULT = 用主题默认色；REVERSED_DEFAULT = 前景背景互换。
            # 用 name 比较，避免耦合 iterm2 包内部的类路径。
            alt = c.alternate
            if getattr(alt, "name", "") == "REVERSED_DEFAULT":
                return "@rev"
            return None
    except Exception:
        return None
    return None


# --------------------------------------------------------------------------
# 屏幕编码
# --------------------------------------------------------------------------

_ATTR_BOLD = 1
_ATTR_ITALIC = 2
_ATTR_UNDERLINE = 4
_ATTR_INVERSE = 8
_ATTR_FAINT = 16
_ATTR_STRIKE = 32


def _cell_count(li) -> int:
    """一行的 cell（列）数量。宽字符占 2 个 cell，第 2 格是空串。"""
    try:
        return len(li._LineContents__offset_of_cell) - 1  # type: ignore[attr-defined]
    except Exception:
        return len(li.string)


def _style_of(st) -> tuple[str | None, str | None, int]:
    if st is None:
        return (None, None, 0)
    fg = color_hex(st.fg_color)
    bg = color_hex(st.bg_color)
    a = 0
    if st.bold:
        a |= _ATTR_BOLD
    if st.italic:
        a |= _ATTR_ITALIC
    if st.underline:
        a |= _ATTR_UNDERLINE
    if st.inverse:
        a |= _ATTR_INVERSE
    if st.faint:
        a |= _ATTR_FAINT
    if st.strikethrough:
        a |= _ATTR_STRIKE
    return (fg, bg, a)


EMPTY_CELL = "\x00"


def _is_wide_char(ch: str) -> bool:
    """东亚宽字符判定，与终端按 2 列渲染的字符集对齐。"""
    if not ch:
        return False
    if unicodedata.combining(ch):
        return False
    return unicodedata.east_asian_width(ch) in ("W", "F")


def encode_line(li) -> dict:
    """
    把一行编码成 style runs。

        {"n": cell 总数, "r": [[x, 文本, 视觉列宽, fg, bg, attrs], ...]}

    约定：
      * 非空 cell 存字符本身
      * 空 cell 存 EMPTY_CELL 占位，让前端能按 cell 精确定位，
        不会因漏格而整行左移
      * 宽字符的第 2 格同样是空 cell，视觉列宽记为 0（已被前一个字符覆盖）
      * 行尾连续空 cell 裁掉，避免无意义占位符撑大体积

    run 里的 `视觉列宽` 是该段实际占用的列数，前端可据此校验自己的
    字符宽度判定是否与终端一致。
    """
    n = _cell_count(li)

    cells: list[tuple[str, tuple[str | None, str | None, int]]] = []
    for x in range(n):
        try:
            ch = li.string_at(x) or ""
        except Exception:
            ch = ""
        cells.append((ch, _style_of(li.style_at(x))))

    while cells and cells[-1][0] == "":
        cells.pop()

    # 先算每个 cell 的视觉宽度（宽字符占位格记 0）
    widths: list[int] = []
    prev_wide = False
    for ch, _key in cells:
        if ch == "":
            widths.append(0 if prev_wide else 1)
            prev_wide = False
        else:
            w = 2 if _is_wide_char(ch) else 1
            widths.append(w)
            prev_wide = w == 2

    runs: list[list[Any]] = []
    i = 0
    total = len(cells)
    while i < total:
        key = cells[i][1]
        start = i
        buf: list[str] = []
        vis = 0
        while i < total and cells[i][1] == key:
            buf.append(cells[i][0] or EMPTY_CELL)
            vis += widths[i]
            i += 1
        fg, bg, a = key
        runs.append([start, "".join(buf), vis, fg, bg, a])

    return {"n": n, "r": runs}


def encode_screen(sc) -> tuple[list[dict | None], dict, int]:
    """
    编码整屏。

    返回 (rows, cursor, start_line)：
      rows[i] 为第 i 行的编码，None 表示空白行
      cursor 为窗口内相对坐标
      start_line 为该行在 buffer 中的绝对行号
    """
    start_line = _buffer_start(sc)

    rows: list[dict | None] = []
    for i in range(sc.number_of_lines):
        try:
            enc = encode_line(sc.line(i))
        except Exception:
            enc = {"n": 0, "r": []}
        rows.append(enc if enc["r"] else None)

    cur = sc.cursor_coord
    cursor = {"x": int(cur.x), "y": int(cur.y) - start_line}
    return rows, cursor, start_line


def _buffer_start(sc) -> int:
    """可见区域首行的绝对行号。属性名在绑定里是驼峰，做两种兼容。"""
    try:
        wr = sc.windowed_coord_range
    except Exception:
        return 0
    for attr in ("coordRange", "coord_range"):
        cr = getattr(wr, attr, None)
        if cr is None:
            continue
        try:
            return int(cr.start.y)
        except Exception:
            continue
    return 0


# --------------------------------------------------------------------------
# Pane 状态
# --------------------------------------------------------------------------


class Pane:
    """单个 iTerm2 session（pane）的镜像状态。"""

    def __init__(self, sid: str, tab_id: str, window_id: str) -> None:
        self.sid = sid
        self.tab_id = tab_id
        self.window_id = window_id
        self.title: str = ""
        self.cols: int = 80
        self.rows: int = 24
        self.active: bool = False
        self.job: str = ""

        # 上一帧的指纹，用于 diff
        self.sig: list[int] = []
        self.cursor: dict = {"x": 0, "y": 0}
        self.start_line: int = 0

        # 最近一次全量快照：新订阅者 / 断线重连时直接下发，避免增量错位
        self.snapshot: dict | None = None

        self.dirty: bool = False
        self.version: int = 0

    def meta(self) -> dict:
        return {
            "sid": self.sid,
            "tab": self.tab_id,
            "win": self.window_id,
            "title": self.title,
            "cols": self.cols,
            "rows": self.rows,
            "active": self.active,
            "job": self.job,
        }

    def apply(self, rows: list[dict | None], cursor: dict, start_line: int) -> list[dict] | None:
        """应用新的一帧，返回需要发送的变化行。"""
        new_sig = [hash(json.dumps(r, ensure_ascii=False)) if r else 0 for r in rows]
        changed: list[dict] = []
        old_len = len(self.sig)

        for y, (row, s) in enumerate(zip(rows, new_sig)):
            if y >= old_len or self.sig[y] != s:
                changed.append({"y": y, "r": row["r"] if row else []})

        # 行数变少：把多出来的清空
        if old_len > len(rows):
            for y in range(len(rows), old_len):
                changed.append({"y": y, "r": []})

        self.sig = new_sig
        self.cursor = cursor
        self.start_line = start_line
        self.dirty = True
        self.version += 1

        self.snapshot = {
            "sid": self.sid,
            "rows": [r["r"] if r else [] for r in rows],
            "cursor": cursor,
            "start": start_line,
            "cols": self.cols,
            "rows_count": len(rows),
        }
        return changed


# --------------------------------------------------------------------------
# iTerm2 桥
# --------------------------------------------------------------------------


class Bridge:
    """维护与 iTerm2 的连接、pane 列表和屏幕事件泵。"""

    def __init__(self, hub: "Hub") -> None:
        self.hub = hub
        self.conn: Any = None
        self.app: Any = None
        self.sessions: dict[str, Any] = {}
        self.pumps: dict[str, asyncio.Task] = {}
        self._stop = False

    async def run(self) -> None:
        backoff = 1.0
        while not self._stop:
            try:
                log.info("连接 iTerm2 API ...")
                self.conn = await iterm2.Connection.async_create()
                self.app = await iterm2.async_get_app(self.conn)
                log.info("已连接 iTerm2")
                backoff = 1.0
                await self._supervise()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.warning("iTerm2 连接异常: %s: %s", type(exc).__name__, exc)
                self.hub.mark_offline()
            finally:
                await self._teardown_pumps()
            if self._stop:
                break
            log.info("%.0fs 后重连 iTerm2", backoff)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 15.0)

    async def _supervise(self) -> None:
        """刷新结构 + 监听布局变化 + 定期刷新标题。"""
        await self.refresh_structure()

        async def watch_layout() -> None:
            async with iterm2.LayoutChangeMonitor(self.conn) as mon:
                while True:
                    await mon.async_get()
                    await asyncio.sleep(0.15)  # 合并短时间内的连续变化
                    try:
                        await self.refresh_structure()
                    except Exception as exc:
                        log.debug("刷新结构失败: %s", exc)

        async def watch_titles() -> None:
            while True:
                await asyncio.sleep(1.5)
                try:
                    await self.refresh_titles()
                except Exception:
                    pass

        t1 = asyncio.create_task(watch_layout(), name="layout")
        t2 = asyncio.create_task(watch_titles(), name="titles")
        try:
            await asyncio.gather(t1, t2)
        finally:
            t1.cancel()
            t2.cancel()

    async def refresh_structure(self) -> None:
        """重新扫描 window/tab/session，起停对应的屏幕泵。"""
        seen: set[str] = set()
        changed = False
        to_pump: list[tuple[Any, Pane]] = []

        for win in self.app.windows:
            for tab in win.tabs:
                for sess in tab.sessions:
                    sid = sess.session_id
                    seen.add(sid)
                    self.sessions[sid] = sess
                    pane = self.hub.panes.get(sid)
                    if pane is None:
                        pane = Pane(sid, tab.tab_id, win.window_id)
                        self.hub.panes[sid] = pane
                        changed = True
                        log.info("发现 pane %s", sid[:8])
                    pane.tab_id = tab.tab_id
                    pane.window_id = win.window_id
                    to_pump.append((sess, pane))

        for sid in list(self.hub.panes):
            if sid not in seen:
                log.info("pane %s 已消失", sid[:8])
                self.hub.remove_pane(sid)
                task = self.pumps.pop(sid, None)
                if task:
                    task.cancel()
                self.sessions.pop(sid, None)
                changed = True

        # 先刷新标题与尺寸：保证每帧 full 里的 cols/rows 是正确的，
        # 否则前端会按 Pane 初始默认的 80 列排版。
        await self.refresh_titles()

        for sess, pane in to_pump:
            if pane.sid not in self.pumps or self.pumps[pane.sid].done():
                self.pumps[pane.sid] = asyncio.create_task(
                    self._pump(sess, pane), name=f"pump-{pane.sid[:8]}"
                )

        if changed:
            await self.hub.broadcast_meta()

    async def refresh_titles(self) -> None:
        changed = False
        for sid, sess in list(self.sessions.items()):
            pane = self.hub.panes.get(sid)
            if pane is None:
                continue
            try:
                title = await sess.async_get_variable("name") or ""
                job = await sess.async_get_variable("jobName") or ""
                cols = await sess.async_get_variable("columns") or pane.cols
                rows = await sess.async_get_variable("rows") or pane.rows
                active = await sess.async_get_variable("is_active")
            except Exception:
                continue
            if (title, job, cols, rows, bool(active)) != (
                pane.title, pane.job, pane.cols, pane.rows, pane.active
            ):
                pane.title, pane.job = title, job
                pane.cols, pane.rows = int(cols), int(rows)
                pane.active = bool(active)
                changed = True
        if changed:
            await self.hub.broadcast_meta()

    async def _pump(self, sess, pane: Pane) -> None:
        """单个 pane 的屏幕事件循环。"""
        try:
            # 尺寸双保险：refresh_titles 可能因时序还没更新到这里
            try:
                c = await sess.async_get_variable("columns")
                r = await sess.async_get_variable("rows")
                if c:
                    pane.cols = int(c)
                if r:
                    pane.rows = int(r)
            except Exception:
                pass

            async with sess.get_screen_streamer(want_contents=True) as streamer:
                # 先拿一帧初始画面
                try:
                    sc = await sess.async_get_screen_contents()
                    rows, cursor, start = encode_screen(sc)
                    pane.apply(rows, cursor, start)
                    await self.hub.flush(pane)
                except Exception as exc:
                    log.debug("初始读屏失败 %s: %s", pane.sid[:8], exc)

                while True:
                    sc = await streamer.async_get(style=True)
                    if sc is None:
                        continue
                    rows, cursor, start = encode_screen(sc)
                    changed = pane.apply(rows, cursor, start)
                    if changed:
                        await self.hub.push_delta(pane, changed)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.warning("pane %s 读屏中断: %s: %s", pane.sid[:8], type(exc).__name__, exc)
            await asyncio.sleep(0.5)
            self.pumps.pop(pane.sid, None)  # 让 supervise 重新拉起

    async def send_text(self, sid: str, text: str) -> bool:
        """把文本当作"用户敲键盘"送进 PTY。

        注意：必须用 async_send_text 而不是 async_inject。
        async_inject 的语义是"当成程序输出"，回车、退格这类控制字符
        会被当成要显示的内容吞掉，shell 根本收不到。
        """
        sess = self.sessions.get(sid)
        if sess is None:
            return False
        if not text:
            return True
        try:
            await sess.async_send_text(text)
            return True
        except Exception as exc:
            log.warning("发送文本失败: %s", exc)
            return False

    async def activate(self, sid: str) -> None:
        sess = self.sessions.get(sid)
        if sess is None:
            return
        try:
            await sess.async_activate()
        except Exception:
            pass

    async def _teardown_pumps(self) -> None:
        tasks = list(self.pumps.values())
        self.pumps.clear()
        for t in tasks:
            t.cancel()
        for t in tasks:
            try:
                await t
            except (asyncio.CancelledError, Exception):
                pass


async def _safe(coro) -> str:
    try:
        return str(await coro)
    except Exception:
        return ""


# --------------------------------------------------------------------------
# Hub：客户端订阅与推送
# --------------------------------------------------------------------------


class Client:
    def __init__(self, ws) -> None:
        self.ws = ws
        self.sub: str | None = None


class Hub:
    def __init__(self) -> None:
        self.panes: dict[str, Pane] = {}
        self.clients: set[Client] = set()
        self.iterm_online = False

    def mark_offline(self) -> None:
        self.iterm_online = False

    def remove_pane(self, sid: str) -> None:
        self.panes.pop(sid, None)

    def meta_payload(self) -> dict:
        order = sorted(self.panes.values(), key=lambda p: (p.window_id, p.tab_id, p.sid))
        return {
            "type": "meta",
            "online": self.iterm_online,
            "panes": [p.meta() for p in order],
        }

    async def _send(self, client: Client, payload: dict) -> None:
        try:
            await client.ws.send(json.dumps(payload, ensure_ascii=False))
        except Exception:
            self.clients.discard(client)

    async def broadcast_meta(self) -> None:
        if not self.clients:
            return
        payload = self.meta_payload()
        for c in list(self.clients):
            await self._send(c, payload)

    async def push_delta(self, pane: Pane, changed: list[dict]) -> None:
        targets = [c for c in self.clients if c.sub == pane.sid]
        if not targets:
            pane.dirty = False
            return
        payload = {
            "type": "delta",
            "sid": pane.sid,
            "rows": changed,
            "cursor": pane.cursor,
        }
        for c in targets:
            await self._send(c, payload)
        pane.dirty = False

    async def flush(self, pane: Pane) -> None:
        """下发当前全量快照（新订阅 / 重连时用）。"""
        targets = [c for c in self.clients if c.sub == pane.sid]
        if not targets or pane.snapshot is None:
            return
        payload = {"type": "full", **pane.snapshot}
        for c in targets:
            await self._send(c, payload)

    # ---------------- 客户端消息处理 ----------------

    async def on_client(self, ws) -> None:
        client = Client(ws)
        self.clients.add(client)
        log.info("客户端接入，当前 %d 个", len(self.clients))
        try:
            await self._send(client, self.meta_payload())
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except Exception:
                    continue
                await self._dispatch(client, msg)
        except Exception as exc:
            log.debug("客户端断开: %s", type(exc).__name__)
        finally:
            self.clients.discard(client)
            log.info("客户端断开，剩余 %d 个", len(self.clients))

    async def _dispatch(self, client: Client, msg: dict) -> None:
        t = msg.get("type")
        if t == "sub":
            sid = msg.get("sid")
            client.sub = sid
            pane = self.panes.get(sid)
            if pane is not None:
                await self.flush(pane)
        elif t == "unsub":
            client.sub = None
        elif t == "input":
            if client.sub:
                await self.bridge.send_text(client.sub, msg.get("data", ""))
        elif t == "key":
            if client.sub:
                seq = KEYMAP.get(msg.get("key", ""))
                if seq:
                    await self.bridge.send_text(client.sub, seq)
        elif t == "ping":
            await self._send(client, {"type": "pong", "t": msg.get("t")})
        elif t == "refresh":
            await self._send(client, self.meta_payload())
            if client.sub and client.sub in self.panes:
                await self.flush(self.panes[client.sub])

    bridge: "Bridge"


# 特殊键 -> 发往 PTY 的字符串序列
# 全部通过 async_send_text 发送（当作键盘输入），不能用 inject。
KEYMAP: dict[str, str] = {
    "esc": "\x1b",
    "tab": "\t",
    "enter": "\r",
    "backspace": "\x7f",
    "up": "\x1b[A",
    "down": "\x1b[B",
    "right": "\x1b[C",
    "left": "\x1b[D",
    "home": "\x1b[H",
    "end": "\x1b[F",
    "pageup": "\x1b[5~",
    "pagedown": "\x1b[6~",
    "ctrl-a": "\x01",
    "ctrl-b": "\x02",
    "ctrl-c": "\x03",
    "ctrl-d": "\x04",
    "ctrl-e": "\x05",
    "ctrl-f": "\x06",
    "ctrl-g": "\x07",
    "ctrl-k": "\x0b",
    "ctrl-l": "\x0c",
    "ctrl-n": "\x0e",
    "ctrl-o": "\x0f",
    "ctrl-p": "\x10",
    "ctrl-q": "\x11",
    "ctrl-r": "\x12",
    "ctrl-s": "\x13",
    "ctrl-t": "\x14",
    "ctrl-u": "\x15",
    "ctrl-v": "\x16",
    "ctrl-w": "\x17",
    "ctrl-x": "\x18",
    "ctrl-y": "\x19",
    "ctrl-z": "\x1a",
    "ctrl-\\": "\x1c",
    "shift-tab": "\x1b[Z",
}


# --------------------------------------------------------------------------
# HTTP / WebSocket 服务（单端口）
# --------------------------------------------------------------------------


def _query_token(path: str) -> str:
    q = path.split("?", 1)
    if len(q) < 2:
        return ""
    from urllib.parse import parse_qs

    return (parse_qs(q[1]).get("t") or [""])[0]


def _cookie_token(request) -> str:
    raw = request.headers.get("Cookie", "")
    for part in raw.split(";"):
        k, _, v = part.strip().partition("=")
        if k == "mirror":
            return v
    return ""


LOGIN_HTML = """<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>iTerm2 Mirror · 访问受限</title><style>
body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
background:#101014;color:#d8d8dc;font-family:-apple-system,"PingFang SC",sans-serif}
.card{width:min(90vw,340px);padding:26px;background:#17171d;border:1px solid #2c2c36;border-radius:14px}
h1{font-size:16px;font-weight:500;margin:0 0 6px}
p{font-size:12.5px;color:#8b8b96;margin:0 0 18px;line-height:1.6}
input{width:100%;box-sizing:border-box;font:inherit;font-size:14px;padding:10px 12px;
background:#1f1f27;border:1px solid #2c2c36;border-radius:8px;color:#d8d8dc;outline:none}
input:focus{border-color:#4a9eff}
button{width:100%;margin-top:10px;font:inherit;font-size:14px;padding:10px;border:none;
border-radius:8px;background:#4a9eff;color:#fff;cursor:pointer}
</style></head><body><div class="card">
<h1>需要访问令牌</h1>
<p>这个页面映射着本机终端，只有持有令牌的人可以进入。</p>
<form onsubmit="location.href='/?t='+encodeURIComponent(document.querySelector('input').value);return false">
<input placeholder="粘贴访问令牌" autofocus autocomplete="off">
<button>进入</button>
</form></div></body></html>"""


def make_process_request(verbose: bool, token: str = ""):
    root = STATIC_DIR.resolve()

    def process_request(conn, request) -> Response | None:
        raw_path = request.path
        path = raw_path.split("?")[0]
        if path == "/ws":
            return None  # 交给 WS 握手

        if path in ("/", ""):
            path = "/index.html"

        # ---- 鉴权 ----
        set_cookie = None
        if token:
            q = _query_token(raw_path)
            if q == token:
                set_cookie = f"mirror={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000"
            elif _cookie_token(request) != token:
                h = Headers()
                h["Content-Type"] = "text/html; charset=utf-8"
                h["Cache-Control"] = "no-store"
                body = LOGIN_HTML.encode()
                h["Content-Length"] = str(len(body))
                return Response(401, "Unauthorized", h, body)

        try:
            fp = (root / path.lstrip("/")).resolve()
            if not str(fp).startswith(str(root)) or not fp.is_file():
                raise FileNotFoundError(path)
            body = fp.read_bytes()
        except Exception:
            h = Headers()
            h["Content-Type"] = "text/plain; charset=utf-8"
            return Response(404, "Not Found", h, f"404 {path}".encode())

        ctype = mimetypes.guess_type(str(fp))[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        h = Headers()
        h["Content-Type"] = ctype
        h["Content-Length"] = str(len(body))
        h["Cache-Control"] = "no-store"
        if set_cookie:
            h["Set-Cookie"] = set_cookie
        if verbose:
            log.debug("GET %s -> %d bytes", path, len(body))
        return Response(200, "OK", h, body)

    return process_request


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------


async def amain(args) -> None:
    hub = Hub()
    bridge = Bridge(hub)
    hub.bridge = bridge

    async def handler(ws) -> None:
        path = ws.request.path.split("?")[0]
        if path != "/ws":
            await ws.close(code=1008, reason="expected /ws")
            return
        if args.token:
            tok = _query_token(ws.request.path) or _cookie_token(ws.request)
            if tok != args.token:
                await ws.send(json.dumps({"type": "error", "msg": "bad token"}))
                await ws.close(code=1008, reason="bad token")
                return
        await hub.on_client(ws)

    server = await serve(
        handler,
        args.host,
        args.port,
        process_request=make_process_request(args.verbose, args.token),
        ping_interval=25,
        ping_timeout=25,
        max_size=8 * 1024 * 1024,
        compression="deflate",
    )

    hub.iterm_online = True
    bridge_task = asyncio.create_task(bridge.run(), name="bridge")

    shown = "127.0.0.1" if args.host in ("0.0.0.0", "") else args.host
    qs = f"?t={args.token}" if args.token else ""
    log.info("=" * 58)
    log.info("  服务已启动")
    log.info("  本地访问:  http://%s:%d/%s", shown, args.port, qs)
    log.info("  WebSocket: ws://%s:%d/ws%s", shown, args.port, qs)
    log.info("=" * 58)

    stop = asyncio.Event()

    def _sig(*_a):
        log.info("收到退出信号")
        stop.set()

    loop = asyncio.get_running_loop()
    for s in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(s, _sig)
        except NotImplementedError:
            pass

    await stop.wait()

    bridge._stop = True
    bridge_task.cancel()
    server.close()
    await server.wait_closed()
    log.info("已退出")


def main() -> None:
    ap = argparse.ArgumentParser(description="iTerm2 pane 镜像到浏览器")
    ap.add_argument("--host", default="127.0.0.1", help="监听地址（走 tunnel 时保持 127.0.0.1）")
    ap.add_argument("--port", type=int, default=7861, help="监听端口")
    ap.add_argument("--token", default="", help="访问令牌（公网暴露时建议设置）")
    ap.add_argument("--verbose", action="store_true", help="输出调试日志")
    args = ap.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
    )

    if not STATIC_DIR.exists():
        log.error("缺少静态目录: %s", STATIC_DIR)
        sys.exit(1)

    try:
        asyncio.run(amain(args))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
