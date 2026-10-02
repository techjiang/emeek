/**
 * 词表加载（浏览器实现）。
 *
 * 与 core 的 segmenter.js 是同一份协议（bytes + decompress 函数）：
 * 这里只负责「怎么把字节取回来」，core 负责「怎么变成词典」——
 * 分词逻辑仍然只有一份。408KB 词表只在这个函数被调用时才会上网络。
 */
export const DICT_URL = '/__studio/dict/zh-words.txt.gz';

/**
 * 取词表字节。
 *
 * 有进度回调时用流式读取 —— 408KB 在慢网下要几秒，而「点了没反应」
 * 和「正在加载 60%」对用户是两种完全不同的体验。
 * 能拿到 Content-Length 就算得出百分比；拿不到（分块传输）就只报已下载量。
 */
export async function fetchDictionaryBytes(url = DICT_URL, onProgress = null) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`词表请求失败：${response.status}`);

  if (!onProgress || !response.body?.getReader) {
    return new Uint8Array(await response.arrayBuffer());
  }

  const total = Number(response.headers.get('content-length') ?? 0) || 0;
  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      onProgress(loaded, total);
    }
  } finally {
    reader.releaseLock?.();
  }

  const merged = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  onProgress(loaded, total || loaded);
  return merged;
}

export { isDictionaryLoaded, dictionarySize } from '@emeeek/core/ai/browser';
