# 分析与统计

Emeek 的分析层只有一条价值观：**默认零追踪**。

不是「默认关掉」，是「默认一个字节都不发出去」。`analytics.enabled` 缺省是 `false`，
此时产物里**不存在任何统计 `<script>` 标签、不存在任何探针端点的引用** ——
不是「加载了但不发送」，是根本不生成。

> 用户选择 Emeek 是因为它干净。默认开追踪就是背叛。

---

## 一、为什么内置分析能不依赖任何服务

Emeek 的基因优势：**博客本来就在 GitHub 上。**

评论在 Issues 里、reaction 在 Issues 里、发布时间在 Issues 里、标签就是 Issue Label。
所以「有多少篇、什么时候写的、哪些标签多、哪篇讨论热」这些问题的答案
**已经在内容里了**，构建期算一遍就有，不需要任何运行时依赖，
也不需要把访客的 IP 抄下来。

这一层产出的东西写在 [`packages/core/src/analytics/builtin.js`](../packages/core/src/analytics/builtin.js)，
全部是纯函数（`posts` 进，数据出），可以直接在测试里断言。

### 三条诚实边界

| 数据 | 能不能得到 | 我们怎么做 |
|------|-----------|-----------|
| 文章数 / 字数 / 标签分布 | ✅ 构建期可得 | 直接算 |
| 评论数 / reaction 数 | ⚠️ 只在 GitHub Issues 源下有 | **没有就返回 `null`，不返回 `0`** |
| 浏览量（PV） | ❌ 构建期造不出来 | 字段值恒为 `null`，页面显示「—」 |
| 访问来源（referer） | ❌ 只有服务端有 | 整块不渲染 |

**`null` 与 `0` 是两个不同的东西。** 0 会被读成「确实没有」，而 `null` 的含义是
「没有这个数据源」。页面上前者显示 `0`，后者显示 `—` 并标注「无数据源」。

> 一张不写数据来源的统计表，读者无法判断它是不是编的。
> 所以统计页底部的「数据来源」区块**不可关闭**。

---

## 二、配置

```js
// emeeek.config.js
export default {
  analytics: {
    enabled: false,          // 默认关闭。关闭时产物里零统计脚本。
    provider: 'builtin',     // builtin | plausible | umami | goatcounter | custom

    plausible:   { domain: '', scriptSrc: 'https://plausible.io/js/script.js' },
    umami:       { websiteId: '', scriptSrc: '' },
    goatcounter: { code: '', scriptSrc: 'https://gc.zgo.at/count.js' },
    custom:      { headScript: '', footerScript: '' },

    builtin: {
      trackPageViews: false, // 自托管 PV 记录（需要 endpoint）
      endpoint: '',          // 你的收集端点。Emeek 不提供收集服务。
      retentionDays: 90,     // 数据保留期，进探针上报体，由服务端裁剪
      excludeAdmin: true,
    },

    statsPage: {
      enabled: false,        // 统计页默认也关
      path: '/stats/',
      nav: true,             // 出现在导航里
      sections: ['totals', 'frequency', 'top', 'tags', 'heatmap'],
      // 'sources'（数据来源）不可关闭 —— 它是这一页诚实性的落点
    },
  },
};
```

**`analytics.enabled` 与 `analytics.statsPage.enabled` 是分开的两个开关。**
统计页展示的是「内容事实」（多少篇、什么时候写的），与「要不要追踪访客」是两件事。
有人想要统计页但不想开任何分析，也有人开分析但不想要公开页面 ——
把它们绑在一个开关上，两种人都得不到自己想要的。

---

## 三、五家分析服务

### 1. `builtin` —— 内置极简（默认推荐）

构建期从内容推断，产物里**没有任何统计脚本**。它是零请求的那个。

```js
analytics: { enabled: true, provider: 'builtin' }
```

打开 `trackPageViews` 之后才多出一个运行时探针（见第四节），
它只往**你自己托管**的端点发数据。

### 2. `plausible` —— 隐私友好 SaaS

```js
analytics: {
  enabled: true,
  provider: 'plausible',
  plausible: { domain: 'blog.example.com' },
}
```

注入 `<script defer data-domain="…" src="https://plausible.io/js/script.js">`。
`scriptSrc` 可改成自托管 Plausible 的地址。

### 3. `umami` —— 自托管

