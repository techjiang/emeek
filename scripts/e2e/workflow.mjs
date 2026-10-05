#!/usr/bin/env node
/**
 * 内容工作流端到端验收（P3-4b-rest D2）。
 *
 * 这一层守的是两条「不可撤回」的事故：
 *   · 一篇草稿被发出去（搜索引擎抓到过、RSS 推过、读者看到过）
 *   · 一篇定时文章没到点就上线
 *
 * 所以断言的方式是**全产物扫描**，不是「看某个文件在不在」：
 * 草稿/定时文章的标题与 slug 不得出现在 dist 下的**任何**文件里
 * （页面、sitemap、feed、搜索索引、PWA 清单、service worker…）。
 * 漏了任何一类，事故就照样发生。
 *
 * 用法：node scripts/e2e/workflow.mjs [--keep]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const CLI = path.join(ROOT, 'packages/cli/bin/emeeek.js');
const KEEP = process.argv.includes('--keep');

let pass = 0;
let fail = 0;
const failures = [];
const ok = (l, e = '') => { pass += 1; console.log(`  ✔ ${l}${e ? `  —— ${e}` : ''}`); };
// 日志里带 ANSI 颜色码，且部分走 stderr。比较前统一清洗 —— 否则
// 「日志里有没有这句话」会因为颜色码插在字中间而误判为没有。
const clean = (text) => String(text ?? '').replace(/\u001b\[[0-9;]*m/g, '');
const output = (result) => clean(`${result.stdout ?? ''}${result.stderr ?? ''}`);
const bad = (l, e = '') => { fail += 1; failures.push(l); console.log(`  ✘ ${l}${e ? `  —— ${e}` : ''}`); };
const check = (l, c, e = '') => (c ? ok(l, e) : bad(l, e));

function makeSite() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emeeek-wf-e2e-'));
  fs.mkdirSync(path.join(dir, 'posts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'emeeek.config.js'), `export default {
  site: { title: '工作流验收站', description: 'E2E', url: 'https://wf-e2e.test', author: 'E2E', language: 'zh-CN' },
  content: { source: 'local', localDirs: ['posts'] },
  analytics: { statsPage: { enabled: true } },
};
`, 'utf8');
  const md = (title, date, extra, body = '正文。') => `---\ntitle: ${title}\ndate: ${date}\n${extra}---\n\n${body}\n`;
  // 已发布
  fs.writeFileSync(path.join(dir, 'posts/2025-01-10-live.md'), md('已发布文章', '2025-01-10', 'tags: [正常]\n'));
  // 草稿 —— 标题与 slug 都是独特的，便于全产物扫描
  fs.writeFileSync(path.join(dir, 'posts/2025-02-10-secret-draft.md'), md('草稿机密标题', '2025-02-10', 'draft: true\ntags: [正常]\n'));
  // 定时（未来）。date 必须写在 front-matter 里 —— 只改文件名不会生效：
  // front-matter 的 date 覆盖文件名日期（读内容的规则是「显式优先」）。
  fs.writeFileSync(path.join(dir, 'posts/2999-12-31-future-post.md'), md('未来定时标题', '2999-12-31', 'tags: [正常]\n'));
  return dir;
}

/** 递归读 dist 下所有文件的文本内容。二进制（图片）跳过。 */
function allTexts(dir, base = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { out.push(...allTexts(full, path.join(base, entry.name))); continue; }
    if (/\.(png|jpe?g|gif|webp|avif|ico|woff2?|ttf)$/i.test(entry.name)) continue;
    out.push({ rel: path.join(base, entry.name), text: fs.readFileSync(full, 'utf8') });
  }
  return out;
}

console.log('▸ 1. 构建产物');
const site = makeSite();
const built = spawnSync('node', [CLI, 'build', '--cwd', site], { encoding: 'utf8', cwd: ROOT });
check('构建成功', built.status === 0, built.status === 0 ? '' : (built.stderr ?? '').slice(0, 300));

const outDir = path.join(site, 'dist');
if (!fs.existsSync(outDir)) { bad('生成 dist'); process.exit(1); }

const files = allTexts(outDir);
check('产物非空', files.length > 5, `${files.length} 个文本文件`);

console.log('');
console.log('▸ 2. 草稿绝不进生产的硬断言');

