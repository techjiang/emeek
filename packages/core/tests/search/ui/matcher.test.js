import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runQuery, collectSuggestions, bigrams, matchIndexedWords } from '../../../src/search/ui/matcher.js';
import { search } from '../../../src/search/query.js';
import { buildIndex } from '../../../src/search/indexer.js';
import { matchIndexedWords as coreMatch } from '../../../src/search/tokenizer.js';
import { loadDictionarySync } from '../../../src/ai/local/segmenter.js';

loadDictionarySync();

const POSTS = [
  { slug: 'a', title: '静态博客引擎', url: '/a', tags: ['设计'], categories: ['技术'], date: '2024-01-03', raw: '静态博客的首屏做到一次请求。Markdown 正文在此。' },
  { slug: 'b', title: '主题系统设计', url: '/b', tags: ['设计'], categories: ['设计'], date: '2024-02-01', raw: '主题系统覆盖链与校验。' },
  { slug: 'c', title: 'Markdown 语法', url: '/c', tags: ['写作'], categories: ['技术'], date: '2023-12-01', raw: 'Markdown 的语法一览。' },
  { slug: 'd', title: '读书笔记', url: '/d', tags: ['阅读'], categories: ['随笔'], date: '2024-03-01', raw: '关于阅读的一些记录。' },
];
const INDEX = buildIndex(POSTS);

describe('matcher 基础', () => {
  test('bigrams 只吃 CJK', () => {
    assert.deepEqual(bigrams('博客'), ['博客']);
    assert.deepEqual(bigrams('abc'), []);
    assert.deepEqual(bigrams('博客 engine'), ['博客']);
  });

  test('matchIndexedWords 最长优先', () => {
    const out = matchIndexedWords(INDEX, '静态博客');
    assert.ok(out.includes('静态') || out.includes('博客'), JSON.stringify(out));
  });

  test('runQuery 空输入返回空', () => {
    assert.deepEqual(runQuery(INDEX, ''), { results: [], level: 0, total: 0 });
    assert.deepEqual(runQuery(INDEX, '   '), { results: [], level: 0, total: 0 });
  });

  test('runQuery 无索引不崩', () => {
    assert.deepEqual(runQuery(null, '博客'), { results: [], level: 0, total: 0 });
  });

  test('结果带高亮字段', () => {
    const item = runQuery(INDEX, '博客').results[0];
    for (const key of ['id', 'title', 'url', 'tags', 'excerpt', 'matched']) assert.ok(key in item, key);
  });

  test('maxResults 生效', () => {
    const r = runQuery(INDEX, '设计', { maxResults: 1 });
    assert.ok(r.results.length <= 1);
  });
});

describe('过滤器', () => {
  test('分类过滤', () => {
    const r = runQuery(INDEX, '设计', { filters: { category: '设计' } });
    for (const item of r.results) assert.ok(item.categories.includes('设计'));
  });

  test('标签过滤', () => {
    const r = runQuery(INDEX, '的', { filters: { tag: '写作' } });
    for (const item of r.results) assert.ok(item.tags.includes('写作'));
  });

  test('日期范围', () => {
    const r = runQuery(INDEX, '的', { filters: { from: '2024-01-01', to: '2024-12-31' } });
    for (const item of r.results) {
      const t = new Date(item.date);
      assert.ok(t >= new Date('2024-01-01') && t <= new Date('2024-12-31'));
    }
  });

  test('过滤后无结果返回空', () => {
    assert.deepEqual(runQuery(INDEX, '博客', { filters: { category: '不存在' } }).results, []);
  });
});

describe('联想', () => {
  test('从标题 / 标签里找', () => {
    assert.ok(collectSuggestions(INDEX, '主').some((x) => x.value.includes('主')));
  });

  test('limit 生效', () => {
    const posts = Array.from({ length: 30 }, (_, i) => ({ slug: `p${i}`, title: `博客 ${i}`, url: `/p${i}`, tags: [], categories: [], date: '2024-01-01', raw: 'x' }));
    assert.ok(collectSuggestions(buildIndex(posts), '博客').length <= 8);
  });

  test('空输入 / 无索引返回空', () => {
    assert.deepEqual(collectSuggestions(INDEX, ''), []);
    assert.deepEqual(collectSuggestions(null, '主'), []);
  });
});

describe('与 core/query.js 的一致性（防两侧漂移）', () => {
  // 这是本文件最重要的一组断言。
  // 客户端的 matcher 是 core/query.js 的精简版（不能内联 400KB 词典）。
  // 简化只允许体现在「词典词可能在客户端认不出」，不允许体现在
  // 「同一批词元下两条路径给出不同结果」—— 后者是 bug。
  const QUERIES = ['博客', '主题系统', '设计', '静态', 'Markdown', '阅读', '的主题系统', '不存在的内容zzz'];

  for (const query of QUERIES) {
    test(`「${query}」的结果集一致`, () => {
      // 用 core 的词元构造 core 侧查询，保证比较的是「同一批词元」。
      // core 的 matchIndexedWords 返回 { matched, unmatched }，这里取 matched。
      const words = coreMatch(INDEX, query).matched;
      const coreOut = search(INDEX, { words, bigrams: bigrams(query), singles: [], phrase: query.toLowerCase() });
      const coreIds = coreOut.results.map((r) => INDEX.docs[r.doc].id).sort();

      const clientIds = runQuery(INDEX, query).results.map((r) => r.id).sort();

      // 客户端可能因为词典词识别不全而结果更多（降级到 OR），
      // 但不该**漏掉** core 能精确命中的那些。
      if (coreIds.length) {
        for (const id of coreIds) {
          assert.ok(clientIds.includes(id), `客户端漏了 core 能命中的 ${id}（query=${query}）`);
        }
      }
      // 反过来：客户端不该凭空造出 core 结果里没有的文档 —— 除非它降级了层级
      const clientLevel = runQuery(INDEX, query).level;
      if (clientLevel === 1) {
        assert.deepEqual(clientIds, coreIds, `同为 Level 1 时结果集应完全一致（query=${query}）`);
      }
    });
  }

  test('两边对空查询的判断一致', () => {
    assert.equal(runQuery(INDEX, '').level, 0);
    assert.equal(search(INDEX, { words: [], bigrams: [], singles: [] }).level, 0);
  });
});
