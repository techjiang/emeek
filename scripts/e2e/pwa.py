#!/usr/bin/env python3
"""PWA e2e（真浏览器 + 真 HTTP 服务）。

为什么必须真浏览器：Service Worker 的行为在 jsdom / 静态检查里**完全不存在**。
「注册成功了吗」「断网时拿到的是缓存还是空白」——只有真的浏览器 + 真的
HTTP 服务能回答。下载线上那个 sw.js 看一眼，不构成任何证据。

验五件事：
  1. 注册成功，且由**页面**发起的（不是我们手动 register 的）
  2. 导航离线回落：断网后访问一个没缓存的页面 → 拿到离线页（不是浏览器的错误页）
  3. 缓存更新：改一个页面重新构建，再访问拿到的是**新内容**（network-first 生效）
  4. 静态资源走缓存：断网后 CSS 仍然可用（页面不是裸的）
  5. 离线页可独立显示：它自带样式，不依赖任何外部资源

输入 JSON：{dist: 产物目录, root: 仓库根, port?: 端口}
"""
import functools
import http.server
import json
import os
import socketserver
import sys
import threading

from playwright.sync_api import sync_playwright


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def end_headers(self):
        # 静态托管上的真实响应头。SW 的 fetch 会用 response.type === 'basic'
        # 判断「能不能缓存」—— 不设这个头在某些场景下 type 会变成 opaque。
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


def serve(directory):
    handler = functools.partial(Quiet, directory=directory)
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, httpd.server_address[1]


def main():
    config = json.load(open(sys.argv[1]))
    dist = config["dist"]
    results = []
    failures = []

    def check(label, ok, detail=""):
        results.append({"label": label, "ok": bool(ok), "detail": detail})
        if not ok:
            failures.append(f"{label}{(' — ' + detail) if detail else ''}")

    httpd, port = serve(dist)
    base = f"http://127.0.0.1:{port}"

    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        from browser import chrome_path
        browser = p.chromium.launch(executable_path=chrome_path(), args=["--no-sandbox"])
        # Service Worker 需要持久化的 context（非匿名）
        context = browser.new_context()
        page = context.new_page()

        page.goto(f"{base}/", wait_until="load")

        # ── 1. 注册 ──────────────────────────────────────────────
        # 注册脚本在 load 之后跑，所以要等一下。用 wait_for_function
        # 而不是 sleep(3)：sleep 在慢机器上会假红，在快机器上白等。
        try:
            page.wait_for_function(
                "() => navigator.serviceWorker.controller !== null || navigator.serviceWorker.getRegistrations().then(r => r.length > 0)",
                timeout=15000,
            )
            ok = page.evaluate("() => navigator.serviceWorker.getRegistrations().then(r => r.length)")
            check("Service Worker 由页面自己注册成功", ok >= 1, f"注册数 {ok}")
        except Exception as error:
            check("Service Worker 由页面自己注册成功", False, str(error)[:120])

        # 等 SW 真正 activate 并接管（controller 就位）
        try:
            page.wait_for_function("() => navigator.serviceWorker.controller !== null", timeout=15000)
            check("SW 已接管页面", True)
        except Exception as error:
            check("SW 已接管页面", False, str(error)[:120])

        # 确认预缓存真的发生了
        cached = page.evaluate(
            """() => caches.keys().then(async (keys) => {
                 if (!keys.length) return 0;
                 const cache = await caches.open(keys[0]);
                 return (await cache.keys()).length;
               })"""
        )
        check("预缓存已建立", cached >= 3, f"缓存 {cached} 条")

        # ── 2. 静态资源断网仍可用 ────────────────────────────────
        # 先在线访问一次，让 CSS 进缓存
        page.goto(f"{base}/", wait_until="load")
        cached_css = page.evaluate(
            """() => caches.keys().then(async (keys) => {
                 const open = await Promise.all(keys.map(k => caches.open(k)));
                 const all = (await Promise.all(open.map(c => c.keys()))).flat();
                 return all.filter(r => r.url.includes('/assets/') || r.url.endsWith('.css')).length;
               })"""
        )
        check("静态资源进了缓存", cached_css >= 1, f"{cached_css} 条")

        context.set_offline(True)

        # ── 3. 离线回落：没缓存过的地址 → 离线页 ────────────────
        page.goto(f"{base}/never-cached-{os.getpid()}.html", wait_until="load")
        body = page.content()
        is_offline_page = "离线" in body or "offline" in body.lower()
        check("断网访问未缓存页面 → 得到离线页（而不是浏览器错误页）", is_offline_page,
              f"标题 {page.title()!r}")

        # 离线页必须自带样式（不引外部 CSS）
        styled = page.evaluate(
            "() => getComputedStyle(document.body).display !== 'block' || document.querySelectorAll('style').length > 0"
        )
        check("离线页自带样式（不依赖外部 CSS）", styled)

        # 离线页要列出确实缓存过的文章
        links = page.evaluate("() => document.querySelectorAll('a[href^=\"/\"], a[href*=\"/posts/\"]').length")
        check("离线页列出可离线阅读的内容", links >= 1, f"{links} 条链接")

        # ── 4. 已缓存的页面断网可读 ─────────────────────────────
        page.goto(f"{base}/", wait_until="load")
        home = page.content()
        check("首页断网仍可读（命中缓存）", len(home) > 500 and "离线" not in page.title(),
              f"内容长度 {len(home)}")

        context.set_offline(False)

        # ── 5. 缓存更新：改内容后拿到的是新内容，不是旧缓存 ────
        # network-first 的意义就在这一条：在线时永远拿最新的。
        marker = f"pwa-e2e-{os.getpid()}"
        index = os.path.join(dist, "index.html")
        original = open(index, encoding="utf-8").read()
        try:
            open(index, "w", encoding="utf-8").write(
                original.replace("</body>", f'<p id="marker">{marker}</p></body>')
            )
            page.goto(f"{base}/", wait_until="load")
            found = page.evaluate("() => !!document.getElementById('marker')")
            check("在线时导航走 network-first（改内容后立刻看到新内容）", found,
                  "改完内容仍拿到旧缓存=HTML 走了 cache-first")
        finally:
            open(index, "w", encoding="utf-8").write(original)

        context.close()
        browser.close()

    httpd.shutdown()

    print(json.dumps({"results": results, "failures": failures}, ensure_ascii=False))
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
