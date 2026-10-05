export { build } from './pipeline/index.js';
export { loadConfig, resolveConfigPath } from './config/loader.js';
export { defaultConfig, mergeConfig } from './config/defaults.js';
export { validateConfig } from './config/schema.js';
export { renderMarkdown } from './pipeline/parse/markdown.js';
export { parseFrontmatter } from './pipeline/parse/frontmatter.js';
export { highlight } from './pipeline/parse/code-block.js';
export { loadPosts, loadLocalPosts, loadGithubIssues } from './pipeline/source/index.js';
export { buildToc, renderToc, addAnchorLinks } from './pipeline/transform/toc.js';
export { decorateImages, createImageResolver } from './pipeline/transform/images.js';
export { buildWikiLinkIndex, resolveWikiLink } from './pipeline/transform/links.js';
export { renderArticle } from './pipeline/index.js';
export { makeExcerpt, readingTime, countWords } from './pipeline/transform/excerpt.js';
// ── 全球加速（P3-4b-accel）─────────────────────────────────────
export {
  accelerate,
  applyAcceleration,
  buildAssetMap,
  rewriteHtmlReferences,
  contentHash,
  fingerprintPath,
  shouldFingerprint,
  FINGERPRINT_EXTENSIONS,
} from './accel/index.js';
export { cacheHeaders, classifyCache, buildHeaderManifest, CACHE_CLASS } from './accel/cache-headers.js';
export { precompress, compressVariants, shouldCompress } from './accel/compress.js';
export { PROVIDERS, PROVIDER_IDS, PROVIDER_IDS as CDN_PROVIDER_IDS, getProvider, validateCdnConfig, readCredentialsFromEnv } from './accel/providers.js';
export { loadCredentials, saveCredentials, parseCredentials, serializeCredentials, ensureGitignored } from './accel/credentials.js';
export { checkIcp, scanBlockedHosts, planFontSubset, toRanges, analyzeImages, buildLocalFontFace, BLOCKED_HOSTS, CHINA_ALTERNATIVES } from './accel/china.js';
export { selectPreloadTargets, renderPreloadTags, buildEarlyHintsHeader, renderNginxSnippet, renderCaddySnippet } from './accel/hints.js';
export { hashTree, diffTrees, planFanout, buildHealthChecks, decideActiveOrigin } from './accel/origins.js';
export { createCdnClient, buildPurgeTargets, buildWarmTargets } from './accel/cdn-client.js';
export { probe, measure, compareLatency, median, PROBE_REGIONS } from './accel/latency.js';
// ── 分析与统计（P3-4b-rest A/B）────────────────────────────────
export {
  ANALYTICS_PROVIDERS, PROVIDER_IDS as ANALYTICS_PROVIDER_IDS, SCRIPT_ORIGINS, listScriptOrigins,
  getAnalyticsProvider, buildAnalyticsScripts, validateAnalyticsConfig,
  buildBuiltinStats, monthlyFrequency, topPosts, tagDistribution,
  dailyHeatmap, computeStreak, writingFrequency, toDayKey,
  buildProbeScript, renderProbeTag, encodeHit, decodeHit, summarizeHits,
  probeEndpoint, DEFAULT_RETENTION_DAYS,
} from './analytics/index.js';
export { buildStatsView, hasSectionData, STATS_SECTIONS } from './stats/index.js';
// 图表是纯函数（数据 → SVG 字符串），单独导出让编辑器/插件也能复用。
export {
  barChart, lineChart, pieChart, heatmapChart, wordCloud, rankedBars,
} from './stats/charts.js';
export { loadTheme } from './pipeline/render/theme.js';
export { normalizeOverrides, mergeOverrides } from './theme/override.js';
export { listBuiltinThemes, listAvailableThemes } from './theme/registry.js';
export { writeOutput, finalizeHtml } from './pipeline/render/output.js';
export { logger } from './util/logger.js';
export { loadPlugins, pluginApi } from './plugin/loader.js';
export { createHookRunner } from './plugin/hooks.js';
export { CAPABILITIES, HOOK_CAPABILITY, FORBIDDEN_CAPABILITIES, normalizeCapabilities, createCapabilityGuard, stripSecrets, CapabilityError } from './plugin/capabilities.js';
export { deploy, plan as planDeploy, verify as verifyDeploy, prepare as prepareDeploy, preflight, missingRequirements, pushCommand, summarize as summarizeDeploy } from './deploy/index.js';
export { getPlatform, normalizeTarget, listTargets, PLATFORMS, probesFor } from './deploy/platforms.js';
export { generateDeployFiles, slugify } from './deploy/config-files.js';
export { AIService, createProvider, resolveProviders } from './ai/registry.js';
export { AITask, AIQuality, AISource, AIError, AIErrorCode, TASK_CAPABILITIES } from './ai/types.js';
export { LocalSummarizer, ReadabilityAnalyzer, LocalSEOAnalyzer, LocalProvider } from './ai/index.js';
// 搜索层：分词 / 查询 / 建索引 / 纯文本 / 构建接缝
export { analyze, analyzeQuery, FUZZY_MIN_LENGTH, matchIndexedWords } from './search/tokenizer.js';
export { search, runLevel, filterDocs, expandFuzzy, DEFAULT_MAX_RESULTS } from './search/query.js';
export { buildIndex, serializeIndex, parseIndex, measureIndexBytes, INDEX_VERSION } from './search/indexer.js';
export { toPlainText, makeSnippet, locateTerms } from './search/plain-text.js';
export { createSearchSession } from './search/runtime.js';
export { runQuery as runClientQuery, collectSuggestions } from './search/ui/matcher.js';
// 构建期接缝（含 node:zlib）不在主入口导出 —— 浏览器打包会炸。走 ./search/build。
