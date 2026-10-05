# 配置参考

配置文件放在项目根目录，命名 `emeeek.config.js`（也支持 `.mjs` / `.json`），
默认导出配置对象。也可以用 `EMEEEK_CONFIG=/path/to/config.js` 指定其它路径。

**所有配置项都有默认值。** 没有配置文件时构建照常进行。

## site

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `title` | `我的知识宇宙` | 站点标题 |
| `description` | `Emeek 驱动的个人博客` | 站点描述，用于 SEO 与 RSS |
| `url` | `https://example.com` | 站点完整地址，**结尾不要带 `/`** |
| `author` | `Anonymous` | 作者名 |
| `language` | `zh-CN` | 站点语言，写入 `<html lang>` |
| `perPage` | `10` | 首页每页文章数 |

`url` 会写进 sitemap、RSS 与 canonical 链接，务必改成真实域名，
否则搜索引擎收录到的会是 `example.com`。

## content

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `source` | `local` | `local` / `github-issues` / `hybrid` |
| `repo` | 空 | `owner/repo`，非 local 源时必填 |
| `labels.publish` | `publish` | 带此标签的 Issue 才发布 |
| `labels.draft` | `draft` | 带此标签的 Issue 强制排除 |
| `labels.pin` | `pin` | 带此标签的 Issue 置顶 |
| `localDirs` | `['posts']` | 本地 Markdown 目录，递归扫描 |
| `allowHtml` | `false` | 是否允许正文里的原始 HTML |

### 三种内容源

- **`local`** —— 只读本地 Markdown，适合作品集、文档站
- **`github-issues`** —— 只读 Issue，Issue 就是文章，评论就是评论
- **`hybrid`** —— 两者都读，按 slug 去重，同名时 Issue 优先

`hybrid` 模式下若 GitHub 不可用（无 token、限流、仓库名错），
只告警并继续用本地内容构建。纯 `github-issues` 模式则会直接失败 ——
那时「构建成功但站点空白」比报错更糟。

### Issue 作为文章

Issue 正文开头可以写 front-matter 覆盖元数据：

```markdown
---
title: 覆盖 Issue 标题
date: 2024-04-01
tags: [自定义]
---

正文内容。
```

Issue 上除 `publish`/`draft`/`pin` 之外的标签会自动合并进文章标签。

## theme

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `name` | `minimal` | 内置名 / `themes/` 下的目录名 / 相对路径 |
| `darkMode` | `auto` | `auto`（跟随系统）/ `light` / `dark` |
| `tocMaxLevel` | `3` | 目录收录到几级标题 |

主题解析顺序：显式路径 → `themes/<name>/` → `packages/theme-<name>/` → 内置。

## search

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 是否生成索引与搜索页 |
| `fuzzy` | `true` | ≥4 字 CJK 词元的编辑距离 1 展开 |
| `maxResults` | `10` | 展示条数上限 |
| `suggest` | `8` | 输入联想条数上限 |
| `indexPath` | `'/search-index.json'` | 索引发布路径 |
| `pagePath` | `'/search/'` | 搜索页路径 |
| `gzipBudget` | `512000` | 索引 gzip 上限（字节），超了构建失败 |
| `inlineLimit` | `65536` | 索引超过这个字节就不内联进页面，改走外链 |
| `allowOverBudget` | `false` | 超预算时只告警不失败 |

索引是全静态的：构建期切词建倒排表，浏览器端查询。详见 [搜索](search.md)。

## seo

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `sitemap` | `true` | 生成 `sitemap.xml`（> 50000 条自动拆 index） |
| `robots` | `true` | 生成 `robots.txt`；对象形式可追加规则 |
| `openGraph` | `true` | 输出 og: / twitter: 标签 |
| `structuredData` | `true` | 输出 JSON-LD |
| `canonical` | `true` | 输出 `<link rel="canonical">` |
| `defaultImage` | `null` | 文章无 `cover` 时的兜底社交卡片图 |
| `authorUrl` | `null` | 结构化数据里的 `author.url` |

默认全开 —— 「被搜索引擎找到」是博客的默认期待，不是需要额外开启的功能。

每项独立开关：`structuredData: false` 只影响 JSON-LD，canonical 与 OG 照常输出。

