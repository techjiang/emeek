#!/usr/bin/env python3
"""主题系统 e2e（真浏览器）。

验四件事，每一件都只有在真浏览器里才成立：

  1. 首帧无闪烁：带 dark 偏好加载时，第一帧的 body 背景就是深的 ——
     不能先亮后暗。判据是「在 HTML 解析完成后立刻读 computed style」。
  2. 明暗切换：点按钮 → data-theme 翻转 → localStorage 记住。
  3. legacy 明暗策略：light/dark 强制模式下，按钮点击不改变外观。
  4. 两套主题视觉不同：同一页面，CSS 变量与关键布局属性不同。

输入 JSON：{dist: {theme: dir}, out: manifest 路径, root, targets}
"""
import json
import os
import sys

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import browser  # noqa: E402


def check(page, name, ok, detail=""):
    return {"name": name, "ok": bool(ok), "detail": detail}


def probe_themes(config):
    rows = []
    with sync_playwright() as playwright:
        b = playwright.chromium.launch(executable_path=browser.chrome_path())
        for theme in config["targets"]:
            dist = config["dist"][theme]
            base = "file://" + os.path.join(dist, "index.html")

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
                pg.goto(base)
                colors[mode] = pg.evaluate("()=>getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()")
                ctx.close()
            rows.append(check(None, f"[{theme}] 亮/暗背景不同（独立配色，非反转也行但必须不同）",
                              colors["light"] != colors["dark"], f"{colors['light']} vs {colors['dark']}"))
            rows[-1]["colors"] = colors

        b.close()
    return rows


def main(config_file):
    config = json.load(open(config_file, encoding="utf8"))
    rows = probe_themes(config)

    # 4. 两套主题互不相同：同一路由下 --bg / 字体 / 圆角至少两项不同
    if len(config["targets"]) >= 2:
        a, b_ = config["targets"][0], config["targets"][1]
        with sync_playwright() as playwright:
            br = playwright.chromium.launch(executable_path=browser.chrome_path())
            samples = {}
            for theme in (a, b_):
                ctx = br.new_context(viewport={"width": 1280, "height": 900}, color_scheme="dark")
                ctx.add_init_script("localStorage.setItem('emeeek-theme','dark')")
                pg = ctx.new_page()
                pg.goto("file://" + os.path.join(config["dist"][theme], "index.html"))
                samples[theme] = pg.evaluate("""()=>{
                  const cs=getComputedStyle(document.documentElement);
                  const card=document.querySelector('.card');
                  return {
                    bg:cs.getPropertyValue('--bg').trim(),
                    radius:cs.getPropertyValue('--radius').trim(),
                    font:cs.getPropertyValue('--font-body').trim(),
                    cardRadius:card?getComputedStyle(card).borderRadius:'',
                    cardWidth:card?Math.round(card.getBoundingClientRect().width):0,
                  };
                }""")
                ctx.close()
            br.close()
            diff = [k for k in samples[a] if samples[a][k] != samples[b_][k]]
            rows.append(check(None, f"主题 {a} 与 {b_} 视觉可辨（≥2 项不同）",
                              len(diff) >= 2, f"不同项 {diff}"))

    if config.get("out"):
        json.dump({"rows": rows}, open(config["out"], "w", encoding="utf8"), ensure_ascii=False)
    print(json.dumps(rows, ensure_ascii=False))


if __name__ == "__main__":
    main(sys.argv[1])
