import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, FUZZY_MIN_LENGTH, matchIndexedWords } from '../../src/search/tokenizer.js';
import { loadDictionarySync, isDictionaryLoaded, resetDictionary } from '../../src/ai/local/segmenter.js';

describe('三类词元分词', () => {
  before(() => { loadDictionarySync(); });

  test('中文产出 bigram 与单字，英文产出整词', () => {
    const r = analyze('博客 engine');
    assert.ok(r.words.includes('engine'), `英文词未进 words：${JSON.stringify(r.words)}`);
    // bigram：相邻二字。「博客」只有一个 bigram。
    assert.ok(r.bigrams.includes('博客'), `bigram 缺「博客」：${JSON.stringify(r.bigrams)}`);
    assert.deepEqual(r.singles.sort(), ['博', '客'].sort());
  });

  test('词典就绪时中文词进 words（精确匹配的来源）', () => {
    const r = analyze('静态博客引擎');
    assert.ok(r.words.includes('博客'), `words 缺「博客」：${JSON.stringify(r.words)}`);
  });

  test('三类词元互不污染：bigram 不进 words', () => {
    // 「主题系统」的 bigram 里有「题系」，但它绝不该出现在 words 里 ——
    // 否则 AND 约束会要求正文里「题」和「系」紧挨着，漏掉正常写法。
    const r = analyze('主题系统');
    assert.ok(!r.words.includes('题系'), `「题系」混进了 words：${JSON.stringify(r.words)}`);
    assert.ok(r.bigrams.includes('题系'));
  });

  test('全角转半角、大小写归一', () => {
    const r = analyze('ＢＬＯＧ Blog');
    assert.ok(r.words.includes('blog'), `未归一化：${JSON.stringify(r.words)}`);
    assert.equal(r.words.filter((w) => w === 'blog').length, 1, '去重失败');
  });

  test('数字串进 words（长度 ≥2）', () => {
    const r = analyze('2024 与 5');
    assert.ok(r.words.includes('2024'), JSON.stringify(r.words));
    assert.ok(!r.words.includes('5'), '单数字不该进 words');
  });

  test('空输入产出空三类', () => {
    assert.deepEqual(analyze(''), { words: [], bigrams: [], singles: [] });
    assert.deepEqual(analyze(null), { words: [], bigrams: [], singles: [] });
  });

  test('词典词里的单字也补进 singles（单字兜底要完整）', () => {
    const r = analyze('博客');
    assert.ok(r.singles.includes('博') && r.singles.includes('客'));
  });

  test('词典未加载时仍能产出 bigram / 单字（降级不崩）', () => {
    resetDictionary();
    assert.equal(isDictionaryLoaded(), false);
    const r = analyze('静态博客');
    assert.ok(r.bigrams.length > 0, 'bigram 层不该依赖词典');
    assert.ok(r.singles.includes('静'));
    loadDictionarySync(); // 恢复，避免影响后续用例
  });
});

describe('FUZZY_MIN_LENGTH', () => {
  test('阈值为 4：2 字词的编辑距离 1 等于换词，不该 fuzzy', () => {
    assert.equal(FUZZY_MIN_LENGTH, 4);
  });
});

describe('matchIndexedWords（不依赖词典的精确匹配）', () => {
  const index = { words: { 博客: [0], 引擎: [0], 静态: [1], 静态博客: [1] } };

  test('从索引表里认出词，最长优先', () => {
    const r = matchIndexedWords(index, '静态博客');
    assert.ok(r.matched.includes('静态博客'), `未做最长匹配：${JSON.stringify(r)}`);
  });

  test('英文整段试表', () => {
    const idx = { words: { markdown: [0] } };
    assert.deepEqual(matchIndexedWords(idx, 'markdown').matched, ['markdown']);
  });

  test('索引里没有的词归入 unmatched，不臆造命中', () => {
    const r = matchIndexedWords(index, '不存在的词');
    assert.deepEqual(r.matched, []);
    assert.ok(r.unmatched.length > 0);
  });

  test('空索引不崩', () => {
    assert.deepEqual(matchIndexedWords({}, '博客').matched, []);
    assert.deepEqual(matchIndexedWords(null, '博客').matched, []);
  });
});
