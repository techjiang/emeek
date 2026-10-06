# 内容管理

Emeek 的内容由两个概念组成：**文章**（post）与**页面**（page）。
文章进列表、feed、归档；页面是独立入口（比如「关于」）。

## 内容源

```javascript
// emeeek.config.js
export default {
  content: {
    source: 'local',            // local | github-issues | hybrid
    repo: 'yourname/yourname.github.io',
    localDirs: ['posts', 'notes'],
  },
};
```

| 源 | 内容来自 | 需要 Token |
| --- | --- | --- |
| `local` | 项目目录里的 `.md` 文件 | 否 |
| `github-issues` | 带 `publish` 标签的 Issues | 私有仓库需要 |
| `hybrid` | 两者合并，按 `date` 排序 | 同 github-issues |

## 文章：local 源

文件名约定 `YYYY-MM-DD-slug.md`（日期可被 front-matter 覆盖）：

```markdown
---
title: 文章标题
date: 2026-03-15
tags: [标签一, 标签二]
categories: [分类]
description: 列表页摘要与 SEO 描述
draft: false
pinned: false
cover: /assets/cover.png
lang: zh-CN
slug: custom-url
---

正文……
```

| 字段 | 默认 | 作用 |
| --- | --- | --- |
| `title` | 文件名 | 文章标题 |
| `date` | 文件名日期 | 发布日期（未来日期 = 定时发布） |
| `tags` | `[]` | 标签页与筛选 |
| `categories` | `[]` | 分类页 |
| `description` | 正文首段 | 列表摘要 + `<meta name="description">` |
| `draft` | `false` | `true` 则**不进任何产物** |
| `pinned` | `false` | 置顶 |
| `cover` | 无 | 社交卡片图（无则**不输出** `og:image`） |
| `lang` | 站点语言 | 多语言站点用 |
| `slug` | 从标题生成 | 自定义 URL |

## 文章：GitHub Issues 源

一条打了 `publish` 标签的 Issue = 一篇文章。

```javascript
content: {
  source: 'github-issues',
  repo: 'you/blog',
  labels: { publish: 'publish', draft: 'draft', pin: 'pin' },
}
```

正文开头可以写 front-matter 覆盖 Issue 元数据：

```markdown
---
date: 2026-03-15
tags: [补充标签]
pin: true
---

Issue 的正文就是文章正文。
```

- 带 `draft` 标签的 Issue **强制排除**，即使同时带了 `publish`
- Issue 的 label（除 `publish`/`draft`/`pin` 外）自动成为标签
- Issue 的评论可驱动评论区，见 [comments.md](comments.md)

## 草稿与定时发布

三条状态由**同一个函数** `partitionPosts` 决定：已发布 / 草稿 / 待定时。
「命令说已发布」和「产物里有它」结构上不可能分叉。

```javascript
workflow: {
  schedule: { enabled: true, graceHours: 0 },
}
```

| 状态 | 判定 | 怎么上线 |
| --- | --- | --- |
| 已发布 | `draft: false` 且 `date <= now` | 立即进产物 |
| 草稿 | `draft: true` | 改成 `false` |
| 定时 | `draft: false` 且 `date > now` | 到点后重建自动出现 |

`graceHours` 是**推迟**小时数，用来躲开时钟偏差与 CI 调度抖动：

```javascript
schedule: { enabled: true, graceHours: 2 }   // date + 2h 才算到点
```

查看当前状态：

```bash
emeek drafts
# 已发布：12 篇
# 草稿：2 篇
# 定时发布：1 篇
```

## 构建期内容校验

```javascript
workflow: {
  validate: 'warn',      // off | warn | error
  checks: [],            // 空 = 全部
}
```

检查项：`title` / `date` / `links` / `markdown` / `taxonomy` / `internal-links`。

```bash
$ emeek build
⚠ 内容校验：posts/2026-03-10-foo.md
   · 标题为空（title 字段缺失且文件名没有可用标题）
   · 站内链接 /posts/bar.html 不存在（指向 404）
```

默认 `warn` 不阻塞 —— 校验是新加的一道关，在用户还没调好内容前挡构建是越界。
但问题必须被说出来，所以不静默。

## 双向链接

正文里用 `[[文章标题]]` 或 `[[文章标题|显示文字]]`：

```markdown
参见 [[搜索系统]] 与 [[SEO 指南|搜索引擎优化]]。
```

构建期解析成真实链接，文末显示「被引用 N 次」。
标题对不上时会告警（不静默变成一个死链）。

## 页面

页面放在 `pages/` 或直接用 `localDirs` 外的独立文件，不进列表与 feed，
但有独立 URL。适合「关于」「隐私政策」这类不随时间变化的内容。

## 图片

图片放 `assets/`，正文里用绝对路径引用：

```markdown
![封面](/assets/cover.png)
```

响应式图片**默认关闭** —— 它需要你提供候选集：

```javascript
perf: {
  responsiveImages: true,
  imageVariants: {
    '/assets/cover.png': [{ width: 400 }, { width: 800 }],
  },
}
```

只写你**确实生成了**的尺寸。srcset 里出现的每个地址都会被浏览器请求，
编造一个不存在的宽度比不做响应式更糟。
