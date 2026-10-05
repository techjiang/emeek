# D6 · 部署是一等公民，不是脚本合集

**状态**：已确认（P3-4a 落地）
**日期**：2024

## 背景：Gmeek 的第三根支柱没有兑现

Emeek 继承 Gmeek 的三根支柱，其中「部署即一片静态文件」在 P3-3 之前只是**一句口号**：
文档让你把 `dist/` 丢到任意静态托管，但「怎么丢」是用户自己的事。

这不对。建完博客发不出去 = 白建。部署是用户体验的**最后一公里**。

## 决策

**把平台差异全部收进一张注册表，`deploy` 命令本身不含任何平台判断。**

```
packages/core/src/deploy/
├── platforms.js     每个平台声明：生成哪些文件、怎么推送、部署后验证什么
├── config-files.js  各平台配置文件生成（纯函数：config → 字符串）
├── preflight.js     部署前门禁（产物级检查）
└── index.js         编排：plan → prepare → verify → deploy
```

新增一个平台 = 往 `platforms.js` 加一条。`deploy.js`（CLI）里没有
`if (target === 'vercel')` —— 有那个 if 的第一天，就注定有第二个、第三个。

## 四个可独立断言的阶段

```
plan     纯计算：该平台要哪些文件、跑什么命令、验证哪些路径
prepare  写盘，幂等：内容一致则跳过（mtime 不变）
verify   部署后探测，可注入 fetcher（所以能在单测里跑完整个验证流程）
deploy   编排以上四步 + build + push
```

**为什么 `verify` 必须可注入 fetcher**：否则「部署验证」在 CI 里就只是祈祷。
注入之后，「探针命中 / 静默 404 / 网络异常」三种情况都被测试盯住。

## 三个关键取舍

### 1. 幂等 = 内容一致时不重写

`prepare` 在内容与磁盘一致时跳过写盘，**不更新 mtime**。
否则每次部署都会让 `git status` 变脏，或者更糟 —— 触发无意义的重建。

负向验证：把「内容一致则跳过」改成永远重写 → 断言 mtime 不变的测试必须红。

### 2. 验证不只看 HTTP 200

静态托管在找不到页面时常回落到 `404.html` 但返回 **200**。
只看状态码会把这种静默 404 当成成功，于是「部署成功」而页面打不开。

所以每个探针带一个内容谓词：

```javascript
{ path: '/sitemap.xml', expect: (body) => /<urlset/i.test(body) }
```

负向验证：把谓词判断去掉、只留 `response.ok` → 静默 404 的测试必须红。

### 3. 部署前门禁拦截「本地看不出、部署后才暴露」的问题

- `site.url` 还是 `example.com` → sitemap / canonical / OG 全指向占位域名
- 只有草稿、没有正式文章 → 发布出去是个白板

这两条在本地构建时都是「成功」的，只有部署后才会暴露。
门禁把它们提前到推送**之前**，任何一条不过就中止，产物不推。

负向验证：让 `preflight` 恒通过 → 「拦截占位域名」的测试必须红。

## 为什么 `weaken` 从 sed 改成 Python

旧的 `scripts/e2e/negative-check.sh` 用 sed 做削弱。
在「源码里有引号、斜杠、多个转义层」时，sed 表达式极易失配 ——
而**失配的表现恰好是「削弱没生效」**，那这条负向验证本身就成了假的，比没有更糟。

改用 `scripts/e2e/weaken.py`（Python `re` + `MULTILINE`）：
未匹配时以非零码退出，脚本据此判红。**失败要响亮，不要假装通过。**

## 验收

- `packages/core/tests/deploy/` —— 54 条单测（platforms / config-files / engine）
- `packages/cli/tests/deploy.test.js` —— 13 条 CLI 测试
- 负向验证 11 条（含 5 条部署专用），`bash scripts/e2e/negative-check.sh` 全绿
- 部署模块行覆盖率 ≥ 97%
