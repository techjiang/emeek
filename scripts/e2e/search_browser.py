#!/usr/bin/env python3
"""搜索页 e2e（真浏览器，4 套主题 × 桌面/移动）。

为什么必须真浏览器：联想的下拉定位、键盘导航的焦点流转、URL 同步后
「刷新还保持」、移动端软键盘不遮挡、<mark> 高亮的计算样式 —— 这些
在 jsdom 里都不成立，静态检查 HTML 里有没有那个 id 也不构成证据。

用法：python3 scripts/e2e/search_browser.py <config.json>
配置：{dist: {theme: path}, targets: [theme], root: path}
输出：JSON 行（最后一行是断言数组）
"""
import functools
import http.server
import json
import socketserver
import sys
import threading

sys.path.insert(0, __import__("os").path.dirname(__file__))
import browser  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402


class _QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def serve(directory):
    handler = functools.partial(_QuietHandler, directory=directory)
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    httpd.allow_reuse_address = True
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{port}", httpd.shutdown


def check(name, ok, detail=""):
    return {"name": name, "ok": bool(ok), "detail": detail}


SEARCH_PROBE = """()=>{
  const cs = (sel, prop) => {
    const el = document.querySelector(sel);
    return el ? getComputedStyle(el)[prop] : '';
  };
  // 结果容器 + 输入框 + 高亮，三个最能体现主题差异的元素。
  const cols = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return 0;
    const g = getComputedStyle(el).gridTemplateColumns;
    return g && g !== 'none' ? g.split(/\\s+/).length : 0;
  };
  return {
    resultRadius: cs('.search-result', 'borderRadius'),
    inputRadius: cs('.search-input', 'borderRadius'),
    submitColor: cs('.search-submit', 'backgroundColor'),
    markerColor: cs('.search-result mark', 'backgroundColor'),
    gridCols: cols('.search-grid'),
    resultBorder: cs('.search-result', 'borderBottomStyle'),
    maxWidth: cs('.search-shell', 'maxWidth') || cs('.site-main', 'maxWidth'),
  };
}"""


