/**
 * 分析层（P3-4b-rest A）。
 *
 * Emeek 的价值观落在这条线上：**默认零追踪**。
 * 不是「默认关掉」，是「默认一个字节都不发出去」——
 * `analytics.enabled: false` 时，产物里不存在任何统计 script 标签、
 * 不存在任何探针端点的引用。不是加载了但不发，是根本不生成。
 *
 * 这套设计的前提：博客本来就在 GitHub 上。
 * 评论在 Issues 里、reaction 在 Issues 里、发布时间在 Issues 里 ——
 * 所以「内容互动」这一类统计**完全可以构建期推断**，不需要任何运行时依赖。
 * 只有 PV（谁在什么时候看了哪一页）必须有服务端，而那一半是可选的。
 *
 * 分三个入口：
 *   providers.js  —— 第三方/自定义注入的 script 片段（纯函数：配置 → HTML）
 *   builtin.js    —— 构建期从内容推断的互动统计（纯函数：posts → 数据）
 *   probe.js      —— 运行时 PV 探针（自托管才用，配置 → HTML/JS）
 *
 * 一条硬约束贯穿全模块：**这里不允许出现「未配置也注入一个脚本」的分支**。
 * 任何脚本的产生都必须由一个显式的 provider 决定。见
 * tests/analytics/injection.test.js 与 negative-check 的「未开启时零 script」条。
 */

export {
  ANALYTICS_PROVIDERS, PROVIDER_IDS, SCRIPT_ORIGINS, listScriptOrigins,
  getAnalyticsProvider, buildAnalyticsScripts, validateAnalyticsConfig,
} from './providers.js';

export {
  buildBuiltinStats, monthlyFrequency, topPosts, tagDistribution,
  dailyHeatmap, computeStreak, writingFrequency, toDayKey,
} from './builtin.js';

export {
  buildProbeScript, renderProbeTag, encodeHit, decodeHit, summarizeHits,
  probeEndpoint, DEFAULT_RETENTION_DAYS,
} from './probe.js';
