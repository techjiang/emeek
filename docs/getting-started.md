# 快速开始

**目标**：3 分钟内拥有一个能访问的静态知识站。

Emeek 的模型很简单 —— 你写 Markdown（或直接开 Issue），它生成一片静态文件，
丢到任何静态托管即可。没有数据库、没有服务器进程、没有构建期以外的运行时。

## 1. 安装

Emeek 是零运行时依赖的，只需 Node.js ≥ 18：

```bash
# 方式一：直接跑，不装
npx emeeek init my-blog && cd my-blog

# 方式二：全局安装
npm install -g emeeek
emeek init my-blog && cd my-blog
```

`init` 会生成：

```
my-blog/
├── emeeek.config.js      # 全部有默认值，可以先不管
├── posts/
│   ├── 2024-01-15-hello.md
│   └── 2024-02-03-markdown-syntax.md
└── .gitignore
```

## 2. 写第一篇文章

```bash
npx emeeek new "我的第一篇文章"
# → posts/2026-03-15-我的第一篇文章.md
```

生成的文件默认 `draft: true` —— 这是刻意的：**新建即草稿，想发再改**。

```markdown
---
title: 我的第一篇文章
date: 2026-03-15
tags: [入门]
draft: false
---

正文用 Markdown 写就行。支持表格、任务列表、脚注、`[[双向链接]]`。
```

把 `draft` 改成 `false`，它才会进产物。

## 3. 预览

```bash
npx emeeek dev
# → http://localhost:3000
```

保存文件即重建。想看渲染后的真实效果，也可以直接开编辑器：

```bash
npx emeeek studio
# → http://localhost:3000/studio
```

Studio 的左侧编辑、右侧预览，**预览和最终发布走的是同一个渲染函数** ——
你在编辑器里看到的就是发布后的样子。

## 4. 构建与部署

```bash
npx emeeek build      # → dist/
```

`dist/` 里就是全部网站。丢到任意静态托管：

```bash
# GitHub Pages / Cloudflare Pages / Vercel / Netlify 都行
emeek deploy --target github-pages
```

## 5. 下一步

- 想让文章来自 GitHub Issues？改一行配置：见 [配置参考](configuration.md)
- 想换主题？`emeek theme switch aurora`
- 想搞清楚每个配置项？见 [配置参考](configuration.md)
- 出问题了？先跑 `emeek doctor`

## 常见问题

**构建报「内容校验」告警怎么办？** 默认 `workflow.validate: 'warn'` 只告警不阻塞。
按提示修，或改成 `'error'` 让问题直接挡住构建。

**`dist/` 里为什么有 `.gz` 和 `.br`？** 那是预压缩产物，配合 CDN 直接发压缩字节，
省掉运行时压缩开销。静态托管会自动优先取用。

**能不用 Node.js 吗？** 构建需要 Node.js（≥18）；构建出的站点不需要 ——
它只是 HTML/CSS/JS。
