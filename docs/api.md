# API 参考

Emeek 是**构建期**引擎，不是服务端框架 —— 所以它的「API」有两层：

1. **Node API**：在 JS 里直接调构建管线（写自己的工具、CI 脚本、集成）
2. **浏览器 API**：产物里注入的运行时接口（搜索、主题切换）

## Node API

从包导入：

```javascript
import { build, loadConfig, loadTheme, logger } from '@emeeek/core';
```

### `build(options)`

跑完整构建。

```javascript
import { build } from '@emeeek/core';

await build({
  cwd: '/path/to/site',        // 项目目录
  config: {/* 覆盖配置 */},     // 可选
  token: process.env.GITHUB_TOKEN,
  onProgress: (msg) => console.log(msg),
});
```

返回构建清单：

```javascript
{
  posts: 3,
  pages: 15,
  files: [ { path: 'index.html', bytes: 17432 }, … ],
  totalBytes: 532480,
}
```

### 内容源

```javascript
import { loadGithubIssues } from '@emeeek/core/pipeline';

const posts = await loadGithubIssues(config, {
  fetchImpl: globalThis.fetch,          // 可注入，方便测试
  token: process.env.GITHUB_TOKEN,
});
```

每个 post 的结构：

```javascript
{
  id: 'issue:42',
  issueNumber: 42,
  slug: 'issue-42-hello',
  title: '你好',
  date: '2026-03-15T00:00:00.000Z',
  updated: '2026-03-16T…',
  author: 'techjiang',
  lang: null,
  tags: ['公告'],
  categories: [],
  description: null,
  draft: false,
  pinned: false,
  cover: null,
  raw: '正文 Markdown…',
  url: 'https://github.com/you/blog/issues/42',
  source: 'github-issues',
}
```

### 渲染

```javascript
import { renderMarkdown } from '@emeeek/core/markdown';

const { html, toc } = renderMarkdown('# 标题\n\n正文', { tocMaxLevel: 3 });
```

### 配置

```javascript
import { loadConfig, defaultConfig } from '@emeeek/core/config';

const config = await loadConfig('/path/to/site');
```

所有配置项都有默认值 —— 配置文件可以只写要改的那几行。

## 浏览器 API

产物注入的接口都在 `window.__emeeek` 命名空间下（仅必要模块）。

### 搜索

```javascript
// 产物里的搜索页会用到；你也可以自己接
const index = await fetch('/search-index.json').then((r) => r.json());
const { createSearchSession } = window.__emeeek.search;

const session = createSearchSession(index);
const results = session.query('静态站点', { maxResults: 10 });
// → [{ url: '/posts/hello.html', title: '你好', score: 12.4 }, …]
```

搜索索引在构建期生成，运行时零后端。三类词元（CJK 单字 / bigram / 拉丁词），
策略链逐级放宽。索引体积有 gzip 预算门禁（默认 512 KB）。

### 主题切换

打开 `theme.switcher` 后，产物里会注入运行时切换：

```javascript
theme: {
  switcher: {
    themes: [
      { name: 'aurora', label: '极光', url: '/aurora/' },
      { name: 'minimal', label: '极简', url: '/' },
    ],
  },
}
```

每个 `url` 必须是**真实存在的另一套主题产物**。没有 url 的主题以灰态列出，
而不是给一个点了没反应的链接。

## 插件 API

插件通过钩子接入构建管线：

```javascript
// plugins/my-plugin.js
export default {
  name: 'my-plugin',
  capabilities: ['content:read', 'content:write'],   // 必须显式声明
  hooks: {
    onContentLoad(post) {
      return { ...post, tags: [...post.tags, '来自插件'] };
    },
  },
};
```

`capabilities` 未声明即跳过钩子（`doctor` 会报原因）。
凭证访问**不在能力表里** —— 名字 `key:read` / `env:read` 不存在，所以无法声明。
不靠审核，靠不存在。

详见 [插件开发](plugins.md)。

## 稳定性承诺

- **产物格式**：搜索索引有版本号（`INDEX_VERSION`），解析时校验，不匹配即报错而非猜
- **配置**：所有字段只增不改语义；废弃字段会先告警一个版本再移除
- **Node API**：标 `export` 的函数是公开面；内部路径（`src/` 下深层文件）不保证稳定
