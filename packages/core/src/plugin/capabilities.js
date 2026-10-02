/**
 * 插件能力声明（决策 D4）。
 *
 * ## 先立规则，再写 API
 *
 * 插件生态的安全模型是「装插件 = 信任它的全部权限」—— 这一句是真的，也
 * 正因为它是真的，**不该在 API 层给插件一个本不该有的能力**。
 * 这把钥匙不给出去，比给了之后写文档劝阻有效得多。
 *
 * 所以规则是：
 *
 *   1. manifest 里必须显式声明需要的能力（`capabilities: ['content:read']`）
 *   2. 未声明就调用 → 拒绝，并说清「哪个插件、缺哪个能力」
 *   3. **没有任何能力能读到 API Key**。不是「不推荐」，是没有这个能力值 ——
 *      凭证访问不在这张表里，插件也就无法「声明」它
 *
 * 第 3 条是这一层的设计目标：不靠审核，靠不存在。
 */

/**
 * 能力清单。
 *
 * 每一条都对应一个会被检查的具体动作 —— 只写在文档里的能力等于没有能力，
 * 因为没人会去核对「这个插件到底用了没用它声明的能力」。
 */
export const CAPABILITIES = Object.freeze({
  /** 读内容目录里的 Markdown（过 resolveProjectFile）。 */
  'content:read': '读取内容目录里的 Markdown',
  /** 写内容目录里的 Markdown（过 resolveProjectFile + 原子替换）。 */
  'content:write': '写入内容目录里的 Markdown',
  /** 改写渲染前的 posts 数组（onContentLoad）。 */
  'content:transform': '在内容管线上改写文章数据',
  /** 注册渲染钩子（onBeforeRender / onAfterRender）。 */
  'render:hook': '在渲染前后插入处理',
  /** 定义额外页面。 */
  'render:page': '定义额外页面',
  /** 提供模板 helper。 */
  'render:helper': '提供模板 helper',
  /** 调用 AI Provider（由宿主代发，插件拿不到 Key）。 */
  'ai:invoke': '通过宿主调用 AI（插件不接触凭证）',
  /** 注册 CLI 子命令。 */
  'cli:command': '注册 CLI 子命令',
});

/** 钩子 → 所需能力。钩子能不能跑，取决于插件声明了什么。 */
export const HOOK_CAPABILITY = Object.freeze({
  onContentLoad: 'content:transform',
  onBeforeRender: 'render:hook',
  onAfterRender: 'render:hook',
  onBuildComplete: 'render:hook',
});

/**
 * 一个词也不能提的能力。
 *
 * 列在这里不是为了让检查通过（检查的实现里根本没有它们），
 * 而是为了让**下一个人**读到这份文件时知道：这些是刻意不给的。
 */
export const FORBIDDEN_CAPABILITIES = Object.freeze([
  'key:read', 'ai:key', 'config:secret', 'env:read', 'process:env',
]);

export class CapabilityError extends Error {
  constructor(message, { plugin, capability } = {}) {
    super(message);
    this.name = 'CapabilityError';
    this.plugin = plugin;
    this.capability = capability;
  }
}

/**
 * 归一化插件声明的能力。
 *
 * 宽容的地方：没写 capabilities 时按「什么都不需要」处理 ——
 * 老插件（examples 里那个只用 onContentLoad 的）不该因为这条规则直接崩掉，
 * 它会被拒的是**动作**，而不是整个插件。
 *
 * 不宽容的地方：声明了不存在的能力（拼错、或者写了 FORBIDDEN 里的东西）
 * 直接报错。静默忽略拼错的能力名，会让插件作者以为自己申请到了权限。
 */
export function normalizeCapabilities(declared, { name = 'plugin' } = {}) {
  if (declared === undefined || declared === null) return new Set();
  if (!Array.isArray(declared)) {
    throw new CapabilityError(`插件「${name}」的 capabilities 必须是数组`, { plugin: name });
  }
  const set = new Set();
  for (const item of declared) {
    const value = String(item);
    if (FORBIDDEN_CAPABILITIES.includes(value)) {
      throw new CapabilityError(`插件「${name}」申请了不允许的能力「${value}」—— 凭证访问不向插件开放`, { plugin: name, capability: value });
    }
    if (!Object.hasOwn(CAPABILITIES, value)) {
      throw new CapabilityError(`插件「${name}」申请了未知能力「${value}」。可用：${Object.keys(CAPABILITIES).join(', ')}`, { plugin: name, capability: value });
    }
    set.add(value);
  }
  return set;
}

/**
 * 能力守卫。
 *
 * 检查动作、记录拒绝，而不是检查「插件声明的列表长什么样」——
 * 后者没法阻止一个声明了 content:read 的插件去写文件。
 */
export function createCapabilityGuard(plugin, { logger = console } = {}) {
  const granted = plugin.capabilities instanceof Set
    ? plugin.capabilities
    : normalizeCapabilities(plugin.capabilities, { name: plugin.name });
  const denials = [];

  function require(capability, action) {
    if (granted.has(capability)) return true;
    const detail = {
      plugin: plugin.name,
      capability,
      action,
      // 这条消息要说清三件事：谁、想干什么、缺什么能力。
      // 只说「权限不足」的报错会让人去翻源码，那是最没用的报错。
      message: `插件「${plugin.name}」试图${action}，但 manifest 里没有声明「${capability}」（${CAPABILITIES[capability] ?? '未知能力'}）`,
    };
    denials.push(detail);
    logger.warn?.(`[plugin] ${detail.message}`);
    return false;
  }

  return {
    require,
    get granted() { return [...granted]; },
    get denials() { return denials; },
    has: (capability) => granted.has(capability),
  };
}

/**
 * 传给插件的 config：剔掉一切凭证。
 *
 * 这一条必须在这里做，而不是在插件 API 的入口 —— 插件收到的第一个参数
 * 就是 ctx.config，「顺手打个日志」就能把它带出去。**入口即出口。**
 *
 * 做法是白名单复制 + 对已知的敏感字段名做深度剔除（双保险）。
 */
const SECRET_FIELDS = /^(?:api[-_]?key|apikey|secret|token|password|passwd|credential|authorization|auth)$/i;

export function stripSecrets(value, depth = 0) {
  if (depth > 6) return undefined;   // 防环 && 防无限深（恶意/意外的自引用对象）
  if (Array.isArray(value)) return value.map((item) => stripSecrets(item, depth + 1));
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date || value instanceof Map || value instanceof Set) return value;

  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_FIELDS.test(key)) continue;
    // 按值看：字符串长得像 Key 也剔掉 —— 字段名是可以随便起的
    if (typeof item === 'string' && /^(?:sk|sk-ant|gsk|xai)[-_][A-Za-z0-9_-]{12,}$/.test(item)) continue;
    if (typeof item === 'function') continue;   // 函数不该出现在传给插件的 config 里
    out[key] = stripSecrets(item, depth + 1);
  }
  return out;
}
