# 部署

建完博客发不出去 = 白建。所以 Emeek 把「部署」做成一条命令：

```bash
npx emeeek deploy --target github-pages
```

它会依次：**构建 → 部署前检查 → 生成平台配置 → 推送 → 验证**，
最后打印可访问的 URL。失败时明确告诉你卡在哪一步、怎么修。

## 支持的平台

| 目标 | `--target` | 推送方式 | 幂等 |
| --- | --- | --- | --- |
| GitHub Pages | `github-pages`（`gh`） | 仓库 Actions | ✅ |
| Cloudflare Pages | `cloudflare`（`cf`） | `wrangler` | ✅ |
| Vercel | `vercel` | `vercel` CLI | ✅ |
| Netlify | `netlify` | `netlify` CLI | ✅ |
| 自托管 | `rsync`（`ssh` / `nginx` / `caddy`） | `rsync --delete` | ✅ |
| Docker | `docker` | `docker build` | ✅ |

别名表见 `packages/core/src/deploy/platforms.js`，
新增平台只需在那里加一条 —— `deploy` 命令里没有任何 `if (target === ...)`。

## 通用选项

```
--target <平台>   目标平台（默认取配置里的 deploy.target）
--preview         预览部署（不发布到生产；Vercel / Cloudflare / Netlify 支持）
--dry-run         只生成配置并预演，不推送、不联网
--no-build        跳过构建，直接用现有 dist/
--no-verify       跳过部署后的在线验证
--url <地址>      验证时用的地址（默认 site.url）
--host --path     自托管（rsync）必填
--tag <镜像名>    Docker 镜像名（默认 emeek-site:latest）
```

## GitHub Pages

```bash
npx emeeek deploy --target github-pages
```

生成 `.nojekyll`、可选 `CNAME`、`.github/workflows/deploy-pages.yml`。
本地不做 `git push`（避免污染你的提交历史）—— 把生成的 workflow 提交并推到 `main`，
Actions 会自动构建并发布。

**为什么要 `.nojekyll`**：GitHub Pages 默认用 Jekyll 处理静态文件，
会吞掉下划线开头的目录。我们不需要 Jekyll，所以直接关掉。

自定义域名：在配置里写 `deploy.customDomain`，会生成 `CNAME`。

```javascript
export default {
  site: { url: 'https://blog.example.com' },
  deploy: { target: 'github-pages', customDomain: 'blog.example.com' },
};
```

## Cloudflare Pages

```bash
npx emeeek deploy --target cloudflare
```

生成 `wrangler.toml`、`public/_headers`、`public/_redirects`。
首次使用需要 `npx wrangler login`；CI 里用 `CLOUDFLARE_API_TOKEN`。

## Vercel

```bash
npx emeeek deploy --target vercel          # 生产
npx emeeek deploy --target vercel --preview # 预览
```

生成 `vercel.json`（构建命令、输出目录、缓存头）。
CI 里需要 `VERCEL_TOKEN` / `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID`。

## Netlify

```bash
npx emeeek deploy --target netlify
```

生成 `netlify.toml`、`public/_headers`、`public/_redirects`。
CI 里需要 `NETLIFY_AUTH_TOKEN` / `NETLIFY_SITE_ID`。

## 自托管

```bash
npx emeeek deploy --target rsync --host root@1.2.3.4 --path /var/www/blog
```

生成 `deploy/nginx.conf`、`deploy/Caddyfile`、`deploy/deploy-rsync.sh`。

**幂等**：rsync 用 `--delete`，让远端与 `dist/` 完全一致 ——
重复部署不会残留已删除的旧页面。漏删比漏传更隐蔽。

- **SSL 自动化**：Caddy 自动申请与续期证书；nginx 配 `certbot`。
- **gzip**：nginx 模板已开启 `gzip on`，静态产物压缩后传输。

## Docker

```bash
npx emeeek deploy --target docker --tag myblog:v1
docker run -p 8080:80 myblog:v1
```

多阶段构建：`node:20-alpine` 构建 → `nginx:alpine` 运行。运行镜像里没有 `node_modules`，
通常在 30MB 量级。带 `HEALTHCHECK`。

## 部署前检查

推送之前，`deploy` 会逐条检查产物（`packages/core/src/deploy/preflight.js`）：

- 首页 / 404 / sitemap / RSS / robots 是否存在
- 搜索索引（`search.enabled` 为 true 时）
- `site.url` 是否还是 `example.com` 占位
- `posts/` 下是否至少有一篇文章

**任何一条不过就中止，产物不推送。** 这些是部署后才暴露、而本地看不出来的典型问题。

## 部署后验证

推送成功后，`deploy` 会探测首页 / sitemap / RSS，
并且**不只看 HTTP 200，还看内容**：

```javascript
{ path: '/sitemap.xml', expect: (body) => /<urlset/i.test(body) }
```

为什么：静态托管在「找不到页面」时常回落到 `404.html` 但返回 200。
只看状态码会把这种静默 404 当成成功。

自定义探针：

```javascript
export default {
  deploy: {
    probes: [
      { path: '/', label: '首页' },
      { path: '/tags.html', label: '标签页' },
    ],
  },
};
```

## 失败时会发生什么

| 阶段 | 失败表现 | 修复建议 |
| --- | --- | --- |
| 构建 | 配置 / Markdown 报错 | 按提示修，或先跑 `emeeek doctor` |
| 部署前检查 | 逐条列出不过的项 | 每条都带「怎么修」 |
| 推送 | 平台 CLI 非零退出 | 命令里带重试方式；常见原因是未登录 / 缺令牌 |
| 验证 | 逐条列出不可访问的页面 | CDN 可能延迟 1-2 分钟；持续失败查解析与部署日志 |

## 配置项

```javascript
export default {
  deploy: {
    target: 'github-pages',   // 默认目标
    customDomain: '',         // 自定义域名（GitHub Pages 生成 CNAME）
    verify: true,             // 是否做部署后在线验证
    probes: [],               // 自定义验证路径，留空用平台默认
  },
};
```

## CI/CD

仓库自带两条工作流：

- `.github/workflows/ci.yml` —— 单测 + 覆盖率 + 构建 + **各平台部署预演**
- `.github/workflows/deploy.yml` —— 部署模块自测 + 预演不留痕

「部署工具自己没被测试过，就不该让用户拿它去发布自己的站点。」
