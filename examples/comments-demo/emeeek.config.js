// 评论演示站：本地 Markdown 文章 + GitHub Issues 评论区。
//
// 为什么用 `issue:` front-matter 而不是把内容放到 Issue 里：
//   这是「本地写文章、GitHub 放评论」的组合。对不想把草稿过程
//   公开到 Issue 的人来说，这是唯一可行的方式。
export default {
  site: {
    title: 'Emeek 评论演示',
    description: '本地 Markdown 内容 + GitHub Issues 评论区。',
    url: 'https://comments.emeeek.example.com',
    author: 'Emeek Demo',
    language: 'zh-CN',
  },
  content: { source: 'local', localDirs: ['posts'] },
  comments: { provider: 'github-issues', repo: 'Meekdai/Gmeek', limit: 50 },
};
