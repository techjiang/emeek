#!/usr/bin/env python3
"""P3-4b-rest-2 的截图（分享 / 阅读统计 / 分类页）。

一份站点数据（带分类、带分享），4 套主题各截：
  · 文章页底部的分享按钮
  · 展开态的微信二维码（点一下「微信」）
  · 分类总览页
只有真浏览器能证明这些是「看起来对」的 —— 尤其是二维码展开态。
"""
import functools
import http.server
import json
import os
import socketserver
import sys
import threading

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "e2e"))
from browser import browser  # noqa: E402


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def serve(directory):
    handler = functools.partial(Quiet, directory=directory)
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{port}", httpd.shutdown


def main(config_path, out_dir):
    cfg = json.load(open(config_path))
    os.makedirs(out_dir, exist_ok=True)
    manifest = []
    with browser() as b:
        for theme, dist in cfg["dist"].items():
            origin, shutdown = serve(dist)
            ctx = b.new_context(viewport={"width": 1280, "height": 1000}, device_scale_factor=2)
            page = ctx.new_page()

            # 1) 文章页（分享按钮在底部）
            page.goto(f"{origin}/posts/design-notes.html", wait_until="domcontentloaded")
            page.wait_for_timeout(300)
            if page.query_selector("[data-share]"):
                page.eval_on_selector("[data-share]", "el => el.scrollIntoView({block:'center'})")
                page.wait_for_timeout(200)
            share_el = page.query_selector("[data-share]")
            if share_el:
                share_el.screenshot(path=f"{out_dir}/{theme}-share-bottom.png")
                manifest.append(f"{theme}-share-bottom.png")
                # 展开微信二维码
                wc = page.query_selector("[data-share-wechat]")
                if wc:
                    wc.click()
                    page.wait_for_timeout(300)
                    share_el.screenshot(path=f"{out_dir}/{theme}-share-qr.png")
                    manifest.append(f"{theme}-share-qr.png")

            # 2) 分类总览页
            if os.path.exists(os.path.join(dist, "categories.html")):
                page.goto(f"{origin}/categories.html", wait_until="domcontentloaded")
                page.wait_for_timeout(200)
                page.screenshot(path=f"{out_dir}/{theme}-categories.png", full_page=True)
                manifest.append(f"{theme}-categories.png")

            ctx.close()
            shutdown()

    print(json.dumps(manifest, ensure_ascii=False))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