```js
analytics: {
  enabled: true,
  provider: 'umami',
  umami: { websiteId: 'xxxxxxxx', scriptSrc: 'https://analytics.example.com/umami.js' },
}
```

`websiteId` 与 `scriptSrc` 都是必填 —— 缺一个构建直接失败，
而不是注入一个半残的脚本（「配了但不生效」比报错难查得多）。

### 4. `goatcounter` —— 免费 / 开源

```js
analytics: { enabled: true, provider: 'goatcounter', goatcounter: { code: 'myblog' } }
```

`code` 只接受字母、数字、点、下划线与连字符 —— 它要被拼进域名
（`https://<code>.goatcounter.com/count`），不做校验就是一个开放重定向。

### 5. `custom` —— 用户自填代码（**会破坏零第三方请求承诺**）

```js
analytics: {
  enabled: true,
  provider: 'custom',
  custom: {
    headScript: '',    // 注入到 </head> 前
    footerScript: '',  // 注入到 body 末尾
  },
}
```

⚠️ **这是唯一一处用户能塞进任意代码的地方。**

我们无法在不知道一段 JS 是什么的前提下消毒它，转义只会把它变成一段什么都不干的文本。
所以这里的信任模型是「用户在自己的站点里放自己的代码」——
与 `customCSS` / `customHead` 不同，那两者有白名单，这个没有。

唯一做的一件事是**打散 `</script>`**：不打散的话，脚本块会被提前结束，
后面的内容被当 HTML 解析 —— 一条不需要任何技巧的 XSS。

用 `custom` 就等于放弃了「零第三方请求」这个承诺。文档与 `emeeek doctor` 都会警告。

---

## 四、内置 PV 探针（自托管那一半）

```js
analytics: {
  enabled: true,
  provider: 'builtin',
  builtin: {
    trackPageViews: true,
    endpoint: 'https://collect.your-own-host/count',
    retentionDays: 90,
  },
}
```

这是整个 Emeek 里**唯一一处会主动把访客数据发出去**的代码。
所以它的自我约束是硬编码的，不是可配置的：

| 约束 | 实现 |
|------|------|
| 不用 Cookie | 脚本里不存在 `document.cookie` |
| 不用 localStorage | 不存任何客户端状态 |
| 不发明文 IP / UA | 两者各取哈希，只用于粗粒度去重 |
| 不发 referer | 脚本里不存在 `referrer` |
| 不发屏幕尺寸 / 语言 / 时区 | 同上 |
| 只发 pathname | `location.pathname`，**不带 query**（query 里常有 token 与追踪参数） |
| 失败静默 | 统计失败不该在读者控制台里刷红字 |
| 不阻塞首屏 | 整段跑在 `load` 之后 |
| 卸载时也能发出去 | 优先 `navigator.sendBeacon`（`fetch` 在 unload 中常被取消） |
| 体积 | 探针 + 标签 < 900 字节（有测试钉住） |

上报体只有四个字段：

```json
{ "p": "/posts/hello.html", "t": 1750000000000, "u": "<hash>", "r": 90 }
```

| 字段 | 含义 |
|------|------|
| `p` | 页面路径（不含 query / hash） |
| `t` | 时间戳（毫秒） |
| `u` | visitor key —— **不是 IP，不是 UA**，是两者拼接后的 FNV-1a 哈希 |
| `r` | 数据保留期（天），服务端按它裁剪 |

> **关于哈希的诚实说明**：FNV-1a 不是加密哈希，IP 段的候选值本来就不多，
> 所以它对攻击者是**可枚举**的。它挡的是「把 IP 明文写进日志」，
> 不是「让人无法推断某个 IP 是否访问过」。别把它当匿名化用。

### 服务端要做什么

Emeek **不提供**收集服务。你的端点是几十行代码的事：

```js
// 伪代码：任何能收 POST 的地方都行
app.post('/count', (req, res) => {
  const { p, t, u, r } = JSON.parse(req.body);
  // 1. 按 r 天裁剪历史
  // 2. 同 u + 同 p 在 30 分钟内的重复请求算一次
  // 3. 只落盘 { path, count, date } —— 不落 u 的明文
  res.status(204).end();
});
```

`summarizeHits()`（[`analytics/probe.js`](../packages/core/src/analytics/probe.js)）
已经实现了第 2、3 步的去重与聚合逻辑，服务端可以直接复用：

```js
import { summarizeHits } from '@emeeek/core';
const report = summarizeHits(logLines);
// { items: [{ path, views }], total, dropped }
```

