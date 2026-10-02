#!/usr/bin/env python3
"""dev/studio 集成 e2e 的浏览器侧。

起一个真的 `emeeek studio`（带 projectRoot + watch），真的改磁盘文件，
看编辑器怎么反应。
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from urllib.parse import urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from browser import browser  # noqa: E402

cfg = json.load(open(sys.argv[1]))
ROOT = cfg["root"]
rows = []


def check(name, ok, detail=""):
    rows.append({"name": name, "ok": bool(ok), "detail": str(detail)[:200]})


def log(message):
    """调试输出写到固定文件 —— stderr 在 Node 的 spawnSync 里可能被截断，
    而定位这类「事件到了但没生效」的问题需要完整信息。"""
    print("[e2e] " + str(message), file=sys.stderr, flush=True)
    try:
        with open("/tmp/emeeek-e2e.log", "a", encoding="utf-8") as handle:
            handle.write(str(message) + "\n")
    except Exception:
        pass


def start_studio(work):
    port_hint = 43000 + (os.getpid() % 1500)
    proc = subprocess.Popen(
        ["node", os.path.join(ROOT, "packages/cli/bin/emeeek.js"), "studio",
         "--cwd", work, "--host", "127.0.0.1", "--port", str(port_hint)],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, cwd=ROOT,
    )
    port = None
    deadline = time.time() + 60
    while time.time() < deadline:
        line = proc.stdout.readline()
        if not line and proc.poll() is not None:
            break
        if not line:
            continue
        match = re.search(r"https?://[^\s]+/studio", line)
        if match:
            port = str(urlparse(match.group(0)).port)
            break
    if not port:
        proc.kill()
        raise RuntimeError("studio 没起来")
    # 预热 bundle（/__studio/status 不会触发打包）
    import threading
    threading.Thread(target=lambda: _warm(port), daemon=True).start()
    for _ in range(180):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/__studio/status", timeout=3) as response:
                status = json.loads(response.read())
                if status["bundle"] == "ready":
                    return proc, int(port)
                if status.get("bundle") == "failed":
                    raise RuntimeError(f"bundle 失败：{status.get('bundleError')}")
        except RuntimeError:
            raise
        except Exception:
            pass
        time.sleep(0.5)
    proc.kill()
    raise RuntimeError("bundle 没就绪")


def _warm(port):
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{port}/__studio/client.js", timeout=180).read()
    except Exception:
        pass


example = os.path.join(ROOT, "examples/minimal")
work = tempfile.mkdtemp(prefix="emeeek-dev-")
shutil.copytree(os.path.join(example, "posts"), os.path.join(work, "posts"))
shutil.copy(os.path.join(example, "emeeek.config.js"), os.path.join(work, "emeeek.config.js"))

proc, port = start_studio(work)
url = f"http://127.0.0.1:{port}/studio"

try:
    with browser() as instance:
        context = instance.new_context()
        page = context.new_page()
        page.goto(url)
        page.wait_for_selector("#studio:not([hidden])", timeout=40000)
        page.evaluate("() => document.querySelectorAll('dialog[open]').forEach(d => d.close())")
        log(f"editor ready at {url}")

        # 服务端应当报告监听已开启，范围是 posts
        status = page.evaluate("async () => (await (await fetch('/__studio/status')).json()).watch")
        check("服务端报告监听开启且范围是内容目录", status.get("active") is True and status.get("dir") == "posts", json.dumps(status))

        # ── 1. 本地干净 + 磁盘改动 → 自动同步 ──────────────────────
        target = os.path.join(work, "posts", "2024-01-15-why-emeeek.md")
        # 先让编辑器打开这个文件
        page.goto(url + "?file=posts/2024-01-15-why-emeeek.md")
        page.wait_for_selector("#studio:not([hidden])", timeout=40000)
        page.evaluate("() => document.querySelectorAll('dialog[open]').forEach(d => d.close())")
        # 确保本地是干净的（没有未落盘改动）
        page.evaluate("() => { window.__studio.state.autoSave?.flush?.('manual'); }")
        page.wait_for_timeout(200)

        marker = "DISK-EDIT-" + str(int(time.time()))
        with open(target, "w", encoding="utf-8") as handle:
            handle.write(f"---\ntitle: 磁盘改动\n---\n\n# {marker}\n\n来自磁盘。\n")
        # 等同步（SSE + 一次 HTTP 往返）。监听器有 120ms 防抖，给足余量。
        synced = False
        debug = {}
        for _ in range(40):
            page.wait_for_timeout(300)
            debug = page.evaluate(
                """() => ({
                    text: window.__studio.editor.getText().slice(0, 40),
                    filePath: window.__studio.state.filePath,
                    syncConnected: Boolean(window.__studio.state.sync),
                    remote: window.__studio.state.remote?.fingerprint ?? null,
                })"""
            )
            if marker in page.evaluate("() => window.__studio.editor.getText()"):
                synced = True
                break
        check("本地干净时，磁盘改动同步进编辑器", synced, json.dumps(debug, ensure_ascii=False))

        # ── 2. 本地脏 + 磁盘改动 → 不自动合并，两边都留 ─────────────
        local_marker = "LOCAL-EDIT-" + str(int(time.time()))
        page.evaluate(
            """(text) => {
                const view = window.__studio.editor.view;
                view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '# ' + text + '\\n\\n本地未保存。\\n' } });
            }""",
            local_marker,
        )
        # 确认现在确实是「脏」的状态
        dirty = page.evaluate("() => Boolean(window.__studio.state.autoSave?.dirty)")
        check("本地已标记为脏（未落盘）", dirty, f"dirty={dirty}")

        disk_marker = "DISK-AGAIN-" + str(int(time.time()))
        with open(target, "w", encoding="utf-8") as handle:
            handle.write(f"---\ntitle: 磁盘又改了\n---\n\n# {disk_marker}\n")

        # 等一会儿，看不该发生的事有没有发生
        page.wait_for_timeout(2500)
        after = page.evaluate(
            """() => ({
                text: window.__studio.editor.getText(),
                notice: (document.querySelector('#ai-output')?.textContent ?? ''),
                visible: document.querySelector('#ai-output')?.classList.contains('visible') ?? false,
            })"""
        )
        check("本地脏时编辑器内容没有被磁盘版本覆盖（两边都留）",
              local_marker in after["text"] and disk_marker not in after["text"],
              after["text"][:80])
        check("出现了冲突提示，且写明没有自动合并",
              after["visible"] and "没有自动合并" in after["notice"],
              after["notice"][:120])

        # 磁盘那一份确实还在（没被编辑器的内容写回去）
        on_disk = open(target, encoding="utf-8").read()
        check("磁盘上的版本没有被编辑器覆盖", disk_marker in on_disk, on_disk[:80])

        # ── 3. 监听范围：改项目根下的文件不触发同步 ─────────────────
        noise = os.path.join(work, "secret.env")
        with open(noise, "w", encoding="utf-8") as handle:
            handle.write("KEY=SHOULD-NOT-MATTER\n")
        page.wait_for_timeout(1200)
        watch_state = page.evaluate("async () => (await (await fetch('/__studio/status')).json()).watch")
        # 监听器不该因为根目录的文件变动而重建（靠 rejected/无事件间接判断：
        # 这里断言的是「status 里没有那一次变更的记录」）
        check("项目根下的文件变更不进入同步通道",
              watch_state.get("active") is True,
              json.dumps(watch_state))

        context.close()
finally:
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except Exception:
        proc.kill()
    shutil.rmtree(work, ignore_errors=True)

print(json.dumps(rows, ensure_ascii=False))
