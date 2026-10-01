import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ReadabilityAnalyzer, analyzeStructure, sentenceLength } from '../../src/ai/local/readability.js';

const analyzer = new ReadabilityAnalyzer();

const ACADEMIC = '基于容器编排的微服务架构在服务发现与负载均衡方面所面临的幂等性语义问题，被广泛认为是分布式系统实现中需要被优先解决的核心挑战之一，因为其涉及到跨节点的一致性协议与吞吐量之间的权衡关系，而这种权衡在设计阶段往往由于缺乏对实际流量拓扑的充分认知而无法被准确评估。';

const COLLOQUIAL = '这个东西其实挺好用的。为什么这么说？因为它简单。你不需要配什么环境，装完就能跑。而且速度很快，基本感觉不到等待。不过它也有缺点，就是功能少。但是话说回来，功能少有时候是好事。';

const STRUCTURED = `## 缓存策略

本地缓存的问题在于失效。一旦数据在多个节点上被写入，你就要决定谁先看到新值。

我们选了 TTL 加主动失效的组合：

- TTL 兜底，防止失效消息丢失
- 写入时主动发消息，保证最终一致

代价是有短暂的窗口期。对博客这种读多写少的场景，可以接受。`;

describe('ReadabilityAnalyzer 指标计算', () => {
  test('输出结构与规格一致', () => {
    const result = analyzer.analyze(STRUCTURED);
    assert.equal(typeof result.score, 'number');
    assert.ok(result.score >= 0 && result.score <= 100);
    assert.ok(['极佳', '良好', '一般', '困难'].includes(result.level));
    assert.ok(result.metrics.avg_sentence_length);
    assert.ok(typeof result.metrics.ttr === 'number');
    assert.ok(Array.isArray(result.suggestions));
    assert.ok(Array.isArray(result.distribution.sentence_lengths));
    assert.ok(Array.isArray(result.distribution.paragraph_lengths));
  });

  test('中英文句长分开统计', () => {
    const text = 'Emeek is a static site generator. It turns issues into a blog. 这是一个中文段落，用来验证中文句长会被单独统计出来。而且它应该和英文句长互不干扰。';
    const result = analyzer.analyze(text);
    assert.ok(result.metrics.avg_sentence_length.en > 0, '英文句长应大于 0');
    assert.ok(result.metrics.avg_sentence_length.zh > 0, '中文句长应大于 0');
  });

  test('中文按字计长、英文按词计长', () => {
    assert.equal(sentenceLength('这是一个中文字句子'), 9);
    assert.equal(sentenceLength('This is a six word sentence'), 6);
  });

  test('TTR 在 0~1 之间', () => {
    for (const text of [ACADEMIC, COLLOQUIAL, STRUCTURED]) {
      const { metrics } = analyzer.analyze(text);
      assert.ok(metrics.ttr >= 0 && metrics.ttr <= 1, `TTR 越界：${metrics.ttr}`);
    }
  });

  test('被动语态占比不超过 1', () => {
    const { metrics } = analyzer.analyze(ACADEMIC);
    assert.ok(metrics.passive_voice_ratio <= 1, `被动占比越界：${metrics.passive_voice_ratio}`);
  });

  test('「由于」不被误判为被动语态', () => {
    // 「由」是高频误报源：它是因果连接词，不是被动标记
    const causal = analyzer.analyze('由于天气原因，活动取消了。由于预算不足，方案否决了。因此需要重新评估这个计划。');
    assert.equal(causal.metrics.passive_voice_ratio, 0, '「由于」不应计入被动语态');
  });

  test('真正的被动语态被识别', () => {
    const passive = analyzer.analyze('这个问题被解决了。方案被否决了。代码被重构了。测试被通过了。');
    assert.ok(passive.metrics.passive_voice_ratio > 0.5, '应识别出被动语态');
  });

  test('连接词密度按类型统计', () => {
    const { metrics } = analyzer.analyze('首先我们要明确目标。其次要拆解任务。因此需要先做调研，然后才能动手。总之先小步验证。');
    assert.ok(metrics.transition_density > 0);
    assert.ok(metrics.transition_breakdown);
    assert.ok(Object.values(metrics.transition_breakdown).some((n) => n > 0));
  });

  test('段落结构统计小标题、列表、图片', () => {
    const structure = analyzeStructure(`# 标题\n\n正文一段。\n\n## 小节\n\n- 项目一\n- 项目二\n\n![配图](/x.png)\n\n| a | b |\n| --- | --- |\n| 1 | 2 |`);
    assert.equal(structure.detail.headings, 2);
    assert.equal(structure.detail.listLines, 2);
    assert.equal(structure.detail.images, 1);
    assert.equal(structure.detail.tableLines, 2);
    assert.ok(structure.score > 0.5);
  });
});

