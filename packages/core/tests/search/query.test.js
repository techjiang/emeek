import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { search, runLevel, filterDocs, expandFuzzy, DEFAULT_MAX_RESULTS } from '../../src/search/query.js';
import { buildIndex } from '../../src/search/indexer.js';
import { analyze, analyzeQuery } from '../../src/search/tokenizer.js';
import { loadDictionarySync } from '../../src/ai/local/segmenter.js';

// 索引必须在词典加载之后建 —— 模块顶层建索引会早于 before 钩子，
// 那时词典还没进来，words 表里只有英文，所有中文精确匹配的断言都会红。
// 这类「测试环境与生产环境不一致导致的失败」最容易浪费时间去查实现。
loadDictionarySync();

const POSTS = [
  { slug: 'a', title: '静态博客引擎', url: '/a', tags: ['设计'], categories: ['技术'], date: '2024-01-03', raw: '静态博客的首屏做到一次请求。' },
  { slug: 'b', title: '主题系统设计', url: '/b', tags: ['设计'], categories: ['设计'], date: '2024-02-01', raw: '主题系统覆盖链与校验。' },
  { slug: 'c', title: 'Markdown 语法', url: '/c', tags: ['写作'], categories: ['技术'], date: '2023-12-01', raw: 'Markdown 的语法一览。' },
];

const INDEX = buildIndex(POSTS);
const q = (text) => analyze(text);

describe('查询策略链', () => {
  test('精确命中走 Level 1（AND）', () => {
    const r = search(INDEX, q('博客'));
    assert.equal(r.level, 1, `应走 AND，实际 level=${r.level}`);
    assert.ok(r.results.some((x) => INDEX.docs[x.doc].id === 'a'));
  });

  test('多词 AND：必须同时命中', () => {
    const r = search(INDEX, q('主题 系统'));
    assert.equal(r.level, 1);
    assert.equal(r.results.length, 1);
    assert.equal(INDEX.docs[r.results[0].doc].id, 'b');
  });

  test('AND 只用 words，不用 bigrams（否则会漏结果）', () => {
    // 「主题系统」的 bigram 含「题系」。若 bigram 进了 AND，
    // 就要求正文里「题」「系」紧挨着 —— 'b' 的正文是「主题系统」，
    // 它确实含「题系」，所以这个用例要能通过 AND 且不依赖 bigram 语义。
    // 真正要守住的是：AND 的判定不因缺少 bigram 而失败。
    const terms = q('主题系统');
    const onlyWords = { words: terms.words, bigrams: [], singles: [] };
    const r = runLevel(INDEX, onlyWords, 1);
    assert.ok(r.length >= 1, 'AND 结果不该依赖 bigram 表');
  });

  test('words 全无命中时降级到 Level 2（OR + bigram）', () => {
    // 构造「words 表里没有、但 bigram 表里有」的输入：
    // 用一个词典不认识的生僻两字组合，它在索引里只有 bigram 与单字。
    const index = buildIndex([{ slug: 'z', title: '标题', url: '/z', tags: [], raw: '孑孓孑孓' }]);
    // 直接给查询词元，绕开 analyze 的词典切分（否则又被词典认作词）
    const terms = { words: [], bigrams: ['孑孓'], singles: ['孑', '孓'] };
    const r = search(index, terms);
    assert.equal(r.level, 2, `应走 OR 层，实际 level=${r.level}`);
    assert.ok(r.results.length >= 1, 'OR 层没有召回');
  });

  test('Level 3 子串兜底能捞出词表没有但正文含的串', () => {
    const index = buildIndex([{ slug: 'z', title: 'x', url: '/z', tags: [], raw: '正文含特殊标识符 zzqqxx' }]);
    // 构造一个 words 表里不存在、bigram 也不覆盖的长串
    const terms = { words: ['zzqq'], bigrams: [], singles: [] };
    const r = search(index, terms);
    assert.ok(r.results.length >= 1, `子串兜底未命中：level=${r.level}`);
  });

  test('完全无命中返回空 + level 0', () => {
    const r = search(INDEX, q('完全不存在的内容xyz'));
    assert.equal(r.level, 0);
    assert.deepEqual(r.results, []);
  });

  test('空查询返回空，不抛', () => {
    assert.deepEqual(search(INDEX, q('')), { results: [], level: 0, total: 0 });
  });

  test('maxResults 生效', () => {
    const r = search(INDEX, q('的'), { maxResults: 1 });
    assert.ok(r.results.length <= 1);
    assert.equal(DEFAULT_MAX_RESULTS, 10);
  });
});