```js
seo: {
  defaultImage: '/assets/og-default.png',
  authorUrl: 'https://docs.asoe.cn',
  robots: {
    disable: ['/drafts/', '/private/'],           // 追加 Disallow
    custom: [{ userAgent: 'BadBot', disallow: ['/'] }],
  },
}
```

`robots.txt` 里 `/search/`、`/*?q=`、`/*?page=` 三条屏蔽**不可取消**：
爬虫看到的搜索页是空壳（内容靠 JS 渲染），收录它只会产生重复内容。
详见 [SEO](seo.md)。

## feed

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 生成 `rss.xml` 与 `atom.xml` |
| `limit` | `20` | 条目上限 |
| `fullContent` | `false` | 是否输出正文全文（否则只发摘要） |
| `categories` | `[]` | 只要这些分类（空 = 全部） |

同时产出 RSS 2.0 与 Atom 1.0。详见 [Feed](feed.md)。

## perf

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `lazyLoading` | `true` | 首屏之外的图片加 `loading="lazy"` |
| `criticalCSS` | `true` | 主题 CSS 内联进 `<head>`；超预算的走外链 |
| `criticalCssLimit` | `24576` | **累计**内联上限（字节）。判据是总量，不是单文件 |
| `prefetch` | `true` | 预取下一篇可能读的文章（只做文章页） |
| `preconnect` | `true` | 站内 origin 的预连接 |
| `responsiveImages` | `false` | 生成 `srcset`。**需要你提供候选集**（见下） |
| `imageVariants` | `{}` | 已知的图片候选宽度，见下 |

### 内联预算是累计的

3 个 20 KB 的文件谁都没超限，内联总量却是 60 KB ——
而首屏 HTML 的膨胀来自总量，不是来自某一个文件。所以按累计字节判断。

超限时按**用途优先级**踢文件（`main.*` → 其余 → `search.*`），
不按文件名顺序 —— 按字母序是 comments → main → search，
于是超限时被踢出去的是排在后面的，结果变成「首屏要的 main.css 走外链，
只在搜索页用的 search.css 被内联」，与关键 CSS 的目的正好相反。

### 响应式图片需要你提供候选集

```javascript
perf: {
  responsiveImages: true,
  imageVariants: {
    '/assets/cover.png': [{ width: 400 }, { width: 800 }],
    '/assets/photo.jpg': [
      { width: 400, url: '/assets/photo-400.webp' },   // 也可以显式给地址
      { width: 1200, url: '/assets/photo-1200.webp' },
    ],
  },
},
```

**只写你确实生成了的尺寸。** `srcset` 里出现的每个地址都会被浏览器请求 ——
假 `srcset` 比没有 `srcset` 更糟，它把「一张图能显示」换成了
「可能一张都显示不出来」。

生成候选集超出本引擎范围（重编码需要 sharp 这类原生依赖，
与核心包零依赖冲突）。这是「不做的事就不写进产物」的落点。

## comments

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `provider` | `none` | `github-issues` / `none` |
| `repo` | 跟随 `content.repo` | `owner/repo` |
| `limit` | `50` | 评论条数上限 |
| `reactions` | `true` | 显示 👍 / ❤️ 等 reaction |

评论在**运行时**从 GitHub Issues API 取（匿名可读，限流 60 次/小时/IP）。
内容在构建期不烘死 —— 来一条新评论不该要重建整站。

不带 token 是刻意的：任何写进静态产物的 token 都是公开的。

本地 Markdown 文章用 front-matter 的 `issue:` 挂到某个 Issue 上：

```yaml
---
title: 标题
issue: 42
---
```

详见 [评论系统](comments.md)。

## pwa

**默认关闭。** Service Worker 是本仓库里唯一一个「装上之后还会继续影响
后续访问」的东西 —— 页面上的 bug 刷新就没了，SW 的 bug 会让读者看到
昨天甚至上周的页面，而我们修了也没用。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 产出 manifest / sw.js / offline.html |
| `themeColor` | `#ffffff` | 写进 manifest 与 `<meta name="theme-color">` |
| `backgroundColor` | `#ffffff` | 启动画面背景 |
| `display` | `standalone` | `standalone` / `minimal-ui` / `browser` / `fullscreen` |
| `icons` | `{}` | `{ "192": "/assets/i192.png", "512": "...", maskable: "..." }` |
| `precachePosts` | `5` | 预缓存的文章篇数 |
| `offlinePath` | `/offline.html` | 离线回落页 |
| `installPrompt` | `false` | 安装提示横幅 |

