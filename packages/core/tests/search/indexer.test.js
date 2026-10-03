import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIndex, serializeIndex, parseIndex, measureIndexBytes, INDEX_VERSION,
} from '../../src/search/indexer.js';
import { loadDictionarySync } from '../../src/ai/local/segmenter.js';

// 索引构建要用词典切中文词 —— 不加这句，words 表里只有英文，
// 后面所有「中文词进了倒排表」的断言都会因为环境差异而红。
before(() => { loadDictionarySync(); });

const POSTS = [
  { slug: 'a', title: '静态博客引擎', url: '/posts/a.html', tags: ['设计'], categories: ['技术'], date: '2024-01-03', raw: '## 静态博客\n\n首屏一次请求，快。' },
  { slug: 'b', title: '主题系统设计', url: '/posts/b.html', tags: ['设计'], categories: ['设计'], date: '2024-02-01', raw: '主题系统的覆盖链与校验。' },
  { slug: 'c', title: 'Markdown 语法', url: '/posts/c.html', tags: ['写作'], categories: ['技术'], date: '2023-12-01', raw: '```js\nconst secret=1;\n```\n正文在此。' },
];

describe('buildIndex', () => {
  test('带上结构版本头', () => {
    assert.equal(buildIndex(POSTS).version, INDEX_VERSION);
  });

  test('content 不进 docs（体积的关键）', () => {
    const index = buildIndex(POSTS);
    const doc = index.docs[0];
    assert.ok(!('raw' in doc) && !('html' in doc) && !('body' in doc), `docs 里混进了正文：${Object.keys(doc)}`);
    assert.ok(doc.excerpt, 'excerpt 必须有（前端要靠它显示摘要）');
  });

  test('三张倒排表都建了，且 posting 是下标', () => {
    const index = buildIndex(POSTS);
    for (const table of ['words', 'bigrams', 'singles']) {
      assert.ok(Object.keys(index[table]).length > 0, `${table} 表为空`);
    }
    assert.ok(Array.isArray(index.words['markdown'] ?? index.words[Object.keys(index.words)[0]]));
  });

  test('同一文档的同一词元不重复 posting', () => {
    const index = buildIndex([{ slug: 'x', title: '博客', url: '/x', tags: [], raw: '博客博客博客' }]);
    const posting = index.words['博客'];
    if (posting) assert.equal(new Set(posting).size, posting.length, `posting 有重复：${posting}`);
  });

  test('代码块内容不进索引', () => {
    const index = buildIndex(POSTS);
    assert.ok(!index.words.secret, '代码块里的词进了倒排表');
  });

  test('标题 / 标签单独建 titleIndex（用于提权）', () => {
    const index = buildIndex(POSTS);
    assert.ok(index.titleIndex['主题'], `titleIndex 缺标题词：${Object.keys(index.titleIndex).slice(0, 10)}`);
  });

  test('序列化顺序稳定：内容相同 → 字节相同', () => {
    const a = serializeIndex(buildIndex(POSTS));
    const b = serializeIndex(buildIndex(POSTS));
    assert.equal(a, b);
  });

  test('空输入产出可用的空索引', () => {
    const index = buildIndex([]);
    assert.deepEqual(index.docs, []);
    assert.equal(parseIndex(serializeIndex(index)) !== null, true);
  });
});

describe('parseIndex（结构校验）', () => {
  test('版本不符返回 null（前端据此降级）', () => {
    const json = serializeIndex(buildIndex(POSTS));
    const tampered = JSON.parse(json);
    tampered.version = 999;
    assert.equal(parseIndex(JSON.stringify(tampered)), null);
  });

  test('缺表返回 null', () => {
    const json = JSON.parse(serializeIndex(buildIndex(POSTS)));
    delete json.bigrams;
    assert.equal(parseIndex(JSON.stringify(json)), null);
  });

  test('坏 JSON 返回 null 而不是抛', () => {
    assert.equal(parseIndex('{不是 json'), null);
    assert.equal(parseIndex(''), null);
  });

  test('正常索引读回可用', () => {
    const index = parseIndex(serializeIndex(buildIndex(POSTS)));
    assert.equal(index.docs.length, 3);
  });
});

describe('measureIndexBytes', () => {
  test('是 UTF-8 字节数而非字符数（中文占 3 字节）', () => {
    const json = JSON.stringify({ 中文: '博客' });
    // 字符数远小于字节数
    assert.ok(measureIndexBytes(json) > json.length, '未按 UTF-8 字节计数');
  });
});
