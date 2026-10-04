import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { prepareDictionary, fetchDictionaryBytes, decompressGzip, isDictionaryLoaded, dictionarySize } from '../../src/search/dictionary.js';
import { resetDictionary, loadDictionarySync } from '../../src/ai/local/segmenter.js';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DICT_FILE = path.resolve(HERE, '../../src/ai/local/dict/zh-words.txt.gz');

describe('prepareDictionary（词表惰性加载 + 状态机）', () => {
  test('加载成功 → 状态依次推进到 ready', async () => {
    resetDictionary();
    const states = [];
    // 传词表字节而不是路径：浏览器路径下 segmenter 的 readFile 会把
    // 字符串当 URL 走 fetch（Node 的 fetch 不认本地路径）。真实前端
    // 也是先 fetch 拿到 bytes 再交给它 —— 这里模拟同一件事。
    const bytes = new Uint8Array(fs.readFileSync(DICT_FILE));
    const ok = await prepareDictionary({
      file: bytes,
      onProgress: (s) => states.push(s),
    });
    assert.equal(ok, true);
    assert.equal(isDictionaryLoaded(), true);
    assert.deepEqual(states, ['loading', 'decompressing', 'indexing', 'ready']);
    assert.ok(dictionarySize() > 50000);
  });

  test('已加载时直接 ready，不重复加载', async () => {
    loadDictionarySync();
    const states = [];
    const ok = await prepareDictionary({ onProgress: (s) => states.push(s), onReady: () => states.push('onReady') });
    assert.equal(ok, true);
    assert.deepEqual(states, ['ready', 'onReady']);
  });

  test('加载失败 → 只警告不抛（搜索是增强，不是依赖）', async () => {
    resetDictionary();
    const states = [];
    let warned = null;
    const ok = await prepareDictionary({
      file: '/不存在的路径/词表.gz',
      onProgress: (s) => states.push(s),
      onWarning: (e) => { warned = e; },
    });
    assert.equal(ok, false);
    assert.ok(warned instanceof Error, 'onWarning 应收到 Error');
    assert.ok(states.includes('failed'), `状态里应有 failed：${states}`);
    loadDictionarySync(); // 恢复
  });

  test('自定义 decompress 抛错也走 failed 分支，不崩', async () => {
    resetDictionary();
    let warned = null;
    const ok = await prepareDictionary({
      file: new Uint8Array(fs.readFileSync(DICT_FILE)),
      decompress: async () => { throw new Error('解压失败'); },
      onWarning: (e) => { warned = e; },
    });
    // loadDictionary 内部 catch 掉了解压错误 → 返回 false
    assert.equal(ok, false);
    assert.ok(warned);
    loadDictionarySync();
  });
});

describe('fetchDictionaryBytes', () => {
  test('无 body 流时整块读取', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const fake = { ok: true, headers: { get: () => null }, body: null, arrayBuffer: async () => bytes.buffer };
    const original = globalThis.fetch;
    globalThis.fetch = async () => fake;
    try {
      const out = await fetchDictionaryBytes('http://x');
      assert.deepEqual([...out], [1, 2, 3]);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('有 body 流时按块读取并报进度', async () => {
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3])];
    let i = 0;
    const progress = [];
    const fake = {
      ok: true,
      headers: { get: () => '3' },
      body: { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }) }) },
    };
    // fetchDictionaryBytes 用全局 fetch —— 这里替换全局，测流式分支
    const original = globalThis.fetch;
    globalThis.fetch = async () => fake;
    try {
      const out = await fetchDictionaryBytes('http://x', { onProgress: (l, t) => progress.push([l, t]) });
      assert.deepEqual([...out], [1, 2, 3]);
      assert.ok(progress.length >= 2, `进度回调次数偏少：${progress}`);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('HTTP 非 2xx 抛错（由调用方决定降级）', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 404 });
    try {
      await assert.rejects(() => fetchDictionaryBytes('http://x'), /404/);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('decompressGzip', () => {
  test('Node 环境下能解 gzip（回退 zlib）', async () => {
    const gz = zlib.gzipSync('你好世界');
    const text = await decompressGzip(new Uint8Array(gz));
    assert.equal(text, '你好世界');
  });

  test('与真实词表字节配合可用（端到端）', async () => {
    const gz = fs.readFileSync(DICT_FILE);
    const text = await decompressGzip(new Uint8Array(gz));
    assert.ok(text.length > 100000, '解压结果太小，词表可能坏了');
    const first = text.split('\n')[0];
    assert.ok(first.length > 0);
  });
});
