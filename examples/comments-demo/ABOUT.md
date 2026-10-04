# 关于这个演示站

这是 **Emeek** 的最小示例，用来验证从 Markdown 到静态站点的完整链路。

它演示了三件事：

1. 内容就是一个 `.md` 文件
2. 构建就是 `emeeek build`
3. 产物是纯静态文件，不需要服务器

## 内容源可以换成 GitHub Issues

把 `emeeek.config.js` 里的 `content.source` 改成 `github-issues`，
再填上 `content.repo`，站点内容就来自 Issue 了 —— 在 GitHub 上写文章，
Actions 自动构建，Pages 自动发布，全程零成本。
