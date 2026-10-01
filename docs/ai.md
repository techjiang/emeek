# AI 能力

Emeek 的 AI 分两层：**本地算法**（零依赖、永远可用）与 **LLM Provider**（可选、质量更高）。
两层走同一个接口，上层不需要知道结果是谁算出来的。

核心原则：**AI 是增强不是必需。** 没配 API Key 时功能变差，但不能不可用。

## 离线可用性矩阵

| 功能 | 有 API Key | 无 API Key（降级） | 本地质量 |
| --- | --- | --- | --- |
| 摘要 | AI 摘要 ✨ | **快速摘要**（抽取式） | medium |
| 标签 | AI 标签 ✨ | **关键词提取**（TF-IDF） | medium |
| 可读性 | 可读性分析 | 可读性分析 | **high** |
| SEO | AI SEO 建议 ✨ | **SEO 检查**（规则） | **high** |
| 标题 | AI 标题建议 ✨ | 标题建议（模板） | medium |
| 续写 / 改写 / 扩写 / 精简 / 翻译 | ✅ | ❌ 明确不可用 | — |

生成类任务（续写、改写）没有本地替代。它们**明确报错**而不是返回一个勉强能看的
结果 —— 编辑流程里塞进一段不该出现的话，比什么都不做更糟。

## 界面文案的来源

UI 的标注文案由 `TASK_CAPABILITIES` 统一提供，改文案不用动组件：

```js
import { TASK_CAPABILITIES } from '@emeeek/core';

TASK_CAPABILITIES.summarize;
// { local: true, label: '快速摘要', aiLabel: 'AI 摘要' }
```

降级提示条只需判断 `service.isDegraded`：

```
当前使用本地算法。配置 AI API Key 可获得更高品质结果。  [配置 AI] [忽略]
```

## 可读性与 SEO 为什么不用 LLM

这两个模块**刻意走本地计算**，即使配了 API Key 也一样。

原因是 LLM 会为「可读性分数」编造一个看起来合理但无法复现的数字。
作者改了一句话，分数该动就得动；两个人拿同一篇文章算，结果该一样。
本地确定性计算满足这两点，LLM 不满足。

LLM 在 SEO 上只被用来补充**建议文字**，而且失败也无所谓 —— 规则检查的结论已经完整。

## 配置

```js
// emeeek.config.js
export default {
  ai: {
    // 主 Provider（可选）
    providers: {
      openai: {
        apiKey: process.env.OPENAI_API_KEY,
        model: 'gpt-4o-mini',
        // 任何 OpenAI 兼容服务都能用：DeepSeek / Moonshot / 本地 vLLM
        baseURL: 'https://api.openai.com/v1',
      },
      anthropic: {
        apiKey: process.env.ANTHROPIC_API_KEY,
        model: 'claude-3-5-haiku-latest',
      },
    },

    // 提示词模板覆盖目录（可选）
    // 模板见 packages/core/src/ai/prompts/templates/*.txt
    promptsDir: './prompts',
  },
};
```

**API Key 不落盘。** Emeek 不存储 Key，也不把用户内容发往任何 Emeek 自有服务 ——
所有请求都由用户自己的环境直连所选 Provider。

## 编程接口

```js
import { AIService } from '@emeeek/core';

// 从配置构建：自动探测可用的 Provider，失败则降级
const ai = await AIService.fromConfig(config);

// 摘要（离线也能用）
const summary = await ai.summarize(markdown, { title: '文章标题' });
summary.content;   // { short, medium, long }
summary.source;    // 'openai' | 'anthropic' | 'local'
summary.quality;   // 'generative' | 'medium' | 'high'

// 可读性（始终本地计算）
const readability = await ai.readability(markdown);
readability.content.score;      // 0~100
readability.content.suggestions; // 具体可执行的建议

// SEO 检查
const seo = await ai.seo(post);

// 关键词
const tags = await ai.tags(markdown, { top: 8 });

// 先查能力，再决定要不要显示按钮
const capabilities = ai.capabilities();
capabilities.continue.available; // false（离线时）
```

## 本地算法

三个模块都在 `packages/core/src/ai/local/`，零外部依赖。

### 摘要（`summarizer.js`）

抽取式，多特征加权打分后贪心选择：

