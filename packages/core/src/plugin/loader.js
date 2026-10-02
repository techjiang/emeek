import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolvePluginSpec } from '../config/loader.js';
import { logger } from '../util/logger.js';
import { normalizeCapabilities, createCapabilityGuard, stripSecrets, FORBIDDEN_CAPABILITIES } from './capabilities.js';

/**
 * 插件加载（决策 D4）。
 *
 * 规则先于 API：
 *   · manifest 里必须显式声明需要的能力，未声明即拒绝（见 capabilities.js）
 *   · 插件代码路径限制在项目内 —— 加载前先过一遍路径判定
 *   · **凭证永不进入插件** —— 传给插件的 config 是剔除过 Key 的副本
 *   · 任何插件 bug 不得影响草稿保存 / 构建主链路
 *
 * 加载失败只告警不中断：「AI 是增强不是必需」同样适用于插件。
 */
export async function loadPlugins(config, cwd, { logger: log = logger } = {}) {
  const specs = config.plugins ?? [];
  const plugins = [];
  /** 被拒的插件与原因。doctor 与测试都看这个，不靠翻日志。 */
  const rejected = [];

  // 凭证在进入插件之前就没了。注意这里复制的是**整个 config**，
  // 插件拿到的第一个参数就是它 —— 「顺手打个日志」是泄漏最常见的形式。
  const safeConfig = stripSecrets(config);

  for (const spec of specs) {
    const name = Array.isArray(spec) ? spec[0] : spec;
    try {
      const { options, resolved } = resolvePluginSpec(spec, cwd);

      /**
       * 插件代码路径必须落在项目内。
       *
       * 为什么这条重要：`plugins: ['../../../tmp/evil.js']` 是完全合法的配置，
       * 而用户复制粘贴一份别人的配置时不会去看那一行。约束在项目内，
       * 至少让「装插件」这件事有一个可审计的边界（项目里有哪些文件是能看到的）。
       */
      if (path.isAbsolute(resolved) || resolved.startsWith('.')) {
        const absolute = path.resolve(resolved);
        const root = path.resolve(cwd);
        if (absolute !== root && !absolute.startsWith(root + path.sep)) {
          throw new Error(`插件路径在项目外：${path.relative(root, absolute)}（插件代码必须放在项目内）`);
        }
      }

      const target = resolved.startsWith('.') || resolved.startsWith('/') ? pathToFileURL(resolved).href : resolved;
      const mod = await import(target);
      const plugin = mod.default ?? mod;
      if (!plugin || typeof plugin !== 'object' || !plugin.name) {
        throw new Error('插件必须默认导出带有 name 字段的对象');
      }

      // 能力归一化会抛（申请了不允许的 / 拼错的能力名）。这是**拒绝加载**，
      // 不是拒绝某个动作 —— 一个 manifest 就写错的插件不该带着半个权限跑起来。
      const capabilities = normalizeCapabilities(plugin.capabilities, { name: plugin.name });
      const loaded = { ...plugin, capabilities, options: options ?? {}, config: safeConfig, cwd };
      loaded.guard = createCapabilityGuard(loaded, { logger: log });
      plugins.push(loaded);

      if (capabilities.size) {
        log.info?.(`插件「${plugin.name}」声明能力：${[...capabilities].join(', ')}`);
      } else if (hasHooks(plugin)) {
        // 有钩子却没声明能力：钩子会在执行时被拒，这里提前说清楚，
        // 省得用户「插件装了但什么都没发生」找不到原因
        log.warn?.(`插件「${plugin.name}」有钩子但没有声明 capabilities，钩子将在执行时被跳过`);
      }
    } catch (error) {
      const reason = error.message;
      rejected.push({ name, reason });
      log.warn?.(`插件「${name}」加载失败，已跳过：${reason}`);
    }
  }

  if (plugins.length) log.info?.(`已加载 ${plugins.length} 个插件：${plugins.map((p) => p.name).join(', ')}`);
  return attachRejections(plugins, rejected);
}

function hasHooks(plugin) {
  return Boolean(plugin.hooks && Object.values(plugin.hooks).some((hook) => typeof hook === 'function'));
}

/**
 * 把「被拒清单」挂在数组上。
 *
 * 用数组属性而不是改返回值形状：几十处调用点都在期待一个数组，
 * 改形状会让这次改动从「加一条规则」变成「动一遍调用方」——
 * 而后者才是引入回归的地方。
 */
function attachRejections(plugins, rejected) {
  Object.defineProperty(plugins, 'rejected', { value: rejected, enumerable: false });
  return plugins;
}

/**
 * 插件能拿到的 API 面。
 *
 * 这是「插件不提供任何读取 Key 的接口」的兑现点：**这个对象上没有那个方法**。
 * 不是返回 undefined，而是根本不存在 —— 一个不存在的属性无法被「绕」。
 */
export function pluginApi(plugin) {
  return Object.freeze({
    name: plugin.name,
    /** 只读的项目根与内容目录。 */
    get cwd() { return plugin.cwd; },
    /** 剔除过凭证的配置。 */
    get config() { return plugin.config; },
    /** 声明过的能力清单（插件自己可以查）。 */
    get capabilities() { return [...plugin.capabilities ?? []]; },
    /** 声明过某项能力没有。 */
    has: (capability) => plugin.capabilities?.has(capability) ?? false,
    /**
     * 读内容目录里的一个文件。
     *
     * 走宿主提供的 readFile —— 宿主在那一侧做 resolveProjectFile 校验。
     * 插件自己拼路径再调 fs 是绕不过去的：它没有 fs。
     */
    readContent: async (relative) => {
      if (!plugin.guard?.require('content:read', '读取内容文件')) return { ok: false, reason: 'forbidden' };
      return plugin.options?.readContent?.(relative) ?? { ok: false, reason: 'no-host' };
    },
    writeContent: async (relative, content) => {
      if (!plugin.guard?.require('content:write', '写入内容文件')) return { ok: false, reason: 'forbidden' };
      return plugin.options?.writeContent?.(relative, content) ?? { ok: false, reason: 'no-host' };
    },
  });
}

export { FORBIDDEN_CAPABILITIES };
