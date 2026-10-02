#!/usr/bin/env node
/**
 * dev/studio 集成 e2e（决策 D4）。
 *
 * 验三件事，每一件都只有在「真的 dev server + 真的浏览器」里才成立：
 *
 *   1. 磁盘改动 → 编辑器自动同步（本地干净时）
 *   2. 本地脏 + 磁盘改动 → **不自动合并**，两边都留，提示可见
 *   3. 监听范围 = 内容目录：改项目根下的文件不会触发同步
 *
 * 为什么必须真浏览器：冲突提示是不是真的出现了、编辑器内容有没有被
 * 悄悄换掉 —— 这两件事都在 DOM 里，Node 侧的断言只能测「决策函数返回了什么」。
 *
 * 用法：node scripts/e2e/dev-integration.mjs [--json]
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const JSON_ONLY = process.argv.includes('--json');

const configFile = path.join(mkdtempSync(path.join(tmpdir(), 'emeeek-dev-')), 'config.json');
writeFileSync(configFile, JSON.stringify({ root: ROOT }));

const result = spawnSync('python3', [path.join(HERE, 'dev_integration.py'), configFile], {
  encoding: 'utf8', cwd: ROOT,
});
if (result.status !== 0) {
  process.stderr.write(result.stderr || '');
  process.stdout.write(result.stdout || '');
  process.exit(result.status || 1);
}

const rows = JSON.parse(result.stdout.trim().split('\n').pop());
if (JSON_ONLY) {
  process.stdout.write(JSON.stringify(rows));
} else {
  console.log('\n▸ dev 集成 e2e（真浏览器 + 真 dev server）');
  for (const row of rows) console.log(`  ${row.ok ? '✔' : '✘'} ${row.name}${row.detail ? `  —— ${row.detail}` : ''}`);
  const failed = rows.filter((r) => !r.ok);
  console.log(`\n  ${rows.length - failed.length}/${rows.length} 通过`);
  if (failed.length) process.exitCode = 1;
}
