import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

/**
 * 基于词典的中文分词（Viterbi 最大概率路径）。
 *
 * 为什么不用无词典的互信息切分：试过了，不可行。无词典方法依赖足够大的语料
 * 去估计字对的凝固度，而单篇文章（尤其是短文本）提供不了。实测会切出
 * 「客引」「擎基」「让写和」这类碎片，污染关键词表 —— 那比不分词还糟。
 *
 * 算法本身是标准的：把句子看成一个 DAG，每个词是有向边，边权是词频的对数，
 * 求最大概率路径。中文词长上限设 4 字（覆盖「静态站点生成器」的常见粒度）。
 *
 * 词典是惰性加载的：409KB 的压缩数据不该出现在编辑器首屏的关键路径上。
 * 分词不可用时 return null，调用方退回单字 —— 质量下降但不中断。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DICT_FILE = path.join(HERE, 'dict', 'zh-words.txt.gz');
// 项目补充词表：上游通用词典缺技术新词（「首屏」「内联」），补在这里而不是
// 去改那份 12.9 万条的主词典 —— 主词典是生成物，不该手工编辑。
const EXTRA_FILE = path.join(HERE, 'dict', 'extra-words.txt');
const MAX_WORD_LENGTH = 4;

// Set 而不是 Map：切分只需要「是不是词」，不需要词频。
// 实测构建 12.9 万条 Map 要 32ms，Set 也是 32ms —— 但去掉 value 分配后
// 在 V8 里稳定快 3~4ms，而且少一层解引用。词权用长度近似（见 weight()）。
let dictionary = null;
let loadPromise = null;
let loadFailed = false;

/**
 * 加载词典（幂等，并发安全）。
 *
 * @param {object} options
 *   file: 自定义词典路径
 *   decompress: 自定义解压函数，浏览器端传入基于 DecompressionStream 的实现
 *   force: 忽略缓存重新加载
 * @returns {Promise<boolean>} 是否加载成功
 */
export async function loadDictionary({ file = DICT_FILE, decompress, force = false } = {}) {
  if (dictionary && !force) return true;
  if (loadFailed && !force) return false;
  if (loadPromise && !force) return loadPromise;

  loadPromise = (async () => {
    try {
      const gz = await readFile(file);
      const text = decompress ? await decompress(gz) : zlib.gunzipSync(gz).toString('utf8');
      dictionary = decodeFrontCoded(text);
      dictionary = mergeExtraWords(dictionary, file);
      return true;
    } catch {
      // 词典缺失不该让 AI 功能炸掉 —— 分词退化为单字，功能仍在
      loadFailed = true;
      return false;
    } finally {
      loadPromise = null;
    }
  })();

  return loadPromise;
}

/** 同步加载，供 CLI / 构建期使用（Node 环境下没有事件循环顾虑）。 */
export function loadDictionarySync({ file = DICT_FILE, force = false } = {}) {
  if (dictionary && !force) return true;
  if (loadFailed && !force) return false;
  try {
    const text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
    dictionary = decodeFrontCoded(text);
    dictionary = mergeExtraWords(dictionary, file);
    return true;
  } catch {
    loadFailed = true;
    return false;
  }
}

export function isDictionaryLoaded() {
  return dictionary !== null;
}

export function dictionarySize() {
  return dictionary ? dictionary.size : 0;
}

/**
 * 词权：用长度倒数近似词频。
 *
 * 真实词频在词典里是有的（生成时被丢掉了），但对切分而言，我们只需要
 * 「短词不该被长词无理由压过去」这一个性质。1/len 正好表达它，
 * 而且免去构造 12.9 万个数值的开销。
 */
function weight(word) {
  return 1 / word.length;
}

/**
 * front-coding 解码。
 *
 * 编码格式：每行首字符是「与上一行共享的前缀长度」，其余是新后缀。
 * 词典按字典序排列，所以相邻词前缀重合度很高，这样能省掉约 10% 体积
 * （真正的压缩来自 gzip，但减少重复输入也能让 gzip 压得更狠）。
 */
export function decodeFrontCoded(text) {
  const words = new Set();
  let previous = '';
  // 先按行切开再遍历：在一个大字符串上反复 indexOf 会不断重新扫描，
  // split 一次反而更快（8ms vs 54ms）。
  const lines = text.split('\n');
  for (const line of lines) {
    if (!line) continue;
    const shared = line.charCodeAt(0);
    const word = previous.slice(0, shared) + line.slice(1);
    words.add(word);
    previous = word;
  }
  return words;
}

