# SEO 全量（P3-3a）

Emeek 的 SEO 输出全部由引擎生成，4 套主题共用同一份 partial。
这份文档说明**为什么这样设计**，以及每一处容易踩的坑。

---

## 一、为什么由引擎统一生成，而不是各主题自己写

4 套主题各自手写 `<meta>` 与 JSON-LD，一定会漂移。
漂移的表现是：A 主题有 `article:published_time`，B 主题漏了；
C 主题的 JSON-LD 少了 `dateModified`。

**这类错误不会让页面看起来有任何异常。**
只有搜索引擎知道，或者你手工去 Google 富媒体测试里一页一页地过。
所以它不是「勤快一点就能靠 review 发现」的问题，是结构问题。

现在的形状：

```
pipeline/index.js
  └── applySeo(page.data, { site, config, seo })
        ├── buildSeoView(...)        → seoView（供主题读取的视图对象）
        ├── renderSeoTags(view)      → headMeta（可直接插进 <head>）
        └── buildStructuredData(...) → jsonLd（完整的 <script> 字符串）
                    ↓
theme-*/partials/seo.html     {{{ headMeta }}}
theme-*/partials/head.html    {% include "seo" %}
theme-*/partials/jsonld.html  {{{ jsonLd }}}
theme-*/partials/footer.html  {% include "jsonld" %}
```

主题不参与任何 SEO 决策。要改 SEO，改 `packages/core/src/pipeline/transform/seo.js` 一处。

---

## 二、sitemap.xml

### 条目来自实际产物，不是重新拼一遍路径

最初实现是「用模板重新拼 URL 列表」—— 结果是标签页、分类页、搜索页、分页
**全都不在 sitemap 里**。搜索引擎只能靠入链爬，而孤立的标签页几乎没有入链。

现在直接读已经渲染完成的页面列表（`rendered`），并过滤掉 `noindex` 的页面。

### 优先级 / 更新频率策略

定义在 `SITEMAP_POLICY`（`transform/seo.js`），判据是**页面类型**而不是路径字符串 ——
路径是可以配置的（搜索页路径就能改），拿路径做判断迟早对不上。

| 类型 | priority | changefreq |
| --- | --- | --- |
| 首页 | 1.0 | daily |
| 文章页 | 0.8 | monthly |
| 标签页 / 分类页 / 归档 / 标签总览 | 0.6 | weekly |
| 其它静态页 | 0.5 | yearly |

### lastmod 用内容时间，不用构建时间

首页 / 归档 / 标签这些聚合页的 `lastmod` 取**最新一篇文章的更新或发布时间**。
如果用构建时间，每次 CI 重建都会把整份 sitemap 的 `lastmod` 刷新一遍 ——
搜索引擎发现这个字段一直在变但没有实质变化，就会开始忽略它。

### 元素顺序是 XSD 的 sequence

```xml
<url>
  <lastmod>…</lastmod>      <!-- 必须在这个位置 -->
  <changefreq>…</changefreq>
  <priority>…</priority>
  <loc>…</loc>              <!-- loc 在最后 -->
</url>
```

`sitemaps.org` 的 XSD 是 `sequence`，顺序错了**整份 sitemap 无效**。
而浏览器打开它看起来完全正常。这条由 `check-seo.mjs` 与单测盯着。

### 超过 50000 条自动拆分

`sitemaps.org` 的硬限制是单文件 ≤ 50000 条 / 50MB。超了会拆成
`sitemap-index.xml` + `sitemap-N.xml`。

注意：**不拆不会「只收前 5 万条」，而是整份被判无效。**

---

## 三、robots.txt

```
User-agent: *
Allow: /
Disallow: /search/
Disallow: /*?q=
Disallow: /*?page=

Sitemap: https://example.com/sitemap.xml
```

### 三条内置屏蔽不可取消

- `/search/` —— 爬虫看到的搜索页是**空壳**（内容靠 JS 渲染），
  收录它只会产生重复内容并稀释整站权重
- `/*?q=` —— 查询参数产生无限变体
- `/*?page=` —— 分页参数同理

可以**追加**规则（`config.seo.robots.disable`），但不能取消这三条。
允许收录搜索页不是偏好问题，是会产生重复内容的问题。

```js
seo: {
  robots: {
    disable: ['/drafts/', '/private/'],
    custom: [{ userAgent: 'BadBot', disallow: ['/'] }],
  },
}
```

### 与 Lighthouse 的冲突（必须知道）

Lighthouse 的 `is-crawlable` 审计对**被 robots.txt 屏蔽的页面**记 0 分，
于是 `/search/` 页的 SEO 分从 100 掉到 66。

这里两个目标互相矛盾：**「Lighthouse SEO = 100」与「正确的 SEO」**。
后者才是我们真正要的，所以 `scripts/lighthouse-themes.mjs` 里
`SEO_OPT_OUT` 把搜索页的 SEO 项摘掉，并在表里标注「（豁免）」。

