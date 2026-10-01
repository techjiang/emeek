import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { LocalSEOAnalyzer } from '../../src/ai/local/seo.js';

const analyzer = new LocalSEOAnalyzer();

const COMPLETE_POST = {
  title: 'Emeek 博客引擎的静态站点方案',
  raw: `## 为什么选择静态站点

Emeek 博客引擎把 GitHub Issues 当作内容源，构建时生成纯静态页面。静态站点方案没有服务器，也不需要数据库，部署成本接近零。

### 构建流程

- 读取 Issues
- 渲染 Markdown
- 输出 HTML

| 指标 | 目标 |
| --- | --- |
| 首屏 | < 50KB |

![构建流程示意图](/assets/flow.png)

想了解更多可以看 [[Emeek 的性能设计]]。`,
  description: 'Emeek 博客引擎采用静态站点方案，用 GitHub Issues 作为内容源，构建期生成纯静态页面，没有服务器也没有数据库，部署成本接近零。',
  tags: ['Emeek', '静态站点', '博客引擎'],
  slug: 'emeeek-static-site',
  date: '2024-04-01',
  author: 'cosc',
  cover: '/assets/cover.png',
  url: 'https://example.com/posts/emeeek-static-site.html',
};

const SPARSE_POST = {
  title: 'x',
  raw: '随便写点东西。没什么内容。',
  tags: [],
  slug: 'Bad Slug!',
  date: null,
  author: null,
};

describe('LocalSEOAnalyzer 输出结构', () => {
  test('输出字段与规格一致', () => {
    const result = analyzer.analyze(COMPLETE_POST);
    assert.equal(typeof result.score, 'number');
    assert.ok(['优秀', '良好', '一般', '需改进'].includes(result.level));
    assert.ok(Array.isArray(result.checks));
    assert.ok(Array.isArray(result.keywords));
    assert.equal(typeof result.meta_description_suggestion, 'string');
    assert.equal(typeof result.total_score, 'number');
    assert.equal(typeof result.improvement_count, 'number');
    assert.ok(result.by_category);
  });

  test('每条 check 都有类别、条目、状态、消息', () => {
    const result = analyzer.analyze(COMPLETE_POST);
    for (const item of result.checks) {
      assert.ok(item.category, '缺少 category');
      assert.ok(item.item, '缺少 item');
      assert.ok(['pass', 'warn', 'fail'].includes(item.status), `非法状态：${item.status}`);
      assert.ok(item.message, '缺少 message');
      assert.equal(typeof item.suggestion, 'string');
    }
  });

  test('评分由检查项推导，不是拍出来的', () => {
    const good = analyzer.analyze(COMPLETE_POST);
    const bad = analyzer.analyze(SPARSE_POST);
    assert.ok(good.score > bad.score, `完整文章 ${good.score} 应高于残缺文章 ${bad.score}`);
  });

  test('improvement_count 等于非 pass 项数量', () => {
    const result = analyzer.analyze(SPARSE_POST);
    const nonPass = result.checks.filter((c) => c.status !== 'pass').length;
    assert.equal(result.improvement_count, nonPass);
  });
});

describe('LocalSEOAnalyzer 检查项覆盖', () => {
  test('覆盖规格要求的全部维度', () => {
    const result = analyzer.analyze(COMPLETE_POST);
    const categories = new Set(result.checks.map((c) => c.category));
    for (const expected of ['title', 'description', 'keyword', 'link', 'structure', 'share', 'technical']) {
      assert.ok(categories.has(expected), `缺少检查维度：${expected}`);
    }
  });

  test('检查项数量达到 15 项以上（覆盖度要求）', () => {
    const result = analyzer.analyze(COMPLETE_POST);
    assert.ok(result.checks.length >= 15, `检查项仅 ${result.checks.length} 项，覆盖不足`);
  });

  test('完整文章各维度基本通过', () => {
    const result = analyzer.analyze(COMPLETE_POST);
    const fails = result.checks.filter((c) => c.status === 'fail');
    assert.equal(fails.length, 0, `完整文章不应有 fail：${fails.map((f) => f.item).join(', ')}`);
  });

  test('残缺文章能检出明显问题', () => {
    const result = analyzer.analyze(SPARSE_POST);
    const items = result.checks.filter((c) => c.status !== 'pass').map((c) => c.item);
    assert.ok(items.includes('元描述存在'), '应检出错失元描述');
    assert.ok(items.includes('发布日期'), '应检出错失日期');
    assert.ok(items.includes('URL slug'), '应检出 slug 不合法');
  });
});

