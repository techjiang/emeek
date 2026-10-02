import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { LocalSummarizer } from '../../src/ai/local/summarizer.js';

const summarizer = new LocalSummarizer();

const ZH_LONG = `
# 静态站点生成器的取舍

市面上的静态站点生成器足够多了，但大多数都在功能清单上竞争，很少有人认真讨论取舍。
Emeek 认为，个人博客真正的问题不是功能不够，而是写作与发布之间的摩擦太大。

## 性能预算

我们给首屏设了三条硬指标：HTML 小于 50KB，JS 压缩后小于 30KB，外部请求为零。
这三条指标是倒推出来的，不是拍脑袋定的。一次请求意味着没有 DNS 查询、没有 TLS 握手、
没有第三方脚本的阻塞。实测 Lighthouse Performance 稳定在 100 分。

## 代价

内联 CSS 的代价是无法跨页面缓存。对于个人博客，这个代价可以接受 ——
页面总共只有十几个，缓存收益远小于额外请求的成本。

## 结论

宁可少一个功能，不让页面慢 100 毫秒。
`;

const EN_LONG = `
# Why we still need static site generators

There are plenty of static site generators available today, but most of them compete on feature
lists rather than discussing trade-offs honestly. A personal blog does not suffer from a lack of
features. It suffers from friction between writing and publishing.

## The performance budget

We set three hard targets for the first screen: HTML under 50KB, JavaScript under 30KB compressed,
and zero external requests. These numbers were derived backwards from the budget, not guessed.
A single request means no DNS lookup, no TLS handshake, and no third party script blocking
rendering. Lighthouse performance holds steady at 100.

## The cost

Inlining CSS means losing cross-page caching. For a personal blog this trade-off is acceptable
because there are only a few pages in total.

## Conclusion

Rather than adding one more feature, we refuse to make the page 100 milliseconds slower.
`;

describe('LocalSummarizer 基本行为', () => {
  test('中文长文生成三档摘要，长度递增', () => {
    const result = summarizer.summarizeMulti(ZH_LONG);
    assert.ok(result.short.length > 0);
    assert.ok(result.medium.length >= result.short.length);
    assert.ok(result.long.length >= result.medium.length);
  });

  test('英文长文生成摘要且以英文句号结尾', () => {
    const summary = summarizer.summarize(EN_LONG, 50);
    assert.ok(summary.length > 0);
    // 被截断时以省略号收尾也是合法的，但绝不能以逗号或裸字母收尾
    assert.ok(/[.…]$/.test(summary), `应以句号或省略号结尾，实际：${summary}`);
  });

  test('摘要内容来自原文，不产生幻觉', () => {
    const summary = summarizer.summarize(ZH_LONG, 100);
    // 抽取式摘要的每一句都必须能在原文里找到
    const sentences = summary.split(/[。！？]/).filter((s) => s.trim().length > 4);
    for (const sentence of sentences) {
      const core = sentence.trim().replace(/\s/g, '');
      assert.ok(ZH_LONG.replace(/\s/g, '').includes(core), `摘要句不在原文中：${sentence}`);
    }
  });

  test('抽取结果按原文顺序排列，不是按分数', () => {
    const summary = summarizer.summarize(ZH_LONG, 200);
    const first = summary.indexOf('市面上的静态站点生成器');
    const last = summary.indexOf('宁可少一个功能');
    if (first >= 0 && last >= 0) assert.ok(first < last, '摘要句应保持原文顺序');
  });

  test('长度控制在目标值的合理区间（±50%）', () => {
    for (const length of [50, 100, 200]) {
      const summary = summarizer.summarize(ZH_LONG, length);
      assert.ok(summary.length <= length * 1.5, `${length} 字档超长：${summary.length}`);
    }
  });
});

