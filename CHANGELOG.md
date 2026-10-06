# Changelog

本项目的重要变更都记在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.0] - 2026-03-15

Emeek 的第一个正式版本。

一句话：**用 GitHub Issues 或 Markdown 写文章，一条命令构建，零依赖部署。**
3339 条测试（1739 单元/集成 + 1600+ e2e）、105 条负向验证、64 次 Lighthouse 全绿。

前身是 [Gmeek](https://github.com/Meekdai/Gmeek)。三根支柱原样继承 ——
**内容即 Issue、构建即一条命令、部署即一片静态文件**，
在此之上补齐了从「能构建」到「能写、能读、能被找到、能扛住流量」的整条链。

### Added

#### 内容与构建（P1 核心引擎）

- **双内容源**：GitHub Issues（`github-issues`）与本地 Markdown（`local`），
  同一份管线；Issue 正文可用 front-matter 覆盖标题/日期/标签
- **草稿与发布**：`publish` / `draft` 标签隔离，draft 强制排除（即使同时带 publish）；
  `partitionPosts` 是**唯一判定点** —— 发布/草稿/定时三态在同一处决定，结构上不可能分叉
- **定时发布**：`date` 在未来即自动跳过，到点重建即上线
- **模板引擎**：Liquid 子集，支持 `{% if %}` / `{% elsif %}` / `{% else %}` / `{% for %}` / `include`
- **主题系统**：4 套内置主题 —— **Minimal / Aurora / Inkstone / Magazine**；
  主题变量在 `theme.json` 声明类型与默认值，四套共用同一套 partial 契约
- **插件系统**：`capabilities` 显式声明制，未声明即跳过钩子；凭证访问**不在能力表里**（靠不存在防越权）
- **内容校验**：构建期检查标题/日期/本地文件存在性，报错不泄漏绝对路径
- **CLI**：`init` / `build` / `dev` / `new` / `theme` / `doctor` / `clean` / `drafts` / `deploy` / `accelerate` / `studio`

#### 写作（S2 Emeek Studio）

- **CodeMirror 6 编辑器**：可编程扩展装配，主题/换行/只读走 Compartment 热切换
- **双栏预览**：防抖 200ms；**预览 ≡ 构建** 由一致性测试盯着（生命线）
- **36 种语言高亮**：显式清单 + 真动态 `import()`，语法包不进首屏
- **目录导航 / 31 条快捷键 / 自动补全 / 16 个格式按钮**
- **草稿自动保存**：5s 空闲 + 10s/30s 兜底 + `visibilitychange`/`pagehide`/`freeze`；
  保留最近 5 版可回退；多标签页会话级互斥
- **AI 内容引擎（P2）**：Provider 抽象层（OpenAI / Anthropic / 本地 / Mock）；
  本地分析（摘要 / 关键词 / 可读性 / SEO）离线可用，生成类无 Key 时**诚实报错**不编造
- **API Key 分层存储**：服务端托管 > 会话级（默认）> 显式记住；密钥字符不回浏览器

#### 阅读体验（P3-2 / P3-3c）

- **全文搜索（P3-2）**：构建期建索引，运行时零后端；中文 bigram + 拼音模糊；
  搜索页独立成页，离线可用；索引体积有预算门禁
- **RSS / Atom Feed（P3-3）**：同一份数据生成两份，日期输出 RFC 3339 + RFC 822 双格式
- **评论系统（P3-3c）**：GitHub Issues 驱动，4 套主题各配样式
- **长文导航（P3-3c）**：目录 / 锚点 / 阅读进度条
- **阅读统计**：阅读时间 / 评论数 / 更新日期，可在配置中开关

#### SEO 与发现（P3-3a）

- **meta / canonical / Open Graph / Twitter Card**：字段**从真实数据生成**，缺就不输出（不编占位值）
- **结构化数据**：JSON-LD 走 `JSON.stringify`，不手拼字符串
- **sitemap.xml / robots.txt**：统计页与 404 明确排除/标记 noindex

#### 性能与加速（P3-3b / P3-4b-accel）

- **资源指纹**：内容哈希命名，`immutable` 长缓存
- **预压缩**：`.gz` + `.br` 双份产物（gzip 省 ~69% / brotli 省 ~75%）
- **关键 CSS 内联 + 外链样式表落盘**，预压缩 + Preload/preconnect
- **PWA**：Service Worker 离线缓存 + Web App Manifest + 主题色
- **CDN 集成**：Cloudflare / 阿里云 / 腾讯云 / 自定义，`accelerate` 子命令含配置向导、
  `--test`（8 探测点 TTFB 中位）/ `--purge` / `--warm` / `--fanout`
- **中国大陆专项**：ICP 检测、Google Fonts 替代、中文字体子集（84 字形 → 2 片，每片 < 30KB）

#### 交付与部署（P3-4a）

- **多平台部署**：GitHub Pages / Cloudflare Pages / Vercel / Netlify / rsync / Docker
- **多源站 + 故障转移**
- **`emeek deploy`**：构建 + 校验 + 预演（`--dry-run`）+ 部署后在线验证
- **CI/CD 模板**：GitHub Actions / CNB / GitLab CI

#### 数据与分享（P3-4b-rest）

- **分析集成**：内置极简 / Plausible / Umami / GoatCounter，产物零第三方脚本
- **统计页**：纯 HTML + SVG，**零 JavaScript**
- **社交分享**：零第三方 JS；微信 QR 为**纯 Canvas 自绘**（自带 Reed-Solomon 编码器）
- **内容工作流**：草稿 / 定时 / 分类，`drafts` 命令给出三态清单

#### 零依赖

- **零 Composer / 零 Node.js 运行时依赖 / 零 Docker** —— 构建产物是纯静态文件
- 中文优先 + 多语言支持

### Fixed

按「真 Bug」计入，每条都有对应防线：

- **`{% elsif %}` 不被识别** —— emit 返回空串导致两个分支**同时渲染**，
  典型的静默 bug；补 `else if` / `elsif` 双支持 + 负向验证钉住
- **XSS：Markdown 预览的 `javascript:` 链接（真实可触发）** ——
  `[点我](JaVaScRiPt:…)` 属性没被跳出，用户一点就执行；
  改为 **URL 白名单 + 默认拒绝**，被拒 URL 退回纯文本；
  `data:` 默认拒（图片仅放开 `image/*`）
- **API Key 泄漏路径** —— Key 曾可能经错误信息/日志回显；改为分层存储 + `redact`/`scanForSecrets`
- **`EMEEEK_CONFIG` 进程级泄漏** —— 并发构建时配置串台
- **`rss.xml` 的 `lastBuildDate` 不可复现** —— 同一内容两次构建产物不同；改为从内容推导
- **4 套主题 390px 横向溢出** —— 移动端出现横向滚动条
- **词云 `viewBox` 字号叠加放大** —— SVG 里字号被父级缩放二次放大
- **排行 `valueSuffix` 静默丢失** —— 图表单位没了，日志正常
- **统计页不在 sitemap** —— 统计页建了但搜索引擎找不到
- **QR 码：格式信息位序** —— 位序反了，扫出来是错地址
- **QR 码：RS 分块排序（短块在前）** —— v1–v4 块等长怎么排都对，
  **从 v5-Q 开始块长不等**，顺序决定每个字节落到哪一格；超长必须显式报错，
  因为「截断的二维码扫出来是一个错的地址，比没有更糟」
- **外链样式表 404** —— 主题超过 24KB 时样式表无人落盘，页面裸奔但构建报成功
- **变量遮蔽函数名 → 同步静默失效** —— `let fingerprint = fingerprint(…)` 让同步退化成 noop
- **客户端连错通道 → 静默失效** —— dev 的 `/__emeeek/reload` 与 studio 的 `/__studio/sync` 接错
- **插件钩子未声明 `capabilities` 时静默跳过** —— 改为 `doctor` 报出原因

### Security

- **凭据结构性不可能泄露**：Token/Key 只从环境变量或 0600 文件读取，
  **不写进代码/配置/日志/产物**；插件加载时即 `stripSecrets`
- **输出转义与 CSP**：URL 白名单、HTML 白名单（丢 `script/iframe/svg/…`、剥一切 `on*`、
  删注释与 CDATA）；链接/图片/双向链接共用同一个 `sanitizeUrl`
- **路径守门收敛到一处**：拒绝 NUL 字节、解析后必须在内容目录内、realpath 也在内（防符号链接越出）
- **扫描器生产/测试共用一份实现** —— 不存在「测试扫的规则与运行时扫的不一样」
- **105 条负向验证**：逐条削弱关键防线，确认对应测试**真的会红**，再恢复原状

### Engineering Notes（值得铭刻的踩坑）

- **边界条件在版本升级时才暴露**：QR 的 RS 分块排序，块等长时怎么排都对，
  块长不等才决定字节归属 —— 这类 bug 只在版本跃迁时现身
- **Node.js 异步模型的经典陷阱**：`spawnSync` 驱动子进程会阻塞事件循环，
  同进程的静态服务**永远不回请求**，e2e 表现为超时；
  改为 `spawn` + 异步或多进程
- **测试写错方向比没有测试更危险**：e2e 杀进程用了新 browser context，
  `localStorage` 当然是空的，测试报「丢稿」其实什么都没丢
- **假验证**：`sed` 表达式没匹配上，「削弱后仍通过」其实是**什么都没改**；
  现在削弱后先 `diff`，没生效就判这条负向验证本身是假的

### 测试总账（v1.0.0）

| 层 | 数量 | 命令 |
| --- | --- | --- |
| 单元 / 集成 | **1739** | `npm test` |
| 负向验证 | **105 条防线** | `bash scripts/e2e/negative-check.sh` |
| e2e · 搜索 | 12 | `node scripts/e2e/search.mjs` |
| e2e · 搜索页 | 134 | `node scripts/e2e/search-page.mjs` |
| e2e · Feed | 88 | `node scripts/e2e/feed.mjs` |
| e2e · 阅读 | 40 | `node scripts/e2e/reading.mjs` |
| e2e · 评论 | 64 | `node scripts/e2e/comments.mjs` |
| e2e · 主题 | 28 | `node scripts/e2e/theme.mjs` |
| e2e · 统计 | 56 | `node scripts/e2e/stats.mjs` |
| e2e · 分享 | 23 | `node scripts/e2e/share.mjs` |
| e2e · 内容工作流 | 20 | `node scripts/e2e/workflow.mjs` |
| e2e · 加速 | 16 | `bash scripts/e2e/acceleration-check.sh` |
| GitHub 集成 | 全链路 | Issues → 构建 → 产物 → 浏览器 |
| Lighthouse | 8 页 × 4 主题 × 2 视口 | `node scripts/lighthouse.mjs` |

### 已知限制（如实标注）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 移动端兜底 10s 写入成本 | 已测无卡顿 | 未做定量压测 |
| 部分语法包缺失 | 如实标注 | Svelte / GraphQL / Elixir / Vue SFC 在 CodeMirror 生态无对应包，按纯文本渲染并告知 |
| AI 生成类需 API Key | 设计如此 | 无 Key 时诚实报错，不返回猜测结果 |
| 内容级 CSP | 未做 | 属部署层，后续迭代 |
| WYSIWYG 模式 | 未做 | 后续迭代 |
| 插件沙箱（VM/Worker) | 未做 | 是另一量级的工作 |
| 草稿云同步 | 不做 | 与「内容即 Issue」的定位冲突 |

