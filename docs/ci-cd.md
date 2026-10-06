# CI/CD 集成

Emeek 的 CI 模型很简单：**Issues 变化 → 触发构建 → 产物推到 Pages**。
Emeek 仓库里 `.github/workflows/build.yml` 是一份可直接用的模板。

## GitHub Actions（Issues 驱动）

```yaml
# .github/workflows/build.yml
name: Build and Deploy

on:
  issues:
    types: [opened, edited, closed, reopened, labeled, unlabeled]
  schedule:
    - cron: '0 * * * *'        # 每小时重建，让「定时发布」到点上线
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Build
        run: npx emeeek build
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - uses: actions/upload-pages-artifact@v3
        with:
          path: dist

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
    steps:
      - uses: actions/deploy-pages@v4
```

**关键点**

- `GITHUB_TOKEN` 从 Secrets 注入，**从不写进配置或代码**
- `schedule` 每小时跑，让 `date` 到点的定时发布自动出现
- `issues` 事件让「开 Issue 即发文」成立

## 定时发布为什么需要 CI

草稿要手动改，**定时发布到点自动上** —— 后者靠 CI 定时重建兑现。没有定时任务，
`date` 在未来的文章永远只是「等下一次你手动构建」。

配置里可以加宽限期躲开调度抖动：

```javascript
workflow: { schedule: { enabled: true, graceHours: 1 } }
```

## GitLab CI

```yaml
# .gitlab-ci.yml
build:
  image: node:20
  script:
    - npx emeeek build
  artifacts:
    paths:
      - dist
  variables:
    GITHUB_TOKEN: $GITHUB_TOKEN      # 在 Settings → CI/CD → Variables 里配
```

## CNB（cnb.cool）

```yaml
# .cnb.yml
main:
  push:
    - stages:
        - name: build
          script: npx emeeek build
        - name: deploy
          script: npx emeeek deploy --target rsync --host $HOST --path $PATH
```

## 缓存与提速

构建本身很快（示例站 ~2s），但 CI 里值得缓存 npm 缓存：

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: 20
    cache: npm
```

## 门禁：把测试接进 CI

Emeek 自己的 CI 跑这些：

```bash
pnpm test                            # 1739 个单元/集成测试
bash scripts/e2e/negative-check.sh   # 105 条负向验证
pnpm check:seo                       # SEO 自检
pnpm lighthouse                      # 性能基线
```

自建站点可以只留最重要的两条：

```yaml
- run: npx emeeek build              # 构建必须成功
- run: npx emeeek doctor             # 配置必须自洽
```

## 部署到其他平台

`emeek deploy` 覆盖六个目标，配置方式见 [部署指南](deployment.md)。

```bash
emeek deploy --target cloudflare --preview   # 预览部署，不推生产
emeek deploy --dry-run                       # 只生成配置 + 预演
```

## 常见问题

**构建时 GitHub API 限流？** 公开仓库用 `GITHUB_TOKEN` 认证可把配额从 60 提到 5000 次/小时。

**定时任务没触发？** GitHub 的 `schedule` 在仓库长期无活动时会暂停 —— 推一次提交即可恢复。

**产物变了但线上没变？** Pages 部署有缓存。`emeek deploy --no-verify` 可跳过在线验证，
但正常情况让它验证（它会在部署后真的去访问一次）。