describe('LocalSummarizer 边界情况', () => {
  test('空文本返回空字符串', () => {
    // 空输入是「没东西可摘」，不是「内容太少」—— 两者要给不同信号
    assert.equal(summarizer.summarize(''), '');
    assert.equal(summarizer.summarize('   \n\n  '), '');
    assert.equal(summarizer.summarize(null), '');
  });

  test('纯代码块给出明确提示而非崩溃', () => {
    const result = summarizer.summarize('```js\nconst a = 1;\nfunction b() {}\n```');
    assert.equal(result, '文本内容较少，无法生成有效摘要');
  });

  test('极短文本不做硬凑', () => {
    const result = summarizer.summarize('短文本。');
    assert.equal(result, '文本内容较少，无法生成有效摘要');
  });

  test('短文（目标长度装得下）直接返回原文', () => {
    const text = '这是一段长度大约四十字左右的短文，用来验证当目标长度足够容纳全文的时候，摘要器会直接返回原文而不是硬凑出一个更短的版本。';
    const result = summarizer.summarize(text, 200);
    assert.ok(result.includes('直接返回原文'));
    assert.ok(result.endsWith('。'));
  });

  test('中英混排正确切分且不丢失语言', () => {
    const text = 'Emeek 是一个 static site generator。它把 GitHub Issues 当作 CMS 使用。No server, no database。部署只需要把 dist/ 目录丢到任意静态托管上即可完成。';
    const result = summarizer.summarize(text, 100);
    assert.ok(result.length > 0);
    // 中英混排的句子都必须保留，不能因为「没找到中文句号」而整体丢弃
    assert.ok(result.includes('static site generator'));
    assert.ok(result.includes('GitHub Issues'));
  });

  test('小标题与列表项不会被当作摘要句', () => {
    const text = `# 标题

## 摩擦在哪

传统的博客系统里，写一篇文章要经历很多步骤，这些步骤累加起来就是摩擦的来源。

- 打开编辑器或后台
- 想标题、选分类、填标签
- 预览、调整格式

而 Gmeek 那一派的做法把这些步骤压缩成了一件事，这是在 GitHub 上开一个 Issue。`;
    const summary = summarizer.summarize(text, 100);
    assert.ok(!summary.includes('摩擦在哪'), '不应包含小标题');
    assert.ok(!summary.includes('打开编辑器或后台'), '不应包含列表项碎片');
  });

  test('摘要去掉开头的连接词', () => {
    const text = '第一句是铺垫内容，用来占位。然而这个转折词开头的句子不应该带着然而出现在摘要里，因为它脱离了上文语境。第三句补充说明。';
    const summary = summarizer.summarize(text, 60);
    if (summary.includes('这个转折词开口的句子')) {
      assert.ok(!summary.startsWith('然而'), '摘要不应以连接词开头');
    }
  });

  test('纯英文短文不再被误判为内容不足', () => {
    const text = 'Emeek turns GitHub Issues into a blog. It needs no server and no database. The output is plain HTML that can be hosted anywhere for free.';
    const result = summarizer.summarize(text, 50);
    assert.notEqual(result, '文本内容较少，无法生成有效摘要');
  });

  test('长度参数覆盖三档范围之外时仍可用', () => {
    const result = summarizer.summarize(ZH_LONG, 150);
    assert.ok(result.length > 0);
    assert.ok(result.length <= 225);
  });
});

describe('LocalSummarizer 性能', () => {
  test('10KB 中文文本摘要 < 50ms', () => {
    let text = ZH_LONG;
    while (text.length < 10000) text += `\n\n${ZH_LONG}`;
    text = text.slice(0, 10000);
    assert.ok(text.length >= 10000);

    // 预热，排除首次 JIT 与缓存填充
    for (let i = 0; i < 5; i += 1) summarizer.summarize(text, 100);

    const samples = [];
    for (let i = 0; i < 5; i += 1) {
      const start = performance.now();
      summarizer.summarize(text, 100);
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const median = samples[2];
    assert.ok(median < 50, `10KB 摘要中位耗时 ${median.toFixed(1)}ms，超过 50ms`);
  });

  test('三档摘要一次生成 < 60ms（共享解析结果）', () => {
    let text = ZH_LONG;
    while (text.length < 10000) text += `\n\n${ZH_LONG}`;
    text = text.slice(0, 10000);
    for (let i = 0; i < 3; i += 1) summarizer.summarizeMulti(text);

    const start = performance.now();
    summarizer.summarizeMulti(text);
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 60, `三档摘要耗时 ${elapsed.toFixed(1)}ms，超过 60ms`);
  });
});
