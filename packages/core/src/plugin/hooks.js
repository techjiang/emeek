import { logger } from '../util/logger.js';

/**
 * 钩子执行器。约定：钩子串行执行（内容管线里前后有依赖），
 * 单个插件报错时记录并继续 —— 一个插件不该拖垮整站构建。
 */
export function createHookRunner(plugins) {
  return {
    async run(hookName, ctx) {
      for (const plugin of plugins) {
        const hook = plugin.hooks?.[hookName];
        if (typeof hook !== 'function') continue;
        try {
          await hook(ctx, plugin.options);
        } catch (error) {
          logger.warn(`插件「${plugin.name}」在 ${hookName} 阶段出错，已跳过：${error.message}`);
        }
      }
    },
  };
}
