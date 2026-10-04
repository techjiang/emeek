// PWA 演示站：同一个最小内容，但启用了完整 PWA（manifest + SW + 离线页）。
//
// 为什么要单独一个示例而不是把 pwa 打开在 examples/minimal 上：
//   examples/minimal 是**性能基线**站点，它的数字要与 docs/performance.md
//   对得上。Service Worker 注册是 load 之后跑的，会给 Lighthouse 的
//   Best Practices 引入一条「Service Worker 已注册」的检查 —— 基线站点
//   保持「没有 SW」才能让那条数字稳定可比。PWA 的验收在它自己的站点上做。
export default {
  site: {
    title: 'Emeek PWA 演示',
    description: '启用了 manifest、Service Worker 与离线页的 Emeek 站点。',
    url: 'https://pwa.emeeek.example.com',
    author: 'Emeek Demo',
    language: 'zh-CN',
  },
  content: { source: 'local', localDirs: ['posts'] },
  pwa: {
    enabled: true,
    themeColor: '#2563eb',
    backgroundColor: '#ffffff',
    // 只声明**确实存在**的图标 —— manifest 里的每个图标都会在安装时被校验。
    icons: { 192: '/assets/icon-192.svg', 512: '/assets/icon-512.svg' },
    precachePosts: 3,
  },
};