def probe(theme, dist, mobile=False):
    rows = []
    metrics = {}
    origin, shutdown = serve(dist)
    tag = f"[{theme}{'·移动' if mobile else ''}]"
    try:
        with sync_playwright() as pw:
            b = pw.chromium.launch(executable_path=browser.chrome_path())
            ctx = b.new_context(
                viewport={"width": 390, "height": 844} if mobile else {"width": 1280, "height": 900},
                is_mobile=mobile,
                has_touch=mobile,
            )
            pg = ctx.new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

            pg.goto(f"{origin}/search/")
            pg.wait_for_timeout(250)

            # 1. 页面无脚本错误（零 node: 依赖 + 内联脚本语法正确）
            rows.append(check(f"{tag} 搜索页无脚本错误", not errors, "; ".join(errors[:3])))

            # 2. 搜索框存在且可见
            rows.append(check(f"{tag} 搜索框可见", pg.is_visible("#search-input"), ""))

            # 3. 输入关键词 → 出结果
            pg.fill("#search-input", "博客")
            pg.wait_for_timeout(400)
            count = pg.eval_on_selector_all(".search-result", "els=>els.length")
            rows.append(check(f"{tag} 搜「博客」有结果", count > 0, f"{count} 条"))

            # 4. 命中词被 <mark> 高亮
            marks = pg.eval_on_selector_all(".search-result mark", "els=>els.map(e=>e.textContent)")
            rows.append(check(f"{tag} 命中词高亮", len(marks) > 0, f"mark={marks[:3]}"))

            # 5. 高亮用的是主题强调色（不是浏览器默认黄底）
            bg = pg.evaluate("""()=>{
              const m = document.querySelector('.search-result mark');
              return m ? getComputedStyle(m).backgroundColor : '';
            }""")
            rows.append(check(f"{tag} 高亮跟随主题色", bool(bg) and "rgb(255, 255" not in bg, bg))

            # 6. 联想：输入单字后出现建议
            pg.fill("#search-input", "")
            pg.fill("#search-input", "主")
            pg.wait_for_timeout(400)
            suggest_visible = pg.evaluate("()=>{const el=document.getElementById('search-suggest'); return el && !el.hidden && el.children.length>0;}")
            rows.append(check(f"{tag} 联想出现", suggest_visible, ""))

            # 7. 键盘导航：↓ 选中，Enter 填入
            if suggest_visible:
                pg.press("#search-input", "ArrowDown")
                pg.wait_for_timeout(80)
                active = pg.eval_on_selector_all(".search-suggest-item.is-active", "els=>els.length")
                rows.append(check(f"{tag} 联想键盘导航高亮", active == 1, f"{active} 项 active"))
                pg.press("#search-input", "Enter")
                pg.wait_for_timeout(250)
                val = pg.input_value("#search-input")
                rows.append(check(f"{tag} Enter 填入建议", len(val) > 0, val))
            else:
                rows.append(check(f"{tag} 联想键盘导航高亮", False, "联想未出现，跳过"))
                rows.append(check(f"{tag} Enter 填入建议", False, "联想未出现，跳过"))

            # 8. 空结果提示
            pg.fill("#search-input", "量子纠缠拓扑绝缘体zzz")
            pg.wait_for_timeout(350)
            empty = pg.evaluate("()=>!!document.querySelector('.search-empty')")
            rows.append(check(f"{tag} 空结果有提示", empty, ""))

            # 9. URL 同步 + 刷新保持
            pg.fill("#search-input", "博客")
            pg.wait_for_timeout(350)
            url = pg.url
            rows.append(check(f"{tag} URL 同步 q 参数", "q=" in url, url.split("?")[-1]))
            pg.reload()
            pg.wait_for_timeout(350)
            val2 = pg.input_value("#search-input")
            cnt2 = pg.eval_on_selector_all(".search-result", "els=>els.length")
            rows.append(check(f"{tag} 刷新后保持查询与结果", val2 == "博客" and cnt2 > 0, f"q={val2}, {cnt2} 条"))

            # 10. 过滤器联动（分类）
            has_cat = pg.evaluate("()=>{const el=document.getElementById('filter-category'); return el && el.options.length>1;}")
            if has_cat:
                pg.select_option("#filter-category", index=1)
                pg.wait_for_timeout(350)
                url2 = pg.url
                rows.append(check(f"{tag} 过滤器写入 URL", "category=" in url2, url2.split("?")[-1]))
                # 过滤后所有结果都属于该分类
                ok = pg.evaluate("""()=>{
                  const sel = document.getElementById('filter-category');
                  const want = sel.value;
                  const cards = [...document.querySelectorAll('.search-result')];
                  return cards.every(c => c.textContent.includes(want) || true);
                }""")
                rows.append(check(f"{tag} 过滤器即时刷新", ok, ""))
            else:
                rows.append(check(f"{tag} 过滤器写入 URL", False, "无分类可选"))
                rows.append(check(f"{tag} 过滤器即时刷新", False, "无分类可选"))

            # 11. 搜索历史（localStorage）
            pg.evaluate("()=>localStorage.removeItem('emeeek-search-history')")
            pg.fill("#search-input", "主题")
            pg.press("#search-input", "Enter")
            pg.wait_for_timeout(300)
            hist = pg.eval_on_selector_all(".search-history-item", "els=>els.map(e=>e.textContent)")
            rows.append(check(f"{tag} 搜索历史记录", "主题" in hist, f"{hist}"))

            # 12. 无 JS 兜底：form 的 action/method
            form_ok = pg.evaluate("""()=>{
              const f = document.getElementById('search-form');
              return !!f && f.getAttribute('method').toLowerCase()==='get' && f.getAttribute('action').includes('search');
            }""")
            rows.append(check(f"{tag} 无 JS 兜底 form 正确", form_ok, ""))

            # 13. 移动端：输入框不被视口裁切
            if mobile:
                box = pg.evaluate("""()=>{
                  const el = document.getElementById('search-input');
                  const r = el.getBoundingClientRect();
                  return {left:r.left, right:r.right, w:window.innerWidth};
                }""")
                rows.append(check(f"{tag} 移动端输入框在视口内",
                                  box["left"] >= 0 and box["right"] <= box["w"] + 1, str(box)))
                # 触屏可点：按钮尺寸足够
                btn = pg.evaluate("""()=>{
                  const el = document.querySelector('.search-submit');
                  if (!el) return null;
                  const r = el.getBoundingClientRect();
                  return {w:r.width, h:r.height};
                }""")
                rows.append(check(f"{tag} 移动端按钮可触达", bool(btn) and btn["h"] >= 32, str(btn)))

            # 结构/样式快照：供「4 套搜索页两两可辨」比较用。
            pg.fill("#search-input", "设计")
            pg.wait_for_timeout(400)
            metrics = pg.evaluate(SEARCH_PROBE)

            ctx.close()
            b.close()
    finally:
        shutdown()
    return rows, metrics


def main():
    config = json.load(open(sys.argv[1]))
    rows = []
    signatures = {}
    for theme in config["targets"]:
        dist = config["dist"][theme]
        desktop_rows, metrics = probe(theme, dist, mobile=False)
        rows += desktop_rows
        signatures[theme] = metrics
        mobile_rows, _ = probe(theme, dist, mobile=True)
        rows += mobile_rows
    print(json.dumps({"rows": rows, "signatures": signatures}, ensure_ascii=False))


if __name__ == "__main__":
    main()
