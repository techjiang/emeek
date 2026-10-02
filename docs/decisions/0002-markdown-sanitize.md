# D2 · Markdown 预览消毒是根风险

**状态**：已确认（S2-3b 落地，修复了一个真实可触发的 XSS）
**日期**：2024

## 背景：这里是先发现的洞，再想起来要钉

核查渲染链路时，向量测试抓到一个**真实可触发**的 XSS：

```markdown
[点我](JaVaScRiPt:window.__xss=1)
```

渲染结果是 `<a href="JaVaScRiPt:window.__xss=1">点我</a>` —— 属性没有被跳出，
括号没错配，`escapeHtml` 该做的都做了。**但用户一点就执行。**

真浏览器验证（`node scripts/e2e/xss.mjs`）：

```
✘ Markdown 链接 大小写混写协议  —— 脚本真的执行了（触发方式：click）
```

为什么转义挡不住：转义解决的是「跳出属性」，而 `javascript:` 是一条**合法的属性值**。
两个问题不在一层上。

为什么「过滤 javascript: 前缀」也不够：浏览器解析 URL 时先剥掉 ASCII 空白与控制字符
（TAB / LF / CR）再判协议，所以 `java\tscript:`、`\x01javascript:`、`JaVaScRiPt:` 全都是活的。
判据必须是「浏览器会怎么理解」，而不是「字符串长什么样」。

## 决策

**白名单，不是黑名单。** 黑名单永远差一个没见过的协议
（vbscript:、file:、blob:、filesystem:、jar:，以及将来某个新的）。

| 层 | 规则 |
| --- | --- |
| URL（`sanitize-url.js`） | 只放行 `http/https/mailto/tel` 与相对路径、片段、协议相对。`data:` 默认拒，只有图片场景显式放开且只放开 `image/*` MIME。被拒的 URL **不生成标签**，退回纯文本 |
| 原始 HTML（`sanitize-html.js`） | `allowHtml` 打开时走白名单消毒：丢 `<script>/<iframe>/<svg>/<object>/<form>/<base>/<meta>` 等；剥一切 `on*` 属性；`style` 里出现 `expression(` / `javascript:` 整条属性丢掉 |
| 注释 / CDATA | 直接删。`<!--><script>…</script>-->` 这种「注释越界」是经典绕过 |
| 链接 / 图片 / 双向链接 | 全部走同一个 `sanitizeUrl`。双向链接不搞例外 —— 它的 URL 也来自内容驱动的 `urlPattern` |

**`allowHtml` 不等于「原样输出」。** 打开它只是允许结构化标签（`<div class="note">`），
脚本与事件属性照样被剥。内容作者的 HTML 与「可执行的内容」是两件事，
而在 Issue 驱动的站点里，后者等于「任何能提 Issue 的人都能 XSS」。

## 验收方式

两道，都必须过：

1. `packages/core/tests/security/xss.test.js` —— 30 条向量 × 静态结构断言（进普通 CI）
2. `node scripts/e2e/xss.mjs` —— 同样的向量塞进**真浏览器**，断言 `window.__xss` 未被写，
   并且真的去点那些链接（进 e2e 线）

判据是「脚本有没有执行」，不是「HTML 里有没有 `<script>`」——
后者可以被字符串处理绕过，前者不会。

## 这条决策的负向证据

`scripts/e2e/negative-check.sh` 削弱的三种方式，每一种都必须让测试红：

- `sanitizeUrl` 恒放行
- `sanitizeHtml` 恒等变换
- 渲染器里链接直接走 `resolveLink` 不消毒
