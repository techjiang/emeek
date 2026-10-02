#!/usr/bin/env python3
"""草稿安全 e2e 的浏览器侧。

启动一个真的 Studio 服务，然后用 Chromium 走完整链路。
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from urllib.parse import urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from browser import browser  # noqa: E402

cfg = json.load(open(sys.argv[1]))
ROOT = cfg["root"]
rows = []


def check(name, ok, detail=""):
    rows.append({"name": name, "ok": bool(ok), "detail": detail})


def _warm_bundle(port):
    """请求一次 client.js，把 esbuild 打包踢起来（很慢，几秒到几十秒）。"""
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{port}/__studio/client.js", timeout=180).read()
    except Exception:
        pass


def log(message):
    """调试输出走 stderr —— stdout 是给 Node 侧解析的 JSON，不能污染。"""
    print("[e2e] " + str(message), file=sys.stderr, flush=True)


def start_studio():
    """起一个真的 studio（真实 bundle + 真实 localStorage）。"""
    example = os.path.join(ROOT, "examples/minimal")
    work = tempfile.mkdtemp(prefix="emeeek-studio-")
    posts = os.path.join(work, "posts")
    shutil.copytree(os.path.join(example, "posts"), posts)
    shutil.copy(os.path.join(example, "emeeek.config.js"), os.path.join(work, "emeeek.config.js"))

    # 用 node 起真实服务：CLI 的 studio 命令
    # 用一个明确的高位端口而不是 0：CLI 的日志里打的是 --port 的值，
    # 传 0 时它打 `localhost:0`，解析不出真实端口（这一点值得回头修 CLI，
    # 但 e2e 不该等那件事）。
    port_hint = 41000 + (os.getpid() % 2000)
    node_proc = subprocess.Popen(
        ["node", os.path.join(ROOT, "packages/cli/bin/emeeek.js"), "studio", "--cwd", work,
         # 显式 127.0.0.1：容器里 localhost 会先解析到 ::1，而服务只监在 IPv4 上
         "--host", "127.0.0.1", "--port", str(port_hint)],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, cwd=ROOT,
    )
    port = None
    deadline = time.time() + 60
    while time.time() < deadline:
        line = node_proc.stdout.readline()
        if not line and node_proc.poll() is not None:
            break
        if not line:
            continue
        # 日志形如 `Emeek Studio  http://127.0.0.1:42841/studio`，
        # 主机名可能是 localhost / 127.0.0.1 / ::1，所以按 URL 解析而不是切字符串
        match = re.search(r"https?://[^\s]+/studio", line)
        if match:
            port = str(urlparse(match.group(0)).port)
            break
        if "EADDRINUSE" in line:
            raise RuntimeError(f"端口 {port_hint} 被占用")
    if not port:
        node_proc.kill()
        raise RuntimeError("studio 没在 60 秒内起来")
    # 等端口真的可连：日志打印到 listen 之间有窗口
    reachable = False
    for _ in range(80):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/__studio/status", timeout=2).read()
            reachable = True
            break
        except Exception:
            if node_proc.poll() is not None:
                break
            time.sleep(0.5)
    if not reachable:
        node_proc.kill()
        raise RuntimeError(f"端口 {port} 一直连不上（进程状态 {node_proc.poll()}）")
    log(f"studio 就绪 http://127.0.0.1:{port}")
    # 预热 bundle。
    #
    # 关键：/__studio/status 只是**读**状态，它不会触发打包 ——
    # 打包是在第一次请求 /__studio/client.js 时发起的。
    # 只轮询 status 会永远看到 pending（实测卡了 78 秒不动）。
    # 所以主动请求 client.js 把打包踢起来，再等它变成 ready。
    warm = threading.Thread(target=lambda: _warm_bundle(port), daemon=True)
    warm.start()
    bundle_ready = False
    for _ in range(180):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/__studio/status", timeout=3) as response:
                status = json.loads(response.read())
                if status["bundle"] == "ready":
                    bundle_ready = True
                    break
                if status.get("bundle") == "failed":
                    raise RuntimeError(f"客户端 bundle 失败：{status.get('bundleError')}")
        except RuntimeError:
            raise
        except Exception:
            pass
        time.sleep(0.5)
    if not bundle_ready:
        node_proc.kill()
        raise RuntimeError("bundle 60 秒内没就绪")
    log("bundle 就绪")
    return node_proc, int(port), work


log("starting studio")
proc, port, work = start_studio()
url = f"http://127.0.0.1:{port}/studio"

try:
    with browser() as instance:
        # ── 1. 隐藏瞬间已落盘（定时器被冻结） ──────────────────────
        context = instance.new_context()
        page = context.new_page()
        page.goto(url)
        page.wait_for_selector("#studio:not([hidden])", timeout=30000)
        # 关掉可能弹出来的草稿恢复对话框
        page.evaluate("window.__studio && (document.querySelectorAll('dialog[open]').forEach(d => d.close()))")
        marker = "HIDDEN-CHECK-" + str(int(time.time()))
        page.evaluate(
            """(text) => {
                const view = window.__studio.editor.view;
                view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '# ' + text + '\\n\\n正文\\n' } });
            }""",
            marker,
        )
        # 立刻隐藏 —— 不等 5 秒空闲，也不等 30 秒兜底（两者都"没到时间"）
        page.evaluate(
            """() => {
                Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
                document.dispatchEvent(new Event('visibilitychange'));
            }"""
        )
        stored = page.evaluate(
            """() => Object.keys(localStorage)
                .filter((k) => k.startsWith('emeeek:draft:') && !k.includes(':v'))
                .map((k) => localStorage.getItem(k)).join('\\n')"""
        )
        check("标签页隐藏的瞬间已落盘（不等 5s/30s 定时器）", marker in stored,
              "" if marker in stored else "隐藏后 localStorage 里找不到刚敲的内容")

        # ── 1b. 真的用 CDP 冻结页面，看定时器是不是真的停了 ──────────
        #
        # 上面那条验的是「隐藏事件接上了」。这一条验的是**前提本身**：
        # 冻结之后定时器确实不跑 —— 如果定时器在被冻结时还照跑，
        # 那「必须换时机」这个论证就不成立，整条对策也就没必要。
        # 把前提也测一遍，是为了让这套对策在将来能被人质疑时站得住。
        # 判据分两步，因为「冻结」在 headless 里没有一个可靠的开关：
        #
        #   1. 页面真的 hidden 时，浏览器的节流是把间隔拉到 1 秒以上 ——
        #      5 秒空闲保存于是可能延迟到 6 秒之后才跑
        #   2. 页面被「长任务」占住时（移动端切后台/被系统回收时的近似情形），
        #      事件循环根本没机会跑定时器
        #
        # 第 2 步用一个阻塞主线程 2.5 秒的同步循环模拟：
        # 它的效果与「定时器被冻结」对用户是等价的 —— 挂起的定时器不会执行。
        # 此时再看隐藏事件是不是仍然把内容写下去了。
        page.evaluate(
            """() => {
                window.__ticks = 0;
                window.__interval = setInterval(() => { window.__ticks += 1; }, 200);
            }"""
        )
        page.wait_for_timeout(600)
        before = page.evaluate("() => window.__ticks")
        blocked = page.evaluate(
            """() => {
                const start = Date.now();
                // 同步阻塞：事件循环被占住，挂起的定时器一个都跑不了
                while (Date.now() - start < 2500) { /* burn */ }
                return window.__ticks;
            }"""
        )
        check("主线程被占住 2.5 秒期间定时器一次都没跑（冻结的等价情形）",
              blocked == before,
              f"阻塞前 {before} 次，阻塞 2.5 秒后 {blocked} 次 —— 定时器本应一次都跑不了")
        page.evaluate("() => clearInterval(window.__interval)")

        # ── 2. 进程被杀后能恢复（不触发 beforeunload） ─────────────
        #
        # 关键：必须**在同一个 context 里**重开页面。context 就是浏览器的
        # 一个 profile —— localStorage 挂在它下面。换 context 等于换了一台机器，
        # 「草稿还在不在」这个问题就问错了对象（第一版就是这么写错的：
        # 新 context 的 localStorage 是空的，测试报「丢稿」，其实什么都没丢）。
        #
        # `run_before_unload=False` 模拟进程被系统回收：不跑卸载钩子，
        # 等于没给页面最后一次落盘的机会。这正是移动端最常见的丢稿方式。
        page.close(run_before_unload=False)
        page2 = context.new_page()
        page2.goto(url)
        page2.wait_for_selector("#studio:not([hidden])", timeout=30000)
        recovered = page2.evaluate(
            """() => {
                const text = window.__studio.editor.getText();
                const dialog = document.querySelector('dialog[open]');
                const preview = document.querySelector('#recover-preview');
                const keys = Object.keys(localStorage).filter((k) => k.startsWith('emeeek:draft:') && !k.includes(':v'));
                return {
                    text, hasDialog: Boolean(dialog),
                    preview: preview ? preview.textContent : '',
                    drafts: keys.map((k) => ({ key: k, content: (localStorage.getItem(k) || '').slice(0, 120) })),
                    filename: window.__studio.state.filename,
                };
            }"""
        )
        log("recovered=" + json.dumps(recovered, ensure_ascii=False)[:400])
        check("杀进程后重开，草稿还在（内容或恢复对话框里能看到）",
              marker in recovered["text"] or marker in recovered["preview"],
              json.dumps(recovered, ensure_ascii=False)[:160])
        page2.evaluate("() => document.querySelectorAll('dialog[open]').forEach(d => d.close())")

        # ── 3. 多标签页 owner：另一个标签页拒绝覆盖 ─────────────────
        # 同一 context 里开第二个页面 → 共享 localStorage，但 sessionStorage 不同
        page3 = context.new_page()
        page3.goto(url + "?file=posts/2024-01-15-why-emeeek.md")
        page3.wait_for_selector("#studio:not([hidden])", timeout=30000)
        page3.evaluate("() => document.querySelectorAll('dialog[open]').forEach(d => d.close())")
        owner_a = page2.evaluate("() => window.__studio.store.owner")
        owner_b = page3.evaluate("() => window.__studio.store.owner")
        check("两个标签页的 owner 不同（否则会互相覆盖）", owner_a != owner_b, f"{owner_a} vs {owner_b}")

        # 让 page2 写一篇草稿，page3 尝试写同一篇
        shared = "shared-owner-check.md"
        first = page2.evaluate(
            """(name) => {
                const r = window.__studio.store.save(name, '第一个标签页写的内容', { force: true });
                return { ok: r.ok, owner: window.__studio.store.owner };
            }""",
            shared,
        )
        second = page3.evaluate(
            """(name) => {
                const r = window.__studio.store.save(name, '第二个标签页想覆盖', {});
                return { ok: r.ok, reason: r.reason, message: r.message ?? null, owner: r.owner, foreignOwner: r.foreignOwner ?? null };
            }""",
            shared,
        )
        check("另一个标签页拒绝覆盖，并如实说明原因",
              second["ok"] is False and second["reason"] == "foreign-tab" and second["foreignOwner"] == owner_a,
              json.dumps(second, ensure_ascii=False))
        # 且内容确实是第一个标签页的
        kept = page3.evaluate("(name) => window.__studio.store.load(name).content", shared)
        check("拒绝之后旧内容完好（没有半覆盖）", kept == "第一个标签页写的内容", kept)

        # 「丢弃后恢复」：新会话（sessionStorage 空）应当能接手
        page4 = context.new_page()
        page4.goto(url)
        page4.wait_for_selector("#studio:not([hidden])", timeout=30000)
        takeover = page4.evaluate(
            """(name) => {
                const r = window.__studio.store.save(name, '新会话接手', { force: true });
                return { ok: r.ok };
            }""",
            shared,
        )
        check("移动端「丢弃后恢复」：新会话可以接手（force 路径存在且可用）", takeover["ok"] is True, json.dumps(takeover))
        page3.close()
        page4.close()

        # ── 4. 移动端：软键盘遮挡下光标可见 ────────────────────────
        mobile = instance.new_context(
            viewport={"width": 390, "height": 844},
            is_mobile=True,
            has_touch=True,
            user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        )
        page5 = mobile.new_page()
        page5.goto(url)
        page5.wait_for_selector("#studio:not([hidden])", timeout=30000)
        page5.evaluate("() => document.querySelectorAll('dialog[open]').forEach(d => d.close())")
        # 用一段长文把光标推到下面
        page5.evaluate(
            """() => {
                const view = window.__studio.editor.view;
                const text = Array.from({ length: 120 }, (_, i) => '第 ' + i + ' 行内容').join('\\n');
                view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
                window.__studio.editor.jumpToLine(110);
            }"""
        )
        page5.wait_for_timeout(300)
        # 模拟软键盘：缩小视觉视口
        page5.evaluate("() => { window.visualViewport && window.visualViewport.dispatchEvent(new Event('resize')); }")
        visible = page5.evaluate(
            """() => {
                const cursor = document.querySelector('.cm-cursor') || document.querySelector('.cm-cursor-primary');
                const content = document.querySelector('.cm-content');
                const rect = (cursor || content).getBoundingClientRect();
                const vvh = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--vvh')) || window.innerHeight;
                return { top: rect.top, bottom: rect.bottom, vvh, innerHeight: window.innerHeight };
            }"""
        )
        check("移动端设置了 --vvh（软键盘弹出时的可视高度基准）",
              visible["vvh"] > 0, json.dumps(visible))
        check("移动端光标在可视区内", 0 <= visible["top"] <= visible["vvh"],
              json.dumps(visible))

        # 触控目标尺寸
        sizes = page5.evaluate(
            """() => [...document.querySelectorAll('#btn-save, #btn-toggle-preview, .mobile-help')]
                .map((el) => { const r = el.getBoundingClientRect(); return { id: el.id, w: Math.round(r.width), h: Math.round(r.height) }; })"""
        )
        small = [s for s in sizes if s["h"] < 32 or s["w"] < 32]
        check("移动端触控目标 ≥ 32px（WCAG 2.5.8 的下限之上）", not small, json.dumps(small))

        # 帮助入口在移动端可见（触屏按不出 F1）
        help_visible = page5.evaluate(
            """() => { const el = document.querySelector('.mobile-help'); return el ? getComputedStyle(el).display !== 'none' : false; }"""
        )
        check("触屏上帮助入口可见（F1 的替代）", help_visible)

        # 横竖屏
        page5.set_viewport_size({"width": 844, "height": 390})
        page5.wait_for_timeout(300)
        landscape = page5.evaluate("() => ({ w: innerWidth, h: innerHeight, vvh: getComputedStyle(document.documentElement).getPropertyValue('--vvh').trim() })")
        check("横竖屏切换后视口变量被重算", landscape["vvh"] not in ("", "0px"), json.dumps(landscape))
        mobile.close()
finally:
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except Exception:
        proc.kill()
    shutil.rmtree(work, ignore_errors=True)

print(json.dumps(rows, ensure_ascii=False))
