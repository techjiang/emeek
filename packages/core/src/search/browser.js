/**
 * 搜索层的浏览器入口（无顶层 node: 依赖）。
 *
 * 与 ai/browser.js 同样的纪律：浏览器只拿纯逻辑 + 运行时。
 * 构建期接缝（site-index.js，用 node:zlib 量 gzip）从主入口和这里都不导出，
 * 需要它的是构建脚本，走 '@emeeek/core/search/build'。
 */
export { analyze, analyzeQuery, FUZZY_MIN_LENGTH, matchIndexedWords } from './tokenizer.js';
export { search, runLevel, filterDocs, expandFuzzy, DEFAULT_MAX_RESULTS } from './query.js';
export { buildIndex, serializeIndex, parseIndex, measureIndexBytes, INDEX_VERSION } from './indexer.js';
export { toPlainText, makeSnippet, locateTerms } from './plain-text.js';
export { createSearchSession } from './runtime.js';
export { prepareDictionary, fetchDictionaryBytes, decompressGzip, isDictionaryLoaded, dictionarySize } from './dictionary.js';
