#!/usr/bin/env python3
"""评论系统 e2e（真浏览器 + 拦截 GitHub API）。

为什么必须真浏览器：评论**内容**是运行时由这段脚本填的。静态检查只能确认
「DOM 里有 data-comments-* 属性」，那离「评论区能显示出来」还差一段
fetch + 渲染 + 转义。而这段逻辑里最要紧的一条是**XSS 防线** ——
评论正文是任意人写的，只有真浏览器能证明它没被当成 HTML 执行。

这里拦截 api.github.com 的响应，而不是真去请求：
  · 匿名限流只有 60 次/小时，跑几次 e2e 就耗光，之后全是假红
  · 我们需要构造恶意正文（`<script>`、`onerror`），真实接口给不了
  · 网络抖动会让门禁变得不可信，而门禁不可信就等于没有

输入 JSON：{dist: {theme: dir}, root}
"""
import functools
import http.server
import json
import os
import socketserver
import sys
import threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from playwright.sync_api import sync_playwright

# 三条评论：普通、含 XSS 载荷、作者本人。
# XSS 那条是这一整个 e2e 最重要的断言对象。
FAKE_COMMENTS = [
    {
        "id": 101,
        "user": {"login": "octocat", "html_url": "https://github.com/octocat", "avatar_url": ""},
        "body": "这个思路很有意思。@meekdai 你看过吗？\n\n参考 https://github.com/Meekdai/Gmeek",
        "created_at": "2024-06-01T10:00:00Z",
        "html_url": "https://github.com/x/y/issues/1#issuecomment-101",
        "author_association": "OWNER",
        "reactions": {"+1": 3, "heart": 1},
    },
    {
        "id": 102,
        "user": {"login": "attacker", "html_url": "https://github.com/attacker", "avatar_url": ""},
        # 这一段如果不被转义，`window.__XSS__` 会被置位。
        "body": "<img src=x onerror=\"window.__XSS__=1\"><script>window.__XSS__=2</script>",
        "created_at": "2024-06-02T11:00:00Z",
        "html_url": "https://github.com/x/y/issues/1#issuecomment-102",
        "author_association": "NONE",
        "reactions": {},
    },
    {
        "id": 103,
        "user": {"login": "reader", "html_url": "https://github.com/reader", "avatar_url": ""},
        "body": "已收藏。",
        "created_at": "2024-06-03T09:00:00Z",
        "html_url": "https://github.com/x/y/issues/1#issuecomment-103",
        "author_association": "NONE",
        "reactions": {},
    },
]


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def serve(directory):
    handler = functools.partial(Quiet, directory=directory)
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, httpd.server_address[1]