去重窗口写死 30 分钟：同一 visitor key 在同一路径上 30 分钟内的重复请求算一次。
这是「刷新 20 次 = 20 次浏览」与「同一个人读两遍 = 2 次」之间的折中。
**口径写在代码里** —— 一个没说清口径的 PV 数字比没有数字更糟。

**服务端不落盘 `u`** 是关键：落盘之后，那些哈希就成了一个可关联的访客 ID，
而探针这一侧的克制就白费了。

---

## 五、统计页 `/stats/`

```js
analytics: {
  enabled: false,                        // 可以不开分析
  statsPage: { enabled: true, nav: true } // 但开统计页
}
```

### 设计约束

- **纯 HTML + SVG，零 JavaScript。** 图表是构建期算好坐标的 SVG，不是一个需要 30KB JS 才显示的 canvas。
- **4 套主题各写样式。** 数据形状由引擎统一（`stats/index.js`），外壳与配色由主题决定。
- **响应式。** `viewBox` + `preserveAspectRatio` 让图表自己缩放，手机端单栏堆叠。
- **可访问。** 每张图有 `role="img"`、`aria-label`、`<title>`、`<desc>`，屏幕阅读器能念出真实数值。

### 图表

| 图表 | 数据 | 位置 |
|------|------|------|
| 数字卡片 | 文章 / 评论 / 字数 / 运行天数 | `totals` |
| 柱状图 | 月度发文量（**补零** —— 没文章的月份也有位置，否则 x 轴被压扁） | `frequency` |
| 折线图 | 累计发文量（与柱状图共用输入，所以「柱子加起来 = 折线终点」结构上成立） | `frequency` |
| 环形图 | 标签分布（前 6 个 + 「其它」） | `tags` |
| 词云 | 标签（字号 + 不透明度双重编码权重） | `tags` |
| 热力图 | 365 天发文密度，按周分列 | `heatmap` |
| 排行 | 热门文章 / 浏览量 | `top` / `pv` |

### 空数据的处理

**任何一张图在数据为空时都不渲染。** 不是画一个全 0 的图 ——
那看起来像「有数据，只是都是 0」。区块整块消失，页面上没有那一节。

空站点的统计页只剩数字卡片（全是 0 或 `—`）与「数据来源」说明。

### 排序依据必须写出来

热门文章的排序依据有两种，页面会明说：

- 有 Issues 互动数据 → 「按评论 + reaction 排序」
- 没有（`local` 源）→ 「按字数排序」

> 一个不写排序依据的「热门」榜单是在骗人。

---

## 六、CSP 指引

如果你站点上配了 `Content-Security-Policy`，按所用 provider 加白名单：

| provider | `script-src` | `connect-src` |
|----------|--------------|---------------|
| `builtin`（无 PV） | 不需要 | 不需要 |
| `builtin`（开 PV） | 不需要（内联，需 `'unsafe-inline'` 或 nonce） | 你的 endpoint |
| `plausible` | `https://plausible.io` | `https://plausible.io` |
| `umami` | 你的 `scriptSrc` 域 | 你的 `scriptSrc` 域 |
| `goatcounter` | `https://gc.zgo.at` | `https://<code>.goatcounter.com` |
| `custom` | 由你决定 | 由你决定 |

`emeek doctor` 会打印当前配置实际需要的域：

```bash
npx emeeek doctor --cwd myblog
```

---

## 七、`emeek doctor` 会检查什么

- `analytics.enabled` 与 `statsPage.enabled` 的实际取值
- provider 是否有必填项缺失
- 数据会发往哪个域（`origin`）—— 空白表示站内，不发往第三方
- 开了 PV 但没有 `endpoint`
- 开了 `custom` provider（警告它会破坏零第三方请求承诺）
- 统计页启用了但主题没有 `stats` 布局

---

## 八、验证

```bash
# 单测（分析与统计）
node --test packages/core/tests/analytics/*.test.js packages/core/tests/stats/*.test.js

# 负向验证：零追踪 / 探针隐私 / 不编数据 / 图表零 JS 等 15 条
bash scripts/e2e/negative-check.sh

# 端到端：真实构建 + 真 Chromium 检查统计页零 JS、图表存在、区块缺席
node scripts/e2e/stats.mjs
```

---

## 九、相关决策

- [0008 — 分析层：零追踪与构建期推断](decisions/0008-analytics-zero-tracking.md)
