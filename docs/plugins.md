# 插件开发

插件是一个默认导出对象的 ESM 模块。整个契约是 `name` + **能力声明** + 若干可选钩子。

> **装插件 = 信任它的全部权限。**
> 这句话是真的，所以这一页的重点不是「怎么写得方便」，而是「边界在哪」。
> 在装上任何插件之前，请先读完「插件拿不到什么」那一节。

## 最小插件

```javascript
export default {
  name: 'reading-stats',
  version: '1.0.0',

  // 能力必须显式声明。没有声明就去用，钩子会被跳过（不是警告，是跳过）
  capabilities: ['content:transform'],

  hooks: {
    onContentLoad(ctx) {
      for (const post of ctx.posts) {
        post.wordCount = post.raw.replace(/\s/g, '').length;
      }
    },
  },
};
```

配置里引用：

```javascript
plugins: ['./plugins/reading-stats.js']
```

## 能力声明（manifest）

**先立规则，再写 API。** 你声明什么，才能做什么；不声明就调用 → 拒绝，
并且报错会说清「哪个插件、想干什么、缺哪个能力」：

```
插件「reading-stats」试图读取内容文件，但 manifest 里没有声明「content:read」（读取内容目录里的 Markdown）
```

| 能力 | 允许做什么 |
| --- | --- |
| `content:read` | 读内容目录里的 Markdown（路径过 `resolveProjectFile`） |
| `content:write` | 写内容目录里的 Markdown（同样过校验 + 原子替换） |
| `content:transform` | 在内容管线上改写文章数据（`onContentLoad` 需要它） |
| `render:hook` | 注册渲染钩子（`onBeforeRender` / `onAfterRender` / `onBuildComplete`） |
| `render:page` | 定义额外页面 |
| `render:helper` | 提供模板 helper |
| `ai:invoke` | 通过宿主调用 AI（**插件接触不到凭证**） |
| `cli:command` | 注册 CLI 子命令 |

声明一个不存在的能力会**直接报错**，不会静默忽略 —— 静默忽略会让你以为
自己申请到了权限，然后在运行时才发现没有。

## 插件拿不到什么

这是这一页最该读的一节。

### 1. 没有读 API Key 的接口

不是「不推荐」，是**没有这个能力值**。`key:read`、`ai:key`、`config:secret`、
`env:read` 这些名字不在能力表里 —— 你无法声明一个不存在的东西。

### 2. 传给插件的 config 里没有凭证

```javascript
hooks: {
  onContentLoad(ctx) {
    ctx.config.ai.apiKey  // undefined —— 它在进入插件之前就被剔掉了
    ctx.config.ai.model   // 'gpt-4o-mini' —— 非凭证字段照常可用
  },
}
```

剔除发生在**加载时**，不是在你访问时。所以「顺手打个日志带上 config」
也不会把 Key 写进构建日志。字段名同样不重要：长得像 Key 的字符串会被按值剔除。

### 3. 读不到项目外的文件

`readContent('../../.env')` 会被拒。校验走的是与 HTTP 入口**同一个**
`resolveProjectFile`：拒绝 NUL 字节、解析后必须在内容目录内、
**真实路径（符号链接）也要在内**。

### 4. 插件路径必须在项目内

```javascript
plugins: ['../../../tmp/evil.js']   // 加载失败：插件路径在项目外
```

## 生命周期钩子

| 钩子 | 需要的能力 | 时机 | ctx 内容 |
| --- | --- | --- | --- |
| `onContentLoad` | `content:transform` | 内容读取、Markdown 渲染完之后 | `{ config, posts, site }` |
| `onBeforeRender` | `render:hook` | 布局渲染完、写盘之前 | `{ config, pages, posts, site }` |
| `onAfterRender` | `render:hook` | 全部产物写完之后 | `{ config, cwd, outDir }` |
| `onBuildComplete` | `render:hook` | 与 `onAfterRender` 同阶段 | `{ config, cwd, outDir }` |

钩子串行执行，按 `plugins` 数组顺序。

```javascript
export default {
  name: 'timeline',
  capabilities: ['content:transform'],
  hooks: {
    async onContentLoad(ctx, options) {
      const extra = options?.limit ?? 10;
      ctx.posts.sort((a, b) => new Date(b.date) - new Date(a.date));
    },
  },
};
```

## 错误处理约定

**插件出问题，只有插件受罚。** 三条：

- 加载失败（找不到、语法错、manifest 不对）→ 跳过这个插件，构建继续
- 钩子抛错 → 跳过这个钩子，其他插件照常
- 钩子超过 **10 秒**没返回 → 跳过。挂起的 Promise 会让构建停在 99%
  而没有任何输出，那比「插件被跳过」糟得多

## 哪个更重要

> **草稿 > 插件。**

草稿保存是用户唯一不能丢的东西。任何插件的 bug 都不允许影响它 ——
所以插件不参与草稿保存链路，也拿不到编辑器的写入路径。

## 调试

```bash
EMEEEK_DEBUG=1 node packages/cli/bin/emeeek.js build
```

`doctor` 会列出加载成功的插件与被拒的插件（含原因）：

```
✔ 已加载 1 个插件：reading-stats
✘ 跳过 1 个插件：evil（申请了不允许的能力「key:read」—— 凭证访问不向插件开放）
```

## 参考实现

`examples/full-featured/plugins/reading-stats.js` —— 二十来行，计算中英混排
文章的字数与阅读时长，可直接作为起点。
