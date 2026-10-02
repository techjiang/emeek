import { logger } from '../util/logger.js';
import { HOOK_CAPABILITY, CAPABILITIES } from './capabilities.js';

/**
 * 钩子执行器（决策 D4）。
 *
 * 两条规则：
 *
 *   1. **钩子必须先过能力检查**。声明了 content:transform 才能跑 onContentLoad ——
 *      否则「能力声明」就只是文档，而文档拦不住任何东西。
 *   2. **单个插件报错时记录并继续**。一个插件不该拖垮整站构建；
 *      更准确地说：草稿保存 > 插件，构建产出 > 插件。
 *
 * 这里还要防一手「插件慢到把构建拖死」：钩子超时就跳过，而不是无限等。
 * 一个挂起的 Promise 会让整个构建停在 99% 而没有任何输出 —— 那种体验
 * 比「插件被跳过」糟得多。
 */
const HOOK_TIMEOUT_MS = 10_000;

export function createHookRunner(plugins, { logger: log = logger, timeoutMs = HOOK_TIMEOUT_MS } = {}) {
  const skipped = [];

  return {
    async run(hookName, ctx) {
      const required = HOOK_CAPABILITY[hookName];
      for (const plugin of plugins) {
        const hook = plugin.hooks?.[hookName];
        if (typeof hook !== 'function') continue;

        /**
         * 能力检查。没有声明就跑 = 静默获得权限，
         * 而「先跑起来再补声明」是权限系统最常见的失效方式。
         */
        if (required && !plugin.guard?.has(required)) {
          const detail = { plugin: plugin.name, hook: hookName, capability: required };
          skipped.push(detail);
          log.warn?.(`[plugin] 插件「${plugin.name}」的 ${hookName} 被跳过：manifest 未声明「${required}」（${CAPABILITIES[required] ?? required}）`);
          continue;
        }

        try {
          await withTimeout(hook(ctx, plugin.options), timeoutMs, `${plugin.name}.${hookName}`);
        } catch (error) {
          // 超时与抛错都只影响这个插件自己
          log.warn?.(`插件「${plugin.name}」在 ${hookName} 阶段出错，已跳过：${error.message}`);
        }
      }
    },
    /** 被跳过的钩子（doctor / 测试看它，不靠翻日志）。 */
    get skipped() { return skipped; },
  };
}

function withTimeout(promise, ms, label) {
  if (!promise || typeof promise.then !== 'function') return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超过 ${ms}ms 未返回`)), ms);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}
