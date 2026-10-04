# D7 · 全球加速做进构建，而不是做进部署

**状态**：已落地（P3-4b-accel）
**落地点**：`packages/core/src/accel/`、`packages/cli/src/commands/accelerate.js`

## 问题

GitHub Pages 在中国大陆经常打不开。这不是「优化项」，是「用不了」。

用户给的信号很直接：两个真实地址 `myblog.techsauce.cn`、`emeeek.example.com`
访问失败。要做的事不是「让站点更快的锦上添花」，是「让站点能被打开」。

## 决策

把加速拆成两层，各自独立可验证：

1. **构建期加速**（默认开启，不依赖任何外部服务）
   资源指纹、预压缩 `.gz`/`.br`、缓存头清单、服务器配置片段。
2. **CDN 接入**（可选，一条命令）
   提供商注册表 + 凭据分层存储 + 刷新/预热/多源站。

## 为什么不是别的做法

### ✗ 在部署脚本里做指纹

部署脚本拿不到渲染后的 HTML，只能靠正则改 `dist/` 里已经写死的引用。
一旦主题改了引用写法（`srcset`、内联 CSS 里的 URL），改写的覆盖面就开始漏。
指纹必须在**产出引用的那一刻**就确定——所以它在构建管线里，在写盘前。

### ✗ 让用户在 Cloudflare 控制台配一堆 Page Rules

控制台配置的失败模式是「配漏了一条，没人知道」。
把缓存策略写成 `cacheHeaders()` 这个纯函数，规则就有了唯一来源，
`acceleration.json` 是它的产物，`dist/server/nginx.conf` 也是。
控制台只是这套规则的复制目标，不是事实来源。

### ✗ 引入各家 CDN 的官方 SDK

三个理由：
- 依赖体积不值得（每次刷新省下的几毫秒，换来一串传递依赖）
- SDK 会把凭据揽进进程的文件句柄与日志
- 不能注入替身 → 无法在 CI 里断言「请求发对了、Key 没落盘」

一个 `createCdnClient({ fetchImpl })` 就够了。

### ✗ API Key 放配置文件，靠 `.gitignore` 兜底

`.gitignore` 只能防「已经忘了一次」的情况。真正的失败模式是
`emeeek.config.js` 被 `git add -f`、被复制进 issue、被贴进聊天窗口。
所以做成**结构性不可能**：配置校验直接拒绝 secret 字段，
凭据只能从环境变量或 `.emeek/credentials`（0600）来。

### ✗ RSS 的 lastBuildDate 用当前时间

看起来无害，实际后果是：每次构建 `rss.xml` 都不同 →
「产物未变 → 跳过推送」的幂等判据永远为假 →
多源站每次全量重推、CDN 每次全量刷新、缓存全部失效。

这个 bug 在本轮开发中被幂等测试抓出来过（`rss.xml` 在二次构建中变化）。
修法是把日期改成「内容最后更新于」，而不是「我什么时候编的」。

## 验收

```bash
npm test                              # 1058 单测（accel 新增 109）
bash scripts/e2e/negative-check.sh    # 38 条防线（本 PR 新增 8 条），削弱后必须红
bash scripts/e2e/acceleration-check.sh # 16 项端到端
bash scripts/e2e/check-no-secrets.sh dist
```

## 负向证据

`scripts/e2e/negative-check.sh` 里新增 8 条（全库共 38 条），每条削弱一个关键不变量：

| 削弱 | 后果 |
| --- | --- |
| `fingerprintPath` 恒等 | 内容变了文件名不变，长缓存永远发旧版本 |
| 未指纹资源也给 `immutable` | 用户清了缓存才能看到更新 |
| 预压缩白名单失效 | 图片被「压缩」，产物反而变大 |
| secret 允许进配置 | API Key 随仓库泄露 |
| ICP 检查失效 | 未备案域名在国内静默不通 |
| 不可达域名扫描恒空 | Google Fonts 悄悄进产物，首屏卡死 |
| `diffTrees` 恒判有变化 | 幂等失效，每次全量重推 |
| 内容谓词恒通过 | 200 + 404 页也算健康，故障转移形同虚设 |

## 覆盖

| 模块 | 行覆盖 |
| --- | --- |
| fingerprint.js / compress.js / credentials.js / latency.js | 100% |
| cache-headers.js | 99% |
| hints.js / origins.js | 98% |
| china.js / cdn-client.js | 96% / 95% |
| index.js（加速管线） | 96% |
| providers.js | 88% |

均高于要求的 80%。
