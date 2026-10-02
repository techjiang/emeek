/**
 * 词表加载（浏览器实现）。
 *
 * 与 core 的 segmenter.js 是同一份协议（bytes + decompress 函数）：
 * 这里只负责「怎么把字节取回来」，core 负责「怎么变成词典」——
 * 分词逻辑仍然只有一份。408KB 词表只在这个函数被调用时才会上网络。
 */
export const DICT_URL = '/__studio/dict/zh-words.txt.gz';

export async function fetchDictionaryBytes(url = DICT_URL) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`词表请求失败：${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

export { isDictionaryLoaded, dictionarySize } from '@emeeek/core/ai/browser';
