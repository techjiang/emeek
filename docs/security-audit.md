# 安全审计报告（v1.0.0）

审计日期：2026-03-15 · 版本：1.0.0

本报告记录 v1.0.0 的安全审计过程与结论。**每一项都附可复现命令**，
结论不是「我们认为它安全」，而是「这些命令跑出来是绿的」。

---

## 1. 依赖链审计

Emeek 的运行时依赖是**零**。所有第三方包只在开发/构建期出现
（CodeMirror、markdown-it、esbuild、jsdom）。

```bash
pnpm audit
```

```
vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 }
dependencies: 60 · devDependencies: 64 · totalDependencies: 124
```

**结论：依赖树 0 漏洞。** 构建产物里没有第三方运行时代码 ——
这也意味着「供应链攻击」的攻击面被压到构建期。

---

## 2. XSS 防护

### 2.1 URL 白名单

唯一的写 `href`/`src` 的地方是 `sanitizeUrl`，它做**白名单**放行
（`http` / `https` / `mailto` / `tel` + 相对路径 + 片段 + 协议相对），
其余一律返回 `null`，调用方渲染成**纯文本**而不是危险标签。

关键实现：**判协议前先剥掉浏览器会忽略的字符**（C0 控制符 + 空格），
否则 `java\tscript:` / `\x01javascript:` 会蒙混过关 ——
判的是「浏览器会怎么理解」，不是「字符串长什么样」。

```bash
node --test packages/core/tests/security/xss.test.js
# ℹ tests 22 · pass 22 · fail 0
```

### 2.2 HTML 消毒

`allowHtml` 打开时仍会走 `sanitizeHtml`：

- 丢弃 `script` / `iframe` / `svg` / `object` / `form` / `base` / `meta`
- 剥掉一切 `on*` 事件属性
- `style` 里的 `expression(` / `javascript:` 整条属性丢掉
- 注释 / CDATA 直接删

**结论：不存在「完全不过滤的原样输出」这个选项。**

### 2.3 真浏览器验证

判据是「脚本有没有真的执行」，不是「HTML 里有没有 `<script>`」。
真 Chromium 里真的去点那些链接，再看 `window.__xss` 有没有被写。

```bash
node scripts/e2e/xss.mjs
```

### 2.4 注入载荷

```bash
node --test packages/core/tests/analytics/injection.test.js
node --test packages/core/tests/comments/comments.test.js
# ℹ tests 64 · pass 64 · fail 0
```

覆盖：分析探针注入、评论内容注入（评论是任意人写的）、
`@提及` 与链接的边界处理。

---

## 3. 路径穿越

文件 API 的路径守门收敛到**一处** `resolveProjectFile`：

1. 拒绝 NUL 字节
2. `path.resolve` 后必须仍在内容目录内
3. `realpath` 也必须在内容目录内（防符号链接越出）

文件监听复用**同一个**函数，不写第二份差不多的判断。

```bash
node --test packages/editor/tests/watcher.test.js
# 含「软链指向内容目录之外被拒」「软链指向内容目录之内放行」等
```

---

## 4. 凭据安全

### 4.1 只从环境变量读

Token / API Key 的读取路径只有环境变量或 `0600` 文件：

- **不写进** `emeeek.config.js`
- **不写进**产物
- **不出现在**日志

```bash
# 用真实 token 构建一个真实站点，然后扫产物
GITHUB_TOKEN=<token> emeek build --cwd <site>
grep -rl "$GITHUB_TOKEN" <site>/dist && echo "LEAK" || echo "✔ 产物无 Token"
```

### 4.2 插件拿不到凭据

凭证访问**不在能力表里** —— `key:read` / `env:read` 这些名字**不存在**，
所以插件无法声明它。传给插件的 config 在加载时就 `stripSecrets`
（按字段名和按值双重识别）。

**不靠审核，靠不存在。**

### 4.3 扫描器

`redact` / `scanForSecrets` 覆盖错误/日志/导出/URL/认证头，
**生产代码与测试共用同一份实现** —— 不存在「测试扫的规则与运行时扫的不一样」。

```bash
bash scripts/e2e/check-no-secrets.sh
# ✔ 产物中未发现 CDN 凭据
```

> ⚠️ **本轮特别提醒**：本次任务的提示词中明文包含了一个 PAT。
> 该 token 已在对话中暴露，应视为已泄露，**必须吊销**。
> 本轮全程只经环境变量使用、报告脱敏，产物扫描零泄漏。

---

## 5. 输出转义

| 输出位置 | 处理 |
| --- | --- |
| HTML 文本 | `escapeHtml` |
| HTML 属性 | `escapeHtml` + 引号 |
| URL | `sanitizeUrl` 白名单 |
| JSON-LD | `JSON.stringify`（不手拼字符串） |
| XML（sitemap / feed） | `escapeXml` |
| RSS/Atom 日期 | 双格式规范化输出 |

---

## 6. 负向验证：测试自己也需要测试

`scripts/e2e/negative-check.sh` 逐条削弱关键防线，确认对应测试**真的会红**，
然后恢复原状。一条防线如果削弱了测试还是绿的，那它只是恰好写在那儿。

```bash
bash scripts/e2e/negative-check.sh
# ── 105 条防线被守住，0 条没守住
```

关键是**削弱必须真的生效**：脚本先 `diff` 确认改动了源码，
没改到就直接判这条负向验证本身是假的
（这套机制抓到过两次假验证）。

---

## 7. 权限最小化

- 静态站点：产物无服务端，攻击面只有静态文件托管
- CI：`permissions` 显式声明（`contents: read` / `pages: write` / `id-token: write`）
- npm 发布：`publishConfig.access: public`，token 从 Secrets 读取
- 分析探针（若启用）：不读 Cookie、不发明文 IP/UA、不发 referer、只发 pathname

---

## 8. 审计结论

| 项 | 结果 |
| --- | --- |
| 依赖漏洞 | ✅ 0（124 个依赖） |
| XSS 载荷 | ✅ 全部被过滤（22 条 XSS 单测 + 真浏览器） |
| 注入载荷 | ✅ 全部被过滤（64 条） |
| 路径穿越 | ✅ 单点守门，符号链接/NUL 字节/NUL 全拒 |
| 凭据保护 | ✅ 结构性不泄露（环境变量唯一入口） |
| Token 入产物/日志 | ✅ 零泄漏（check-no-secrets 全绿） |
| 输出转义 | ✅ 全输出点覆盖 |
| 负向验证 | ✅ 105/105 守住 |
| 权限最小化 | ✅ CI 显式声明 |

**结论：通过。** 无已知未修安全问题。

---

## 复现全部命令

```bash
pnpm audit                                              # 依赖
node --test packages/core/tests/security/xss.test.js    # XSS
node --test packages/core/tests/analytics/injection.test.js
node --test packages/core/tests/comments/comments.test.js
node scripts/e2e/xss.mjs                                # 真浏览器 XSS
bash scripts/e2e/check-no-secrets.sh                    # 凭据
bash scripts/e2e/negative-check.sh                      # 105 条防线
```
