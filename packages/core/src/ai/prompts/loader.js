import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AIError, AIErrorCode } from '../types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = path.join(HERE, 'templates');

/**
 * 提示词模板：放在 .txt 文件里，不硬编码在代码中。
 *
 * 理由是提示词会持续调优，而调优提示词不该需要改 JS、跑测试、重新发版。
 * 用户也能用 config.promptsDir 覆盖任意模板 —— 有些场景（学术写作、特定行业）
 * 用户比我们更清楚该怎么问。
 *
 * 模板语法刻意做到最小：只有 {{变量}}，没有条件、循环、函数。
 * 提示词不是程序，一旦能写逻辑就会有人写逻辑，然后没人看得懂。
 */

const cache = new Map();

/** 列出内置模板名（不含扩展名），用于文档与测试完整性校验。 */
export function listTemplates() {
  return fs.readdirSync(TEMPLATE_DIR).filter((file) => file.endsWith('.txt')).map((file) => file.replace(/\.txt$/, '')).sort();
}

export function loadTemplate(name, { dir } = {}) {
  const key = `${dir ?? ''}::${name}`;
  if (cache.has(key)) return cache.get(key);

  const candidates = [];
  if (dir) candidates.push(path.join(dir, `${name}.txt`));
  candidates.push(path.join(TEMPLATE_DIR, `${name}.txt`));

  for (const file of candidates) {
    try {
      const body = fs.readFileSync(file, 'utf8');
      const template = parseTemplate(name, body);
      cache.set(key, template);
      return template;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  throw new AIError(`找不到提示词模板「${name}」，已查找：${candidates.join(', ')}`, { code: AIErrorCode.INVALID_INPUT });
}

/**
 * 模板体分两段：顶部用 `@key: value` 写元信息，空行之后是正文。
 * 元信息里的 `期待输出` 用来生成文档，`变量` 用来在渲染时校验。
 */
export function parseTemplate(name, body) {
  const normalized = String(body).replace(/\r\n?/g, '\n');
  const match = /^((?:@[^\n]*\n)+)\n?([\s\S]*)$/.exec(normalized);
  const meta = { name };
  let text = normalized;
  if (match) {
    text = match[2];
    for (const line of match[1].trim().split('\n')) {
      const pair = /^@([^:]+):\s*(.*)$/.exec(line.trim());
      if (pair) meta[pair[1].trim()] = pair[2].trim();
    }
  }
  const variables = [...new Set([...text.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]))].sort();
  return { name, meta, text: text.trim(), variables };
}

/**
 * 渲染。缺失变量渲染成空串而不是抛异常 —— 提示词里少填一个字段，
 * 不该让整个 AI 功能崩掉；模型看到空位自己会处理。
 * 但 `strict` 模式下会报错，测试用得到。
 */
export function renderTemplate(template, variables = {}, { strict = false } = {}) {
  const source = typeof template === 'string' ? loadTemplate(template) : template;
  if (strict) {
    const missing = source.variables.filter((key) => variables[key] === undefined || variables[key] === null);
    if (missing.length) {
      throw new AIError(`提示词「${source.name}」缺少变量：${missing.join(', ')}`, { code: AIErrorCode.INVALID_INPUT });
    }
  }
  return source.text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const value = resolvePath(variables, key);
    if (value === undefined || value === null) return '';
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  });
}

function resolvePath(variables, key) {
  if (!key.includes('.')) return variables[key];
  let current = variables;
  for (const part of key.split('.')) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}

/** 测试辅助：清空缓存，避免改模板文件后读到旧内容。 */
export function clearTemplateCache() {
  cache.clear();
}

export { TEMPLATE_DIR };
