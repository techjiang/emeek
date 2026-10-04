import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createSearchSession } from '../../src/search/runtime.js';
import { buildIndex, serializeIndex } from '../../src/search/indexer.js';
import { loadDictionarySync, resetDictionary } from '../../src/ai/local/segmenter.js';

loadDictionarySync();

const POSTS = [
  { slug: 'a', title: '静态博客引擎', url: '/a', tags: ['设计'], categories: ['技术'], date: '2024-01-03', raw: '静态博客的首屏做到一次请求。' },
  { slug: 'b', title: '主题系统设计', url: '/b', tags: ['设计'], categories: ['设计'], date: '2024-02-01', raw: '主题系统覆盖链与校验。' },
];
const INDEX = buildIndex(POSTS);

const fakeResponse = (body, { ok = true, status = 200 } = {}) => ({ ok, status, text: async () => body });

describe('createSearchSession', () => {
  test('直接传索引即可用', async () => {
    const s = await createSearchSession({ index: INDEX });
    assert.equal(s.ready, true);
    assert.ok(s.query('博客').results.length >= 1);
  });

  test('从 URL 取索引（fetch 注入）', async () => {
    const s = await createSearchSession({
      fetchImpl: async () => fakeResponse(serializeIndex(INDEX)),
    });
    assert.equal(s.ready, true);
    assert.ok(s.query('博客').results.length >= 1);
  });

  test('fetch 失败 → 降级为空会话，不抛（搜索是增强不是依赖）', async () => {
    let warned = null;
    const s = await createSearchSession({
      fetchImpl: async () => { throw new Error('网络断了'); },
      onWarning: (e) => { warned = e; },
    });
    assert.equal(s.ready, false);
    assert.deepEqual(s.query('博客'), { results: [], level: 0, total: 0 });
    assert.ok(warned, 'onWarning 必须被调用');
  });

  test('索引版本不符 → 降级而不是用坏数据', async () => {
    let warned = null;
    const bad = JSON.parse(serializeIndex(INDEX));
    bad.version = 999;
    const s = await createSearchSession({
      fetchImpl: async () => fakeResponse(JSON.stringify(bad)),
      onWarning: (e) => { warned = e; },
    });
    assert.equal(s.ready, false);
    assert.ok(warned);
  });

  test('没有 fetch 也不抛', async () => {
    const s = await createSearchSession({ fetchImpl: null, index: undefined, onWarning: () => {} });
    assert.equal(s.ready, false);
  });
});

describe('查询结果形状', () => {
  test('结果带 UI 需要的全部字段', async () => {
    const s = await createSearchSession({ index: INDEX });
    const item = s.query('博客').results[0];
    for (const key of ['id', 'title', 'url', 'tags', 'categories', 'date', 'excerpt', 'offset', 'matched']) {
      assert.ok(key in item, `结果缺字段 ${key}：${Object.keys(item)}`);
    }
  });

  test('命中词在 matched 里（UI 用它做 <mark>）', async () => {
    const s = await createSearchSession({ index: INDEX });
    const item = s.query('博客').results[0];
    assert.ok(item.matched.includes('博客'), `matched=${JSON.stringify(item.matched)}`);
  });

  test('空查询返回空', async () => {
    const s = await createSearchSession({ index: INDEX });
    assert.deepEqual(s.query(''), { results: [], level: 0, total: 0 });
  });

  test('facets 给出过滤器的可选项', async () => {
    const s = await createSearchSession({ index: INDEX });
    assert.ok(s.facets.categories.some((c) => c.value === '技术'));
    assert.ok(s.facets.tags.some((t) => t.value === '设计'));
    assert.equal(s.facets.categories[0].count >= 1, true);
  });

  test('过滤器透传到查询', async () => {
    const s = await createSearchSession({ index: INDEX });
    const r = s.query('设计', { filters: { categories: ['设计'] } });
    for (const item of r.results) assert.ok(item.categories.includes('设计'));
  });
});

describe('联想 suggest', () => {
  test('从标题 / 标签里找包含输入的子串', async () => {
    const s = await createSearchSession({ index: INDEX });
    const out = s.suggest('主');
    assert.ok(out.some((x) => x.value.includes('主')), JSON.stringify(out));
  });

  test('最多 8 条', async () => {
    const posts = Array.from({ length: 30 }, (_, i) => ({ slug: `p${i}`, title: `博客系列 ${i}`, url: `/p${i}`, tags: [], categories: [], date: '2024-01-01', raw: 'x' }));
    const s = await createSearchSession({ index: buildIndex(posts) });
    assert.ok(s.suggest('博客').length <= 8);
  });

  test('空输入返回空数组', async () => {
    const s = await createSearchSession({ index: INDEX });
    assert.deepEqual(s.suggest(''), []);
  });
});

describe('词表惰性加载下的查询（关键不变量）', () => {
  test('词典未加载时，靠索引 words 表仍能精确命中 Level 1', async () => {
    // 这是「索引与查询分叉」的正面防线：建索引用了词典，
    // 查询时词典不在，words 表里的「博客」本该匹配不上。
    // matchIndexedWords 直接从索引表认词，把这条路补上。
    resetDictionary();
    const s = await createSearchSession({ index: INDEX });
    const r = s.query('博客');
    assert.equal(r.level, 1, `词典缺失时应仍走 AND，实际 level=${r.level}`);
    assert.ok(r.results.length >= 1);
    loadDictionarySync(); // 恢复
  });
});

describe('补齐分支', () => {
  test('没有 fetch 且没有注入索引 → 明确降级并警告', async () => {
    // 真把全局 fetch 藏掉，才走到「没有可用 fetch」那一支。
    // 不藏的话 Node 24 自带 fetch，这个用例测的是另一条路径（fetch 抛错），
    // 看起来绿了但防线没被覆盖 —— 那是自欺欺人的覆盖率。
    const original = globalThis.fetch;
    // eslint-disable-next-line no-global-assign
    delete globalThis.fetch;
    try {
      let warned = null;
      const s = await createSearchSession({
        fetchImpl: null,
        index: undefined,
        onWarning: (e) => { warned = e; },
      });
      assert.equal(s.ready, false);
      assert.ok(warned, '应给出警告');
    } finally {
      globalThis.fetch = original;
    }
  });

  test('死的会话仍带 warn 字段（调用方可以复用同一个 warning 通道）', async () => {
    const s = await createSearchSession({ fetchImpl: async () => { throw new Error('x'); }, onWarning: () => {} });
    assert.equal(typeof s.warn, 'function');
  });
});
