#!/usr/bin/env python3
"""把渲染好的 HTML 塞进真浏览器，检查有没有脚本真的执行。

判据不是「HTML 里有没有 <script>」，而是「页面里 __xss 有没有被写」——
后者才是攻击者想要的东西，也是唯一无法被字符串处理绕过的判据。
"""
import json
import sys

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from browser import browser  # noqa: E402

CASES = json.load(open(sys.argv[1]))
rows = []

with browser() as instance:
    for case in CASES:
        page = instance.new_page()
        try:
            page.goto("about:blank")
            page.set_content(f"<!doctype html><html><body>{case['html']}</body></html>")
            page.wait_for_timeout(120)
            fired = page.evaluate("() => window.__xss ?? null")
            detail = ""
            if fired is None:
                links = page.query_selector_all("a[href]")
                for index in range(min(len(links), 4)):
                    try:
                        links[index].click(timeout=400)
                        page.wait_for_timeout(120)
                        if page.evaluate("() => window.__xss ?? null") is not None:
                            fired = "click"
                            break
                    except Exception:
                        continue
            if fired is not None:
                detail = f"脚本真的执行了（触发方式：{fired}）"
            rows.append({"name": f"[浏览器] {case['name']}", "ok": fired is None, "detail": detail})
        finally:
            page.close()

print(json.dumps(rows, ensure_ascii=False))
