/**
 * @emeeek/editor —— Emeek Studio 的公开入口。
 *
 * 三个层次：
 *   createEmeekEditor  编辑器内核（可在任意页面嵌入）
 *   updatePreview      预览渲染（就是构建用的那个渲染器）
 *   createStudioServer Studio 的完整应用（带词表/上传/站点索引的服务端）
 */
export { createEmeekEditor, mountEditor, THEMES } from './editor/index.js';
export { updatePreview, buildHtml, previewMeta, createIncrementalRenderer, createWikiLinkResolver, BUILD_PROFILE } from './preview/index.js';
export { canonicalizeHtml, htmlEquivalent, parseHtml, normalizeTree } from './preview/dom.js';
export { createStudioServer } from './studio/server.js';
export { bundleClient } from './studio/bundle.js';
export { SUPPORTED_LANGUAGES, COMMON_LANGUAGES, findLanguage, isKnownLanguage, preloadLanguages } from './editor/languages.js';
export { buildOutline, headingSlug } from './editor/outline.js';
export { editorStats, countWords, readingTime } from './editor/stats.js';
