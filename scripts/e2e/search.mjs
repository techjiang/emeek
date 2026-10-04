#!/usr/bin/env node
/**
 * 搜索层端到端（P3-2a）。
 *
 * 这条 e2e 覆盖「构建产物 → 前端运行时」这一整段，而不是拿一份手写的
 * 索引做单测。理由：搜索最容易出的问题是**构建期与查询期用不同的规则**，
 * 而两侧各自的单测都是绿的。只有真的把构建产物喂给运行时，才能发现它。
 *
 * 断言分五组：
 *   1. 产物存在且是合法索引（版本、字段、能被 parseIndex 读回）
 *   2. 运行时能加载并可搜（走真实 runtime，不是裸调 search）
 *   3. 中文检索准确（完整词 / 半截词 / 生造词不误伤）
 *   4. 词典未加载时仍能精确检索（首开场景）
 *   5. 体积与响应时间守住预算
 *
 * 用法：node scripts/e2e/search.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseIndex } from '@emeeek/core/search/build';
import { createSearchSession } from '@emeeek/core/search';
// 词典的同步加载只在构建期 / 脚本侧可用（浏览器走 createSearchSession +
// prepareDictionary 的异步路径）。这里是脚本，直接取源实现。
import { loadDictionarySync, resetDictionary, isDictionaryLoaded } from '@emeeek/core/ai/browser';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CASES = [];

function check(label, fn) {
  try {
    const detail = fn();
    CASES.push({ label, ok: true, detail });
  } catch (error) {
    CASES.push({ label, ok: false, detail: error.message });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ── 构建产物 ──────────────────────────────────────────────────────
const demo = 'examples/themes-demo';
const dist = path.join(ROOT, demo, 'dist');
if (!fs.existsSync(path.join(dist, 'search-index.json'))) {
  const result = spawnSync('node', [path.join(ROOT, 'packages/cli/bin/emeeek.js'), 'build', '--cwd', demo], { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) {
    console.error(result.stdout, result.stderr);
    process.exit(1);
  }
}

const raw = fs.readFileSync(path.join(dist, 'search-index.json'), 'utf8');
const index = parseIndex(raw);
const gzipBytes = (() => {
  const out = spawnSync('node', ['-e', `process.stdout.write(String(require('node:zlib').gzipSync(Buffer.from(require('node:fs').readFileSync('${path.join(dist, 'search-index.json')}'))).length))`], { encoding: 'utf8' });
  return Number(out.stdout);
})();

check('产物 search-index.json 存在且是合法索引', () => {
  assert(index, 'parseIndex 读不回产物（版本或字段不符）');
  return `${index.docs.length} 篇 · 结构版本 v${index.version}`;
});

check('索引不含正文（content 只进倒排表，不进 docs）', () => {
  const leaked = index.docs.filter((d) => ['raw', 'html', 'body'].some((k) => k in d));
  assert(leaked.length === 0, `${leaked.length} 篇文档泄漏了正文`);
  const hasExcerpt = index.docs.every((d) => typeof d.excerpt === 'string');
  assert(hasExcerpt, '有文档缺 excerpt');
  return `docs 字段：${Object.keys(index.docs[0]).join(', ')}`;
});

// ── 运行时（模拟前端首开：词典未加载） ───────────────────────────
resetDictionary();

check('词典未加载（前端首开）时运行时仍可用', () => {
  assert(!isDictionaryLoaded(), '这一步应当处于词典未加载状态');
  return 'dictionary=absent（接下来的检索都在这条路径上验证）';
});

const session = await createSearchSession({ index });

check('运行时加载索引并可查询', () => {
  assert(session.ready, 'session 未就绪');
  const r = session.query('博客');
  assert(r.total > 0, '「博客」没有结果');
  return `level ${r.level} · ${r.total} 条`;
});

check('中文完整词精确命中', () => {
  const r = session.query('主题系统');
  assert(r.results.length > 0, '「主题系统」没有结果');
  return `${r.results.length} 条：${r.results[0].title}`;
});

check('中文半截词也能召回', () => {
  const r = session.query('主题');
  assert(r.results.length > 0, '「主题」没有结果');
  return `${r.results.length} 条`;
});

check('生造词不误伤', () => {
  const r = session.query('量子纠缠态与拓扑绝缘体');
  assert(r.results.length === 0, `误命中 ${r.results.length} 条`);
  return '0 条';
});

check('结果带高亮所需字段', () => {
  const item = session.query('博客').results[0];
  for (const key of ['id', 'title', 'url', 'excerpt', 'matched', 'offset']) {
    assert(key in item, `缺字段 ${key}`);
  }
  return `matched=${JSON.stringify(item.matched)}`;
});

check('联想（suggest）可用', () => {
  const out = session.suggest('主');
  assert(out.length > 0, '「主」没有联想不到东西');
  return `${out.length} 条`;
});

// ── 词典就绪后质量提升（热替换，不重建索引） ─────────────────────
check('词典就绪后不重建索引仍能精确检索（热替换）', () => {
  loadDictionarySync();
  const after = session.query('主题系统');
  assert(after.results.length > 0, '词典就绪后反而搜不到了');
  return `level ${after.level} · ${after.total} 条`;
});

// ── 体积与性能 ────────────────────────────────────────────────────
check('索引 gzip 体积在预算内', () => {
  assert(gzipBytes < 500 * 1024, `gzip ${(gzipBytes / 1024).toFixed(1)}KB 超预算`);
  return `raw ${(raw.length / 1024).toFixed(1)}KB / gzip ${(gzipBytes / 1024).toFixed(1)}KB`;
});

check('搜索响应 < 100ms（热态均值）', () => {
  const queries = ['博客', '主题', '静态', '设计', '写作', 'Markdown', '首屏', '主题系统'];
  for (const q of queries) session.query(q); // 预热
  let total = 0;
  let count = 0;
  let max = 0;
  for (let round = 0; round < 20; round += 1) {
    for (const q of queries) {
      const t = performance.now();
      session.query(q);
      const d = performance.now() - t;
      total += d;
      count += 1;
      if (d > max) max = d;
    }
  }
  const avg = total / count;
  assert(avg < 100, `平均 ${avg.toFixed(2)}ms 超 100ms`);
  return `平均 ${avg.toFixed(3)}ms · 最大 ${max.toFixed(3)}ms（${count} 次）`;
});

// ── 报告 ──────────────────────────────────────────────────────────
const passed = CASES.filter((c) => c.ok).length;
for (const c of CASES) {
  console.log(`  ${c.ok ? '✔' : '✘'} ${c.label}  —— ${c.detail}`);
}
console.log(`\n  ${passed}/${CASES.length} 通过`);
process.exit(passed === CASES.length ? 0 : 1);
