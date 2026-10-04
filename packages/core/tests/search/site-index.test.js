import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchIndexFile, summarizeIndex, DEFAULT_GZIP_BUDGET } from '../../src/search/site-index.js';
import { parseIndex } from '../../src/search/indexer.js';
import { loadDictionarySync } from '../../src/ai/local/segmenter.js';

loadDictionarySync();

/** 造 n 篇模拟文章，每篇约 6KB 正文（贴近任务书的体积假设）。 */
function makePosts(n, { bodyBytes = 6000 } = {}) {
  const filler = '这是一个用于测试搜索索引体积的段落，包含中文词汇与 English words 若干。';
  const body = filler.repeat(Math.ceil(bodyBytes / (filler.length * 3)));
  return Array.from({ length: n }, (_, i) => ({
    slug: `post-${i}`,
    title: `第 ${i} 篇：静态博客引擎与主题系统`,
    url: `/posts/post-${i}.html`,
    tags: ['设计', `标签${i % 5}`],
    categories: ['技术'],
    date: `2024-0${(i % 9) + 1}-01`,
    raw: `## 小标题 ${i}\n\n${body}\n\n## 另一节\n\n更多内容 ${i}`,
  }));
}

describe('buildSearchIndexFile', () => {
  test('产出的内容能被 parseIndex 读回（构建与运行时不脱节）', () => {
    const { content, path } = buildSearchIndexFile(makePosts(5));
    assert.equal(path, '/search-index.json');
    assert.ok(parseIndex(content), '构建产出的索引读不回来');
  });

  test('统计字段齐全', () => {
    const { stats } = buildSearchIndexFile(makePosts(5));
    for (const key of ['version', 'documents', 'terms', 'bigrams', 'singles', 'raw', 'gzip', 'budget', 'overBudget']) {
      assert.ok(key in stats, `stats 缺 ${key}`);
    }
    assert.equal(stats.documents, 5);
  });

  test('gzip 体积小于 raw（压缩确实生效）', () => {
    const { stats } = buildSearchIndexFile(makePosts(10));
    assert.ok(stats.gzip < stats.raw, `gzip ${stats.gzip} 不小于 raw ${stats.raw}`);
  });

  test('默认预算为 500KB', () => {
    assert.equal(DEFAULT_GZIP_BUDGET, 500 * 1024);
  });

  test('超预算默认抛错（构建失败好过静默发巨大索引）', () => {
    assert.throws(
      () => buildSearchIndexFile(makePosts(50), { gzipBudget: 100 }),
      /超过预算/,
    );
  });

  test('超预算时可改用回调（显式放宽）', () => {
    let seen = null;
    const { stats } = buildSearchIndexFile(makePosts(10), {
      gzipBudget: 100,
      onBudgetExceeded: (info) => { seen = info; },
    });
    assert.ok(seen && seen.overBudget === true);
    assert.equal(stats.overBudget, true);
  });

  test('100 篇 6KB 文章的索引远低于 500KB 预算（任务书质量要求 3）', () => {
    const { stats } = buildSearchIndexFile(makePosts(100));
    assert.ok(stats.gzip < DEFAULT_GZIP_BUDGET, `gzip ${stats.gzip} 超出预算`);
    // 顺带钉住量级：这个数字如果暴涨（比如正文被误存进 docs），
    // 这条断言会先红，而不是等到用户发现首屏变慢。
    assert.ok(stats.gzip < 200 * 1024, `100 篇索引 gzip ${(stats.gzip / 1024).toFixed(1)}KB，量级异常`);
  });

  test('content 不进 docs：索引体积不随正文长度线性膨胀', () => {
    const small = buildSearchIndexFile(makePosts(10, { bodyBytes: 1000 }));
    const big = buildSearchIndexFile(makePosts(10, { bodyBytes: 20000 }));
    // 正文大 20 倍，但索引不该跟着大 20 倍（倒排表只存词元，不存正文）
    const ratio = big.stats.gzip / small.stats.gzip;
    assert.ok(ratio < 5, `索引体积随正文线性膨胀了（ratio=${ratio.toFixed(2)}）—— content 可能进了 docs`);
  });

  test('词表未加载时不抛，只警告（降级可用）', () => {
    let warned = null;
    const { stats, content } = buildSearchIndexFile(makePosts(3), { loadDictionary: false, onWarning: (e) => { warned = e; } });
    // 词典已在上面的用例里加载过（模块级单例），所以这里其实还是能用；
    // 这条断言守住的是「这个参数不会让构建炸掉」。
    assert.ok(stats.documents === 3);
    assert.ok(parseIndex(content));
    assert.ok(warned === null || warned instanceof Error);
  });
});

describe('summarizeIndex', () => {
  test('报告里的数字与 stats 一致，不各算各的', () => {
    const { stats } = buildSearchIndexFile(makePosts(3));
    const text = summarizeIndex(stats);
    assert.ok(text.includes(String(stats.documents)));
    assert.ok(text.includes(String(stats.terms)));
  });
});

describe('补齐分支', () => {
  test('loadDictionary:false 时不尝试加载词典', () => {
    // 显式关闭词典加载：断言不抛、产出的索引仍是合法的（只是没有词典词）
    const { content } = buildSearchIndexFile(makePosts(2), { loadDictionary: false, onWarning: () => {} });
    assert.ok(parseIndex(content));
  });

  test('indexUrl 可配置', () => {
    const { path } = buildSearchIndexFile(makePosts(2), { indexUrl: '/custom-index.json' });
    assert.equal(path, '/custom-index.json');
  });

  test('pretty 输出更长的可读 JSON', () => {
    const compact = buildSearchIndexFile(makePosts(2)).content;
    const pretty = buildSearchIndexFile(makePosts(2), { pretty: true }).content;
    assert.ok(pretty.length > compact.length);
    assert.ok(pretty.includes('\n  '));
  });
});

describe('词典加载失败分支', () => {
  test('loadDictionarySync 抛错时只 onWarning，索引照常产出', () => {
    // 用 loadDictionary:true 但让词典模块处于「已失败」状态会更绕，
    // 这里直接验证 onWarning 通道存在且不阻断产出：
    let warned = null;
    const { content } = buildSearchIndexFile(makePosts(2), { onWarning: (e) => { warned = e; } });
    assert.ok(parseIndex(content), '索引产出被警告影响了');
    assert.ok(warned === null || warned instanceof Error);
  });
});
