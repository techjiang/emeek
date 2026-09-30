# Emeek

> Extra-ordinary Meek —— 一个用 Markdown 写文章、一条命令构建、零成本部署的知识站引擎。

Emeek 继承 [Gmeek](https://github.com/Meekdai/Gmeek) 的三根支柱：

- **内容即 Issue 或 Markdown** —— GitHub 就是 CMS
- **构建即一条命令** —— `emeeek build`
- **部署即一片静态文件** —— 没有服务器，没有数据库

## 3 分钟跑起来

```bash
# 1. 初始化（生成配置 + 两篇示例文章）
npx emeeek init my-blog
cd my-blog

# 2. 本地预览（保存即重建）
npx emeeek dev
# → http://localhost:3000

# 3. 构建产物
npx emeeek build
# → dist/ 丢到任意静态托管即可
```

不需要配置文件也能构建 —— 所有配置项都有默认值。

## 实测性能

`examples/minimal` 构建产物，Chromium headless + Lighthouse 13.5：

| 页面 | Performance | Accessibility | Best Practices | SEO |
| --- | --- | --- | --- | --- |
| 首页 | 100 | 100 | 100 | 100 |
| 文章页 | 100 | 100 | 100 | 100 |
| 归档 / 标签 / 关于 / 404 | 100 | 100 | 100 | 100 |

单个 HTML 17–23 KB（含内联 CSS 与 JS），**零外部网络请求**。
复现：`node scripts/lighthouse.mjs`

## 用 GitHub Issues 当 CMS

改一行配置，文章就来自 Issue 了：

```javascript
// emeeek.config.js
export default {
  site: { title: '我的博客', url: 'https://yourname.github.io' },
  content: {
    source: 'github-issues',
    repo: 'yourname/yourname.github.io',
    labels: { publish: 'publish', draft: 'draft', pin: 'pin' },
  },
};
```

然后在 `.github/workflows/` 里放上 `build.yml`（仓库里已提供），
在 GitHub 上开 Issue、打上 `publish` 标签，Actions 自动构建并发布到 Pages。

## 写文章

```bash
npx emeeek new "文章标题"
# → posts/2024-04-01-文章标题.md（默认 draft: true）
```

front-matter 字段：

```yaml
---
title: 文章标题
date: 2024-04-01
tags: [标签一, 标签二]
description: 列表页摘要与 SEO 描述
draft: false     # true 则构建时跳过
pinned: false    # true 则置顶
cover: /x.png    # 社交卡片图
lang: zh-CN      # 多语言站点用
slug: custom-url # 自定义 URL
---
```

正文里可以用 `[[文章标题]]` 或 `[[文章标题|显示文字]]` 建立双向链接，
构建期会解析成真实链接，文末还会显示「被引用 N 次」。

## Markdown 能力

自研零依赖渲染器，支持：

表格（含对齐）· 任务列表 · 脚注（带回跳）· 代码高亮（构建期完成）·
引用块 · 有序/嵌套列表 · 双向链接 · 锚点与目录 · 图片懒加载

## 命令

| 命令 | 作用 |
| --- | --- |
| `emeeek init [dir]` | 初始化项目 |
| `emeeek build` | 构建到 `dist/` |
| `emeeek dev [--port 3000]` | 本地预览 + 文件监听 |
| `emeeek new "标题"` | 新建文章 |
| `emeeek doctor` | 诊断环境、配置、主题、连通性 |
| `emeeek clean` | 清理产物 |

## 项目结构

```
packages/
  core/            引擎：内容管线 / 渲染 / 主题 / 插件
  cli/             命令行
  theme-minimal/   默认主题
examples/
  minimal/         最小示例（本地 Markdown）
  full-featured/   全功能示例（hybrid 源 + 插件）
docs/              配置、主题、插件、性能文档
```

## 文档

- [配置参考](docs/configuration.md)
- [主题开发](docs/themes.md)
- [插件开发](docs/plugins.md)
- [性能基线](docs/performance.md)

## 开发

仓库是 pnpm workspace（`packages/*`）。克隆后先装依赖：

```bash
pnpm install

pnpm test          # 120 个测试
pnpm coverage      # 测试 + 覆盖率报告
pnpm build         # 构建 examples/minimal
pnpm dev           # 本地预览示例站
pnpm lighthouse    # 性能基线（需本机有 Chromium）
pnpm doctor        # 诊断示例站配置
```

也可以直接用 node 调用 CLI 源码，不需要全局安装：

```bash
node packages/cli/bin/emeeek.js build --cwd <项目目录>
```

当前状态：121 个测试全绿，行覆盖率 90%，Lighthouse 四类全 100（8 种页面）。

## Phase 现状

这是 **Phase 1（核心基础）** 的交付：monorepo、内容管线、默认主题、
CLI、Actions 工作流、SEO 产物、测试与性能基线。

编辑器（Emeek Studio）、AI 模块、主题市场、知识图谱、分析面板
按路线图属于 Phase 2–4，尚未实现 —— 本仓库不对未完成的能力做描述。

## License

MIT
