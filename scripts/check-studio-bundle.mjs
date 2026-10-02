/**
 * 校验 Studio 客户端能打包，且入口体积在预算内。
 *
 * 为什么单独一个脚本、还进 CI：
 * 入口体积是编辑器首屏的硬指标，而它极易在无意识中被破坏 ——
 * 比如把某个语言语法从动态 import 改成静态 import，或引入
 * @codemirror/language-data 这种「注册全部语言」的包。
 * 那种改动不会让任何测试变红，只会让首屏从 275KB 变成 2.9MB。
 * 实测踩过一次，所以在这里钉住。
 *
 * 用法：node scripts/check-studio-bundle.mjs
 */
import { bundleClient } from '../packages/editor/src/studio/bundle.js';

const ENTRY_BUDGET_KB = 600;
const MIN_CHUNKS = 10;

const result = await bundleClient({ sourcemap: false });

if (!result.code) {
  console.error('✖ 客户端打包失败');
  console.error(result.error);
  process.exit(1);
}

const entryKB = Math.round(result.bytes / 1024);
const chunkKB = Math.round(result.chunks.reduce((sum, c) => sum + c.contents.length, 0) / 1024);

console.log(`入口 ${entryKB}KB · ${result.chunks.length} 个按需 chunk（共 ${chunkKB}KB）`);
console.log(`打包器：${result.mode}`);

const problems = [];
if (entryKB > ENTRY_BUDGET_KB) {
  problems.push(`入口 ${entryKB}KB 超过预算 ${ENTRY_BUDGET_KB}KB —— 检查是否有语言语法被静态引入`);
}
if (result.chunks.length < MIN_CHUNKS) {
  problems.push(`只有 ${result.chunks.length} 个 chunk（期望 ≥ ${MIN_CHUNKS}）—— 代码分割可能失效，懒加载会退化成「全部首屏加载」`);
}
if (/from\s*["']node:/.test(result.code)) {
  problems.push('入口里含 node: 静态导入 —— 浏览器会直接抛错');
}

if (problems.length) {
  console.error('\n✖ 未通过：');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('✔ Studio 客户端打包检查通过');
