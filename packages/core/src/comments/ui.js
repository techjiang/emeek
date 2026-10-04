/**
 * 评论客户端脚本的**构建期接缝**。
 *
 * 与搜索页（search/ui/index.js）同一套做法，理由也一样：
 * 站点产物是静态 HTML，浏览器不打包模块，所以这段逻辑必须以
 * 「一段内联脚本」的形式落进页面。
 *
 * 但评论区比搜索多一个要求：**normalize 逻辑必须与构建期一份**。
 * 构建期用 normalizeComments 生成 e2e 的期望值，浏览器用同一段逻辑渲染 ——
 * 两份实现一定会漂移，而漂移的表现是「测试里的样子与读者看到的不一样」，
 * 这种差异只能靠肉眼发现。
 *
 * 做法：把 client.js 与 index.js 里的 normalize 函数拼在一起，
 * 去掉 export / import 关键字，挂到 window.__EMEEEK_COMMENTS__。
 * 一行正则的事 —— 不值得为它引入打包器。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMENTS_CLIENT } from './client.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_FILE = path.join(HERE, 'index.js');

let cached = null;

/**
 * 产出可内联的评论脚本（构建期调用，结果缓存）。
 *
 * @returns {Promise<string>}
 */
export async function loadCommentsClient() {
  if (cached) return cached;
  const index = await fs.readFile(INDEX_FILE, 'utf8');

  // 只抽 normalize 所需的那两个函数。不能用「整个文件去掉 import/export」
  // 的粗暴做法 —— index.js 里还有 resolveCommentTarget / renderCommentsShell，
  // 它们依赖构建期上下文（config、转义工具），搬进浏览器会报错。
  const normalizeComments = extract(index, 'normalizeComments');
  const normalizeBody = extract(index, 'normalizeBody');
  const normalizeReactions = extract(index, 'normalizeReactions');
  const escapeHtml = extract(index, 'escapeHtml');
  if (!normalizeComments || !normalizeBody || !normalizeReactions || !escapeHtml) {
    throw new Error('无法从 comments/index.js 抽出浏览器端所需的函数 —— 它们被改名或删除了？');
  }

  // 依赖顺序：被调用的在前。
  const prelude = [escapeHtml, normalizeReactions, normalizeBody, normalizeComments].join('\n\n');
  cached = `${prelude}\n\nwindow.__EMEEEK_COMMENTS__ = function (raw, limit, reactions) {\n  return normalizeComments(raw, { limit: limit, reactions: reactions });\n};\n\n${COMMENTS_CLIENT}`;
  return cached;
}

/**
 * 从模块源码里抠出一个具名函数的完整声明。
 *
 * 为什么要用「缩进 + 大括号计数」而不是纯大括号配对：
 *
 * 函数体里有正则字面量（`/[&<>"']/g`）与模板字符串。逐字符数大括号时，
 * 正则里的 `'` 会被当成字符串开头，于是剩下的解析全错位 ——
 * `normalizeComments` 会被截成 75 个字符（一个残缺的函数声明），
 * 而这**不会报错**，只会产出一段引用未定义函数的脚本，页面上评论永远空白。
 *
 * 所以这里改成：先按行切，再用「这一行的首字符缩进」判断函数是否结束。
 * 顶层函数的结束行一定是**下一行缩进回到 0 且本行以 `}` 开头**。
 * 正则字面量不可能出现在行首（它总是跟在 `=`、`(`、`return` 之后），
 * 所以这个判据不会被正则误导。
 */
function extract(source, name) {
  const lines = source.split('\n');
  const startIndex = lines.findIndex((line) =>
    line.startsWith(`export function ${name}(`) || line.startsWith(`function ${name}(`));
  if (startIndex < 0) return null;

  const collected = [];
  for (let i = startIndex; i < lines.length; i += 1) {
    const line = lines[i];
    collected.push(line);
    // 顶层的结束行：以 } 开头（缩进 0）。函数的最后一行必然如此。
    if (i > startIndex && line.startsWith('}')) break;
  }
  const decl = collected.join('\n');
  // 没找到结束行说明函数被截断了 —— 抛错而不是产出一段残缺脚本。
  if (!decl.trimEnd().endsWith('}')) {
    throw new Error(`从 comments/index.js 抽 ${name} 时没找到函数结束行（缩进判据失效？）`);
  }
  return decl.replace(/^export\s+/, '');
}
