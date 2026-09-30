# 插件开发

插件是一个默认导出对象的 ESM 模块。整个契约就是一个 `name` 加上若干可选钩子。

## 最小插件

```javascript
export default {
  name: 'my-plugin',
  version: '1.0.0',

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
plugins: ['./plugins/my-plugin.js']
```

## 生命周期钩子

| 钩子 | 时机 | ctx 内容 |
| --- | --- | --- |
| `onContentLoad` | 内容读取、Markdown 渲染完之后 | `{ config, posts, site }` |
| `onBeforeRender` | 布局渲染完、写盘之前 | `{ config, pages, posts, site }` |
| `onAfterRender` | 全部产物写完之后 | `{ config, cwd, outDir }` |
| `onBuildComplete` | 与 `onAfterRender` 同阶段 | `{ config, cwd, outDir }` |

钩子串行执行，按 `plugins` 数组顺序。

```javascript
export default {
  name: 'timeline',
  hooks: {
    async onContentLoad(ctx, options) {
      // options 来自配置里的 [名称, { ... }]
      const extra = options?.limit ?? 10;
      ctx.posts.sort((a, b) => new Date(b.date) - new Date(a.date));
    },
  },
};
```

## 其它能力

```javascript
export default {
  name: 'with-pages',
  version: '1.0.0',

  // 额外页面：复用主题已有布局，只提供数据。
  // layout 必须是主题 layouts/ 里存在的名字，否则该页面渲染失败。
  pages: [
    {
      path: '/timeline.html',
      layout: 'archive',       // 复用归档页布局
      title: '时间线',
      description: '按时间排列的全部文章',
      data: { groups: [] },    // 布局需要的额外变量
    },
  ],
};
```

## 错误处理约定

插件加载失败、或钩子执行中抛错，都只会打印一条警告并跳过该插件，
构建继续完成。这是刻意的设计：

> 可选能力不应该成为构建的必要条件。

如果你写的插件提供的是站点必需的功能，请在文档里说明，
并让插件在自己的钩子里抛错 —— 但那仍然只影响它自己。

## 调试

```bash
EMEEEK_DEBUG=1 node packages/cli/bin/emeeek.js build
```

`doctor` 会列出加载成功的插件：

```
✔ 已加载 1 个插件：reading-stats
```

## 参考实现

`examples/full-featured/plugins/reading-stats.js` —— 20 行，计算中英混排
文章的字数与阅读时长，可直接作为起点。