describe('打分', () => {
  test('标题命中排在正文命中之前', () => {
    const index = buildIndex([
      { slug: 'titlehit', title: '博客指南', url: '/1', tags: [], raw: '正文无关内容' },
      { slug: 'bodyhit', title: '无关标题', url: '/2', tags: [], raw: '正文里提到博客一次' },
    ]);
    const r = search(index, q('博客'));
    assert.equal(index.docs[r.results[0].doc].id, 'titlehit', '标题命中未提权');
  });

  test('同级内按日期降序兜底', () => {
    const index = buildIndex([
      { slug: 'old', title: '博客', url: '/1', tags: [], raw: '博客', date: '2020-01-01' },
      { slug: 'new', title: '博客', url: '/2', tags: [], date: '2024-01-01', raw: '博客' },
    ]);
    const r = search(index, q('博客'));
    // 两条标题相同、分数相同 → 新的在前
    assert.equal(index.docs[r.results[0].doc].id, 'new');
  });
});

describe('过滤器', () => {
  test('分类过滤在打分前生效（不产生矛盾的 total）', () => {
    const r = search(INDEX, q('设计'), { filters: { categories: ['设计'] } });
    for (const item of r.results) {
      assert.ok(INDEX.docs[item.doc].categories.includes('设计'));
    }
  });

  test('标签过滤', () => {
    const r = search(INDEX, q('博客'), { filters: { tags: ['设计'] } });
    for (const item of r.results) assert.ok(INDEX.docs[item.doc].tags.includes('设计'));
  });

  test('日期范围过滤', () => {
    const r = search(INDEX, q('的'), { filters: { from: '2024-01-01', to: '2024-12-31' } });
    for (const item of r.results) {
      const t = new Date(INDEX.docs[item.doc].date).getTime();
      assert.ok(t >= new Date('2024-01-01').getTime() && t <= new Date('2024-12-31').getTime());
    }
  });

  test('无过滤器时 filterDocs 返回 null（表示不限制）', () => {
    assert.equal(filterDocs(INDEX, {}), null);
  });

  test('过滤后无结果时继续降级而不是返回被过滤前的结果', () => {
    const r = search(INDEX, q('博客'), { filters: { categories: ['不存在的分类'] } });
    assert.deepEqual(r.results, []);
  });
});

describe('expandFuzzy', () => {
  test('≥4 字 CJK 词元才展开', () => {
    assert.deepEqual(expandFuzzy('博客'), [], '2 字词不该 fuzzy');
    assert.deepEqual(expandFuzzy('主题'), []);
    assert.ok(expandFuzzy('主题系统').length > 0, '4 字词应展开');
  });

  test('英文词不参与 CJK fuzzy', () => {
    assert.deepEqual(expandFuzzy('markdown'), []);
  });

  test('展开结果不含原词，且长度都 ≥2', () => {
    const variants = expandFuzzy('主题系统');
    assert.ok(!variants.includes('主题系统'));
    for (const v of variants) assert.ok([...v].length >= 2, `${v} 太短`);
  });
});

describe('搜索质量（任务书第 7 条：中文搜索准确）', () => {
  test('搜完整词能命中，搜半截词也能命中', () => {
    assert.ok(search(INDEX, q('主题系统')).results.length >= 1, '完整词未命中');
    assert.ok(search(INDEX, q('主题')).results.length >= 1, '半截词未命中');
  });

  test('搜不相关词不误伤', () => {
    const r = search(INDEX, q('量子力学'));
    assert.deepEqual(r.results, [], `误命中：${r.results}`);
  });
});

describe('补齐分支', () => {
  test('runLevel 的未知级别返回空数组', () => {
    assert.deepEqual(runLevel(INDEX, q('博客'), 99), []);
  });

  test('候选过多时先按命中项数粗筛（不逐个算摘要）', () => {
    // 造 500 篇都含「的」的文章，maxResults=1 → 候选 500 > 1*20
    const posts = Array.from({ length: 500 }, (_, i) => ({ slug: `p${i}`, title: `标题${i}`, url: `/p${i}`, tags: [], categories: [], date: '2024-01-01', raw: '的内容在这里' }));
    const index = buildIndex(posts);
    const r = search(index, { words: [], bigrams: ['的'], singles: [] }, { maxResults: 1 });
    assert.ok(r.results.length <= 1, `粗筛后仍返回过多：${r.results.length}`);
  });
});

describe('analyzeQuery 别名', () => {
  test('与 analyze 行为一致（查询侧与索引侧共用同一入口）', () => {
    assert.deepEqual(analyzeQuery('博客'), analyze('博客'));
  });
});

describe('候选粗筛的边界', () => {
  test('候选数恰好等于 maxResults*20 时不触发粗筛分支', () => {
    const posts = Array.from({ length: 20 }, (_, i) => ({ slug: `p${i}`, title: `t${i}`, url: `/p${i}`, tags: [], categories: [], date: '2024-01-01', raw: '的的的' }));
    const index = buildIndex(posts);
    const r = search(index, { words: [], bigrams: ['的'], singles: [] }, { maxResults: 1 });
    assert.ok(r.results.length <= 1);
  });
});
