#!/usr/bin/env python3
"""社交分享的浏览器行为验收（P3-4b-rest C）。

要验的三件事都只在真浏览器里成立：
  1. 点「微信」后 canvas 真的画出了东西 —— 而且是**能扫码的**二维码
     （单测只能验「矩阵一致」，验不了「画出来的像素能读出正确地址」）
  2. 点「复制」后剪贴板里真的是当前文章地址
  3. 二维码里编的是**当前文章**的地址，不是首页、不是空串

二维码的「能扫」用 OpenCV 的真实解码器判定 —— 这是唯一能证明
「它不是一张黑白图」的方式。
"""
import base64
import json
import sys
import numpy as np
import cv2

sys.path.insert(0, __import__("os").path.dirname(__file__))
from browser import browser, page  # noqa: E402

RESULTS = []


def check(label, ok, extra=""):
    RESULTS.append({"label": label, "ok": bool(ok), "extra": extra})


def canvas_to_matrix(page_obj):
    """把 canvas 的像素取回来，转成 OpenCV 能读的二值图。"""
    data_url = page_obj.evaluate("""() => {
      const c = document.querySelector('[data-share-qr] canvas');
      return c ? c.toDataURL('image/png') : null;
    }""")
    if not data_url:
        return None
    raw = base64.b64decode(data_url.split(",", 1)[1])
    arr = np.frombuffer(raw, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_GRAYSCALE)
    return img


def run(base_url, expected_url):
    with browser() as b:
        with page(b, viewport={"width": 1280, "height": 900}) as p:
            p.goto(base_url + "/posts/hello.html", wait_until="domcontentloaded")

            # ── 1. 分享块存在 ──
            has_share = p.evaluate("() => !!document.querySelector('[data-share]')")
            check("文章页有分享块", has_share)

            # ── 2. 纯 <a> 平台不加载第三方 SDK ──
            external = p.evaluate("""() => Array.from(document.querySelectorAll('script[src]'))
              .map(s => s.getAttribute('src'))""")
            third_party = [s for s in external if s and ('twitter' in s or 'facebook' in s or 'addthis' in s)]
            check("没有第三方分享 SDK", not third_party, ",".join(third_party))

            # ── 3. 点「微信」→ 画二维码 ──
            wechat = p.query_selector("[data-share-wechat]")
            check("有微信按钮", wechat is not None)
            if wechat:
                wechat.click()
                p.wait_for_timeout(200)
                opened = p.evaluate("() => document.querySelector('[data-share-qr]').hasAttribute('data-open')")
                check("点微信后二维码面板展开", opened)
                img = canvas_to_matrix(p)
                check("canvas 有像素", img is not None and img.size > 0)
                if img is not None:
                    # 需要放大到解码器舒服的尺寸 —— 二维码本身是模块化的，
                    # 但 canvas 上的模块可能只有几像素，OpenCV 对极小的码
                    # 识别率会掉。放大 4 倍保持模块边界清晰。
                    big = cv2.resize(img, None, fx=4, fy=4, interpolation=cv2.INTER_NEAREST)
                    decoded, _, _ = cv2.QRCodeDetector().detectAndDecode(big)
                    check("二维码能被真实解码器读出", bool(decoded), f"读出={decoded[:60]!r}")
                    # 编的必须是当前文章地址（带 UTM），不是首页、不是空串
                    check("二维码内容是当前文章地址", decoded.startswith(expected_url) and "utm_source" in decoded,
                          f"读出={decoded[:80]!r}")
                    check("二维码内容不是首页", decoded.rstrip("/") != base_url.rstrip("/"))

            # ── 4. 复制链接 ──
            copy_btn = p.query_selector("[data-share-copy]")
            check("有复制按钮", copy_btn is not None)
            if copy_btn:
                p.context.grant_permissions(["clipboard-read", "clipboard-write"])
                copy_btn.click()
                p.wait_for_timeout(150)
                copied = p.evaluate("() => navigator.clipboard.readText()")
                check("剪贴板里是当前文章地址", copied.startswith(expected_url), f"读到={copied[:80]!r}")
                marked = p.evaluate("() => document.querySelector('[data-share-copy]').hasAttribute('data-copied')")
                check("复制后按钮给出反馈", marked)

            # ── 5. 移动端折叠 ──
            with page(b, viewport={"width": 390, "height": 844}) as m:
                m.goto(base_url + "/posts/hello.html", wait_until="domcontentloaded")
                toggle_visible = m.evaluate("""() => {
                  const t = document.querySelector('[data-share-toggle]');
                  return t ? getComputedStyle(t).display !== 'none' : false;
                }""")
                check("手机视口下出现折叠开关", toggle_visible)
                if toggle_visible:
                    m.query_selector("[data-share-toggle]").click()
                    m.wait_for_timeout(120)
                    shown = m.evaluate("""() => {
                      const b = document.querySelector('.share-buttons');
                      return b ? getComputedStyle(b).display !== 'none' : false;
                    }""")
                    check("点开关后按钮出现", shown)
                overflow = m.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth")
                check("手机视口无横向溢出", overflow <= 1, f"溢出 {overflow}px")


if __name__ == "__main__":
    base = sys.argv[1]
    expected = sys.argv[2]
    try:
        run(base, expected)
    finally:
        print(json.dumps(RESULTS, ensure_ascii=False))