def main():
    cfg = json.load(open(sys.argv[1]))
    dists = cfg["dist"]
    results = []
    failures = []

    def check(scope, label, ok, detail=""):
        results.append({"theme": scope, "label": label, "ok": bool(ok), "detail": detail})
        if not ok:
            failures.append(f"[{scope}] {label}{(' — ' + detail) if detail else ''}")

    from browser import chrome_path
    with sync_playwright() as p:
        br = p.chromium.launch(executable_path=chrome_path(), args=["--no-sandbox"])
        for theme, dist in dists.items():
            httpd, port = serve(dist)
            base = f"http://127.0.0.1:{port}"
            ctx = br.new_context(viewport={"width": 1100, "height": 900})
            page = ctx.new_page()
            api_calls = []
            page.route("**/api.github.com/**", lambda route: (
                api_calls.append(route.request.url),
                route.fulfill(status=200, content_type="application/json", body=json.dumps(FAKE_COMMENTS)),
            )[-1])
            page.goto(f"{base}/posts/why-emeeek.html", wait_until="load")
            page.wait_for_timeout(1200)

            # ── 1. 外壳与数据属性 ────────────────────────────
            has_shell = page.evaluate("() => !!document.querySelector('.comments[data-comments-provider]')")
            check(theme, "评论区外壳存在", has_shell)
            if not has_shell:
                ctx.close(); httpd.shutdown(); continue

            provider = page.evaluate("() => document.querySelector('.comments').getAttribute('data-comments-provider')")
            check(theme, "provider 写进了数据属性", provider == "github-issues", f"实际 {provider}")

            # ── 2. 请求真的发出去了 ──────────────────────────
            check(theme, "向 GitHub 请求了评论", len(api_calls) >= 1, f"{len(api_calls)} 次请求")

            # ── 3. 渲染出评论 ────────────────────────────────
            count = page.evaluate("() => document.querySelectorAll('.c-item').length")
            check(theme, "渲染出全部评论", count == 3, f"渲染 {count} 条")

            authors = page.evaluate("() => Array.from(document.querySelectorAll('.c-author')).map(a => a.textContent.trim())")
            check(theme, "作者名显示正确", authors == ["octocat", "attacker", "reader"], f"{authors}")

            # ── 4. XSS 防线（最重要的一条） ──────────────────
            xss = page.evaluate("() => window.__XSS__")
            check(theme, "XSS 载荷没有被执行", xss is None, f"window.__XSS__ = {xss}")
            # 载荷必须**可见**（转义成字面量），而不是被悄悄丢掉 ——
            # 丢掉的话读者会以为有人发了空评论。
            body_text = page.evaluate(
                """() => {
                     const item = document.querySelectorAll('.c-item')[1];
                     return item ? (item.querySelector('.c-body').textContent || '') : '';
                   }""")
            check(theme, "载荷以字面量形式可见（不是被丢掉）", "<img" in body_text or "<script" in body_text,
                  f"正文：{body_text[:60]!r}")
            injected_tags = page.evaluate(
                """() => {
                     const item = document.querySelectorAll('.c-item')[1];
                     if (!item) return -1;
                     return item.querySelectorAll('img, script').length;
                   }""")
            check(theme, "载荷没有变成真实标签", injected_tags == 0, f"注入了 {injected_tags} 个标签")

            # ── 5. @提及与链接 ───────────────────────────────
            mentions = page.evaluate("() => Array.from(document.querySelectorAll('.c-mention')).map(a => a.getAttribute('href'))")
            check(theme, "@提及变成 GitHub 链接", any("github.com/meekdai" in h for h in mentions), f"{mentions}")
            links = page.evaluate("() => Array.from(document.querySelectorAll('.c-link')).map(a => a.getAttribute('href'))")
            check(theme, "URL 变成链接", any("github.com/Meekdai/Gmeek" in h for h in links), f"{links}")
            # 外链必须带 noopener —— 缺了它留着 window.opener 这条
            # 跨域改写标签页的路径。
            rels = page.evaluate("() => Array.from(document.querySelectorAll('.c-body a')).map(a => a.getAttribute('rel') || '')")
            check(theme, "外链带 noopener noreferrer", all("noopener" in r and "noreferrer" in r for r in rels), f"{rels}")

            # ── 6. 作者标记与 reaction ───────────────────────
            badges = page.evaluate("() => Array.from(document.querySelectorAll('.c-badge')).map(b => b.textContent.trim())")
            check(theme, "只给作者本人打标记", len(badges) == 1, f"{len(badges)} 个标记：{badges}")
            reactions = page.evaluate("() => document.querySelectorAll('.c-reaction').length")
            check(theme, "reaction 渲染出来", reactions == 2, f"{reactions} 个（该是 2：👍3 与 ❤️1）")

            # ── 7. 空列表要说出来 ────────────────────────────
            ctx2 = br.new_context(viewport={"width": 1100, "height": 900})
            page2 = ctx2.new_page()
            page2.route("**/api.github.com/**", lambda route: route.fulfill(
                status=200, content_type="application/json", body="[]"))
            page2.goto(f"{base}/posts/why-emeeek.html", wait_until="load")
            page2.wait_for_timeout(900)
            status = page2.evaluate(
                """() => { const el = document.querySelector('.comments [data-role=status]'); return el ? el.textContent.trim() : ''; }""")
            check(theme, "没有评论时给出说明（不是一片空白）", "还没有评论" in status, f"{status!r}")
            ctx2.close()

            # ── 8. 失败要分类（Issue 不存在 vs 网络失败） ────
            ctx3 = br.new_context(viewport={"width": 1100, "height": 900})
            page3 = ctx3.new_page()
            page3.route("**/api.github.com/**", lambda route: route.fulfill(status=404, content_type="application/json", body='{"message":"Not Found"}'))
            page3.goto(f"{base}/posts/why-emeeek.html", wait_until="load")
            page3.wait_for_timeout(900)
            status404 = page3.evaluate(
                """() => { const el = document.querySelector('.comments [data-role=status]'); return el ? el.textContent.trim() : ''; }""")
            check(theme, "404 给出「讨论区不存在」而不是笼统的失败", "不存在" in status404, f"{status404!r}")
            kind = page3.evaluate("() => document.querySelector('.comments [data-role=status]')?.getAttribute('data-kind')")
            check(theme, "失败状态带 data-kind（可样式化、可断言）", kind == "not-found", f"{kind}")
            ctx3.close()

            ctx.close()
            httpd.shutdown()
        br.close()

    print(json.dumps({"results": results, "failures": failures}, ensure_ascii=False))
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
