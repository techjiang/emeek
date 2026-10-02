import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolvePluginSpec } from '../config/loader.js';
import { logger } from '../util/logger.js';

/**
 * 插件加载。插件是一个默认导出 EmeekPlugin 对象的模块；
 * 加载失败时只告警不中断 —— 「AI 是增强不是必需」同样适用于插件。
 */
export async function loadPlugins(config, cwd) {
  const specs = config.plugins ?? [];
  const plugins = [];
  for (const spec of specs) {
    // 路径解析也要包在 try 里：解析失败（插件不存在、包名拼错）
    // 属于同一种「这个插件用不了」，不应让整个构建挂掉。
    const name = Array.isArray(spec) ? spec[0] : spec;
    try {
      const { options, resolved } = resolvePluginSpec(spec, cwd);
      const target = resolved.startsWith('.') || resolved.startsWith('/') ? pathToFileURL(resolved).href : resolved;
      const mod = await import(target);
      const plugin = mod.default ?? mod;
      if (!plugin || typeof plugin !== 'object' || !plugin.name) {
        throw new Error('插件必须默认导出带有 name 字段的对象');
      }
      plugins.push({ ...plugin, options: options ?? {}, config });
    } catch (error) {
      logger.warn(`插件「${name}」加载失败，已跳过：${error.message}`);
    }
  }
  if (plugins.length) logger.info(`已加载 ${plugins.length} 个插件：${plugins.map((p) => p.name).join(', ')}`);
  return plugins;
}
