#!/usr/bin/env python3
"""主题截图（Playwright + 系统 Chromium）。

输入：一个 JSON 配置 {dist: {theme: 目录}, out: 输出目录, targets: [...]}
输出：每套主题 × 亮/暗 × 桌面/移动 的 PNG，以及 manifest。
"""
import json
import os
import sys
from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "e2e"))
import browser  # noqa: E402

VIEWPORTS = {"desktop": {"width": 1280, "height": 900}, "mobile": {"width": 390, "height": 844}}
MODES = ["light", "dark"]
PAGES = [("home", "/index.html"), ("post", "/posts/design-notes.html")]


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
                    context = browser_.new_context(
                        viewport=viewport, color_scheme=mode,
                        device_scale_factor=2 if device == "mobile" else 1,
                    )
                    # 固定明暗：首帧脚本会读 localStorage，这里把它设成目标模式。
                    context.add_init_script(f"localStorage.setItem('emeeek-theme', '{mode}')")
                    page = context.new_page()
                    for name, route in PAGES:
                        page.goto("file://" + os.path.join(dist, route.lstrip("/")))
                        page.wait_for_timeout(300)
                        file = os.path.join(out, f"{theme}-{name}-{device}-{mode}.png")
                        page.screenshot(path=file, full_page=(device == "desktop"))
                        manifest.append({"theme": theme, "page": name, "device": device,
                                         "mode": mode, "file": os.path.relpath(file, config["root"])})
                    context.close()
        browser_.close()
    json.dump(manifest, open(os.path.join(out, "manifest.json"), "w", encoding="utf8"), indent=2)
    print(json.dumps({"count": len(manifest), "manifest": manifest}))


if __name__ == "__main__":
    main(sys.argv[1])
