#!/usr/bin/env python3
"""主题截图（Playwright + 系统 Chromium）。

输入：一个 JSON 配置 {dist: {theme: 目录}, out: 输出目录, targets: [...]}
输出：每套主题 × 亮/暗 × 桌面/移动 的 PNG，以及 manifest。
"""
import functools
import http.server
import json
import os
import socketserver
import sys
import threading
from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "e2e"))
import browser  # noqa: E402

VIEWPORTS = {"desktop": {"width": 1280, "height": 900}, "mobile": {"width": 390, "height": 844}}
MODES = ["light", "dark"]
# (名字, 路径, 截图前的准备动作)
# 搜索页必须先输入关键词才看得到结果 —— 空搜索页只有一句提示，
# 拿它当「搜索页长什么样」的证据是没有说服力的。
PAGES = [
    ("home", "/index.html", None),
    ("post", "/posts/design-notes.html", None),
    ("search", "/search/", "search"),
]


class _QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def serve(directory):
    """本地静态服务，返回 (origin, shutdown)。

    必须走 HTTP 而不是 file://：CSS 超过 24KB 的主题（Magazine）会把样式
    改成外链 /assets/theme.css，而 file:// 下 `/assets/...` 指向文件系统根目录，
    样式表 404 —— 亮暗两版截图会一模一样（暗色根本没生效）。
    CSS 小的主题碰巧躲过这个坑，所以问题只在第 4 套主题上暴露。
    """
    handler = functools.partial(_QuietHandler, directory=directory)
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    httpd.allow_reuse_address = True
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{port}", httpd.shutdown


def main(config_file):
    config = json.load(open(config_file, encoding="utf8"))
    out = config["out"]
    os.makedirs(out, exist_ok=True)
    manifest = []
    with sync_playwright() as playwright:
        browser_ = playwright.chromium.launch(executable_path=browser.chrome_path())
        for theme in config["targets"]:
            dist = config["dist"][theme]
            for device, viewport in VIEWPORTS.items():
                for mode in MODES:
                    origin, shutdown = serve(dist)
                    try:
                        context = browser_.new_context(
                            viewport=viewport, color_scheme=mode,
                            device_scale_factor=2 if device == "mobile" else 1,
                        )
                        # 固定明暗：首帧脚本会读 localStorage，这里把它设成目标模式。
                        context.add_init_script(f"localStorage.setItem('emeeek-theme', '{mode}')")
                        page = context.new_page()
                        for name, route, prepare in PAGES:
                            page.goto(origin + route)
                            page.wait_for_timeout(300)
                            if prepare == "search":
                                # 填一个站内确实存在的词，并等联想与结果都稳定。
                                page.fill("#search-input", "设计")
                                page.wait_for_timeout(500)
                            file = os.path.join(out, f"{theme}-{name}-{device}-{mode}.png")
                            page.screenshot(path=file, full_page=(device == "desktop"))
                            manifest.append({"theme": theme, "page": name, "device": device,
                                             "mode": mode, "file": os.path.relpath(file, config["root"])})
                        context.close()
                    finally:
                        shutdown()
        browser_.close()

    # 合并而非覆盖：只跑单套主题时（node scripts/screenshots/capture.mjs magazine）
    # 不能把其它主题的清单条目抹掉。后写的覆盖同键（theme/page/device/mode）旧条目。
    manifest_path = os.path.join(out, "manifest.json")
    merged = {}
    if os.path.exists(manifest_path):
        try:
            for row in json.load(open(manifest_path, encoding="utf8")):
                merged[(row["theme"], row["page"], row["device"], row["mode"])] = row
        except (ValueError, KeyError):
            pass
    for row in manifest:
        merged[(row["theme"], row["page"], row["device"], row["mode"])] = row
    ordered = sorted(merged.values(), key=lambda r: (r["theme"], r["page"], r["device"], r["mode"]))
    json.dump(ordered, open(manifest_path, "w", encoding="utf8"), indent=2)
    print(json.dumps({"count": len(manifest), "manifest": manifest}))


if __name__ == "__main__":
    main(sys.argv[1])