| 特征 | 权重 |
| --- | --- |
| 首段 / 尾段句 | ×1.15 |
| 段首句 | ×1.05 |
| 长度 20~60 字 | ×1.1 |
| 命中 TF-IDF Top-20 关键词 | ×1.2 |
| 含数字 / 百分比 | ×1.05~1.1 |
| 与已选句子相似度 > 0.7 | 丢弃 |

选完之后按**原文顺序**重排 —— 按分数排序会得到「东一句西一句」的摘要。

**不产生幻觉**是可断言的：抽取式摘要的每一句都能在原文里逐字找到，
测试直接验证这一点。

### 可读性（`readability.js`）

八项指标：平均句长（中英分开）、平均段长、TTR、句式复杂度、被动语态、
术语密度、连接词密度、结构化程度。加权 0~100 分。

中文与英文的阈值不同 —— 中文单字信息密度高，同样字数读起来更短，
把英文的 15~25 词直接搬过来会让中文文章一律判定为「好读」。

被动语态识别要处理中文的坑：`由于` 是因果连接词不是被动标记，
`由 A 所 B` 才是。这类边界不处理，一篇普通文章的被动占比能虚高一倍。

### SEO（`seo.js`）

20 项检查，覆盖标题 / 元描述 / 关键词 / 内链 / 结构 / 社交卡片 / 技术 SEO。

每条检查在非 pass 时**必须**给出具体建议，且建议里要出现具体字符串：

```
✗ 标题缺少核心关键词
  建议改为「Emeek 博客引擎 — 零成本个人站点方案」
      —— 这样搜索结果里用户能立刻看出文章讲什么。

✗ 元描述长度 36 字符，偏短，浪费了展示空间
  建议扩到 50~160 字符。可以补一句这篇文章解决了什么问题：…

✗ 1/3 张图片缺少有效的 alt 文本（第一张：/assets/no-alt.png）
  alt 是图片搜索的唯一入口，也是屏幕阅读器用户的唯一信息来源。
  请描述图片内容，而不是写「图片」。
```

给不出具体建议的检查项宁可不做。「SEO 得分 45」没有价值。

### 中文分词（`segmenter.js`）

摘要要算 TF-IDF、可读性要算词汇丰富度，都需要「知道什么是词」。

**无词典方案不可行**：互信息切分依赖足够的语料估计凝固度，
单篇文章（尤其短文本）提供不了，实测会切出 `客引`（博客引擎）、
`擎基`、`让写和` 这类碎片，直接污染关键词表。

所以内置了一份 12.9 万词条的词表 + Viterbi 最大概率路径切分：

```
博客引擎基于 GitHub 构建静态站点
→ 博客 | 引擎 | 基于 | GitHub | 构建 | 静态站点
```

词表来源与格式见 `packages/core/src/ai/local/dict/README.md`。
词典**惰性加载**（≈50ms），只影响关键词质量，不影响摘要主体 ——
加载失败时退化为字级统计，功能不中断。

## 性能

`pnpm benchmark` 可复现（15KB 真实文档语料）：

| 模块 | 中位 | P90 | 目标 |
| --- | --- | --- | --- |
| 分词（词典已加载） | 0.03ms | 0.04ms | — |
| 关键词提取 top-5 | 12.9ms | 13.1ms | — |
| 摘要 `summarize(100)` | 10.1ms | 11.8ms | < 50ms |
| 摘要 `summarizeMulti` 三档 | 10.4ms | 10.7ms | < 100ms |
| 可读性分析 | 2.6ms | 2.9ms | < 30ms |
| SEO 分析 | 13.0ms | 13.5ms | < 30ms |

## 提示词模板

模板是 `.txt` 文件，不硬编码在代码里 —— 调优提示词不该需要改 JS、重发版。

```
packages/core/src/ai/prompts/templates/
├── summarize.txt    三档摘要
├── tags.txt         标签推荐
├── seo.txt          SEO 建议
├── continue.txt     续写
├── rewrite.txt      改写（5 种风格）
├── expand.txt       扩写
├── condense.txt     精简
├── translate.txt    翻译
└── title.txt        标题建议
```

模板语法只有 `{{变量}}`，没有条件与循环 —— 提示词不是程序，
一旦能写逻辑就会有人写逻辑，然后没人看得懂。

用 `ai.promptsDir` 指向自己的目录即可覆盖任意模板。
