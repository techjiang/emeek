/**
 * 示例插件：给每篇文章加上「阅读时长」与「字数」。
 *
 * 展示插件契约的最小形态：一个 name、一个 hooks.onContentLoad。
 * 这同时是 docs/plugins.md 里插件开发指南的参考实现。
 */
export default {
  name: 'reading-stats',
  version: '1.0.0',
  description: '为中英混排文章计算字数与阅读时长',

  /**
   * 能力声明是必须的。
   *
   * onContentLoad 改的是 posts 数组，对应 content:transform。
   * 声明它之后钩子才会真的跑；不声明的插件会被跳过（不是警告，是跳过）——
   * 「先跑起来再补声明」是权限系统最常见的失效方式，所以这里没有那条路。
   */
  capabilities: ['content:transform'],

  hooks: {
    onContentLoad(ctx, options) {
      // options 来自配置里的 [插件名, { ... }]，这里给个默认值兜底。
      const charsPerMinute = options?.charsPerMinute ?? 500;
      for (const post of ctx.posts) {
        const plain = post.raw.replace(/```[\s\S]*?```/g, '').replace(/\s/g, '');
        post.data = { ...(post.data ?? {}), charCount: plain.length, readingMinutes: Math.max(1, Math.ceil(plain.length / charsPerMinute)) };
      }
    },
  },
};