不是放宽阈值（那会连带放过真的回归），是把这一项**换成更准确的形式**守住：
`check-seo.mjs` 的 `checkRobots()` 直接断言 `/search/` 被屏蔽，
`negative-check.sh` 第 46 条确认删掉那条 Disallow 会让测试变红。

---

## 四、结构化数据（JSON-LD）

### @type 按页面类型分派

| 页面 | @type |
| --- | --- |
| 文章页 | `BlogPosting`（+ `BreadcrumbList`） |
| 首页 | `Blog` |
| 标签页 / 分类页 / 归档 | `CollectionPage` |
| 关于页 | `AboutPage` |
| 其余（含 404） | `WebPage` |

未知类型**退到 `WebPage`**，而不是硬套一个错的 `@type` ——
错误的 `@type` 会让富媒体结果整个失效，而 `WebPage` 只是没有增强。

### 字段从真实数据生成，不编造

- 没有封面图 → **不输出** `image`。空 `og:image` 会让部分平台抓到一张白图，
  比没有更糟。
- 站点没有 logo → `publisher` 不带 `logo` 节点。空 `url` 会被校验器判为错误。
- 作者名取自 `post.author` → `site.author` → `'Anonymous'`。

### 必须用 JSON.stringify

手拼字符串的 JSON-LD 在标题带引号或 `</script>` 时会直接变成语法错误。
这类错误的典型场景：写「如何防 XSS」的文章，正文里就有 `</script>`。

```js
// jsonLdSafe：< 转成 \u003c，既是合法 JSON 也无法提前闭合标签
JSON.stringify(data).replace(/</g, '\\u003c')
```

顺带处理 U+2028 / U+2029 —— 它们在 JSON 里合法，但在 JS 里是换行。

**测试用真 `JSON.parse`，不用正则。**
正则「看着像 JSON」的东西里，一个未转义的引号就能让它整体失效。

---

## 五、Open Graph / Twitter Card

每页输出：

```
og:type  og:title  og:description  og:url  og:site_name  og:locale
twitter:card  twitter:title  twitter:description
```

文章页额外：`article:published_time` / `article:modified_time` / `article:tag`（每个标签一条）。

`og:url` 必须等于 `canonical`（`check-seo.mjs` 会断言）。
不一致会让社交平台与搜索引擎对「这页的正式地址」产生分歧。

`twitter:card` 有图时 `summary_large_image`，无图时 `summary`。

---

## 六、canonical 与分页

每页恰好一个 `<link rel="canonical">`，绝对地址。

分页输出 `rel="prev"` / `rel="next"`，且**用绝对地址** ——
相对地址在 `/page/2.html` 这种目录下会解析错。

分页首页的 canonical 指向 `/`，与首页重复，所以 sitemap 里会去重。

---

## 七、页面级约定

### 每页只有一个 `<h1>`

主标题由布局输出（文章页是 `post.title`，首页是站点标题，关于页来自 `ABOUT.md`）。

**正文里的一级标题会被降级为 `h2`**（`renderMarkdown` 的 `demoteH1`，默认开）。

两个理由：

1. 一页两个 `<h1>` → 搜索引擎无法判断哪个是页面主题，
   无障碍工具会把文档大纲读成两棵树。
2. 笔记类内容经常在正文里重写一遍标题（front-matter 里已经有），
   用户会看到同一个标题印两遍。

降级而不是删除：正文里的一级标题是作者明确的层级意图，删掉会丢信息。

**例外：关于页。** `ABOUT.md` 的 h1 **就是**这一页的主标题，
所以 `renderAbout` 用 `demoteH1: false` 渲染，再把它提成页面标题
（`extractAboutTitle`）。否则页面主标题会变成布局里写死的「关于」，
而作者写的那句被降成 h2 印在正文里。

### 外链一律 `rel="noopener noreferrer"`

- `noopener` —— 关掉 `window.opener` 这条跨域改写本站标签页的路径
- `noreferrer` —— 不把本站 URL 当 Referer 送给第三方

站内链接（相对路径 / 同源绝对地址）不加：加上会让分析工具丢掉来源，
而站内本来没有这两个风险。

### 图片 alt 有兜底，但会被标出来

`alt` 是图片搜索的唯一入口，也是屏幕阅读器用户的唯一信息来源。

- 作者写了 `alt` → 原样保留
- 没写 → 从文件名推导（`cover-photo.jpg` → `cover photo`），
  并加 `data-alt-inferred="true"`

为什么要标记：**推导出来的 alt 不等于作者写的 alt**。
`check-seo.mjs` 会把它算成「待补」而不是「已填」。
悄悄替作者编一个 alt 然后给自己打勾，是自欺。

### 首屏图片不懒加载

