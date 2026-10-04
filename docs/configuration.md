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
| `lazyLoading` | `true` | 图片加 `loading="lazy"` |
| `criticalCSS` | `true` | CSS 小于 24 KB 时内联进 `<head>`，否则外链 |

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

`deploy.target` 目前只用于配置校验与文档提示，实际部署由 CI 或你的托管平台完成。

## 校验

配置在构建前会做一次校验，错误会一次性列全：

```
配置校验失败：
  - site.url: 必须是以 http(s):// 开头的完整地址
  - feed.limit: 必须是正整数
```

先用 `emeeek doctor` 自检，能省掉大部分试错。
