#!/usr/bin/env node
/**
 * 草稿安全 e2e（决策 D3）—— 真浏览器，Node 绿不算数。
 *
 * 这里验的四件事，每一件都只在真浏览器里成立：
 *
 *   1. 标签页隐藏瞬间已落盘   定时器被冻结时，`visibilitychange` 是唯一的救生索
 *   2. 进程被杀后能恢复       不触发 beforeunload，模拟系统回收 / 崩溃
 *   3. 多标签页 owner 接手    移动端上「丢弃后恢复」是常态，不是异常
 *   4. 软键盘遮挡下光标可见   布局视口不变、视觉视口变小，不处理就会看不见光标
 *
 * 起一个真的 studio 服务（真实 bundle、真实 localStorage），
 * 用 CDP 的 `Page.setWebLifecycleState` 把页面切到 frozen —— 这是系统
 * 冻结页面的等价物，比「切到另一个标签页」更接近移动端的真实行为。
 *
 * 用法：node scripts/e2e/draft-mobile.mjs [--json]
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const JSON_ONLY = process.argv.includes('--json');

const script = path.join(HERE, 'draft_mobile.py');
const config = JSON.stringify({ root: ROOT });
const configFile = path.join(mkdtempSync(path.join(tmpdir(), 'emeeek-e2e-')), 'config.json');
writeFileSync(configFile, config);

const result = spawnSync('python3', [script, configFile], { encoding: 'utf8', cwd: ROOT });
if (result.status !== 0) {
  process.stderr.write(result.stderr || '');
  process.stdout.write(result.stdout || '');
  process.exit(result.status || 1);
}

const rows = JSON.parse(result.stdout.trim().split('\n').pop());
if (JSON_ONLY) {
  process.stdout.write(JSON.stringify(rows));
} else {
  console.log('\n▸ 草稿安全 e2e（真浏览器）');
  for (const row of rows) console.log(`  ${row.ok ? '✔' : '✘'} ${row.name}${row.detail ? `  —— ${row.detail}` : ''}`);
  const failed = rows.filter((r) => !r.ok);
  console.log(`\n  ${rows.length - failed.length}/${rows.length} 通过`);
  if (failed.length) process.exitCode = 1;
}