`icons` **只声明确实存在的档位** —— manifest 里声明的每个图标都会在
安装时被下载并校验，缺一个就是安装失败，而失败信息在控制台里很不显眼。

详见 [PWA](pwa.md)。

## reading

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `theme.tocMaxLevel` | `3` | 目录收录到几级标题 |
| `theme.tocMinItems` | `3` | 少于此章节数就不给目录与进度条 |

目录的落位（侧栏 / 正文上方 / 不给）由引擎根据布局决定，
不在这里配 —— 见 [长文导航](reading.md)。

## reading（阅读统计显示）

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `reading.showTime` | `true` | 阅读时间徽章 |
| `reading.showDate` | `true` | 发布日期（有 `updated` 且不同时显示「更新于」） |
| `reading.showComments` | `true` | 评论数徽章（**只在有数据源时出现**，local 源没有 → 不显示） |
| `reading.wordsPerMinute` | `400` | 阅读时长口径（中文速度）。与 AI 模块的估算共用这一处 |

评论数「没有数据源时不显示」而不是显示 0 —— 见 [长文导航 · 阅读统计显示](reading.md#六阅读统计显示p3-4b-rest-d1)。

## share（社交分享）

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `share.enabled` | `false` | 总开关。默认关 —— 要不要让别人分享是作者的偏好 |
| `share.platforms` | `['twitter','weibo','copy']` | 要出现哪些平台。未知名字会告警（不静默丢弃） |
| `share.position` | `'bottom'` | `bottom` / `sidebar` / `both` |
| `share.utm_source` | `'emeek'` | 拼进分享地址的 UTM。设 `null` 去掉 |
| `share.utm_medium` | `'social'` | 同上 |
| `share.utm_campaign` | `null` | 同上 |
| `share.label` | `'分享'` | 按钮组前的文字 |

全部按钮都是构建期算好的 `<a>` —— 零第三方 JS、零 SDK。
见 [社交分享](share.md)。

## workflow（内容工作流）

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `workflow.validate` | `'warn'` | `off` / `warn`（逐条告警，构建继续）/ `error`（让构建失败） |
| `workflow.checks` | `[]` | 要跑哪些检查，空 = 全部：`title` / `date` / `links` / `markdown` / `taxonomy` / `internal-links` |
| `workflow.schedule.enabled` | `true` | 定时发布：`date` 在未来的文章不进产物 |
| `workflow.schedule.graceHours` | `0` | **推迟**小时数：`date + graceHours` 才算到点 |

草稿（`draft: true`）与定时发布都不进生产构建，判定只有一处。
见 [内容工作流](workflow.md)。

## plugins

数组，元素为路径或包名，也可写成 `[名称, { 选项 }]`：

```javascript
plugins: [
  './plugins/my-plugin.js',
  ['@emeeek/plugin-gallery', { maxWidth: 800 }],
],
```

插件加载失败只打警告，不中断构建。见 [插件开发](plugins.md)。

## output / deploy

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `output.dir` | `dist` | 产物目录 |
| `deploy.target` | `github-pages` | `github-pages` / `vercel` / `netlify` / `cloudflare` / `custom` |
| `deploy.origins` | GitHub Pages + Vercel | 多源站列表，见下 |
| `deploy.healthInterval` | `5m` | 源站健康检查间隔 |

`deploy.target` 用于配置校验与文档提示，实际部署由 CI 或你的托管平台完成。

`deploy.origins` 声明「同一份产物推送到哪些入口」，配合
`emeek accelerate --fanout` 做幂等推送与故障转移：

```javascript
deploy: {
  origins: [
    { id: 'github-pages', role: 'primary' },
    { id: 'vercel', role: 'mirror' },
    { id: 'cloudflare-pages', role: 'mirror' },
  ],
}
```

## cdn（全球加速）

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `cdn.enabled` | `true` | 总开关。关掉则跳过指纹与预压缩 |
| `cdn.provider` | `null` | `cloudflare` / `aliyun` / `tencent` / `custom` |
| `cdn.fingerprint.enabled` | `true` | 资源内容哈希 |
| `cdn.compression.enabled` | `true` | 生成 `.gz` / `.br` 预压缩产物 |
| `cdn.server` | `true` | 生成 nginx / Caddy 片段 |
| `cdn.china.enabled` | `false` | 中国大陆加速 |
| `cdn.china.icp` | `false` | 加速域名是否已备案 |

> **`cdn` 段里没有 API Key，也不应该有。**
> 凭据从环境变量或 `.emeek/credentials` 读。写进配置会被构建拦住。

完整说明见 [全球加速](acceleration.md)。

## analytics（分析与统计）

**默认零追踪。** `enabled: false` 时产物里不存在任何统计 `<script>` 标签、
不存在任何探针端点的引用 —— 不是「加载了但不发」，是根本不生成。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `analytics.enabled` | **`false`** | 总开关。关闭时零统计脚本 |
| `analytics.provider` | `builtin` | `builtin` / `plausible` / `umami` / `goatcounter` / `custom` |
| `analytics.plausible.domain` | `''` | Plausible 站点域名（必填） |
| `analytics.plausible.scriptSrc` | `https://plausible.io/js/script.js` | 可指向自托管实例 |
| `analytics.umami.websiteId` | `''` | Umami 站点 ID（必填） |
| `analytics.umami.scriptSrc` | `''` | Umami 脚本地址（必填） |
| `analytics.goatcounter.code` | `''` | GoatCounter 站点 code（必填） |
| `analytics.goatcounter.scriptSrc` | `https://gc.zgo.at/count.js` | 可指向自托管实例 |
| `analytics.custom.headScript` | `''` | 注入 `</head>` 前。**会破坏零第三方请求承诺** |
| `analytics.custom.footerScript` | `''` | 注入 body 末尾。同上 |
| `analytics.builtin.trackPageViews` | `false` | 自托管 PV 探针 |
| `analytics.builtin.endpoint` | `''` | 你的收集端点（Emeek 不提供收集服务） |
| `analytics.builtin.retentionDays` | `90` | 数据保留期，进上报体由服务端裁剪 |
| `analytics.builtin.excludeAdmin` | `true` | 不统计管理员访问 |
| `analytics.statsPage.enabled` | `false` | 统计页（与 `analytics.enabled` 独立） |
| `analytics.statsPage.path` | `/stats/` | 统计页路径 |
| `analytics.statsPage.nav` | `true` | 出现在导航里 |
| `analytics.statsPage.sections` | 全部 | `totals` / `frequency` / `top` / `tags` / `heatmap` |

> `sources`（数据来源）区块**不可关闭** —— 它是统计页诚实性的落点。
> 一张不写数据来源的统计表，读者无法判断它是不是编的。

### 两个开关是分开的

- 想要统计页但不想开任何分析 → `analytics.enabled: false` + `statsPage.enabled: true`
- 想开分析但不想要公开页面 → `analytics.enabled: true` + `statsPage.enabled: false`

统计页展示的是「内容事实」（多少篇、什么时候写的），与「要不要追踪访客」是两件事。

### 没有数据源时显示「—」而不是 0

- `local` 内容源没有 Issues 互动数据 → 评论数是 `null`，页面显示 `—` + 「无数据源」
- 构建期永远算不出 PV → 浏览量恒为 `null`，对应区块整块不渲染

**`null` 与 `0` 是两个不同的东西。** 0 会被读成「确实没有」，`null` 的含义是
「没有这个数据源」。一个全 0 的图看起来像「有数据只是都是 0」——
那是误导，所以那种图我们不画。

完整说明见 [分析与统计](analytics.md)。

## 校验

配置在构建前会做一次校验，错误会一次性列全：

```
配置校验失败：
  - site.url: 必须是以 http(s):// 开头的完整地址
  - feed.limit: 必须是正整数
```

先用 `emeeek doctor` 自检，能省掉大部分试错。