第一张图给 `loading="eager"` + `fetchpriority="high"`。
首屏图通常就是 LCP 那张，给它 `loading="lazy"` 会让「最快内容绘制」反而更慢。

---

## 八、SEO 自检

```bash
node scripts/check-seo.mjs            # 4 套主题全查
node scripts/check-seo.mjs aurora     # 只查一套
node scripts/check-seo.mjs --dist examples/minimal/dist  # 只查一个产物目录
```

检查项：

**A. `<head>` 完整性**
- 每页恰好 1 个 `<title>` / `description` / `canonical`
- `<title>` 非空，`description` ≤ 200 字符
- `canonical` 是绝对地址
- 每页恰好 1 个 `<h1>`（404 除外）
- `<html lang>` 存在

**B. Open Graph / Twitter**
- 6 个基础 OG 标签各恰好 1 个且非空
- `og:url == canonical`
- `twitter:card` 取值合法
- `og:image` 是绝对地址

**C. JSON-LD**
- 用真 `JSON.parse` 解析（不是正则扫一眼）
- `@context` 是 schema.org
- 每个节点有 `@type`
- `BlogPosting` 有 `headline` / `datePublished` / `author` / `mainEntityOfPage`
- `BreadcrumbList` 至少 2 项，`position` 从 1 递增

**D. 外链安全** —— 所有跨域链接有 `rel="noopener noreferrer"`

**E. 图片** —— 每张图有 `alt`；统计推导出来的数量

**F. sitemap**
- XML 声明 + 正确命名空间
- `<loc>` 绝对地址、无重复、≤ 50000 条
- 子元素顺序符合 XSD
- `priority` / `changefreq` 取值合法
- `lastmod` 是 W3C 日期且不是未来
- **每个 `<loc>` 都有对应产物**，且没有 `noindex` 页面混进来

**G. robots.txt**
- `User-agent: *` + `Allow: /`
- 三条内置屏蔽都在
- 恰好 1 条 `Sitemap:`，地址合法

---

## 九、配置

```js
seo: {
  sitemap: true,          // 产出 sitemap.xml
  robots: true,           // 产出 robots.txt；也可传对象追加规则
  openGraph: true,        // OG / Twitter 标签
  structuredData: true,   // JSON-LD
  canonical: true,        // <link rel="canonical">
  defaultImage: '/assets/og-default.png',  // 文章无 cover 时的兜底社交图
  authorUrl: 'https://docs.asoe.cn',       // 结构化数据里的 author.url
}
```

默认**全开** —— 「被搜索引擎找到」是博客的默认期待，不是需要额外开启的功能。

`structuredData: false` 时页面不再输出 JSON-LD，但 canonical / OG 不受影响
（开关是分项的，不是一刀切）。

---

## 十、防线

`scripts/e2e/negative-check.sh` 里 13 条：

| # | 防线 | 削弱方式 |
| --- | --- | --- |
| 42 | JSON-LD 走 stringify | 改成手拼字符串 |
| 43 | JSON-LD 可解析 | 输出坏 JSON |
| 44 | sitemap 元素顺序 | 把 loc 提前 |
| 45 | sitemap XML 转义 | escapeHtml 直通 |
| 46 | robots 屏蔽搜索页 | 删掉 Disallow |
| 47 | 404 noindex | 判断恒假 |
| 48 | canonical 唯一 | partial 里加第二个 |
| 49 | 正文 h1 降级 | 关掉 demoteH1 |
| 50 | 外链 rel | 不再加 rel |
| 51 | 首屏图 eager | 改成全部 lazy |
| 52 | 图片 alt 兜底 | 改回空 alt |
| 53 | 关于页标题取正文 | 不提取 |
| 54 | sitemap 与产物一致 | 不过滤 noindex |

每条都验证「削弱后测试真的变红」。

第 53 条有个值得记下来的教训：它最初写的是「不提取 h1 就会有两个主标题」，
但削弱之后测试**仍然全绿** —— 因为正文 h1 已经被降级成 h2，
「两个 h1」那个断言是靠降级守住的，跟提取无关。
**一条削弱之后不会红的负向验证，本身就是在自欺。**
改成断言「关于页主标题等于 ABOUT.md 的一级标题」之后才真的守住了。

---

## 十一、复现

```bash
npm test                                  # 1157 个单测
node scripts/check-seo.mjs                # SEO 自检（4 套主题）
node scripts/e2e/theme.mjs                # 28 项主题 e2e
node scripts/e2e/search.mjs               # 12 项搜索 e2e
node scripts/e2e/search-page.mjs          # 134 项搜索页 e2e
node scripts/e2e/feed.mjs                 # 88 项 feed e2e
bash scripts/e2e/negative-check.sh        # 54 条负向验证
node scripts/lighthouse-themes.mjs        # 40 项 Lighthouse
```
