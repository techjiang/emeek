# 全球加速

Emeek 的加速不是「锦上添花」——GitHub Pages 在中国大陆经常打不开。
这一章讲清楚：默认加速做了什么、CDN 怎么接、中国大陆怎么专治。

## 默认就有的加速（不用配任何东西）

构建即生效，不依赖任何外部服务：

| 机制 | 做什么 | 产出 |
| --- | --- | --- |
| 资源指纹 | `theme.css` → `theme.a1b2c3d4.css` | 内容变则文件名变 |
| 长缓存策略 | 带指纹的资源发 `immutable` | 浏览器/CDN 一年不回源 |
| 预压缩 | 生成 `.gz` 与 `.br` 变体 | Nginx `gzip_static on` 直接发 |
| HTML 改写 | 引用自动指向指纹文件 | 无需手工维护 |
| 缓存头清单 | `dist/acceleration.json` | 静态托管的缓存规则来源 |
| 服务器片段 | `dist/server/nginx.conf`、`Caddyfile` | 复制即用 |

构建日志会给出数字：

```
ℹ 加速：17 个资源已指纹 · 预压缩 27 个文件（gzip 67% 节省 / brotli 74% 节省）
```

### 为什么 HTML 不指纹

HTML 是**稳定入口**。用户收藏的是 `/posts/hello.html`，分享出去的也是它。
给它加指纹等于每次改文章都换一次 URL——收藏全失效。

所以 HTML 用短缓存 + `stale-while-revalidate`：

```http
Cache-Control: public, max-age=300, stale-while-revalidate=3600
```

- 5 分钟内命中缓存，不发请求
- 之后 1 小时内先发旧版本、后台回源，用户永远不等
- 新文章最多 5 分钟可见（实际通常更快，因为回源会在后台完成）

### 为什么搜索索引不缓存

`search-index.json` 是「稳定 URL、内容会变」的典型。
缓存久了，用户搜不到刚发的文章——这种 bug 最难排查，因为功能「没坏」。

```http
Cache-Control: public, max-age=60, must-revalidate
```

## 接入 CDN

```bash
emeek accelerate
```

交互式向导：选提供商 → 填凭据 → 写配置。凭据落在 `.emeek/credentials`
（权限 `0600`，自动进 `.gitignore`），**绝不写进 `emeeek.config.js`**。

### 支持的提供商

| 提供商 | 中国大陆节点 | ICP 备案 | 免费 |
| --- | --- | --- | --- |
| Cloudflare | ✗（需 Enterprise/合作伙伴） | 不需要 | ✓ |
| 阿里云 CDN | ✓ | 需要 | ✗ |
| 腾讯云 CDN | ✓ | 需要 | ✗ |
| 自定义 / 自建 | ✓ | 视情况 | ✓ |

新增提供商 = 往 `packages/core/src/accel/providers.js` 加一条。
`cdn-client.js` 里没有 `if (provider === 'cloudflare')`——这是有意的。

### 凭据从哪来

优先级：环境变量 > 项目 `.emeek/credentials` > 用户 `~/.emeek/credentials`。

```bash
export CF_API_KEY=...      # 或写进 .emeek/credentials
export CF_ZONE_ID=...
```

把凭据写进配置会被构建**直接拦住**：

```
✖ CDN 配置校验失败：
  - cdn.apiKey: API Token（Cache Purge 权限）属于凭据，不能写进配置文件；
    请用环境变量 CF_API_KEY 或 ~/.emeek/credentials
```

## 中国大陆加速专项

这块的痛点不是「不够快」，是「打不开」。四个具体原因，四条对策：

### 1. ICP 备案

未备案的域名在国内 CDN 会被**阻断解析**。构建会拦：

```
⚠ 中国大陆加速前置条件未满足：
  Cloudflare 免费套餐不含中国大陆节点，请把 cdn.china.provider 指向 aliyun/tencent。
```

`github.io` 不能备案，也不能作加速域名——也会被拦。

```javascript
cdn: {
  china: {
    enabled: true,
    provider: 'aliyun',
    domain: 'cdn.myblog.techsauce.cn',
    icp: true,   // 备案完成后再打开
  },
}
```

### 2. Google Fonts

`fonts.googleapis.com` 国内不可达，页面会卡在样式表请求上直到超时。
构建会扫描产物并记进 `acceleration.json`：

