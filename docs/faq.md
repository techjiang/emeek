# 常见问题

## 基础

### Emeek 和 Gmeek 是什么关系？

Emeek 继承 [Gmeek](https://github.com/Meekdai/Gmeek) 的三根支柱
（内容即 Issue、构建即一条命令、部署即一片静态文件），
在此之上补齐写入、搜索、SEO、性能、部署等整条链。详见 [关于](about.md)。

### 需要服务器吗？

不需要。产物是纯静态文件，丢到任意静态托管（GitHub Pages / Cloudflare /
Vercel / Netlify / 对象存储）即可。

### 需要数据库吗？

不需要。内容在 Markdown 文件或 GitHub Issues 里，构建期读一次。

### 需要 PHP 吗？

不需要。Emeek 是 Node.js（≥ 18）构建的。产物本身不需要任何运行时。

### 能商用吗？

可以，MIT 许可。见 [LICENSE](../LICENSE)。

## 内容

### 草稿会不会被发出去？

**不会。** `draft: true` 的文章不进任何产物 —— 不只在列表里隐藏，
是根本不生成。有 e2e 做**全产物扫描**：草稿的标题与 slug 不得出现在 `dist/` 下
任何文件（含 feed / 搜索索引 / sitemap）。

### 定时发布怎么工作？

`date` 在未来的文章构建期被过滤，等 CI 定时重建时自动出现。
与草稿是两条路：草稿要手动改，定时到点自动上。

```javascript
workflow: { schedule: { enabled: true, graceHours: 0 } }
```

### 能用本地 Markdown，也能用 Issue 吗？

能，`source: 'hybrid'` 同时读两者，按 `date` 排序合并。

### 改 URL 结构会不会断开旧链接？

改 `slug` 会。建议发布后别改，或自己加重定向。

## 隐私

### 有统计代码吗？

**默认没有。** `analytics.enabled` 默认 `false`，此时产物里**不存在**任何
统计 `<script>` 标签 —— 不是「加载了但不发」，是根本不生成。

需要统计可以：构建期推断（评论/reaction/发布时间都在 Issues 里）+ 零 JS 统计页，
或显式接 Plausible / Umami / GoatCounter。

### 有第三方 JS 吗？

默认没有。分享按钮是 `<a>` 标签，微信二维码是纯 Canvas 自绘，
统计页是内联 SVG —— **产物零外部网络请求**（可用浏览器 DevTools 的 Network 面板验证）。

## 性能

### 站点有多大？

示例站单个 HTML 17–33 KB（含内联 CSS/JS）。加上预压缩产物通常不到 1 MB。

### Lighthouse 多少分？

Performance / Accessibility / Best Practices / SEO 全 100（8 页 × 4 主题 × 2 视口）。
复现：`node scripts/lighthouse.mjs`。

### `.gz` / `.br` 是什么？

预压缩产物。静态托管会优先取用，省掉运行时压缩。

## 安全

### Token 会泄漏吗？

结构性上不会。Token 只从环境变量读，不写进配置/代码/日志/产物。
`scripts/e2e/check-no-secrets.sh` 会扫产物，`negative-check.sh` 有对应的负向验证。

### 别人提的 Issue 能有恶意内容吗？

正文只识别 `@提及` 与 `http(s)` 链接，其余全部转义。
URL 走白名单，被拒的退回纯文本。`allowHtml` 打开时仍会做一轮消毒
（剥 `script/iframe/on*` 等）—— **不存在「完全不过滤的原样输出」这个选项**。

### 评论是第三方 iframe 吗？

不是。评论由 GitHub Issues 驱动、客户端渲染，4 套主题各有各的样式 ——
不挂第三方 iframe，「零外部请求」这条约束才保得住。

## 使用

### 怎么换主题？

```bash
emeek theme switch aurora
emeek theme list
```

4 套内置：Minimal / Aurora / Inkstone / Magazine。

### 怎么建自定义主题？

```bash
emeek theme create my-theme
```

详见 [主题开发](themes.md)。

### 怎么部署到 Vercel / Netlify？

```bash
emeek deploy --target vercel
emeek deploy --target netlify
```

详见 [部署指南](deployment.md)。

### 编辑器里看到的和发布的一样吗？

**一样。** 两边调的是同一个渲染函数，有一致性测试逐节点盯着，
还有一条测试扫源码防止出现第二份渲染器。

### 能离线用吗？

能。PWA 默认关闭，打开后 Service Worker 提供离线缓存 + 断网回落页。

```javascript
pwa: { enabled: true }
```

## 排错

### 构建失败怎么办？

先跑 `emeek doctor`，再 `EMEEEK_DEBUG=1 emeeek build` 看堆栈。
见 [故障排查](troubleshooting.md)。

### Issue 没出现在站点？

见 [故障排查](troubleshooting.md#issue-没出现在站点里) —— 多半是标签不对，
或者是 GitHub 索引延迟（新建仓库/Issue 有 1~2 分钟）。
