/**
 * 分析 provider 注册表。
 *
 * 形状与 accel/providers.js、deploy/platforms.js 一致：新增一家 = 加一条。
 * CLI / 校验 / 文档全部从这里读，不存在第二份「支持哪些分析服务」的清单。
 *
 * 每一条声明：
 *   id          配置里写的名字
 *   label       给人看的名字
 *   origin      会向哪个域发请求（null = 站内，不发出去）
 *   requires    必填配置项（缺了就报错，而不是注入一个半残的脚本）
 *   build(cfg)  纯函数：配置 → { head, footer } 两段 HTML
 *
 * 「注入什么」全部走 build()，返回的是**已转义**的 HTML 字符串。
 * 这里不引任何模板引擎 —— 一段 script 标签不值得。
 */

/** HTML 属性转义。provider 的配置项来自用户，不能直接拼进属性。 */
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 只允许 http(s)。javascript: / data: 一律拒绝 —— 这就是一条 XSS。 */
function safeUrl(raw, { allowed = null } = {}) {
  const value = String(raw ?? '').trim();
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (allowed && !allowed.includes(parsed.hostname)) return null;
  return value;
}

const PLAUSIBLE_ORIGIN = 'plausible.io';

export const ANALYTICS_PROVIDERS = {
  /**
   * 内置：不发任何请求。
   *
   * 它的「数据」全部在构建期从内容推断（见 builtin.js），产物里
   * 只需要一个 /stats/ 页面。这里返回空片段是**故意的** ——
   * 内置分析在浏览期的存在感必须为零。
   *
   * 唯一例外是 trackPageViews（自托管 PV 探针），它由 probe.js 单独生成，
   * 不在这里 —— 因为它是唯一一处「真的会发请求」的内置能力，
   * 混在这里会让「builtin 不注入脚本」这条断言没法写。
   */
  builtin: {
    id: 'builtin',
    label: '内置极简（零外部依赖）',
    origin: null,
    requires: [],
    build: () => ({ head: '', footer: '' }),
  },

  plausible: {
    id: 'plausible',
    label: 'Plausible（隐私友好 SaaS）',
    origin: PLAUSIBLE_ORIGIN,
    requires: ['domain'],
    build(cfg = {}) {
      // scriptSrc 可自定义（自托管 Plausible 是常见部署）。
      const src = safeUrl(cfg.scriptSrc || 'https://plausible.io/js/script.js');
      if (!src) throw new Error('analytics.plausible.scriptSrc 必须是一个 http(s) 地址');
      const domain = esc(cfg.domain);
      // defer：统计脚本永远不该挡住首屏。它排在 load 之后跑没关系，
      // 少记一次 PV 的代价远小于让读者等它。
      return {
        head: `<script defer data-domain="${domain}" src="${esc(src)}"></script>`,
        footer: '',
      };
    },
  },

  umami: {
    id: 'umami',
    label: 'Umami（自托管）',
    origin: null, // 自托管，域名由用户给
    requires: ['websiteId', 'scriptSrc'],
    build(cfg = {}) {
      const src = safeUrl(cfg.scriptSrc);
      if (!src) throw new Error('analytics.umami.scriptSrc 必须是一个 http(s) 地址');
      return {
        head: `<script defer src="${esc(src)}" data-website-id="${esc(cfg.websiteId)}"></script>`,
        footer: '',
      };
    },
  },

  goatcounter: {
    id: 'goatcounter',
    label: 'GoatCounter（免费 / 开源）',
    origin: 'goatcounter.com',
    requires: ['code'],
    build(cfg = {}) {
      const code = String(cfg.code ?? '').trim();
      if (!/^[\w.-]+$/.test(code)) {
        throw new Error('analytics.goatcounter.code 只能包含字母、数字、点、下划线与连字符');
      }
      // GoatCounter 官方脚本自己处理 host 推断；显式给 data-goatcounter
      // 是为了能指向自托管实例，而不是写死 gc.zgo.at。
      const src = safeUrl(cfg.scriptSrc || 'https://gc.zgo.at/count.js');
      if (!src) throw new Error('analytics.goatcounter.scriptSrc 必须是一个 http(s) 地址');
      return {
        head: `<script data-goatcounter="https://${esc(code)}.goatcounter.com/count" async src="${esc(src)}"></script>`,
        footer: '',
      };
    },
  },

  /**
   * 自定义 script。
   *
   * 这是唯一一处「用户能塞进任意代码」的地方，也是唯一一处
   * 会破坏「零第三方请求」承诺的地方 —— 所以它必须显式开启
   * （provider === 'custom'），并且在文档与 doctor 里都给出警告。
   *
   * 代码原样注入（不转义）：我们无法在不知道它是什么的前提下
   * 消毒一段 JS，转义只会把它变成一段什么都不干的文本。
   * 因此这里的信任模型是「用户在自己的站点里放自己的代码」——
   * 与 customCSS/customHead 不同的是，那两者有白名单，这个没有。
   * 这个差异必须被文档说清，见 docs/analytics.md。
   */
  custom: {
    id: 'custom',
    label: '自定义脚本（会破坏零第三方请求承诺）',
    origin: null,
    requires: [],
    untrustedCode: true,
    build(cfg = {}) {
      const head = String(cfg.headScript ?? '').trim();
      const footer = String(cfg.footerScript ?? '').trim();
      const wrap = (code) => (code ? `<script>${guardAgainstClosingTag(code)}</script>` : '');
      return { head: wrap(head), footer: wrap(footer) };
    },
  },
};

