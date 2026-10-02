import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { defaultConfig, mergeConfig } from './defaults.js';
import { validateConfig } from './schema.js';

const CONFIG_FILES = ['emeeek.config.js', 'emeeek.config.mjs', 'emeeek.config.json'];

/**
 * 按优先级加载配置：EMEEEK_CONFIG 环境变量 > 目录内约定文件名 > 纯默认值。
 * 找不到配置文件不是错误 —— 零配置必须能跑起来。
 */
export async function loadConfig(cwd = process.cwd()) {
  const found = resolveConfigPath(cwd);
  let userConfig = {};
  if (found) {
    userConfig = await readConfigFile(found);
  }
  const config = mergeConfig(defaultConfig(), userConfig);
  if (typeof config.site.url === 'string') config.site.url = config.site.url.replace(/\/+$/, '');

  const { errors, warnings } = validateConfig(config);
  return { config, errors, warnings, configPath: found, raw: userConfig };
}

export function resolveConfigPath(cwd) {
  const explicit = process.env.EMEEEK_CONFIG;
  if (explicit) {
    const abs = path.resolve(cwd, explicit);
    if (!fs.existsSync(abs)) throw new Error(`EMEEEK_CONFIG 指向的文件不存在：${abs}`);
    return abs;
  }
  for (const name of CONFIG_FILES) {
    const abs = path.join(cwd, name);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

async function readConfigFile(file) {
  if (file.endsWith('.json')) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  // 缓存穿透：本地 dev 模式反复加载同一路径时，用时间戳绕过 ESM 模块缓存。
  const url = `${pathToFileURL(file).href}?t=${Date.now()}`;
  const mod = await import(url);
  const cfg = mod.default ?? mod.config;
  if (!cfg || typeof cfg !== 'object') throw new Error(`${file} 必须默认导出一个配置对象`);
  return cfg;
}

/** 插件可以是包名，也可以是相对路径；统一解析成绝对路径便于后续 import。 */
export function resolvePluginSpec(spec, cwd) {
  const [name, options] = Array.isArray(spec) ? spec : [spec, {}];
  if (name.startsWith('.') || name.startsWith('/')) {
    const require = createRequire(pathToFileURL(path.join(cwd, 'noop.js')));
    return { name, options, resolved: require.resolve(name.startsWith('/') ? name : path.resolve(cwd, name)) };
  }
  return { name, options, resolved: name };
}
