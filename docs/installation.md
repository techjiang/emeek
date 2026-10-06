# 安装

Emeek 有三种安装形态：**跑 CLI 构建**、**跑构建服务**、**只用构建产物**。
只有前两种需要环境，第三种什么都不需要。

## 环境要求

| 组件 | 要求 | 说明 |
| --- | --- | --- |
| Node.js | ≥ 18 | 构建与 CLI 需要。用 `node --version` 检查 |
| 磁盘 | ~50 MB | 含依赖；产物本身通常 < 1 MB |
| 网络 | 仅 GitHub Issues 源需要 | 访问 `api.github.com` |

**不需要**：PHP、Composer、Docker、数据库、全局 npm 包。

## 方式一：npx（推荐）

```bash
npx emeeek init my-blog
cd my-blog
npx emeeek dev
```

零安装。适合先试一下，也适合 CI —— 每次跑的都是最新版。

## 方式二：全局安装

```bash
npm install -g emeeek
emeek --version     # 1.0.0
```

适合经常用、不想每次都 `npx` 的场景。

## 方式三：源码（开发 / 贡献）

仓库是 pnpm workspace：

```bash
git clone https://github.com/techjiang/emeek.git
cd emeeek
pnpm install
node packages/cli/bin/emeeek.js build --cwd examples/minimal
```

跑测试与门禁：

```bash
pnpm test                            # 1739 个单元/集成测试
bash scripts/e2e/negative-check.sh   # 105 条负向验证
pnpm lighthouse                      # 性能基线（需本机 Chromium）
```

## 方式四：Docker

Emeek 本身零依赖，但如果你想在容器里构建：

```dockerfile
FROM node:20-alpine
WORKDIR /site
COPY . .
RUN npm install -g emeeek && emeeek build
# 产物在 /site/dist
```

```bash
docker build -t my-blog .
docker run --rm -v "$PWD/dist:/out" my-blog sh -c 'cp -r /site/dist/* /out/'
```

注意：**Docker 只是构建环境，不是运行时**。产物是静态文件，
用任意 HTTP 服务器托管即可 —— 不需要把 Emeek 部署到生产。

## 一键脚本（Linux / macOS）

```bash
curl -fsSL https://raw.githubusercontent.com/techjiang/emeek/main/scripts/install.sh | bash
```

## GitHub Issues 源需要的凭据

只有 `content.source: 'github-issues'` 或 `'hybrid'` 时才需要。

**公开仓库**：可以完全不配 Token（GitHub 匿名 API 有速率限制，60 次/小时）。

**私有仓库 / 高频构建**：设环境变量：

```bash
export GITHUB_TOKEN=ghp_xxx
emeek build
```

Token 的规则是**只能从环境变量读**：

- 不写进 `emeeek.config.js`
- 不写进产物
- 不出现在日志

CI 里用 Secrets 注入：

```yaml
- run: emeeek build
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

## 验证安装

```bash
emeek doctor
```

它会逐项检查 Node 版本、配置文件、内容目录、主题加载、
Issues 仓库连通性、输出目录可写、资源指纹、CDN 配置等，并给出修复提示。

## 卸载

```bash
npm uninstall -g emeeek        # 全局安装
rm -rf ~/.npm/_npx             # npx 缓存（可选）
```

产物与项目文件不受影响。
