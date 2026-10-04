# 搜索

Emeek 的搜索是**全静态**的：构建期把文章切成词元、建成倒排表、写成一个
JSON 文件；浏览器取到这个文件后在本地查询。没有搜索服务，没有数据库，
没有网络往返。

## 为什么这么设计

搜索是用户「找到内容」的唯一入口。搜不到 = 内容不存在。所以它必须：

- **在离线 / 静态托管上也能用**（GitHub Pages 没有后端）
- **首屏不吃亏**（索引跟着页面一起下载，不能是几 MB 的胖子）
- **中文可用**（中文没有词边界，按空格切词的方案在这里直接失效）

三条一起，指向「构建期建索引 + 客户端查询」。

## 三类词元

中文分词的核心矛盾：**切得太粗召回不够，切得太细噪声太多**。
「主题系统」切成一个词，搜「主题」就命中不了；切成单字，搜「主题系统」
又会召回一堆只有「主」「题」的文章。

所以分三档，各司其职：

| 类别 | 来源 | 用途 | 例 |
| --- | --- | --- | --- |
| `words` | 词典词 / 英文词 / 数字串 | 精确匹配，AND 约束的主力 | `博客`、`markdown`、`2024` |
| `bigrams` | CJK 相邻二字 | 放宽级字面召回（搜半截词靠它） | `博客`、`客引` |
| `singles` | CJK 单字 | 最后兜底，不参与正常组合 | `博`、`客` |

分词器复用 `packages/core/src/ai/local/segmenter.js`（Viterbi 最大概率路径 +
12.9 万词条词典 + 惰性加载）。**没有第二套切分规则** —— 搜索最怕的就是
两侧规则不一致：索引切出一种词元，查询切出另一种，两边单独看都对，
合起来搜不到。

## 查询策略链

查询分三级，逐级放宽。每一级都明确知道自己在牺牲什么。

```
Level 1   AND(words ∪ titleIndex)    高精度。所有词同时命中
Level 2   OR(words + bigrams)        字面召回。半截词靠 bigram 捞回来
Level 3   子串扫描                    最后手段。词库里没有但正文确实含
```

两个必须记住的约束：

**AND 只用 `words`，绝不用 `bigrams`。**
「主题系统」的 bigram 里有「题系」。如果 bigram 也进 AND，就等于要求
正文里「主题」和「系统」必须紧挨着写成「题系」—— 正常写法里它们根本
不构成那个 bigram，结果是漏掉本该命中的文章。

**标题词单独建表（`titleIndex`）并在查询期并进 AND。**
标题含「博客」而正文不含的文章（很常见 —— 标题就是关键词），如果只查
正文倒排表，它永远搜不到。

## 索引的体积

`content` 进倒排表（可搜）但**不进 `docs`（不存）**。前端只存 `excerpt`。

实测：100 篇 6KB 文章 → `raw 90.6KB / gzip 2.7KB`。

构建期会守住「gzip 后 < 500KB」这条预算，超了**默认让构建失败** ——
索引跟着页面下载，发一个几 MB 的索引给每个访客，与「搜索是增强」自相矛盾。

```js
// emeeek.config.js
export default {
  search: {
    enabled: true,
    fuzzy: true,          // ≥4 字 CJK 词元的编辑距离 1 展开
    maxResults: 10,
    suggest: 8,           // 输入联想条数上限
    indexPath: '/search-index.json',
    pagePath: '/search/', // 搜索页路径
    gzipBudget: 512000,   // 索引 gzip 上限（字节）
    inlineLimit: 65536,   // 超过这个字节就不内联进页面，改走外链
    allowOverBudget: false,
  },
};
```

## 词表惰性加载

索引在构建期用词典切（所以 `words` 表里是「博客」这样的完整词）。
但前端首次打开时词典还没加载 —— 此时 `analyze()` 切不出词典词，
索引里明明有「博客」却匹配不上。**这是「索引与查询分叉」最隐蔽的一种。**

解法是 `matchIndexedWords()`：查询期不依赖重新分词，而是拿输入串去
**索引的 `words` 表**里找已存在的词元（最长优先）。词典缺失时仍能走
Level 1 精确 AND，结果与词典就绪时一致。

词表在后台异步加载（`prepareDictionary`），状态：
`loading → decompressing → indexing → ready`。
**加载失败只告警不抛错** —— 搜索是增强，不是依赖。
词表就绪后**不重建索引**：`bigram` 层已经把大部分中文检索覆盖住了。

## 搜索页

`/search/`，4 套主题各有一份 `layouts/search.html` 与 `styles/search.css`，
共用同一份客户端逻辑（`packages/core/src/search/ui/`），差异全在 CSS。

功能：

- 结果以 `<mark>` 高亮命中词（走各主题 `--accent`，亮暗自动跟随）
- 摘要以命中词为中心截取（而不是从头截 —— 从头的截图里常常看不到高亮）
- 输入联想：防抖 150ms、最多 8 条、`↑↓` 选择、`Enter` 确认
- 过滤器：分类 / 标签 / 日期范围 / 排序
- URL 同步：`?q=&category=&tag=&from=&to=&sort=`，可分享、可后退、刷新保持
- 搜索历史（localStorage，最多 8 条）
- **无 JS 兜底**：`<form method="get" action="/search/">`，脚本只做增强

页头页脚各有一个搜索入口（`header` 的图标与 `nav`），都指向搜索页。
**搜索只有一个实现** —— 两套必然会分叉。

## 零依赖

搜索层的浏览器入口（`@emeeek/core/search`）**不允许有任何顶层 `node:` 依赖**。
这条边界由 `scripts/check-search-browser-deps.mjs` 静态扫描依赖闭包守住，
并在负向校验里确认「削弱即红」。

构建期接缝（用 `node:zlib` 量 gzip 体积）走另一个入口
`@emeeek/core/search/build`，不出现在浏览器闭包里。

## 可复现命令

```bash
node scripts/e2e/search.mjs          # 构建产物 → 运行时，12 项
node scripts/e2e/search-page.mjs     # 4 主题 × 桌面/移动，134 项
node scripts/check-search-browser-deps.mjs
node --test packages/core/tests/search/
```
