#!/usr/bin/env python3
"""从渲染后的首页生成主题预览图（512x256）。

为什么要缩略而不是「随便截一块」：预览图是主题的门面，
它要在文档与主题列表里被一眼比较。统一尺寸+统一取景，
比较才有意义。这里取「首屏 + 顶部」，正好覆盖 header + hero + 若干卡片。
"""
import functools
import http.server
import json
import os
import socketserver
import sys
import threading

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "e2e"))
import browser  # noqa: E402


class _QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def serve(directory):
    """本地静态服务，返回 (origin, shutdown)。

    必须走 HTTP：CSS 超过 24KB 的主题会把样式改成外链 /assets/theme.css，
    而 file:// 下 `/assets/...` 指向文件系统根目录 —— 预览图会拍到一个没有样式的
    裸 HTML。CSS 小的主题碰巧躲过了这个坑，于是问题只在第 4 套主题上出现。
    """
    handler = functools.partial(_QuietHandler, directory=directory)
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    httpd.allow_reuse_address = True
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{port}", httpd.shutdown


def main(config_file):
    config = json.load(open(config_file, encoding="utf8"))
    rows = []
    with sync_playwright() as playwright:
        b = playwright.chromium.launch(executable_path=browser.chrome_path())
        for theme, dist in config["dist"].items():
            origin, shutdown = serve(dist)
            for mode in ("dark", "light"):
                # 用 1280 宽的桌面视图渲染，再缩到 512x256 —— 直接开 512 宽的
                # viewport 会触发移动布局，预览图就变成手机截图了。
                ctx = b.new_context(viewport={"width": 1280, "height": 640}, color_scheme=mode, device_scale_factor=1)
                ctx.add_init_script(f"localStorage.setItem('emeeek-theme','{mode}')")
                page = ctx.new_page()
                page.goto(origin + "/index.html")
                page.wait_for_timeout(250)
                shot = os.path.join(config["themepkg"][theme], f".preview-{mode}.raw.png")
                page.screenshot(path=shot, full_page=False)
                from PIL import Image
                Image.open(shot).resize((512, 256), Image.LANCZOS).save(
                    os.path.join(config["themepkg"][theme], "preview.png" if mode == "dark" else "preview-light.png"))
                os.remove(shot)
                out = os.path.join(config["themepkg"][theme], "preview.png" if mode == "dark" else "preview-light.png")
                rows.append(out)
                ctx.close()
            shutdown()
        b.close()
    print(json.dumps(rows))


if __name__ == "__main__":
    main(sys.argv[1])
