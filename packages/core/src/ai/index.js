/**
 * AI 层入口。
 *
 * 设计原则（按重要性排序）：
 * 1. **AI 是增强不是必需** —— AI 挂了，编辑流程必须照常。降级链末端永远有 LocalProvider。
 * 2. **不静默失败** —— 本地算法做不了的任务（续写、改写）明确报错，不给假结果。
 * 3. **质量可区分** —— 每个结果带 source / quality，UI 才知道该标「本地算法」还是打 ✨。
 * 4. **确定性优先** —— 能用规则算准的（可读性、SEO 结构检查）不用模型，模型会编数字。
 */

export { AIProvider, requireText } from './providers/base.js';
export { OpenAIProvider } from './providers/openai.js';
export { AnthropicProvider } from './providers/anthropic.js';
export { LocalProvider } from './providers/local.js';
export { MockProvider } from './providers/mock.js';

export { AIService, createProvider, resolveProviders } from './registry.js';

export {
  AITask,
  AIQuality,
  AISource,
  AIError,
  AIErrorCode,
  TASK_CAPABILITIES,
  makeAIResult,
  toPlainText,
} from './types.js';

export {
  loadTemplate,
  renderTemplate,
  listTemplates,
  parseTemplate,
  clearTemplateCache,
  TEMPLATE_DIR,
} from './prompts/loader.js';

// 本地模块可以直接用，不必绕 Provider
export { LocalSummarizer } from './local/summarizer.js';
export { ReadabilityAnalyzer, analyzeStructure, sentenceLength } from './local/readability.js';
export { LocalSEOAnalyzer } from './local/seo.js';
export { loadDictionary, loadDictionarySync, segment, segmentWords } from './local/segmenter.js';
export { extractKeywords, stripMarkdown, splitSentences, countWords } from './local/text.js';