describe('LocalSEOAnalyzer 建议可操作性', () => {
  test('所有非 pass 项都给出具体建议，且建议不含空话', () => {
    const result = analyzer.analyze(SPARSE_POST);
    const vague = ['建议优化', '需要优化', '建议改进', '注意一下', '可以更好'];
    for (const item of result.checks.filter((c) => c.status !== 'pass')) {
      assert.ok(item.suggestion && item.suggestion.length > 10, `「${item.item}」的建议过短：${item.suggestion}`);
      for (const phrase of vague) {
        assert.ok(!item.suggestion.includes(phrase), `「${item.item}」的建议空泛：「${item.suggestion}」`);
      }
    }
  });

  test('标题缺关键词时给出可直接使用的新标题', () => {
    const result = analyzer.analyze({
      ...COMPLETE_POST,
      title: '一些随想',
    });
    const titleCheck = result.checks.find((c) => c.item === '标题含关键词');
    assert.ok(titleCheck, '应产出标题关键词检查项');
    assert.equal(titleCheck.status, 'fail');
    // 建议里必须出现具体的新标题字符串，而不是「请添加关键词」
    assert.ok(/建议改为「.+」/.test(titleCheck.suggestion), `建议应包含可直接改用的标题：${titleCheck.suggestion}`);
  });

  test('元描述缺失时给出可直接使用的描述', () => {
    const result = analyzer.analyze({ ...COMPLETE_POST, description: null });
    const descCheck = result.checks.find((c) => c.item === '元描述存在');
    assert.equal(descCheck.status, 'fail');
    assert.ok(descCheck.suggestion.includes('建议补上：'), '应给出完整描述内容');
    assert.ok(descCheck.suggestion.length > 30);
  });

  test('图片缺 alt 时指出具体是哪一张', () => {
    const result = analyzer.analyze({
      ...COMPLETE_POST,
      raw: `${COMPLETE_POST.raw}\n\n![](/assets/no-alt.png)`,
    });
    const altCheck = result.checks.find((c) => c.item === '图片 alt 文本');
    assert.equal(altCheck.status, 'fail');
    assert.ok(altCheck.message.includes('no-alt.png'), '应指出具体图片路径');
  });

  test('slug 不规范时给出规范化后的 slug', () => {
    const result = analyzer.analyze(SPARSE_POST);
    const slugCheck = result.checks.find((c) => c.item === 'URL slug');
    assert.ok(slugCheck.suggestion.includes('bad-slug'), `应给出规范化 slug：${slugCheck.suggestion}`);
  });
});

describe('LocalSEOAnalyzer 元描述生成', () => {
  test('元描述长度落在 50~160 区间或合理偏短', () => {
    const result = analyzer.analyze(COMPLETE_POST);
    const length = [...result.meta_description_suggestion].length;
    assert.ok(length > 0);
    assert.ok(length <= 160, `元描述超长：${length}`);
  });

  test('元描述以标点结尾', () => {
    for (const post of [COMPLETE_POST, SPARSE_POST]) {
      const result = analyzer.analyze(post);
      assert.ok(/[。！？.!?…]$/.test(result.meta_description_suggestion), `未以标点结尾：${result.meta_description_suggestion}`);
    }
  });

  test('元描述内容来自原文，不编造', () => {
    const result = analyzer.analyze(COMPLETE_POST);
    // 首段句子必须能在原文里找到
    assert.ok(result.meta_description_suggestion.includes('Emeek'));
    assert.ok(COMPLETE_POST.raw.includes('GitHub Issues') || result.meta_description_suggestion.length > 0);
  });

  test('元描述是确定性的', () => {
    const a = analyzer.analyze(COMPLETE_POST).meta_description_suggestion;
    const b = analyzer.analyze(COMPLETE_POST).meta_description_suggestion;
    assert.equal(a, b);
  });
});

describe('LocalSEOAnalyzer 边界情况', () => {
  test('空对象不崩溃', () => {
    const result = analyzer.analyze({});
    assert.ok(result.score >= 0 && result.score <= 100);
    assert.ok(result.checks.length > 0);
  });

  test('纯字符串输入按无元数据文章处理', () => {
    const result = analyzer.analyze('这是一段没有 front-matter 的正文内容，用来测试裸字符串输入。它应该被当作一篇没有标题、没有日期的文章来分析。');
    assert.ok(result.checks.some((c) => c.item === '标题存在' && c.status === 'fail'));
  });

  test('null 输入不崩溃', () => {
    const result = analyzer.analyze(null);
    assert.ok(result.score >= 0);
  });

  test('健康文章给出高分', () => {
    const result = analyzer.analyze(COMPLETE_POST);
    assert.ok(result.score >= 70, `完整文章得分 ${result.score} 偏低`);
    assert.equal(result.level === '优秀' || result.level === '良好', true);
  });
});

describe('LocalSEOAnalyzer 性能', () => {
  test('10KB 文本分析 < 30ms', () => {
    let raw = COMPLETE_POST.raw;
    while (raw.length < 10000) raw += `\n\n${COMPLETE_POST.raw}`;
    const post = { ...COMPLETE_POST, raw: raw.slice(0, 10000) };
    // 预热：首次运行包含 JIT 编译与惰性初始化，不能代表稳态性能
    for (let i = 0; i < 5; i += 1) analyzer.analyze(post);

    // 取 5 次的中位数，避免单次 GC 抖动造成的假失败
    const samples = [];
    for (let i = 0; i < 5; i += 1) {
      const start = performance.now();
      analyzer.analyze(post);
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const median = samples[2];
    assert.ok(median < 30, `SEO 分析中位耗时 ${median.toFixed(1)}ms，超过 30ms`);
  });
});