### [Unreleased]

#### Emeek Studio 的后续计划（S3）

- 图片管理
- AI 写作辅助（续写/改写，需 API Key）

### 不做的事（明确立场）

- **不引入 DOMPurify 之类的运行时依赖** —— 需求窄到可以自己写准
- **不做「记住 Key」的加密存储** —— `localStorage` 上没有真正的密钥保护
- **不做插件沙箱**
- **不做冲突自动合并，也不做「一键以磁盘为准」** —— 后者是自动合并的另一种形式
- **不做草稿云同步 / 多端同步**
- **不做分块增量渲染** —— 渲染器带跨块状态，正确路径是给 core 渲染器加可注入 `state`
- **不做 `ftp:` 等冷门协议** —— 放行一个协议等于放行一类绕过

---

## 版本沿革

| 版本 | 里程碑 |
| --- | --- |
| 1.0.0 | 正式版：内容管线 + Studio 编辑器 + 搜索/Feed/评论 + SEO/PWA/加速 + 部署/CI/CD + 分析/分享/工作流 |
| 0.2.x | P3 系列：主题 / 搜索 / SEO / 性能与 PWA / 评论与阅读 / 部署 / 加速 / 分析 / 分享 / 工作流 |
| 0.1.x | Phase 1–2：核心引擎 + AI 内容引擎 + Emeek Studio |
