#!/usr/bin/env python3
"""Feed 产物校验（用真 XML 解析器 + Atom/RSS 结构规则）。

为什么不用正则：正则能检查「有没有那个标签」，但检查不出「标签嵌套错了」
或「有非法字符」——而那两类错误会让阅读器直接拒绝整个 feed。
这里用 xml.dom.minidom 真解析一遍，再按规范逐项核对。

用法：python3 scripts/e2e/feed.py <dist目录> [更多dist目录...]
输出：JSON 行（断言数组）
"""
import json
import os
import re
import sys
import xml.dom.minidom as minidom
from email.utils import parsedate_to_datetime


def check(name, ok, detail=""):
    return {"name": name, "ok": bool(ok), "detail": detail}


def text_of(node, tag):
    els = node.getElementsByTagName(tag)
    return els[0].firstChild.nodeValue if els and els[0].firstChild else None


def validate_rss(path, label):
    rows = []
    raw = open(path, encoding="utf8").read()
    try:
        dom = minidom.parseString(raw)
    except Exception as e:  # noqa: BLE001
        return [check(f"{label} RSS 能被 XML 解析", False, str(e))]
    rows.append(check(f"{label} RSS 能被 XML 解析", True, ""))

    rss = dom.documentElement
    rows.append(check(f"{label} RSS 根元素是 <rss>", rss.tagName == "rss", rss.tagName))
    rows.append(check(f"{label} RSS version=2.0", rss.getAttribute("version") == "2.0", rss.getAttribute("version")))

    channels = dom.getElementsByTagName("channel")
    rows.append(check(f"{label} RSS 有且只有一个 channel", len(channels) == 1, f"{len(channels)} 个"))
    if channels:
        ch = channels[0]
        for tag in ("title", "link", "description"):
            v = text_of(ch, tag)
            rows.append(check(f"{label} RSS channel/{tag} 非空", bool(v), (v or "")[:40]))
        pub = text_of(ch, "lastBuildDate")
        ok = False
        try:
            parsedate_to_datetime(pub)
            ok = True
        except Exception:  # noqa: BLE001
            pass
        rows.append(check(f"{label} RSS lastBuildDate 是合法 RFC 822", ok, pub or "缺"))

    items = dom.getElementsByTagName("item")
    rows.append(check(f"{label} RSS 至少 1 条 item", len(items) >= 1, f"{len(items)} 条"))
    bad = []
    for i, item in enumerate(items):
        for tag in ("title", "link", "guid", "pubDate"):
            if not text_of(item, tag):
                bad.append(f"#{i} 缺 {tag}")
        pub = text_of(item, "pubDate")
        if pub:
            try:
                parsedate_to_datetime(pub)
            except Exception:  # noqa: BLE001
                bad.append(f"#{i} pubDate 非法: {pub}")
    rows.append(check(f"{label} RSS 每条 item 必备字段与日期都合法", not bad, "; ".join(bad[:3])))
    return rows


def validate_atom(path, label):
    rows = []
    raw = open(path, encoding="utf8").read()
    try:
        dom = minidom.parseString(raw)
    except Exception as e:  # noqa: BLE001
        return [check(f"{label} Atom 能被 XML 解析", False, str(e))]
    rows.append(check(f"{label} Atom 能被 XML 解析", True, ""))

    feed = dom.documentElement
    rows.append(check(f"{label} Atom 根元素是 <feed>", feed.tagName == "feed", feed.tagName))
    rows.append(check(f"{label} Atom 命名空间正确",
                      feed.getAttribute("xmlns") == "http://www.w3.org/2005/Atom",
                      feed.getAttribute("xmlns")))

    # Atom 规范要求 feed 级必备元素
    for tag in ("title", "id", "updated"):
        v = text_of(feed, tag)
        rows.append(check(f"{label} Atom feed/{tag} 非空", bool(v), (v or "")[:40]))

    updated = text_of(feed, "updated")
    # Atom 要求 RFC 3339。toUTCString 会得到 RFC 822，验证器会拒。
    rfc3339 = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$")
    rows.append(check(f"{label} Atom feed/updated 是 RFC 3339", bool(updated and rfc3339.match(updated)), updated or "缺"))

    entries = dom.getElementsByTagName("entry")
    rows.append(check(f"{label} Atom 至少 1 条 entry", len(entries) >= 1, f"{len(entries)} 条"))
    bad = []
    for i, entry in enumerate(entries):
        for tag in ("title", "id", "updated"):
            if not text_of(entry, tag):
                bad.append(f"#{i} 缺 {tag}")
        upd = text_of(entry, "updated")
        if upd and not rfc3339.match(upd):
            bad.append(f"#{i} updated 不是 RFC 3339: {upd}")
    rows.append(check(f"{label} Atom 每条 entry 必备字段与日期都合法", not bad, "; ".join(bad[:3])))
    return rows


def probe(dist, label):
    rows = []
    rss = os.path.join(dist, "rss.xml")
    atom = os.path.join(dist, "atom.xml")
    if os.path.exists(rss):
        rows += validate_rss(rss, label)
    else:
        rows.append(check(f"{label} 产出 rss.xml", False, "文件不存在"))
    if os.path.exists(atom):
        rows += validate_atom(atom, label)
    else:
        rows.append(check(f"{label} 产出 atom.xml", False, "文件不存在"))

    # 页面里的 discovery 标签
    index = os.path.join(dist, "index.html")
    if os.path.exists(index):
        html = open(index, encoding="utf8").read()
        rss_links = re.findall(r'<link rel="alternate"[^>]*type="application/rss\+xml"', html)
        atom_links = re.findall(r'<link rel="alternate"[^>]*type="application/atom\+xml"', html)
        rows.append(check(f"{label} 首页有 RSS discovery 且不重复", len(rss_links) == 1, f"{len(rss_links)} 个"))
        rows.append(check(f"{label} 首页有 Atom discovery 且不重复", len(atom_links) == 1, f"{len(atom_links)} 个"))
        # 页脚图标
        rows.append(check(f"{label} 页脚有 feed 图标链接",
                          'class="feed-link"' in html and 'feed-icon' in html, ""))
    return rows


def main():
    rows = []
    for arg in sys.argv[1:]:
        dist, _, label = arg.partition("=")
        rows += probe(dist, label or os.path.basename(dist))
    print(json.dumps(rows, ensure_ascii=False))


if __name__ == "__main__":
    main()
