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

CHROME_CANDIDATES = [
    os.environ.get("EMEEEK_CHROMIUM"),
    "/opt/ms-playwright/chromium-1243/chrome-linux64/chrome",
    "/usr/bin/chromium",
    "/usr/local/bin/chromium",
]


def chrome_path():
    for candidate in CHROME_CANDIDATES:
        if candidate and os.path.exists(candidate):
            return candidate
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
