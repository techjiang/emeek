/**
 * 浏览器端的本地 AI 服务。
 *
 * 决定 1 的落点：408KB 词表不进首屏。只有用户点了「快速摘要 / 关键词提取」
 * 时才去取 /__studio/dict/zh-words.txt.gz，用 DecompressionStream 解压
 * （浏览器原生，零依赖），再交给 core 的分词器。
 *
 * core 的 segmenter 是模块级单例状态，所以「加载过一次」这个事实由它自己记着，
 * 这里不需要再包一层缓存 —— 重复调用的开销只是一次 isDictionaryLoaded()。
 */
import { AIService, LocalProvider } from '@emeeek/core/ai/browser';

const DICT_URL = '/__studio/dict/zh-words.txt.gz';

/**
 * 创建本地 AI 服务。
 *
 * 传入的 loadDictionary 可以换成别的实现（测试里用 Node 的 zlib），
 * 默认走浏览器：fetch → ArrayBuffer → DecompressionStream('gzip')。
 * core 的 segmenter 支持传 bytes + decompress，所以这里不需要自己解压，
 * 把原始 bytes 交给它就行 —— 解压逻辑只有一份。
 */
export async function createLocalAIService({ loadDictionary: loader = loadDictionaryFromServer, providers = [] } = {}) {
  const provider = new LocalProvider({
    name: 'local',
    dictionary: {
      file: DICT_URL,
      decompress: decompressGzip,
    },
    dictionaryBytes: await loadDictionaryBytes(loader),
  });

  return new AIService({ providers: [provider, ...providers] });
}

/** 取词表原始字节。取不到就返回 null —— 分词退化为单字，功能不中断。 */
async function loadDictionaryBytes(loader) {
  try {
    return await loader(DICT_URL);
  } catch (error) {
    console.warn('[studio] 词表加载失败，关键词将退化为字级统计', error);
    return null;
  }
}

async function loadDictionaryFromServer(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`词表请求失败：${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * gzip 解压。
 *
 * 浏览器用 DecompressionStream；Node（测试）用 zlib。
 * 两边的产物都是同一个字符串，所以分词结果一致。
 */
export async function decompressGzip(bytes) {
  if (typeof DecompressionStream === 'function') {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).text();
  }
  const zlib = await import('node:zlib');
  return zlib.gunzipSync(Buffer.from(bytes)).toString('utf8');
}