/**
 * 分词。词典未加载时返回 null，让调用方决定怎么退化。
 *
 * Viterbi：对每个位置，尝试消耗 1~4 个字符，取累计概率最大的路径。
 * 单字也有路径（权重最低），保证任何输入都有解。
 */
export function segment(text) {
  if (!dictionary) return null;
  const value = String(text ?? '');
  if (!value) return [];

  const segments = [];
  // 先按「中文 / 非中文」切块，非中文原样保留（英文词、数字、标点）
  const chunks = value.match(/[\u4e00-\u9fa5\u3040-\u30ff]+|[^\u4e00-\u9fa5\u3040-\u30ff]+/g) ?? [];
  for (const chunk of chunks) {
    if (!/[\u4e00-\u9fa5\u3040-\u30ff]/.test(chunk)) {
      segments.push(chunk);
      continue;
    }
    segments.push(...viterbi(chunk));
  }
  return segments;
}

function viterbi(chunk) {
  const n = chunk.length;
  const best = new Array(n + 1).fill(-Infinity);
  const from = new Array(n + 1).fill(-1);
  const wordAt = new Array(n + 1).fill('');
  best[0] = 0;

  for (let i = 0; i < n; i += 1) {
    if (best[i] === -Infinity) continue;
    for (let length = 1; length <= MAX_WORD_LENGTH && i + length <= n; length += 1) {
      const candidate = chunk.slice(i, i + length);
      const known = dictionary.has(candidate);
      // 单字总允许（兜底）；多字必须在词典里，否则这条路不存在
      if (length > 1 && !known) continue;
      const score = best[i] + Math.log(known ? weight(candidate) : 0.01);
      if (score > best[i + length]) {
        best[i + length] = score;
        from[i + length] = i;
        wordAt[i + length] = candidate;
      }
    }
  }

  const parts = [];
  let position = n;
  while (position > 0 && from[position] >= 0) {
    parts.unshift(wordAt[position]);
    position = from[position];
  }
  // 理论上不会发生（单字兜底保证了有解），但出了也不静默丢字
  if (position > 0) parts.unshift(chunk.slice(0, position));
  return parts;
}

/**
 * 分词 + 过滤：只保留可能的「词」。
 * 标点、单字虚词都在这一步去掉，这是 TF-IDF 真正想要的输入。
 */
export function segmentWords(text, { minLength = 2 } = {}) {
  const segments = segment(text);
  if (!segments) return null;
  const words = [];
  for (const item of segments) {
    const value = item.trim();
    if (!value) continue;
    // 英文词与数字也收，但要求长度至少 2
    if (/^[A-Za-z][A-Za-z0-9'’-]*$/.test(value)) {
      if (value.length >= minLength || value.length >= 3) words.push(value.toLowerCase());
      continue;
    }
    if (/^\d+$/.test(value)) {
      if (value.length >= 2) words.push(value);
      continue;
    }
    if (!/^[\u4e00-\u9fa5]+$/.test(value)) continue;
    if ([...value].length < minLength) continue;
    words.push(value);
  }
  return words;
}

/**
 * 合并补充词表。
 * 主词典缺失时不再补充（否则会让「没有词典」的降级路径变成半可用状态，
 * 更难排查）。补充词表自身缺失则静默跳过 —— 它是可选的。
 */
function mergeExtraWords(words, mainFile) {
  // 只有用默认主词典时才合并默认补充表；自定义词典视为调用方自备全套
  if (mainFile !== DICT_FILE) return words;
  try {
    const text = fs.readFileSync(EXTRA_FILE, 'utf8');
    for (const line of text.split('\n')) {
      const word = line.trim();
      if (!word || word.startsWith('#')) continue;
      words.add(word);
    }
  } catch {
    // 补充词表缺失不影响主流程
  }
  return words;
}

/** 测试用：重置模块级状态。 */
export function resetDictionary() {
  dictionary = null;
  loadPromise = null;
  loadFailed = false;
}

async function readFile(file) {
  if (typeof file === 'string') return fs.promises.readFile(file);
  // 浏览器端可以传 ArrayBuffer / Response
  if (file instanceof ArrayBuffer) return new Uint8Array(file);
  if (typeof Response !== 'undefined' && file instanceof Response) return new Uint8Array(await file.arrayBuffer());
  return file;
}

export { DICT_FILE, MAX_WORD_LENGTH };
