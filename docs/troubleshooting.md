# 故障排查

**先跑 `emeek doctor`。** 它会逐项检查环境、配置、主题、连通性，并给出修复提示。
下面是最常见的问题。

---

## 构建阶段

### `content.repo 未配置，无法读取 GitHub Issues`

`content.source` 是 `github-issues` 或 `hybrid`，但没写 `repo`。

```javascript
content: { source: 'github-issues', repo: 'you/blog' }
```

### Issue 没出现在站点里

按顺序排查：

1. **标签对不对** —— 只有带 `publish` 标签的 Issue 才进站点
2. **是不是被 `draft` 排除了** —— `draft` 优先级高于 `publish`，两者同时带会被排除
3. **GitHub 索引延迟** —— 刚建的仓库/Issue，列表 API 可能有 1~2 分钟才可见
   （`open_issues_count` 已是对的，但 `GET /issues` 还返回空）。等一会儿再构建
4. **是不是 PR** —— Pull Request 会被跳过

### `内容校验` 报错/告警

```bash
⚠ 内容校验：posts/foo.md
   · 标题为空
   · 站内链接 /posts/bar.html 不存在
```

按提示修，或改档位：

```javascript
workflow: { validate: 'off' }     // 关掉
workflow: { validate: 'error' }   // 让它挡构建
```

### 主题 CSS 没生效 / 页面裸奔

先确认 `dist/assets/theme.*.css` 存在。若不存在，多半是自定义主题路径写错：

```bash
emeek theme list     # 确认主题名与路径
emeek doctor         # 会报出主题加载情况
```

### `EMEEEK_DEBUG`

出任何未预期错误时：

```bash
EMEEEK_DEBUG=1 emeeek build
```

会打印完整堆栈。

---

## 预览阶段

### `emeek dev` 起来了但改动不重建

监听范围只覆盖内容目录。确认你改的是 `posts/`（或 `localDirs`）里的文件，
而不是项目根目录。

### 端口被占用

```bash
emeek dev --port 4321
```

### 浏览器看到旧内容

硬刷新（`Ctrl/Cmd + Shift + R`）。dev 服务不缓存 HTML，但浏览器可能缓存了静态资源。

---

## 产物阶段

### 产物里有 `.gz` / `.br` 文件

正常 —— 那是预压缩产物。静态托管会自动优先取用，省掉运行时压缩。

### 搜索找不到文章

1. 文章是不是草稿？（草稿不进索引）
2. 索引大小是否超预算？构建日志会打印 `文档 N 篇`
3. 试试更短的关键词 —— 搜索对 ≥4 字 CJK 词元做模糊展开，短词走精确匹配

### 微信二维码扫不出来

二维码**超长会显式报错**，不会截断 —— 「截断的二维码扫出来是一个错的地址，比没有更糟」。
确认分享地址长度合理（微信 URL 有长度上限）。

---

## 部署阶段

### `emeek deploy` 失败

先 `--dry-run` 看它打算做什么：

```bash
emeek deploy --dry-run
```

常见原因：

| 现象 | 原因 | 修法 |
| --- | --- | --- |
| `rsync` 连不上 | host / 密钥没配 | 检查 `--host` `--path` 与 SSH 配置 |
| Pages 部署 403 | 权限不足 | 检查 workflow 的 `permissions` |
| 部署后访问 404 | 子路径 / basePath 不对 | 检查 `site.url` 与托管路径是否一致 |

### 部署后产物是旧的

CDN 缓存。内容更新后刷新：

```bash
emeek accelerate --purge
```

---

## 测试阶段（贡献者）

### `npm test` 报 `Cannot find package '@emeeek/core'`

workspace 链接没装：

```bash
pnpm install
```

### e2e 报 `ERR_INTERNET_DISCONNECTED`

PWA e2e 在部分沙箱环境会失败 —— Playwright 的离线模式连 `127.0.0.1` 都拦。
这是环境限制，不是 Emeek 的 bug。在有正常网络的环境里跑即可。

### e2e 报缺 Python 模块

真浏览器 e2e 用到 `playwright` / `numpy` / `opencv-python`：

```bash
pip install playwright numpy opencv-python-headless
python -m playwright install chromium
```

---

## 还是不行

带上这些信息开 Issue：

```bash
node --version
emeek --version
emeek doctor
EMEEEK_DEBUG=1 emeeek build 2>&1 | tail -50
```

**不要把 Token 贴进 Issue。** 日志里的凭据会被 `redact` 处理，但你自己贴的不会。