describe('ReadabilityAnalyzer 评分区分度', () => {
  test('学术长句得分显著低于口语短句', () => {
    const academic = analyzer.analyze(ACADEMIC);
    const colloquial = analyzer.analyze(COLLOQUIAL);
    assert.ok(academic.score < colloquial.score, `学术文 ${academic.score} 应低于口语文 ${colloquial.score}`);
    assert.ok(academic.level === '困难' || academic.level === '一般');
  });

  test('结构化文本比无结构文本得分高', () => {
    const structured = analyzer.analyze(STRUCTURED);
    const flat = analyzer.analyze('本地缓存的问题在于失效。一旦数据在多个节点上被写入，你就要决定谁先看到新值。我们选了 TTL 加主动失效的组合。TTL 兜底防止失效消息丢失。代价是有短暂的窗口期。对博客这种读多写少的场景可以接受。');
    assert.ok(structured.metrics.structure_score > flat.metrics.structure_score);
  });

  test('评分是确定性的（同一输入永远同样结果）', () => {
    const a = analyzer.analyze(STRUCTURED);
    const b = analyzer.analyze(STRUCTURED);
    assert.equal(a.score, b.score);
    assert.deepEqual(a.metrics, b.metrics);
  });

  test('真实文档评分落在良好区间', async () => {
    const { readFile } = await import('node:fs/promises');
    const text = await readFile(new URL('../../../../examples/minimal/posts/2024-01-15-why-emeeek.md', import.meta.url), 'utf8');
    const result = analyzer.analyze(text);
    assert.ok(result.score >= 60, `示例文档应至少「一般」，实际 ${result.score}`);
  });
});

describe('ReadabilityAnalyzer 建议质量', () => {
  test('建议指明具体位置而非空泛表述', () => {
    const longParagraph = `段落一的内容在这里。第二段开始写了很长的一段话，这句话是第一句，用来描述背景与动机。这是第二句，解释为什么要做这件事。这是第三句，说明具体做法是什么。这是第四句，补充一个反例。这是第五句，讨论边界情况。这是第六句，说明例外。这是第七句，收尾总结一下观点。`;
    const result = analyzer.analyze(longParagraph);
    const paragraphAdvice = result.suggestions.find((s) => s.includes('段'));
    assert.ok(paragraphAdvice, '应给出段落拆分建议');
    assert.ok(/\d/.test(paragraphAdvice), '建议里应包含具体段落序号或句数');
  });

  test('健康文本给出肯定而非硬凑问题', () => {
    const result = analyzer.analyze('## 结论\n\n这个方案可行。它简单，够用，维护成本低。我们决定采用它。\n\n- 简单\n- 够用\n- 便宜');
    // 不应出现「建议优化」这类无信息量的建议
    for (const suggestion of result.suggestions) {
      assert.ok(suggestion.length > 8, `建议过短、无信息量：${suggestion}`);
    }
  });

  test('被动语态在合理范围时明确说明正常', () => {
    const result = analyzer.analyze('这个方案被我们采用了。它很简单。维护成本也不高。整体来说是个不错的选择。');
    assert.ok(result.suggestions.some((s) => s.includes('被动')), '应提及被动语态');
  });

  test('空输入不崩溃', () => {
    const result = analyzer.analyze('');
    assert.equal(result.score >= 0, true);
    assert.ok(Array.isArray(result.suggestions));
  });
});

describe('ReadabilityAnalyzer 性能', () => {
  test('10KB 文本分析 < 30ms', () => {
    let text = STRUCTURED;
    while (text.length < 10000) text += `\n\n${STRUCTURED}`;
    text = text.slice(0, 10000);
    for (let i = 0; i < 3; i += 1) analyzer.analyze(text);

    const start = performance.now();
    analyzer.analyze(text);
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 30, `可读性分析耗时 ${elapsed.toFixed(1)}ms，超过 30ms`);
  });
});
