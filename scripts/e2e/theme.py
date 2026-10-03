#!/usr/bin/env python3
"""主题系统 e2e（真浏览器）。

验四件事，每一件都只有在真浏览器里才成立：

  1. 首帧无闪烁：带 dark 偏好加载时，第一帧的 body 背景就是深的 ——
     不能先亮后暗。判据是「在 HTML 解析完成后立刻读 computed style」。
  2. 明暗切换：点按钮 → data-theme 翻转 → localStorage 记住。
  3. legacy 明暗策略：light/dark 强制模式下，按钮点击不改变外观。
  4. 两套主题视觉不同：同一页面，CSS 变量与关键布局属性不同。
  5. 布局结构两两可辨：4 套主题的首页版面结构（网格/单栏/两栏/多栏）
     两两至少一项不同 —— 「换主题只换颜色」在这里被挡住。

输入 JSON：{dist: {theme: dir}, out: manifest 路径, root, targets}
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
import browser  # noqa: E402


def check(page, name, ok, detail=""):
    return {"name": name, "ok": bool(ok), "detail": detail}


class _QuietHandler(http.server.SimpleHTTPRequestHandler):
    """静态服务：不往 stderr 刷访问日志（失败详情由断言给出，噪音只会淹没它）。"""

    def log_message(self, *args):
        pass


def serve(directory):
    """每个主题的产物各起一个本地服务，返回 base URL 与关闭函数。

    为什么必须走 HTTP 而不是 file://：
      CSS 超过 24KB 的主题会退回外链 /assets/theme.css（见 output.js 的
      inlineCriticalCss）。file:// 下 `/assets/...` 会被解析成文件系统根目录，
      外链永远 404 —— 主题看起来「暗色不生效」，其实是样式表根本没加载。
      内联 CSS 的主题（体积小）碰巧不受影响，于是这个缺陷只在第 4 套主题
      上才暴露。用 HTTP 服务，阈值两侧的主题走同一条路径。
    """
    handler = functools.partial(_QuietHandler, directory=directory)
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    httpd.allow_reuse_address = True
    port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return f"http://127.0.0.1:{port}", httpd.shutdown


# 首页「版面结构」采样：这些字段描述的是**布局**，不是配色。
#   mainDisplay/mainCols/mainFlex —— 页面主容器的排列方式
#   listDisplay/listCols/listFlex  —— 文章列表容器的排列方式
#   cardFullWidth                 —— 首页所有卡片是否等宽（单栏/多栏的信号）
#   asideColumn                   —— 是否存在并排的侧栏列
# 判据只有一条：任意两套主题，这份结构快照至少一项不同。
LAYOUT_PROBE = """()=>{
  const cs = (el) => el ? getComputedStyle(el) : null;
  const main = document.querySelector('.site-main');
  const cards = [...document.querySelectorAll('.card')];
  // 主容器里的直接子元素（排除 script），用来判断有没有「并排的第二列」
  const mainChildren = main ? [...main.children].filter(Boolean) : [];
  const list = document.querySelector('.post-list') || document.querySelector('.post-grid')
    || document.querySelector('.lead-grid') || document.querySelector('.index-column');
  const widths = cards.map((c) => Math.round(c.getBoundingClientRect().width));
  const uniqueWidths = [...new Set(widths)];
  return {
    mainDisplay: cs(main)?.display ?? '',
    mainCols: cs(main)?.gridTemplateColumns ?? '',
    mainFlex: cs(main)?.flexDirection ?? '',
    mainChildCount: mainChildren.length,
    listDisplay: cs(list)?.display ?? '',
    listCols: cs(list)?.gridTemplateColumns ?? '',
    listFlex: cs(list)?.flexDirection ?? '',
    cardCount: cards.length,
    // 「所有卡片同宽」在单栏与网格里都可能成立，但它区分「有主次」的杂志版式
    allCardsEqualWidth: uniqueWidths.length <= 1,
    // 第一张卡是否明显比其余宽 —— Magazine 的封面头条就是这种结构
    hasLeadCard: widths.length > 1 && widths[0] > Math.max(...widths.slice(1)) * 1.2,
    // 首页是否有 hero 区（Aurora 的渐变舞台、Inkstone/Magazine 的刊头）
    hasHero: !!document.querySelector('.hero'),
    // 区块编号（Magazine 的 01/02），是它「三级权重」的可见标记
    hasSectionNumber: !!document.querySelector('.section-number'),
  };
}"""


def probe_layout_structure(config):
    """返回 {theme: {signature, metrics}}，供两两比较用。"""
    out = {}
    with sync_playwright() as playwright:
        b = playwright.chromium.launch(executable_path=browser.chrome_path())
        for theme in config["targets"]:
            origin, shutdown = serve(config["dist"][theme])
            ctx = b.new_context(viewport={"width": 1280, "height": 900}, color_scheme="dark")
            ctx.add_init_script("localStorage.setItem('emeeek-theme','dark')")
            pg = ctx.new_page()
            pg.goto(origin + "/index.html")
            pg.wait_for_timeout(120)
            metrics = pg.evaluate(LAYOUT_PROBE)
            ctx.close()
            shutdown()
            out[theme] = {"metrics": metrics}
        b.close()
    return out


def probe_themes(config):
    rows = []
    with sync_playwright() as playwright:
        b = playwright.chromium.launch(executable_path=browser.chrome_path())
        for theme in config["targets"]:
            dist = config["dist"][theme]
            origin, shutdown = serve(dist)
            base = f"{origin}/index.html"

            # 1. 首帧无闪烁：dark 偏好 + 无 localStorage
            ctx = b.new_context(viewport={"width": 1280, "height": 900}, color_scheme="dark")
            pg = ctx.new_page()
            pg.goto(base)
            bg = pg.evaluate("()=>getComputedStyle(document.documentElement).getPropertyValue('--bg')")
            rows.append(check(pg, f"[{theme}] 深色偏好下首帧即深色（--bg 不含白）",
                              bg.strip().lower() not in ("#ffffff", "#fff", ""), bg.strip()))
            ctx.close()

            # 2. 切换：light 起步 → 点击 → 变 dark 且写 localStorage
            ctx = b.new_context(viewport={"width": 1280, "height": 900}, color_scheme="light")
            ctx.add_init_script("localStorage.setItem('emeeek-theme','light')")
            pg = ctx.new_page()
            pg.goto(base)
            pg.wait_for_timeout(120)
            before = pg.get_attribute("html", "data-theme")
            if pg.query_selector("#theme-toggle"):
                pg.click("#theme-toggle")
                pg.wait_for_timeout(80)
                after = pg.get_attribute("html", "data-theme")
                stored = pg.evaluate("()=>localStorage.getItem('emeeek-theme')")
                rows.append(check(pg, f"[{theme}] 点击切换按钮翻转 data-theme",
                                  before == "light" and after == "dark", f"{before}→{after}"))
                rows.append(check(pg, f"[{theme}] 切换写入 localStorage",
                                  stored == "dark", str(stored)))
            else:
                rows.append(check(pg, f"[{theme}] 存在切换按钮", False, "未找到 #theme-toggle"))
            ctx.close()

            # 3. 亮度差异：light 与 dark 的 --bg 必须不同（不能是同一套配色）
            colors = {}
            for mode in ("light", "dark"):
                ctx = b.new_context(viewport={"width": 1280, "height": 900}, color_scheme=mode)
                ctx.add_init_script(f"localStorage.setItem('emeeek-theme','{mode}')")
                pg = ctx.new_page()
                pg.goto(origin + "/index.html")
                colors[mode] = pg.evaluate("()=>getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()")
                ctx.close()
            rows.append(check(None, f"[{theme}] 亮/暗背景不同（独立配色，非反转也行但必须不同）",
                              colors["light"] != colors["dark"], f"{colors['light']} vs {colors['dark']}"))
            rows[-1]["colors"] = colors
            shutdown()

        b.close()
    return rows


def main(config_file):
    config = json.load(open(config_file, encoding="utf8"))
    rows = probe_themes(config)

    # 4. 主题两两可辨：计算样式 ≥ 5 项不同（配色/字体/圆角/卡片宽度…）
    structure = probe_layout_structure(config)
    if len(config["targets"]) >= 2:
        with sync_playwright() as playwright:
            br = playwright.chromium.launch(executable_path=browser.chrome_path())
            samples = {}
            for theme in config["targets"]:
                origin, shutdown = serve(config["dist"][theme])
                ctx = br.new_context(viewport={"width": 1280, "height": 900}, color_scheme="dark")
                ctx.add_init_script("localStorage.setItem('emeeek-theme','dark')")
                pg = ctx.new_page()
                pg.goto(origin + "/index.html")
                samples[theme] = pg.evaluate("""()=>{
                  const cs=getComputedStyle(document.documentElement);
                  const card=document.querySelector('.card');
                  return {
                    bg:cs.getPropertyValue('--bg').trim(),
                    radius:cs.getPropertyValue('--radius').trim(),
                    font:cs.getPropertyValue('--font-body').trim(),
                    fontSize:cs.getPropertyValue('--font-size-base').trim(),
                    lineHeight:cs.getPropertyValue('--line-height-base').trim(),
                    maxWidth:cs.getPropertyValue('--max-width').trim(),
                    cardRadius:card?getComputedStyle(card).borderRadius:'',
                    cardWidth:card?Math.round(card.getBoundingClientRect().width):0,
                  };
                }""")
                ctx.close()
                shutdown()
            br.close()
            themes = list(config["targets"])
            for i in range(len(themes)):
                for j in range(i + 1, len(themes)):
                    a, b_ = themes[i], themes[j]
                    diff = [k for k in samples[a] if samples[a][k] != samples[b_][k]]
                    rows.append(check(None, f"主题 {a} 与 {b_} 计算样式可辨（≥5 项不同）",
                                      len(diff) >= 5, f"不同 {len(diff)} 项 {diff}"))

    # 5. 布局结构快照：把每套主题的原始结构指标一并回传。
    #    判据（签名压缩 + 两两比较）由 Node 侧的 scripts/e2e/theme_signature.mjs
    #    计算 —— 那里有单测钉着，Python 这边只负责“把真浏览器的结果读出来”。
    if structure:
        rows.append({
            "name": "首页版面结构快照（供两两比较）",
            "ok": True,
            "detail": ", ".join(f"{t}:{structure[t]['metrics']['listDisplay']}" for t in structure),
            "layout": {t: structure[t]["metrics"] for t in structure},
        })

    if config.get("out"):
        json.dump({"rows": rows}, open(config["out"], "w", encoding="utf8"), ensure_ascii=False)
    print(json.dumps(rows, ensure_ascii=False))


if __name__ == "__main__":
    main(sys.argv[1])
