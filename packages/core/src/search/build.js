/**
 * 搜索层构建期入口。只有构建脚本（CLI / 测试）该用它 ——
 * 它拉进 node:zlib，浏览器打包会炸。
 */
export { buildSearchIndexFile, summarizeIndex, DEFAULT_GZIP_BUDGET } from './site-index.js';
export { loadSearchClient } from './ui/index.js';
export { buildIndex, serializeIndex, parseIndex, measureIndexBytes, INDEX_VERSION } from './indexer.js';
