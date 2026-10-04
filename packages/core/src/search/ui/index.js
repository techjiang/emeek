/**
 * 搜索页客户端脚本的构建期接缝。
 *
 * 站点产物是静态 HTML，浏览器不打包模块。所以搜索页需要的那段逻辑
 * 必须以<一段内联脚本>的形式落进页面。
 *
 * 匹配逻辑只有一份（ui/matcher.js），这里把它**内联**进 DOM 壳的占位符。
 * 不用打包器：matcher 是自包含的纯函数（不 import 任何东西），
 * 把 export 关键字去掉就是合法的传统脚本 —— 一行正则的事，
 * 不值得为它引入 esbuild 依赖。
 *
 * 这样既避免了「为了内联而复刻一份会漂移的副本」，也不需要构建工具。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MATCHER_FILE = path.join(HERE, 'matcher.js');
export const CLIENT_FILE = path.join(HERE, 'client.js');
const PLACEHOLDER = '//__MATCHER__';

let cached = null;

/**
 * 产出可内联的搜索页脚本（构建期调用，结果缓存）。
 *
 * @returns {Promise<string>}
 */
export async function loadSearchClient() {
  if (cached !== null) return cached;
  const [shell, matcher] = await Promise.all([
    fs.readFile(CLIENT_FILE, 'utf8'),
    fs.readFile(MATCHER_FILE, 'utf8'),
  ]);
  cached = shell.replace(PLACEHOLDER, indent(stripModuleSyntax(matcher)));
  if (cached === shell) {
    // 占位符没了却没人发现，会产出一个「runQuery is not defined」的页面 ——
    // 那是最难查的一类失败（构建成功、页面报错）。这里直接炸。
    throw new Error(`搜索客户端里找不到占位符 ${PLACEHOLDER}，拼接失败`);
  }
  return cached;
}

/** 去掉 ESM 语法，让它成为可内联的传统脚本。 */
function stripModuleSyntax(source) {
  return source
    .replace(/^export\s+(function|const|let|var|class)\s/gm, '$1 ')
    .replace(/^export\s*\{[^}]*\}\s*;?\s*$/gm, '');
}

function indent(source) {
  return source.split('\n').map((line) => (line ? `  ${line}` : line)).join('\n');
}
