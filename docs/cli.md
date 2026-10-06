# CLI 命令参考

```
emeek <command> [options]
```

全局选项：

| 选项 | 说明 |
| --- | --- |
| `--cwd <dir>` | 指定项目目录（默认当前目录） |
| `-h, --help` | 显示帮助 |
| `-v, --version` | 显示版本号 |

---

## `emeek init [dir]`

初始化新项目：生成 `emeeek.config.js`、`posts/` 与两篇示例文章。

```bash
emeek init my-blog
emeek init .            # 初始化当前目录
```

## `emeek build`

构建静态站点到 `dist/`。

```bash
emeek build
emeek build --cwd examples/minimal
```

流程：读取内容 → 校验 → 渲染 → 写盘 → 指纹 → 预压缩 → 生成 feed/sitemap/搜索索引。

输出示例：

```
▸ 构建 /tmp/gh-site
▸ 内容源：github-issues · 配置：emeeek.config.js
ℹ 读取 3 篇内容（0 篇草稿、0 篇待定时发布已跳过）
ℹ 主题：minimal v1.0.0
ℹ 内容校验：3 篇全部通过
ℹ 搜索索引：文档 3 篇 · 词元 41 个 · bigram 64 个 · raw 3.9KB / gzip 1.4KB（预算 500.0KB）
ℹ Sitemap：14 条 URL
ℹ Feed：RSS + Atom · 3 条
ℹ 加速：22 个资源已指纹 · 预压缩 35 个文件（gzip 69% 节省 / brotli 75% 节省）
✔ 构建完成：3 篇文章 · 15 个页面 · 耗时 2.0s
```

## `emeek dev`

本地预览 + 文件监听，保存即重建。

```bash
emeek dev
emeek dev --port 4321
```

监听范围收敛到内容目录 —— 目录外的改动不触发重建（避免 `node_modules` 抖动）。
`/studio` 路径可直接打开编辑器。

## `emeek studio`

打开 Emeek Studio 编辑器（CodeMirror 6 + 双栏预览）。

```bash
emeek studio
```

预览与构建共用同一个渲染函数 —— 编辑器里看到的就是发布后的样子。

## `emeek new "标题"`

新建文章，默认 `draft: true`。

```bash
emeek new "我的文章"
# → posts/2026-03-15-我的文章.md
```

## `emeek drafts`

列出已发布 / 草稿 / 定时发布三态。

```bash
$ emeek drafts
▸ 内容状态：3 篇
✔ 已发布：3 篇
草稿：0 篇
定时发布：0 篇
```

## `emeek doctor`

诊断环境、配置、主题、连通性。

```bash
$ emeek doctor --cwd /tmp/gh-site
✔ Node 版本：v24.21.0
✔ 配置文件：emeeek.config.js
✔ 内容目录 posts：/tmp/gh-site/posts
✔ 内容解析：共 3 篇（0 篇草稿）
✔ Issues 仓库连通：techjiang/emeek → HTTP 200
✔ 主题加载：minimal v1.0.0（8 个布局）
✔ 输出目录可写：dist
✔ 资源指纹：已开启
✔ 预压缩产物：35 个文件（gzip 省 69% / brotli 省 75%）
✔ 国内可达性：无国内不可达的外部引用
✔ 全部检查通过，可以运行 emeeek build
```

出任何问题先跑它。

## `emeek theme`

```bash
emeek theme list                 # 列出可用主题
emeek theme switch magazine      # 切换主题（写入 emeeek.config.js）
emeek theme preview aurora       # 切换 + 起预览
emeek theme create my-theme      # 生成自定义主题骨架
```

## `emeek deploy`

构建 + 校验 + 部署到目标平台。

```bash
emeek deploy --target github-pages
emeek deploy --target cloudflare --preview
emeek deploy --target rsync --host example.com --path /var/www/blog
emeek deploy --dry-run          # 只预演，不推送
emeek deploy --no-build         # 用现有 dist/
emeek deploy --no-verify        # 跳过部署后在线验证
```

目标：`github-pages` / `cloudflare` / `vercel` / `netlify` / `rsync` / `docker`。

## `emeek accelerate`

全球加速：配置向导、实测、刷新、预热。

```bash
emeek accelerate              # 配置向导（Cloudflare / 阿里云 / 腾讯云 / 自定义）
emeek accelerate --test       # 实测各区域 TTFB
emeek accelerate --purge      # 内容更新后刷新缓存
emeek accelerate --warm       # 部署后预热
emeek accelerate --fanout     # 多源站故障转移
```

## `emeek clean`

清理 `dist/`。

```bash
emeek clean
```

---

## 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 1 | 失败（配置错误 / 构建错误 / 校验 `error` 档拦下） |

CI 里可以靠退出码判断：

```yaml
- run: emeeek build
```

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `GITHUB_TOKEN` | GitHub Issues 源的认证（只从这里读） |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | AI 生成类功能（可选） |
| `EMEEEK_DEBUG=1` | 打印完整错误堆栈 |
