#!/usr/bin/env python3
"""从渲染后的首页生成主题预览图（512x256）。

为什么要缩略而不是「随便截一块」：预览图是主题的门面，
它要在文档与主题列表里被一眼比较。统一尺寸+统一取景，
比较才有意义。这里取「首屏 + 顶部」，正好覆盖 header + hero + 若干卡片。
"""
import json
import os
import sys

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "e2e"))
import browser  # noqa: E402


def main(config_file):
    config = json.load(open(config_file, encoding="utf8"))
    rows = []
    with sync_playwright() as playwright:
        b = playwright.chromium.launch(executable_path=browser.chrome_path())
        for theme, dist in config["dist"].items():
            for mode in ("dark", "light"):
                # 用 1280 宽的桌面视图渲染，再缩到 512x256 —— 直接开 512 宽的
                # viewport 会触发移动布局，预览图就变成手机截图了。
                ctx = b.new_context(viewport={"width": 1280, "height": 640}, color_scheme=mode, device_scale_factor=1)
                ctx.add_init_script(f"localStorage.setItem('emeeek-theme','{mode}')")
                page = ctx.new_page()
                page.goto("file://" + os.path.join(dist, "index.html"))
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
        b.close()
    print(json.dumps(rows))


if __name__ == "__main__":
    main(sys.argv[1])
