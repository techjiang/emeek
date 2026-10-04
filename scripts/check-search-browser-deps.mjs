#!/usr/bin/env node
/**
 * 检查搜索层的浏览器入口有没有顶层 node: 依赖。
 *
 * 「零 node: 依赖」这条要求很容易在后续改动里悄悄失守 —— 有人在
 * 某个模块里加一句 `import { readFile } from 'node:fs'`，浏览器打包
 * 就炸了，但本地 Node 测试全绿。所以做成脚本，放进 CI / 负向校验链。
 *
 * 与 ai/browser.js 的区别：那边通过 providers 间接拉进了
 * prompts/loader（node:fs），是既有问题、不在 P3-2a 范围。这个脚本
 * 只查搜索层自己的闭包 —— 那才是本次要守住的东西。
 *
 * 用法：node scripts/check-search-browser-deps.mjs
 * 退出码：0 = 干净；1 = 发现违规（并打印违规链）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'packages/core/src');
const ENTRY = path.join(SRC, 'search/browser.js');

const seen = new Set();
const violators = [];

function resolve(dir, spec) {
  const target = path.resolve(dir, spec);
  if (fs.existsSync(target) && fs.statSync(target).isFile()) return target;
  if (fs.existsSync(`${target}.js`)) return `${target}.js`;
  if (fs.existsSync(path.join(target, 'index.js'))) return path.join(target, 'index.js');
  return null;
}

function walk(file) {
  if (seen.has(file) || !fs.existsSync(file)) return;
  seen.add(file);
  const source = fs.readFileSync(file, 'utf8');
  const dir = path.dirname(file);
  for (const match of source.matchAll(/^(?:import|export)\b[^'"]*from\s+['"]([^'"]+)['"]/gm)) {
    const spec = match[1];
    if (spec.startsWith('node:')) {
      violators.push(`${path.relative(ROOT, file)} → ${spec}`);
      continue;
    }
    if (!spec.startsWith('.')) continue;
    const target = resolve(dir, spec);
    if (target) walk(target);
  }
}

walk(ENTRY);

console.log(`▸ 搜索层浏览器入口依赖闭包：${seen.size} 个文件`);
for (const file of [...seen].map((f) => path.relative(ROOT, f)).sort()) console.log(`  · ${file}`);

if (violators.length) {
  console.error(`\n✖ 发现 ${violators.length} 处顶层 node: 依赖（浏览器打包会炸）：`);
  for (const v of violators) console.error(`  · ${v}`);
  process.exit(1);
}
console.log('\n✔ 零顶层 node: 依赖');
