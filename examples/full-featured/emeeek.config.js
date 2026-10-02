// 全功能示例 —— 展示 Emeek 的全部配置面
// 每一项都有默认值，删掉任意一行都能继续工作。
export default {
  site: {
    title: '我的知识宇宙',
    description: '用 GitHub Issues 写文章，Actions 自动构建，Pages 零成本发布。',
    url: 'https://yourname.github.io',
    author: 'Your Name',
    language: 'zh-CN',
    perPage: 8, // 首页每页文章数
  },

  content: {
    // 内容源：local | github-issues | hybrid
    // hybrid 会同时读取本地 Markdown 与带 publish 标签的 Issue
    source: 'hybrid',
    repo: 'yourname/yourname.github.io',
    labels: {
      publish: 'publish', // 只有带这个标签的 Issue 才会发布
      draft: 'draft',     // 带这个标签的 Issue 强制排除
      pin: 'pin',         // 带这个标签的 Issue 置顶
    },
    localDirs: ['posts', 'notes'],
  },

  theme: {
    name: 'minimal',
    darkMode: 'auto', // auto 跟随系统 | light | dark
    tocMaxLevel: 3,   // 目录收录到几级标题
  },

  search: {
    enabled: true,
    maxResults: 10,
  },

  seo: {
    sitemap: true,
    robots: true,
    openGraph: true,
    structuredData: true, // 输出 JSON-LD
  },

  feed: {
    enabled: true,
    limit: 20,
  },

  perf: {
    lazyLoading: true,
    criticalCSS: true, // CSS 体积小于 24KB 时内联进 <head>
  },

  // 插件：路径或包名都可以。加载失败只告警，不影响构建。
  plugins: [
    './plugins/reading-stats.js',
  ],

  output: {
    dir: 'dist',
  },

  deploy: {
    target: 'github-pages', // github-pages | vercel | netlify | cloudflare | custom
  },
};
