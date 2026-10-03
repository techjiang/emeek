/**
 * 构建管线接缝：把站点的文章列表变成可发布的搜索索引文件。
 *
 * 这一层是**唯一**允许摸 node: 的地方（gzip 体积预算需要 zlib）。它把
 * 纯逻辑（indexer）和构建期能力（体积测量）拼在一起，向上只暴露一个
 * 函数给 pipeline 调用。
 *
 * 体积预算的意义：索引要跟着页面一起下载。100 篇文章的索引如果 gzip 后
 * 有几 MB，那「搜索是增强」这句话就成了反讽 —— 增强拖垮了首屏。所以
 * 预算不是「最好能守住」，是**必须**守住，超了就抛错（构建失败好过
 * 静默发一个巨大的索引给每个访客）。
 */

import { gzipSync } from 'node:zlib';
import { buildIndex, serializeIndex, measureIndexBytes, INDEX_VERSION } from './indexer.js';
import { analyze, FUZZY_MIN_LENGTH } from './tokenizer.js';
import { loadDictionarySync, isDictionaryLoaded } from '../ai/local/segmenter.js';

/** gzip 后的体积预算（字节）。100 篇文章的实测值远低于此。 */
export const DEFAULT_GZIP_BUDGET = 500 * 1024;

/**
 * 产出搜索索引文件。
 *
 * @param {Array} posts 构建期文章
 * @param {object} [options]
 *   gzipBudget  字节上限，默认 500KB
 *   pretty      是否缩进（调试用）
 *   onBudgetExceeded (info) => void  超预算回调；不给就抛错
 *   indexUrl    索引的发布路径，用于报告
 * @returns {{path: string, content: string, stats: object}}
 */
export function buildSearchIndexFile(posts = [], {
  gzipBudget = DEFAULT_GZIP_BUDGET,
  pretty = false,
  indexUrl = '/search-index.json',
  onBudgetExceeded,
  loadDictionary = true,
  onWarning = () => {},
} = {}) {
  // 构建期必须把词表加载上。否则中文只有 bigram/单字可搜 ——
  // 前端同样能搜（这是设计好的降级），但构建期明明有文件系统，
  // 不用词典等于主动放弃检索质量。
  if (loadDictionary && !isDictionaryLoaded()) {
    try {
      loadDictionarySync();
    } catch (error) {
      onWarning(error);
    }
    if (!isDictionaryLoaded()) onWarning(new Error('词表未能加载，索引只含字级词元'));
  }
  const index = buildIndex(posts);
  const content = serializeIndex(index, { pretty });
  const raw = measureIndexBytes(content);
  const gzip = gzipSync(content).length;
  const stats = {
    version: INDEX_VERSION,
    documents: index.docs.length,
    terms: Object.keys(index.words).length,
    bigrams: Object.keys(index.bigrams).length,
    singles: Object.keys(index.singles).length,
    raw,
    gzip,
    budget: gzipBudget,
    overBudget: gzip > gzipBudget,
  };

  if (stats.overBudget) {
    if (onBudgetExceeded) onBudgetExceeded(stats);
    else {
      throw new Error(
        `搜索索引 gzip 后 ${kb(gzip)} 超过预算 ${kb(gzipBudget)}（${index.docs.length} 篇文章）。`
        + '要么收敛摘要长度，要么把预算调高并想清楚为什么。',
      );
    }
  }

  return { path: indexUrl, content, stats };
}

/**
 * 索引统计报告，供 CLI / 测试断言用。
 * 与 buildSearchIndexFile 共用同一套计算，避免「报告的数字与产物不一致」。
 */
export function summarizeIndex(stats) {
  return [
    `文档 ${stats.documents} 篇`,
    `词元 ${stats.terms} 个`,
    `bigram ${stats.bigrams} 个`,
    `单字 ${stats.singles} 个`,
    `raw ${kb(stats.raw)} / gzip ${kb(stats.gzip)}（预算 ${kb(stats.budget)}）`,
  ].join(' · ');
}

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)}KB`;
}
