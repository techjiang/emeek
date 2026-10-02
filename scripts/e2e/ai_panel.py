#!/usr/bin/env python3
"""AI 面板 e2e 的浏览器侧。"""
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
SESSION_KEY = "sk-proj-sessionFAKE0123456789abcdefghij"
SERVER_KEY = "sk-proj-serverFAKE0123456789abcdefghij"
rows = []


def check(name, ok, detail=""):
    rows.append({"name": name, "ok": bool(ok), "detail": str(detail)[:220]})


def log(message):
    print("[e2e] " + str(message), file=sys.stderr, flush=True)


def _warm(port):
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{port}/__studio/client.js", timeout=180).read()
    except Exception:
        pass


def start_studio(work, env_extra=None):
    port_hint = 44000 + (os.getpid() % 1200)
    env = dict(os.environ)
    env.update(env_extra or {})
    proc = subprocess.Popen(
        ["node", os.path.join(ROOT, "packages/cli/bin/emeeek.js"), "studio",
         "--cwd", work, "--host", "127.0.0.1", "--port", str(port_hint)],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, cwd=ROOT, env=env,
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
    threading.Thread(target=lambda: _warm(port), daemon=True).start()
    for _ in range(180):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/__studio/status", timeout=3) as response:
                if json.loads(response.read())["bundle"] == "ready":
                    return proc, int(port)
        except Exception:
            pass
        time.sleep(0.5)
    proc.kill()
    raise RuntimeError("bundle 没就绪")


def stop(proc):
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except Exception:
        proc.kill()


example = os.path.join(ROOT, "examples/minimal")
work = tempfile.mkdtemp(prefix="emeeek-ai-")
shutil.copytree(os.path.join(example, "posts"), os.path.join(work, "posts"))
shutil.copy(os.path.join(example, "emeeek.config.js"), os.path.join(work, "emeeek.config.js"))

try:
    # ── 模式 1：没有 Key ────────────────────────────────────────
    proc, port = start_studio(work, {"EMEEEK_OPENAI_API_KEY": "", "OPENAI_API_KEY": ""})
    url = f"http://127.0.0.1:{port}/studio"
    try:
        with browser() as instance:
            context = instance.new_context()
            page = context.new_page()
            page.goto(url)
            page.wait_for_selector("#studio:not([hidden])", timeout=40000)
            page.evaluate("() => document.querySelectorAll('dialog[open]').forEach(d => d.close())")

            status = page.evaluate("() => window.__studio.state.keyStatus")
            # 首次渲染是异步的，等一拍
            for _ in range(20):
                if status: break
                page.wait_for_timeout(200)
                status = page.evaluate("() => window.__studio.state.keyStatus")
            check("没有 Key 时状态是「未配置」", status and status.get("kind") == "none", json.dumps(status))

            label = page.inner_text("#ai-key-label")
            check("面板如实显示「未配置」", label.strip() == "未配置", label)

            # 点生成类动作 → 诚实报错
            page.click("#btn-ai")
            page.click('[data-ai-action="continue"]')
            page.wait_for_timeout(400)
            output = page.inner_text("#ai-output")
            check("没有 Key 时生成类动作诚实报错", "需要配置 API Key" in output, output[:120])
            check("报错里不含任何「猜的」内容", "续写如下" not in output and "以下内容" not in output, output[:120])
            check("报错里给出两条可执行的路（会话 Key / 服务端托管）",
                  "AI 设置" in output and "EMEEEK_OPENAI_API_KEY" in output, output[:200])
            context.close()
    finally:
        stop(proc)

    # ── 模式 2：会话级 Key（Key 不进浏览器这件事要在这里证明） ──
    proc, port = start_studio(work, {"EMEEEK_OPENAI_API_KEY": "", "OPENAI_API_KEY": ""})
    url = f"http://127.0.0.1:{port}/studio"
    try:
        with browser() as instance:
            context = instance.new_context()
            page = context.new_page()
            requests = []
            page.on("request", lambda request: requests.append(request.url))
            page.goto(url)
            page.wait_for_selector("#studio:not([hidden])", timeout=40000)
            page.evaluate("() => document.querySelectorAll('dialog[open]').forEach(d => d.close())")

            # 通过面板填入会话级 Key（不勾「记住」）
            page.click("#btn-ai")
            page.click("#btn-ai-key")
            page.fill("#ai-key-value", SESSION_KEY)
            page.click("#btn-ai-key-save")
            page.wait_for_timeout(400)
            label = page.inner_text("#ai-key-label")
            check("填入会话级 Key 后状态是「本次会话」", label.strip() == "本次会话", label)

            # 传参这一路：Key 必须走请求体，不能出现在任何 URL 里
            page.click('[data-ai-action="continue"]')
            page.wait_for_timeout(1500)
            leaked = [u for u in requests if SESSION_KEY in u]
            check("Key 从未出现在任何请求 URL 上", not leaked, f"{len(leaked)} 条 URL 带 Key")

            # 页面里搜一遍：sessionStorage 里应当有（那是它的家），
            # 但**请求记录里不该有**，localStorage 里也不该有（没勾记住）
            stored = page.evaluate(
                """(key) => ({
                    session: Object.values(sessionStorage).some((v) => v && v.includes(key)),
                    local: Object.values(localStorage).some((v) => v && v.includes(key)),
                    dom: document.documentElement.outerHTML.includes(key),
                })""",
                SESSION_KEY,
            )
            check("会话级 Key 存在 sessionStorage（关标签页即消失）", stored["session"], json.dumps(stored))
            check("未勾「记住」时 localStorage 里没有 Key", not stored["local"], json.dumps(stored))
            check("Key 不在 DOM 里（表单里也不该留明文）", not stored["dom"], json.dumps(stored))

            # 保存后输入框被清空
            value = page.evaluate("() => document.querySelector('#ai-key-value')?.value ?? ''")
            check("保存后输入框被清空（明文不留在 DOM）", value == "", repr(value))
            context.close()
    finally:
        stop(proc)

    # ── 模式 3：服务端托管 ─────────────────────────────────────
    proc, port = start_studio(work, {"EMEEEK_OPENAI_API_KEY": SERVER_KEY})
    url = f"http://127.0.0.1:{port}/studio"
    try:
        with browser() as instance:
            context = instance.new_context()
            page = context.new_page()
            page.goto(url)
            page.wait_for_selector("#studio:not([hidden])", timeout=40000)
            page.evaluate("() => document.querySelectorAll('dialog[open]').forEach(d => d.close())")
            for _ in range(30):
                status = page.evaluate("() => window.__studio.state.keyStatus")
                if status and status.get("kind") == "server":
                    break
                page.wait_for_timeout(200)
            status = page.evaluate("() => window.__studio.state.keyStatus")
            check("服务端托管时状态是「服务端已配置」", status and status.get("kind") == "server", json.dumps(status))

            label = page.inner_text("#ai-key-label")
            check("面板显示「服务端已配置」", label.strip() == "服务端已配置", label)

            hint = page.inner_text("#ai-key-hint")
            check("提示里说明 Key 不会进入浏览器", "不会到达浏览器" in hint, hint[:160])

            # 整个页面里搜不到服务端那份 Key
            found = page.evaluate("(key) => document.documentElement.outerHTML.includes(key)", SERVER_KEY)
            check("服务端托管的 Key 不出现在页面里", not found)

            # 服务端状态接口也不回 Key
            body = page.evaluate("async () => await (await fetch('/__studio/ai/status')).text()")
            check("状态接口不回 Key", SERVER_KEY not in body, body[:120])
            context.close()
    finally:
        stop(proc)
finally:
    shutil.rmtree(work, ignore_errors=True)

print(json.dumps(rows, ensure_ascii=False))