export const PROVIDER_IDS = Object.keys(ANALYTICS_PROVIDERS);

/**
 * 已知的分析服务域名（doctor / CSP 指引用）。
 *
 * 从每个 provider 的默认配置里**派生**，而不是手写一份常量 ——
 * 手写的那份会在「改了默认 scriptSrc」之后悄悄过期，
 * 而过期的 CSP 白名单表现为「统计不工作」，很难往回查。
 */
export function listScriptOrigins() {
  const origins = new Set();
  for (const provider of Object.values(ANALYTICS_PROVIDERS)) {
    if (provider.origin) origins.add(provider.origin);
    // 默认 scriptSrc 的域也收进来（goatcounter 的脚本在 gc.zgo.at，数据发往 <code>.goatcounter.com）。
    const src = provider.id === 'plausible' ? 'https://plausible.io/js/script.js'
      : provider.id === 'goatcounter' ? 'https://gc.zgo.at/count.js'
        : null;
    if (src) origins.add(new URL(src).hostname);
  }
  return [...origins].sort();
}

/** @deprecated 用 listScriptOrigins() —— 常量会漂移。保留只为兼容旧引用。 */
export const SCRIPT_ORIGINS = listScriptOrigins();

/**
 * `</script>` 出现在内联脚本里会直接结束脚本块，后面的内容被当 HTML 解析 ——
 * 一条完整的 XSS，且注入方不需要任何技巧。
 *
 * 打散方式用 `<\/script>`：JS 字符串/正则里的 `\/` 与 `/` 等价，
 * 所以正常代码不受影响，而 HTML 解析器再也看不到 `</script`。
 */
function guardAgainstClosingTag(code) {
  return String(code).replace(/<\/(script)/gi, '<\\/$1');
}

export function getAnalyticsProvider(id) {
  return ANALYTICS_PROVIDERS[id] ?? null;
}

/**
 * 校验分析配置。
 *
 * 分成 errors / warnings 两档：
 *   errors   —— 缺必填项、provider 不存在、URL 非法。构建应失败。
 *   warnings —— 用户可能真的想要的组合（比如 custom + 站内已有 CSP）。
 *
 * 关键一条：`enabled: false` 时**直接返回空**，不做任何 provider 校验。
 * 一个关掉的功能不该因为配置里留了半截参数就让构建失败。
 */
export function validateAnalyticsConfig(analytics = {}) {
  const errors = [];
  const warnings = [];
  if (analytics.enabled !== true) return { errors, warnings };

  const id = analytics.provider ?? 'builtin';
  const provider = getAnalyticsProvider(id);
  if (!provider) {
    errors.push({ path: 'analytics.provider', message: `未知的分析服务「${id}」，可选：${PROVIDER_IDS.join(' / ')}` });
    return { errors, warnings };
  }
  const cfg = analytics[id] ?? {};
  for (const key of provider.requires) {
    if (cfg[key] === undefined || cfg[key] === null || cfg[key] === '') {
      errors.push({ path: `analytics.${id}.${key}`, message: `${provider.label} 必须配置 ${key}` });
    }
  }
  if (provider.untrustedCode && !cfg.headScript && !cfg.footerScript) {
    warnings.push({ path: 'analytics.custom', message: 'provider 是 custom 但没有提供任何脚本内容' });
  }
  if (id === 'builtin' && analytics.builtin?.trackPageViews === true) {
    // 自托管 PV 探针需要一个能收数据的端点，产物本身给不了。
    warnings.push({
      path: 'analytics.builtin.trackPageViews',
      message: '已开启 PV 记录：探针会把访问发到 analytics.builtin.endpoint，请确认该端点由你自托管',
    });
  }
  if (id !== 'builtin' && analytics.builtin?.trackPageViews === true) {
    warnings.push({
      path: 'analytics.builtin.trackPageViews',
      message: `provider 是 ${id} 时内置 PV 探针不会生效（避免同一次访问被记两遍）`,
    });
  }
  return { errors, warnings };
}

/**
 * 生成要注入的 script 片段。
 *
 * 三件事在这里被钉死：
 *   1. `enabled !== true` → 返回空。这是「零追踪」的唯一实现点。
 *   2. 校验失败 → 抛错。不从「拼一个半残的脚本」继续。
 *   3. builtin + trackPageViews 时走 probe.js 的探针，而不是 provider.build()。
 */
export function buildAnalyticsScripts(analytics = {}, { buildProbe } = {}) {
  if (analytics.enabled !== true) return { head: '', footer: '', provider: null, origin: null };

  const { errors } = validateAnalyticsConfig(analytics);
  if (errors.length) {
    throw new Error(`分析配置校验失败：\n${errors.map((e) => `  - ${e.path}: ${e.message}`).join('\n')}`);
  }

  const id = analytics.provider ?? 'builtin';
  const provider = ANALYTICS_PROVIDERS[id];
  const built = provider.build(analytics[id] ?? {});

  let footer = built.footer;
  let probeOrigin = null;
  if (id === 'builtin' && analytics.builtin?.trackPageViews === true && typeof buildProbe === 'function') {
    const probe = buildProbe(analytics.builtin);
    footer = [footer, probe.tag].filter(Boolean).join('\n');
    probeOrigin = probe.origin;
  }

  return {
    head: built.head,
    footer,
    provider: id,
    // 前面所有请求会落到哪些域。doctor 与 CSP 指引用它列白名单。
    origin: provider.origin ?? probeOrigin ?? null,
  };
}
