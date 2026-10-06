# npm 发布流程

> **当前状态：只做准备，尚未实际发布。**
> 一切字段与工作流模板已就位，但**没有真正 `npm publish`** ——
> 发布需要 `NPM_TOKEN`，而凭据不通过提示词或代码传递。
> 实际发布由维护者手动执行。

## 前置条件

1. **npm 账号** —— https://www.npmjs.com/signup
2. **账号有 `emeeek` / `@emeeek/*` 的发布权限** —— 首次发布会占据包名
3. **本地测试全绿**：

```bash
pnpm install
pnpm test                            # 1739 个测试
bash scripts/e2e/negative-check.sh   # 105 条负向验证
```

## 包结构

发布三个包：

| 包名 | 内容 | 说明 |
| --- | --- | --- |
| `emeeek` | CLI + bin | 用户装的就是它 |
| `@emeeek/core` | 引擎 | `emeeek` 的依赖 |
| `@emeeek/editor` | Studio 编辑器 | `emeeek` 的依赖 |

`emeeek` 依赖另两个包 —— 用户 `npm install -g emeeek` 会一起装上。

## 打包内容检查

发布前**必看**这一步：

```bash
cd packages/cli
npm pack --dry-run
```

它会列出将被上传的每个文件。检查：

- ✅ 包含 `bin/` `src/` `README.md` `LICENSE`
- ✅ 不含 `node_modules/` `.git/` 测试文件
- ✅ 不含任何 Token / 凭据
- ✅ 体积合理（通常 < 100 KB）

自动化的凭据扫描：

```bash
bash scripts/e2e/check-no-secrets.sh
```

## 实际发布

### 方式一：手动（推荐首次）

```bash
# 登录（token 由 npm 自己存，不出现在命令行历史里时更安全）
npm login

# 三个包按依赖顺序发布
cd packages/core   && pnpm publish --access public
cd ../editor       && pnpm publish --access public
cd ../cli          && pnpm publish --access public
```

**必须用 `pnpm publish`，不能用 `npm publish`。**
`package.json` 里写的是 `workspace:^1.0.0`，pnpm 会在发布时把它改写成真实版本号；
`npm publish` 会因为 `workspace:` 不是合法 semver 而失败。

### 方式二：GitHub Actions（`release.yml` 模板已就位）

1. 在 GitHub 仓库 **Settings → Secrets and variables → Actions** 添加：
   - `NPM_TOKEN`：npm 的 **Automation** 类型 token（在 npmjs.com → Access Tokens 生成）
2. 打 tag 并推送：

```bash
git tag v1.0.0
git push origin v1.0.0
```

3. 工作流会自动：装依赖 → 跑全量测试 → 负向验证 → 构建示例 → 发布到 npm → 创建 GitHub Release。

**为什么先跑测试**：让「测试没绿也照样发出去」这件事不可能发生。

## NPM_TOKEN 怎么生成

1. 登录 npmjs.com
2. 头像 → **Access Tokens** → **Generate New Token** → **Automation**
3. 复制 token（只显示一次）
4. 粘进 GitHub Secrets，命名 `NPM_TOKEN`

**Automation 类型**绕过 2FA 的交互提示，适合 CI。
**不要**用 Classic 的 Publish 类型 —— 它在 CI 里会卡在 OTP 上。

## 故障排查

| 现象 | 原因 | 修法 |
| --- | --- | --- |
| `EPUBLISHCONFLICT` / `403` | 版本号已存在 | 改版本号，npm 不允许覆盖已发布版本 |
| `EOTP` / 卡在验证码 | token 类型不对 | 换成 Automation 类型 |
| `Unsupported URL Type "workspace:"` | 用了 `npm publish` | 改用 `pnpm publish` |
| `ENEEDAUTH` | 没配 `NODE_AUTH_TOKEN` | 检查 GitHub Secrets |
| 包体积异常大 | `files` 字段不对 | `npm pack --dry-run` 核对清单 |

## 版本号规则

遵循 [语义化版本](https://semver.org/lang/zh-CN/)：

- **补丁**（1.0.1）：向后兼容的修 bug
- **次版本**（1.1.0）：向后兼容的新功能
- **主版本**（2.0.0）：破坏性变更（如配置语义变化、插件能力收紧）

`packages/core/src/version.js` 是版本的**唯一真相**，tests 会校验四处
（根 + 三个子包）版本号一致 —— 漏改任何一处立刻变红。

发布后记得：

```bash
git tag v1.0.1 && git push origin v1.0.1
```

## 发布后验证

```bash
# 在一个干净目录里装装看
mkdir /tmp/verify && cd /tmp/verify
npm install -g emeeek
emeek --version     # 应输出刚发布的版本
emeek init demo && cd demo && emeeek build
```
