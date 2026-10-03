/**
 * 词表惰性加载（搜索层）。
 *
 * 与 AI 那边的 bridge.js 是同一个思路、不同的使用场景：
 *   AI 侧：用户点「摘要」时才加载，加载不到就退化为字级统计。
 *   搜索侧：搜索是「找内容」的唯一入口，比 AI 增强更重要 ——
 *          但它同样不该把 400KB 词表塞进首屏。
 *
 * 所以策略是「先能用，再变好」：
 *   1. 页面一打开就能搜（bigram + 单字公共层，不依赖词典）。
 *   2. 词表在后台加载，加载完调 onReady 通知，此时起查询走词典分词。
 *   3. 加载失败只 onWarning，绝不抛错 —— 搜索降级但仍在。
 *
 * 一个刻意的选择：词表就绪**不重建索引**。
 *   索引里 words/bigrams/singles 三张表是并存的，bigram 层已经把
 *   大部分中文检索覆盖住了。词表就绪后只是查询侧多了一种更精确的
 *   切法（words 表已有的词能被 AND 精确匹配），索引不需要动。
 *   重建索引的代价（重新下载 + 解析整个索引）远大于收益。
 */

import { loadDictionary, isDictionaryLoaded, dictionarySize } from '../ai/local/segmenter.js';

export { isDictionaryLoaded, dictionarySize };

/**
 * 加载词表并驱动状态机。
 *
 * 状态流转：idle → loading → decompressing → indexing → ready
 * 任何一步失败 → 停在 failed，并回调 onWarning。失败后不重试
 * （调用方想重试就再调一次），避免在断网场景里反复打网络。
 *
 * @param {object} [options]
 *   file       词表地址（默认 core 内置的 zh-words.txt.gz）
 *   decompress 自定义解压，浏览器传 DecompressionStream 实现
 *   onProgress (state) => void
 *   onReady    () => void        词表可用
 *   onWarning  (error) => void   加载失败（不抛）
 * @returns {Promise<boolean>} 是否成功
 */
export async function prepareDictionary({
  file,
  decompress,
  onProgress = () => {},
  onReady = () => {},
  onWarning = () => {},
} = {}) {
  if (isDictionaryLoaded()) {
    onProgress('ready');
    onReady();
    return true;
  }

  onProgress('loading');
  try {
    const ok = await loadDictionary({ file, decompress });
    if (!ok) {
      onProgress('failed');
      onWarning(new Error('词表不可用，搜索已退化到字级检索'));
      return false;
    }
    onProgress('decompressing');
    // 词典解码在 loadDictionary 内部完成（front-coding 解码），
    // 这里补一个 indexing 状态并不代表在建索引 —— 它表示「词表已可分词」。
    // 前端 UI 需要四个可见状态，所以都发一遍。
    onProgress('indexing');
    onProgress('ready');
    onReady();
    return true;
  } catch (error) {
    onProgress('failed');
    onWarning(error);
    return false;
  }
}

/**
 * 词表字节的默认获取方式（浏览器）。fetch 失败抛错，由 prepareDictionary 兜住。
 * 单列出来是为了让 Studio / 站点两侧共用，不必各写一份。
 */
export async function fetchDictionaryBytes(url, { onProgress } = {}) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`词表请求失败：${response.status}`);
  const total = Number(response.headers.get('content-length') ?? 0);
  if (!response.body || !onProgress) {
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }
  // 有流就报进度：400KB 在慢网下要几百毫秒，没有进度条用户会以为卡住了。
  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(loaded, total);
  }
  const merged = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

/** 浏览器端 gzip 解压。Node 下回退到 zlib。 */
export async function decompressGzip(bytes) {
  if (typeof DecompressionStream === 'function') {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).text();
  }
  const zlib = await import('node:zlib');
  return zlib.gunzipSync(Buffer.from(bytes)).toString('utf8');
}
