#!/usr/bin/env node
/**
 * AI 面板 e2e（PR-4）。
 *
 * 走三种 Key 模式，看面板说的是不是同一件事：
 *   1. 没有 Key          → 生成类动作诚实报错，且不返回任何猜的内容
 *   2. 会话级 Key        → 请求走服务端转发（**浏览器里搜不到 Key 明文**）
 *   3. 服务端托管 Key    → 面板显示「服务端已配置」，用户什么都不用输
 *
 * 第 2 条是这一组里最重要的：它验的是「Key 到底有没有到达浏览器」，
 * 而这只能靠「在页面里搜一遍」来证明 —— 代码里写了什么是另一回事。
 *
 * 用法：node scripts/e2e/ai-panel.mjs [--json]
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

const configFile = path.join(mkdtempSync(path.join(tmpdir(), 'emeeek-ai-')), 'config.json');
writeFileSync(configFile, JSON.stringify({ root: ROOT }));

const result = spawnSync('python3', [path.join(HERE, 'ai_panel.py'), configFile], { encoding: 'utf8', cwd: ROOT });
if (result.status !== 0) {
  process.stderr.write(result.stderr || '');
  process.stdout.write(result.stdout || '');
  process.exit(result.status || 1);
}
const rows = JSON.parse(result.stdout.trim().split('\n').pop());
if (process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify(rows));
} else {
  console.log('\n▸ AI 面板 e2e（真浏览器）');
  for (const row of rows) console.log(`  ${row.ok ? '✔' : '✘'} ${row.name}${row.detail ? `  —— ${row.detail}` : ''}`);
  const failed = rows.filter((r) => !r.ok);
  console.log(`\n  ${rows.length - failed.length}/${rows.length} 通过`);
  if (failed.length) process.exitCode = 1;
}
