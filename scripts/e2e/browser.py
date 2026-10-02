#!/usr/bin/env python3
"""真浏览器驱动的最小封装（Playwright + 系统里已装的 Chromium）。

为什么不用 jsdom：这一阶段要验的三件事 —— 定时器在后台标签页被冻结、
软键盘遮挡、进程被杀后的恢复 —— 全都只在**真浏览器**里成立。
jsdom 没有渲染、没有冻结、没有进程，它给的绿灯不构成证据。

Chromium 用 /opt/ms-playwright 里已装好的那个，不做自动下载
（离线 CI 里下载是失败源，而不是保障）。
"""
import json
import os
import sys
from contextlib import contextmanager
from playwright.sync_api import sync_playwright

FIXED_CANDIDATES = [
    "/opt/ms-playwright/chromium-1243/chrome-linux64/chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/local/bin/chromium",
]


def chrome_path():
    """按「最明确 → 最模糊」的顺序找 Chromium。

    CI 里 playwright 会把自己那份装到指定目录，用 EMEeeK_CHROMIUM 传进来；
    本地开发用系统装的。两条路都要能用，所以先看环境变量。
    """
    explicit = os.environ.get("EMEEEK_CHROMIUM")
    if explicit and os.path.exists(explicit):
        return explicit
    for candidate in FIXED_CANDIDATES:
        if os.path.exists(candidate):
            return candidate
    # 最后再扫一遍 playwright 的常见安装位置（版本号会变，不能写死）
    for root in (os.environ.get("PLAYWRIGHT_BROWSERS_PATH"), "/opt/ms-playwright", os.path.expanduser("~/.cache/ms-playwright")):
        if not root or not os.path.isdir(root):
            continue
        for dirpath, _dirnames, filenames in os.walk(root):
            if "chrome" in filenames and dirpath.endswith("chrome-linux64"):
                return os.path.join(dirpath, "chrome")
    raise SystemExit("找不到 Chromium，可用 EMEEEK_CHROMIUM 指定路径")


@contextmanager
def browser(**kwargs):
    with sync_playwright() as playwright:
        instance = playwright.chromium.launch(executable_path=chrome_path(), **kwargs)
        try:
            yield instance
        finally:
            instance.close()


@contextmanager
def page(browser_instance, **context_args):
    context = browser_instance.new_context(**context_args)
    try:
        page = context.new_page()
        yield page
    finally:
        context.close()


def report(title, rows):
    """统一输出：人读得懂，也方便 CI 里 grep。"""
    print(f"\n▸ {title}")
    for row in rows:
        mark = "✔" if row.get("ok") else "✘"
        detail = row.get("detail", "")
        print(f"  {mark} {row['name']}" + (f"  —— {detail}" if detail else ""))
    failed = [r for r in rows if not r.get("ok")]
    print(f"  {len(rows) - len(failed)}/{len(rows)} 通过")
    return failed


def fail(rows):
    failed = [r for r in rows if not r.get("ok")]
    if failed:
        print(json.dumps([r["name"] for r in failed], ensure_ascii=False))
        sys.exit(1)
