# Feed（RSS / Atom）

构建期产出两份订阅文件：`dist/rss.xml`（RSS 2.0）与 `dist/atom.xml`（Atom 1.0）。

## 为什么两份都要

RSS 2.0 是老阅读器的通用语言（Feedly / Inoreader / 各种桌面客户端），
Atom 1.0 是 IETF 标准，对日期、内容类型、多语言的处理更严谨。只发一份
总有人订不上 —— 这不是多此一举，是「别让读者挑工具」。

两份由**同一份数据**生成（`feedItems`），避免 RSS 与 Atom 内容不一致。
那种不一致用户看不出来（他只用其中一个），但会让「订阅数」对不上。

## 配置

```js
// emeeek.config.js
export default {
  feed: {
    enabled: true,
    limit: 20,          // 条目上限
    fullContent: false, // true 时发正文全文
    categories: [],     // 只要这些分类（空 = 全部）
  },
};
```

`fullContent` 默认 **关**：整站正文塞进 feed 会让文件巨大，而多数阅读器
本来也只显示摘要。要全文就显式开。

## 日期格式（中文站点最常踩的坑）

两种格式对日期的要求**不一样**：

| 格式 | 字段 | 要求 | 示例 |
| --- | --- | --- | --- |
| RSS 2.0 | `pubDate` / `lastBuildDate` | RFC 822 | `Mon, 15 Jan 2024 00:00:00 GMT` |
| Atom 1.0 | `updated` / `published` | RFC 3339 | `2024-01-15T00:00:00.000Z` |

中文站点常见的问题是只写本地格式（`2024年1月15日`），验证器直接判不合法。

实现上：`toUTCString()` 得到 RFC 822（给 RSS），`toISOString()` 得到
RFC 3339（给 Atom）。`docs` 里页面显示的日期仍走 `toLocaleDateString`，
与 feed 无关 —— **一套数据，三种呈现**。

## 页面里的发现标签

`<head>` 里由 `partials/head.html` 统一输出：

```html
<link rel="alternate" type="application/rss+xml" href="/rss.xml" title="… RSS" />
<link rel="alternate" type="application/atom+xml" href="/atom.xml" title="… Atom" />
```

因为放在 `head` partial 里，**所有页面都有**（含 404 与搜索页），
且跟随 `config.feed` —— 关掉 feed 就一起消失。

> 早期版本在 `index.html` / `post.html` 里各硬编码了一份，写死 `/rss.xml`、
> 且只在两个页面生效。已移除，现在只有 head partial 这一个来源。

## 页脚图标

页脚有一对 SVG 图标（RSS + Atom），用 `currentColor` 跟随主题链接色，
hover 时变 `--accent`。图标不是图片文件 —— 内联 SVG 不产生额外请求，
也不必为 4 套主题各备一份。

## XML 正确性

两件容易出错、且肉眼看不出来的事：

**1. 转义。** 标题里的 `&` 或 `<` 会直接让 XML 坏掉。`escapeXml` 比 HTML
转义更严：还要剔除 XML 1.0 不允许的控制字符（保留 `\t` `\n` `\r`）。

**2. CDATA 里的 `]]>`。** 正文里出现这个序列（写代码文档时很常见）会让
整个 feed 变成坏 XML。按官方做法拆成 `]]]]><![CDATA[>`。

## 验证

`scripts/e2e/feed.mjs` 用**真 XML 解析器**（Python `xml.dom.minidom`）
解析产物，再按 RSS / Atom 规范逐项核对：

- 根元素与命名空间
- channel / feed 级必备元素非空
- 每条 item / entry 的必备字段
- 日期的**实际可解析性**（`email.utils.parsedate_to_datetime` 与 RFC 3339 正则）
- 页面里的 discovery 标签**恰好各一个**（不多不少）

```bash
node scripts/e2e/feed.mjs     # 4 主题 × 22 项
```

为什么不用正则检查「有没有那个标签」：正则检查不出「标签嵌套错了」或
「有非法字符」—— 而那两类错误会让阅读器拒收整个 feed。