const DRAFT_MARKERS = ['2025-02-10-secret-draft', 'secret-draft', '草稿机密标题'];
const draftLeaks = [];
for (const f of files) {
  for (const marker of DRAFT_MARKERS) {
    if (f.text.includes(marker)) draftLeaks.push(`${f.rel} 含「${marker}」`);
  }
}
check('草稿的 slug 与标题不出现在任何产物里', draftLeaks.length === 0, draftLeaks.join(' · '));
check('没有草稿页面文件', !fs.existsSync(path.join(outDir, 'posts/secret-draft.html')));
check('没有草稿页面（按日期名）', !fs.existsSync(path.join(outDir, 'posts/2025-02-10-secret-draft.html')));

console.log('');
console.log('▸ 3. 定时发布：没到点绝不进产物');

const FUTURE_MARKERS = ['2999-12-31-future-post', 'future-post', '未来定时标题'];
const futureLeaks = [];
for (const f of files) {
  for (const marker of FUTURE_MARKERS) {
    if (f.text.includes(marker)) futureLeaks.push(`${f.rel} 含「${marker}」`);
  }
}
check('未来文章不出现在任何产物里', futureLeaks.length === 0, futureLeaks.join(' · '));
check('没有未来文章的页面文件', !fs.existsSync(path.join(outDir, 'posts/future-post.html')));

console.log('');
console.log('▸ 4. 已发布的照常一切正常');

check('已发布页面存在', fs.existsSync(path.join(outDir, 'posts/live.html')));
const sitemap = fs.readFileSync(path.join(outDir, 'sitemap.xml'), 'utf8');
check('sitemap 含已发布文章', sitemap.includes('/posts/live.html'));
check('sitemap 不含草稿/未来', !sitemap.includes('draft') && !sitemap.includes('future'));

console.log('');
console.log('▸ 5. 内容校验可发现坏内容');

fs.writeFileSync(path.join(site, 'posts/2025-03-01-broken.md'), `---
title:
date: bad-date
tags: a, b
---

\`\`\`js
未闭合的代码块
`, 'utf8');

// validate = warn（默认）：构建成功但报告问题
const warnRun = spawnSync('node', [CLI, 'build', '--cwd', site], { encoding: 'utf8', cwd: ROOT });
const warnOut = output(warnRun);
check('validate=warn：构建仍成功', warnRun.status === 0);
check('校验报告出现在日志里', /内容校验/.test(warnOut));
check('含逗号的标签被抓到', /逗号/.test(warnOut));
check('未闭合代码块被抓到', /围栏/.test(warnOut));
// 说明：本地源的「空标题」不会报 —— 加载器会用文件名兜底出一个标题
// （这是「零配置即可运行」的一部分）。所以校验只在真的没有兜底时才报空标题，
// 例如 front-matter 显式写成 untitled 或 Issues 源没有标题。

// validate = error：构建失败
const configFile = path.join(site, 'emeeek.config.js');
const original = fs.readFileSync(configFile, 'utf8');
fs.writeFileSync(configFile, original.replace('content:', "workflow: { validate: 'error' },\n  content:"));
const errorRun = spawnSync('node', [CLI, 'build', '--cwd', site], { encoding: 'utf8', cwd: ROOT });
check('validate=error：坏内容让构建失败', errorRun.status !== 0, `退出码 ${errorRun.status}`);
check('失败信息说清是校验失败', /内容校验失败/.test(`${errorRun.stdout}${errorRun.stderr}`));
fs.writeFileSync(configFile, original);

console.log('');
console.log('▸ 6. emeeek drafts 的状态与产物一致');

const draftsRun = spawnSync('node', [CLI, 'drafts', '--cwd', site], { encoding: 'utf8', cwd: ROOT });
const draftsOut = output(draftsRun);
check('drafts 命令成功', draftsRun.status === 0);
check('报告草稿 1 篇', /草稿：1 篇/.test(draftsOut), draftsOut.match(/草稿：\S+/)?.[0] ?? '');
check('报告定时 1 篇', /定时发布：1 篇/.test(draftsOut), draftsOut.match(/定时发布：\S+/)?.[0] ?? '');
check('命令行的「已发布」数与产物一致', /已发布：2 篇/.test(draftsOut), draftsOut.match(/已发布：\S+/)?.[0] ?? '');

if (!KEEP) fs.rmSync(site, { recursive: true, force: true });

console.log('');
console.log(`  ── ${pass} 通过，${fail} 失败`);
if (fail) {
  console.log('  失败项：');
  for (const f of failures) console.log(`    · ${f}`);
  process.exit(1);
}
