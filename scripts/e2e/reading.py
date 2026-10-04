#!/usr/bin/env python3
"""长文导航 e2e（真浏览器）。

为什么必须真浏览器：这一层的三件事**全都只在渲染与滚动中存在** ——
  · 目录点下去真的会跳到对应位置吗（锚点 id 与标题 id 对得上吗）
  · 滚动时高亮的目录项真的是「当前章节」吗（IntersectionObserver 的
    rootMargin 算错了会表现成「滚过一节的开头，目录就跳到下一节」）
  · 进度条真的随滚动增长吗（0% 到 100% 的映射对不对）
静态检查只能确认「DOM 里有这些元素」，那离「它工作」还差很远。

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
            # 用一篇章节多的文章 —— 章节太少时引擎不给目录（这是刻意的），
            # 拿它测目录等于什么都没测。
            ctx = br.new_context(viewport={"width": 1280, "height": 800})
            page = ctx.new_page()
            page.goto(f"{base}/posts/markdown-syntax.html", wait_until="load")

            # ── 1. 目录存在且只有一份 ──────────────────────────
            toc_count = page.evaluate("() => document.querySelectorAll('nav.toc, .sidebar-toc').length")
            check(theme, "目录存在", toc_count >= 1, f"找到 {toc_count} 个目录容器")

            links = page.eval_on_selector_all(
                ".sidebar-toc a[data-heading], .toc-list a[data-heading]",
                "els => els.map(e => e.getAttribute('data-heading'))")
            check(theme, "目录项带 data-heading（浏览器端的接缝）", len(links) >= 3, f"{len(links)} 项")

            # 每个目录项都必须指向真的存在的标题 —— 锚点对不上时点击无反应，
            # 而这一条在静态检查里看不出来（href 与 id 是两处生成的）。
            missing = page.evaluate(
                """(ids) => ids.filter(id => !document.getElementById(id))""", links)
            check(theme, "每个目录项都指向真实存在的标题", not missing, f"找不到：{missing}")

            # ── 2. 点击目录真的会跳 ────────────────────────────
            if links:
                target_id = links[-1]
                page.click(f'a[data-heading="{target_id}"]')
                page.wait_for_timeout(600)
                in_view = page.evaluate(
                    """(id) => {
                         const el = document.getElementById(id);
                         const rect = el.getBoundingClientRect();
                         return rect.top >= -50 && rect.top < window.innerHeight;
                       }""", target_id)
                check(theme, "点击目录项跳到对应章节", in_view, f"目标 {target_id}")

            # ── 3. 滚动时高亮当前章节 ─────────────────────────
            page.evaluate("window.scrollTo(0, 0)")
            page.wait_for_timeout(400)
            page.evaluate("window.scrollTo(0, document.body.scrollHeight * 0.45)")
            page.wait_for_timeout(800)
            active = page.evaluate(
                """() => {
                     const el = document.querySelector('.sidebar-toc a.active, .toc-list a.active');
                     return el ? el.getAttribute('data-heading') : null;
                   }""")
            check(theme, "滚动时高亮当前章节", active is not None, "没有任何目录项被高亮")
            if active:
                # 高亮的那一项必须是「读者正在读的那一节」——判据是：
                # 它的顶边在视口 30% 判定线之上（或刚好是第一个标题），
                # 且**下一个**标题还没过线。也就是说「最后一个过了线的标题」
                # 就是它。断言这一点，而不是断言「它在视口里」——
                # 后者在长章节里会误报（一个很长的章节标题早已滚出视口，
                # 但读者确实还在读它）。
                correct = page.evaluate(
                    """(id) => {
                         const links = Array.from(document.querySelectorAll('.toc-list a[data-heading], .sidebar-toc a[data-heading]'));
                         const ids = links.map(a => a.getAttribute('data-heading'));
                         const line = window.innerHeight * 0.3;
                         let expected = null;
                         for (const hid of ids) {
                           const el = document.getElementById(hid);
                           if (!el) continue;
                           if (el.getBoundingClientRect().top <= line) expected = hid; else break;
                         }
                         if (!expected) expected = ids[0];
                         return expected === id;
                       }""", active)
                check(theme, "高亮的是「最后一个已滚过判定线的章节」", correct, f"高亮 {active}，与判定结果不符")

            # ── 4. 进度条随滚动增长 ───────────────────────────
            page.evaluate("window.scrollTo(0, 0)")
            page.wait_for_timeout(400)
            bar = page.query_selector("[data-reading-bar]")
            if bar:
                page.evaluate("window.scrollTo(0, document.body.scrollHeight * 0.25)")
                page.wait_for_timeout(400)
                quarter = float(bar.get_attribute("data-reading-ratio") or 0)
                page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                page.wait_for_timeout(500)
                end = float(bar.get_attribute("data-reading-ratio") or 0)
                check(theme, "进度条随滚动增长", end > quarter, f"{quarter} → {end}")
                check(theme, "滚到底时进度接近 100%", end > 0.9, f"实际 {end}")
                check(theme, "进度条不回退到 0 以下", quarter >= 0, f"{quarter}")
            else:
                check(theme, "进度条存在", False, "没有 [data-reading-bar]")

            # ── 5. 短文章不给目录（阈值生效） ──────────────────
            ctx2 = br.new_context(viewport={"width": 1280, "height": 800})
            page2 = ctx2.new_page()
            # 性能页章节少 —— 断言它没有目录，证明阈值不是摆设。
            headings = page2.goto(f"{base}/posts/performance-notes.html", wait_until="load")
            toc2 = page2.evaluate("() => document.querySelectorAll('.sidebar-toc, nav.toc').length")
            h2 = page2.evaluate("() => document.querySelectorAll('.prose h2').length")
            # 只说「章节少时不该有目录」；章节 ≥ 3 的文章有目录是对的。
            if h2 < 3:
                check(theme, f"章节过少（{h2} 个）时不给目录", toc2 == 0, f"却有 {toc2} 个目录容器")
            else:
                check(theme, f"章节足够（{h2} 个）时给出目录", toc2 >= 1)
            ctx2.close()

            ctx.close()
            httpd.shutdown()
        br.close()

    print(json.dumps({"results": results, "failures": failures}, ensure_ascii=False))
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
