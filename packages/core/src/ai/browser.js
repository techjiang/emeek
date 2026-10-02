/**
 * AI 能力的浏览器入口（无 node: 依赖）。
 *
 * 编辑器里能用的只有本地算法 —— LLM Provider 需要把 API Key 发到第三方，
 * 那是服务端或用户明确配置之后的事，不在这里。所以这里只导出
 * LocalProvider 与它依赖的分析器。
 */
export { LocalProvider } from './providers/local.js';
export { LocalSummarizer } from './local/summarizer.js';
export { ReadabilityAnalyzer } from './local/readability.js';
export { LocalSEOAnalyzer } from './local/seo.js';
export { extractKeywords } from './local/text.js';
export { segment, segmentWords, isDictionaryLoaded, dictionarySize } from './local/segmenter.js';
export { AITask, AIQuality, AISource, AIError, AIErrorCode } from './types.js';
export { AIService } from './registry.js';