```json
"blockedHosts": [
  {
    "host": "fonts.googleapis.com",
    "suggestion": { "replaceWith": "自有 CDN 字体（emeek 字体子集化产物）或系统字体回退" }
  }
]
```

替代方案：字体子集化 + 自有 CDN；无网络时回退系统字体（零请求）。

### 3. 中文字体体积

思源黑体全量 20MB+，一次下载等于不可用。规划分片：

```bash
emeek accelerate --plan
```

```
中文字形：361 个 → 5 片
  subset-0.woff2  73 字形  ~30KB  U+3001-U+3002…
  ...
```

按 `unicode-range` 分片，浏览器只下用到的片。**不按笔画分**——
那会让所有片都被下载，比不分还慢。

### 4. 图片

`analyzeImages` 点出超体积/超尺寸/缺 WebP/未懒加载的图片。
HTML 侧用 `srcset` 按视口下发，WebP 通常比 PNG 小 60~80%。

## 效果实测

```bash
emeek accelerate --test
```

对北京/上海/广州/成都/东京/新加坡/法兰克福/纽约测 TTFB，取中位数。
中国大陆目标线：**中位 TTFB < 500ms**。

```
区域延迟对比
  beijing      3000ms →    420ms
  shanghai     2800ms →    390ms
中国大陆中位 TTFB：405ms ✔ < 500ms
```

`--offline` 时跳过网络探测，只报告产物侧事实——本地没网也能自查。

## 多源站与故障转移

```
主站：GitHub Pages
镜像：Vercel / Cloudflare Pages / 自托管（大陆节点）
```

```bash
emeek accelerate --fanout   # 规划推送（幂等）
emeek accelerate --health   # 健康检查配置
```

**幂等**：每个源站记录上次推送的产物摘要，一致就跳过。

```
✔ github-pages       产物未变化，跳过推送
✔ vercel             产物未变化，跳过推送
✔ 所有源站产物已是最新 —— 重复推送不产生副作用
```

**健康检查带内容谓词**：静态托管常用 `404.html` 返回 200，
只判状态码会把挂掉的源站当健康。

## 刷新与预热

```bash
emeek accelerate --purge            # 内容更新后刷新（HTML + 索引）
emeek accelerate --purge --all      # 连指纹资源一起刷
emeek accelerate --warm             # 部署后预热（首页 + 最近文章 + 索引）
emeek accelerate --purge --dry-run  # 只看会刷哪些 URL
```

未配置 provider 时 `--warm` 会明确说 `skipped`，不会假装成功。

## 缓存头一览

| 类型 | Cache-Control |
| --- | --- |
| 带指纹资源 | `public, max-age=31536000, immutable` |
| HTML | `public, max-age=300, stale-while-revalidate=3600` |
| search-index.json | `public, max-age=60, must-revalidate` |
| sitemap / rss / robots | `public, max-age=60, must-revalidate` |
| 未指纹静态资源 | `public, max-age=300, stale-while-revalidate=3600` |

最后一行是关键：**没有指纹就不能 immutable**。文件变了 URL 没变，
用户会一直看到旧版本——这类 bug 的报障描述通常是「清了缓存就好了」。

## 配置参考

```javascript
export default {
  site: { title: '我的博客', url: 'https://blog.techsauce.cn' },

  cdn: {
    enabled: true,
    provider: 'cloudflare',       // cloudflare | aliyun | tencent | custom

    fingerprint: { enabled: true },
    compression: { enabled: true },
    server: true,                 // 生成 nginx / Caddy 片段

    cacheRules: {
      static: { ttl: '30d', immutable: true },
      html: { ttl: '5m', staleWhileRevalidate: '1h' },
    },

    china: {
      enabled: true,
      provider: 'aliyun',
      domain: 'cdn.blog.techsauce.cn',
      icp: true,
    },

    // ⚠️ 这里没有 apiKey。凭据走环境变量或 .emeek/credentials。
  },
};
```

## 无 CDN 也能用

上表的每一项都不依赖 CDN：

- 指纹 + 长缓存 → 浏览器缓存生效
- 预压缩 `.gz` / `.br` → 静态托管直接发
- `dist/server/nginx.conf` → 自建 Nginx 复制即用
- 103 Early Hints → 有 Nginx/Caddy 就生效
- 字体子集化 + 系统字体回退 → 零网络请求

「降级」不是排除法，是本来就有的一半。
