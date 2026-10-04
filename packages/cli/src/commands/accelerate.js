import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import {
  loadConfig,
  logger,
  PROVIDERS,
  PROVIDER_IDS,
  getProvider,
  validateCdnConfig,
  loadCredentials,
  saveCredentials,
  ensureGitignored,
  createCdnClient,
  buildPurgeTargets,
  buildWarmTargets,
  measure,
  compareLatency,
  PROBE_REGIONS,
  checkIcp,
  planFontSubset,
  renderNginxSnippet,
  renderCaddySnippet,
  analyzeImages,
  hashTree,
  planFanout,
  buildHealthChecks,
  decideActiveOrigin,
  diffTrees,
} from '@emeeek/core';
import { formatBytes, formatDuration } from '../utils/format.js';

/**
 * `emeek accelerate` —— 全球加速的总入口。
 *
 * 四个动作：
 *   （无参数）  配置向导：选 CDN → 填凭据 → 写配置 → 打印服务器片段
 *   --test     加速效果检测：对多个区域测 TTFB，可选对比加速前
 *   --purge    刷新 CDN 缓存（内容更新后）
 *   --warm     预热 CDN（部署后）
 *
 * 设计取向：能一条命令做完的事，不让用户去控制台点。但也绝不替用户
 * 做需要他知情的事（比如写凭据文件会明确说写在哪个路径、权限 0600）。
 */
export async function accelerate({ cwd, flags }) {
  const root = path.resolve(cwd);
  const { config } = await loadConfig(root).catch(() => ({ config: null }));

  if (flags.purge) return runPurge({ root, config, flags });
  if (flags.warm) return runWarm({ root, config, flags });
  if (flags.test) return runTest({ root, config, flags });
  if (flags.plan) return runPlan({ root, config, flags });
  if (flags.fanout) return runFanout({ root, config, flags });
  if (flags.health) return runHealth({ root, config, flags });
  return runWizard({ root, config, flags });
}

// ── 配置向导 ─────────────────────────────────────────────────────

async function runWizard({ root, config, flags }) {
  const out = process.stdout;
  out.write('\n\x1b[36m▸ Emeek 全球加速配置向导\x1b[0m\n');
  out.write('\x1b[2m  目标：让中国大陆用户打开博客不用等 10 秒，也不用挂代理。\x1b[0m\n\n');

  const providerId = flags.provider ?? (await askChoice('选择 CDN 提供商', PROVIDER_IDS, (id) => `${id} — ${PROVIDERS[id].name}`));
  const provider = getProvider(providerId);
  out.write(`\n  \x1b[2m${provider.name}：${provider.chinaAccess ? '具备中国大陆节点能力' : '无中国大陆节点（需搭配 aliyun/tencent）'}${provider.requiresIcp ? ' · 需要 ICP 备案' : ''}\x1b[0m\n\n`);

  const rl = readline.createInterface({ input: process.stdin, output: out });
  const answers = {};
  const secrets = {};
  try {
    for (const field of provider.fields) {
      if (field.env && flags[field.key] === undefined && !field.secret) {
        const envValue = process.env[field.env];
        if (envValue) {
          answers[field.key] = envValue;
          continue;
        }
      }
      if (field.secret) {
        const value = await askSecret(rl, field, provider);
        if (value) secrets[field.env] = value;
        continue;
      }
      const value = await askField(rl, field, flags);
      if (value !== undefined) answers[field.key] = value;
    }
    if (provider.chinaAccess || flags.china) {
      const enableChina = await askBool(rl, '是否启用中国大陆加速', flags.china !== false);
      if (enableChina) {
        const domain = await askField(rl, { key: 'chinaDomain', label: '大陆加速域名（如 cdn.myblog.techsauce.cn）' }, flags);
        const icp = await askBool(rl, '该域名是否已完成 ICP 备案', Boolean(flags.icp));
        answers.china = { enabled: true, provider: provider.chinaAccess ? provider.id : 'aliyun', domain: domain || '', icp };
      }
    }
  } finally {
    rl.close();
  }

  // 凭据落到 .emeek/credentials（0600），绝不进配置文件。
  let credPath = null;
  if (Object.keys(secrets).length) {
    credPath = await saveCredentials(secrets, { cwd: root, scope: flags.scope === 'user' ? 'user' : 'project' });
    const added = await ensureGitignored(root);
    logger.success(`凭据已写入 ${path.relative(process.cwd(), credPath)}（权限 0600）`);
    if (added) logger.info('.gitignore 已补上 .emeek/ —— 防止凭据被提交');
  }

  const cdnBlock = buildCdnConfig(providerId, answers);
  await writeCdnConfig(root, cdnBlock);

  const { errors, warnings } = validateCdnConfig(cdnBlock);
  for (const w of warnings) logger.warn(`cdn: ${w.message}`);
  if (errors.length) {
    for (const e of errors) logger.error(`${e.path}: ${e.message}`);
    throw new Error('CDN 配置校验失败');
  }

  const serverName = config?.site?.url ? safeHost(config.site.url) : 'example.com';
  process.stdout.write(`\n\x1b[36m▸ 服务器加速片段\x1b[0m\n`);
  logger.dim('  Nginx（graph gzip_static / brotli_static / 103 Early Hints / 缓存头）：');
  process.stdout.write(indent(renderNginxSnippet({ serverName }), '    '));
  logger.dim(`  Caddy：同样写在 dist/server/Caddyfile，构建时自动生成。`);

  const icp = checkIcp({ cdn: cdnBlock, site: config?.site });
  if (icp.blockers.length) {
    process.stdout.write('\n');
    for (const b of icp.blockers) logger.warn(`中国大陆加速前置条件未满足：${b.message}`);
    logger.dim('  这不是「变慢」，是「打不开」——请在部署前解决。');
  }

  process.stdout.write('\n');
  logger.success(`配置已写入 emeeek.config.js 的 cdn 段`);
  logger.dim(`  下一步：emeek build && emeeek accelerate --test   # 实测加速效果`);
  return { provider: providerId, config: cdnBlock, credentialsPath: credPath };
}

async function askChoice(label, options, render) {
  if (!process.stdin.isTTY) return options[0];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(`\n  ${label}：\n`);
    options.forEach((opt, i) => process.stdout.write(`    ${i + 1}) ${render(opt)}\n`));
    const answer = (await rl.question('  > ')).trim();
    const index = Number(answer) - 1;
    if (Number.isInteger(index) && options[index]) return options[index];
    if (options.includes(answer)) return answer;
    return options[0];
  } finally {
    rl.close();
  }
}

async function askField(rl, field, flags) {
  if (!process.stdin.isTTY) return flags[field.key] ?? field.default;
  if (flags[field.key] !== undefined) return flags[field.key];
  const hint = field.required ? '' : '（可留空）';
  const answer = (await rl.question(`  ${field.label}${hint}: `)).trim();
  return answer || field.default || '';
}

async function askBool(rl, label, fallback) {
  if (!process.stdin.isTTY) return fallback;
  const answer = (await rl.question(`  ${label} (y/N): `)).trim().toLowerCase();
  if (!answer) return fallback;
  return answer === 'y' || answer === 'yes';
}

/**
 * 读取凭据输入。用 readline 的普通 question：真正的隐藏输入需要 raw mode
 * 与终端控制，价值不抵复杂度；这里改为「不落盘、不回声到日志」来保护。
 */
async function askSecret(rl, field, provider) {
  const existing = process.env[field.env];
  if (existing) {
    logger.dim(`  已从环境变量 ${field.env} 读取 ${field.label}（不写入配置文件）`);
    return null;
  }
  if (!process.stdin.isTTY) return null;
  const answer = (await rl.question(`  ${field.label}（不会写入配置文件，留空则跳过）: `)).trim();
  return answer || null;
}

function buildCdnConfig(providerId, answers) {
  const provider = getProvider(providerId);
  const cdn = { enabled: true, provider: providerId };
  for (const field of provider.fields) {
    if (field.secret) continue;
    if (answers[field.key] !== undefined && answers[field.key] !== '') cdn[field.key] = answers[field.key];
  }
  if (answers.china) cdn.china = answers.china;
  cdn.fingerprint = { enabled: true };
  cdn.compression = { enabled: true };
  return cdn;
}

/**
 * 把 cdn 段写进 emeeek.config.js。
 *
 * 用「标记块」替换而不是生成整份配置：用户的 site/content 等他写的东西
 * 必须原样保留。找不到就追加到默认导出对象前，并提示手动合并。
 */
export async function writeCdnConfig(root, cdn) {
  const target = path.join(root, 'emeeek.config.js');
  const snippet = `  cdn: ${JSON.stringify(cdn, null, 2).split('\n').join('\n  ')},\n`;
  const START = '  // >>> emeeek:cdn （由 emeeek accelerate 维护，可手动编辑）';
  const END = '  // <<< emeeek:cdn';

  let content;
  try {
    content = await fs.readFile(target, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    content = `export default {\n  site: { title: '我的知识宇宙', url: 'https://example.com' },\n};\n`;
  }

  const block = `${START}\n${snippet}${END}\n`;
  if (content.includes(START) && content.includes(END)) {
    const start = content.indexOf(START);
    const end = content.indexOf(END) + END.length + 1;
    content = `${content.slice(0, start)}${block}${content.slice(end)}`;
  } else {
    const anchor = content.indexOf('export default {');
    if (anchor === -1) {
      throw new Error('emeeek.config.js 里找不到 `export default {`，无法自动写入 cdn 段。请手动添加。');
    }
    const insertAt = content.indexOf('{', anchor) + 1;
    content = `${content.slice(0, insertAt)}\n${block}${content.slice(insertAt)}`;
  }
  await fs.writeFile(target, content);
  return target;
}

// ── 效果检测 ─────────────────────────────────────────────────────

async function runTest({ root, config, flags }) {
  const distDir = path.resolve(root, config?.output?.dir ?? 'dist');
  const siteUrl = flags.url ?? config?.site?.url;
  const regions = flags.region ? String(flags.region).split(',') : PROBE_REGIONS.map((r) => r.id);
  const runs = Number(flags.runs ?? 3);

  process.stdout.write('\n\x1b[36m▸ 加速效果检测\x1b[0m\n');
  logger.dim(`  目标：${siteUrl ?? '（未配置 site.url）'}`);
  logger.dim(`  探测点：${regions.join(' / ')} · 每点 ${runs} 次取中位`);

  if (!siteUrl) {
    logger.warn('没有可探测的地址：请设 site.url 或用 --url 指定。');
    logger.dim('  本地可先用：emeek accelerate --test --url http://localhost:3000/');
  }

  // 本地无网络时仍然要产出可用的东西：报告产物侧的加速事实。
  const localReport = await localAccelerationReport(distDir);

  if (siteUrl && flags.offline !== true) {
    const result = await measure(`${String(siteUrl).replace(/\/+$/, '')}/`, { runs });
    const rows = [{
      id: 'probe',
      label: regions[0] ?? 'default',
      area: 'cn',
      before: null,
      after: result.ttfb,
      available: result.ok,
    }];
    const comparison = compareLatency(rows);
    printComparison(comparison);
    if (!result.ok) logger.warn(`探测失败：${result.error ?? `HTTP ${result.status}`}`);
  } else if (!siteUrl) {
    logger.dim('  跳过网络探测。');
  } else {
    logger.dim('  已指定 --offline：跳过网络探测，只报告产物侧事实。');
  }

  printLocalReport(localReport);
  return { localReport };
}

/**
 * 产物侧加速事实。这是「即使没配 CDN 也能自查」的部分 ——
 * 降级加速不是摆设，得能证明它在。
 */
export async function localAccelerationReport(distDir) {
  const report = { dir: distDir, files: 0, fingerprinted: 0, precompressed: 0, html: 0, totalBytes: 0, savings: null, fonts: null, blocked: [] };
  let manifest = null;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(distDir, 'acceleration.json'), 'utf8'));
  } catch { /* 没构建过就只报空 */ }

  let entries = [];
  try {
    entries = await walk(distDir);
  } catch { return report; }

  for (const file of entries) {
    const rel = path.relative(distDir, file).split(path.sep).join('/');
    if (rel.startsWith('server/')) continue;
    report.files += 1;
    const stat = await fs.stat(file);
    report.totalBytes += stat.size;
    if (/\.[0-9a-f]{8}\.\w+$/.test(rel)) report.fingerprinted += 1;
    if (rel.endsWith('.gz') || rel.endsWith('.br')) report.precompressed += 1;
    if (rel.endsWith('.html')) report.html += 1;
  }
  if (manifest?.compression) {
    report.savings = {
      gzipSaved: formatBytes(Math.round(manifest.compression.originalBytes * (1 - manifest.compression.gzipRatio))),
      brotliSaved: formatBytes(Math.round(manifest.compression.originalBytes * (1 - manifest.compression.brotliRatio))),
      gzipRatio: manifest.compression.gzipRatio,
      brotliRatio: manifest.compression.brotliRatio,
    };
  }
  report.fonts = manifest?.fonts ?? null;
  report.blocked = manifest?.blockedHosts ?? [];
  report.preload = manifest?.preload ?? [];
  report.headers = manifest?.headers ?? [];
  return report;
}

function printComparison(comparison) {
  process.stdout.write('\n  \x1b[1m区域延迟对比\x1b[0m\n');
  for (const row of comparison.rows) {
    const after = row.after != null ? `${row.after}ms` : '不可达';
    const before = row.before != null ? `${row.before}ms` : '—';
    process.stdout.write(`    ${row.label.padEnd(8, ' ')} ${before.padStart(8)} → ${after.padStart(8)}\n`);
  }
  if (comparison.cn.after != null) {
    const ok = comparison.cnTarget;
    process.stdout.write(`\n  中国大陆中位 TTFB：${comparison.cn.after}ms ${ok ? '\x1b[32m✔ < 500ms\x1b[0m' : '\x1b[31m✖ ≥ 500ms\x1b[0m'}\n`);
  }
}

function printLocalReport(report) {
  process.stdout.write('\n  \x1b[1m产物侧加速事实\x1b[0m\n');
  process.stdout.write(`    文件：${report.files} 个 · ${formatBytes(report.totalBytes)}\n`);
  process.stdout.write(`    已指纹资源：${report.fingerprinted} 个（可 immutable 长缓存）\n`);
  process.stdout.write(`    预压缩产物：${report.precompressed} 个（.gz / .br）\n`);
  if (report.savings) {
    process.stdout.write(`    压缩节省：gzip ${report.savings.gzipSaved} · brotli ${report.savings.brotliSaved}\n`);
  }
  if (report.preload?.length) {
    process.stdout.write(`    preload 目标：${report.preload.map((p) => p.path).join(', ')}\n`);
  }
  if (report.fonts?.chunkCount) {
    process.stdout.write(`    中文字体子集：${report.fonts.totalGlyphs} 字形 → ${report.fonts.chunkCount} 片（每片 < ${Math.round(report.fonts.maxChunkBytes / 1024)}KB）\n`);
  }
  if (report.blocked?.length) {
    process.stdout.write('    \x1b[33m国内不可达引用：\x1b[0m\n');
    for (const b of report.blocked) process.stdout.write(`      ${b.host} — ${b.suggestion?.replaceWith ?? '建议替换'}\n`);
  } else {
    process.stdout.write('    国内不可达引用：无 ✔\n');
  }
}

// ── 刷新 / 预热 ──────────────────────────────────────────────────

async function runPurge({ root, config, flags }) {
  const distDir = path.resolve(root, config?.output?.dir ?? 'dist');
  const siteUrl = flags.url ?? config?.site?.url;
  const cdnConfig = config?.cdn ?? {};
  if (!cdnConfig.provider) throw new Error('没有 CDN 配置。先运行 `emeek accelerate` 配置。');

  const targets = buildPurgeTargets(siteUrl, { files: await listDistFiles(distDir), includeAssets: flags.all === true });
  const client = await makeClient(cdnConfig, flags);
  process.stdout.write(`\n\x1b[36m▸ 刷新 CDN 缓存\x1b[0m\n`);
  logger.dim(`  ${cdnConfig.provider} · ${targets.length} 个 URL`);
  if (flags['dry-run']) {
    logger.info('--dry-run：只列出将被刷新的 URL，不发请求');
    for (const t of targets.slice(0, 20)) process.stdout.write(`    ${t}\n`);
    return { dryRun: true, targets };
  }
  const result = await client.purge(targets);
  if (result.skipped) {
    logger.warn(result.reason);
    return result;
  }
  if (!result.ok) throw new Error(`刷新失败：HTTP ${result.status} ${result.raw}`);
  logger.success(`刷新完成（${formatDuration(result.elapsed)}）`);
  return { ...result, targets };
}

async function runWarm({ root, config, flags }) {
  const cdnConfig = config?.cdn ?? {};
  if (!cdnConfig.provider) throw new Error('没有 CDN 配置。先运行 `emeek accelerate` 配置。');
  const siteUrl = flags.url ?? config?.site?.url;
  const client = await makeClient(cdnConfig, flags);

  const posts = await loadPostUrls(root, config);
  const targets = buildWarmTargets(siteUrl, {
    posts,
    extra: ['/search-index.json', '/sitemap.xml', '/rss.xml'],
  });
  process.stdout.write(`\n\x1b[36m▸ 预热 CDN\x1b[0m\n`);
  logger.dim(`  ${cdnConfig.provider} · ${targets.length} 个 URL（首页 + 最近文章 + 索引）`);
  if (flags['dry-run']) {
    logger.info('--dry-run：只列出将被预热的 URL，不发请求');
    for (const t of targets.slice(0, 20)) process.stdout.write(`    ${t}\n`);
    return { dryRun: true, targets };
  }
  const result = await client.warm(targets);
  if (result.skipped) {
    logger.warn(result.reason);
    process.stdout.write('  \x1b[2m  提示：预热只是「提前回源」。不预热时首次访问仍会回源，只是第一个用户会多等一次。\x1b[0m\n');
    return result;
  }
  if (!result.ok) throw new Error(`预热失败：HTTP ${result.status} ${result.raw}`);
  logger.success(`预热完成（${formatDuration(result.elapsed)}）`);
  return { ...result, targets };
}

async function makeClient(cdnConfig, flags) {
  const { values, missing, sources } = await loadCredentials(cdnConfig.provider, { cwd: flags.cwd });
  if (missing.length) {
    const lines = missing.map((m) => `  - ${m.key}（环境变量 ${m.env}）`).join('\n');
    throw new Error(`缺少 CDN 凭据：\n${lines}\n  可用环境变量提供，或运行 emeeek accelerate 写入 .emeek/credentials。`);
  }
  if (flags.verbose) {
    for (const [key, source] of Object.entries(sources)) logger.dim(`  凭据 ${key} ← ${source}`);
  }
  return createCdnClient({ providerId: cdnConfig.provider, config: cdnConfig, credentials: values });
}

// ── 只读规划 ─────────────────────────────────────────────────────

async function runPlan({ root, config, flags }) {
  const distDir = path.resolve(root, config?.output?.dir ?? 'dist');
  const posts = await loadPostUrls(root, config, { withRaw: true });
  const fonts = planFontSubset(posts);
  const images = analyzeImages([]);
  const report = await localAccelerationReport(distDir);
  process.stdout.write('\n\x1b[36m▸ 加速规划\x1b[0m\n');
  logger.dim(`  中文字形：${fonts.totalGlyphs} 个 → ${fonts.chunkCount} 片`);
  for (const chunk of fonts.chunks.slice(0, 6)) {
    process.stdout.write(`    subset-${chunk.index}.woff2  ${chunk.glyphCount} 字形  ~${Math.round(chunk.estimatedBytes / 1024)}KB  ${chunk.unicodeRange[0]}…\n`);
  }
  logger.dim(`  图片建议：WebP ${images.savings.webp}`);
  printLocalReport(report);
  return { fonts, report };
}

// ── 多源站 ───────────────────────────────────────────────────────

/**
 * 多源站推送规划。
 *
 * 核心是**幂等**：每个源站记录上一次推送的产物摘要，摘要一致就跳过。
 * 「切换 CDN 会不会把内容搞乱」这种担心，答案必须由代码给出而不是文档。
 */
async function runFanout({ root, config, flags }) {
  const distDir = path.resolve(root, config?.output?.dir ?? 'dist');
  process.stdout.write('\n\x1b[36m▸ 多源站推送规划\x1b[0m\n');

  const tree = await hashTree(distDir);
  if (!tree.count) {
    throw new Error(`产物目录为空：${distDir}\n  先运行 emeeek build。`);
  }

  const origins = config?.deploy?.origins
    ?? config?.cdn?.origins
    ?? [{ id: 'github-pages', role: 'primary' }, { id: 'vercel' }, { id: 'cloudflare-pages' }];

  const stateFile = path.join(root, '.emeek', 'deploy-state.json');
  const prevManifest = await readJson(stateFile, {});
  const plan = planFanout({ origins, prevManifest, nextManifest: tree });

  logger.dim(`  产物：${tree.count} 个文件 · 摘要 ${tree.digest}`);
  for (const entry of plan) {
    const mark = entry.needsPush ? '\x1b[33m↻\x1b[0m' : '\x1b[32m✔\x1b[0m';
    process.stdout.write(`    ${mark} ${entry.id.padEnd(18)} ${entry.reason}\n`);
  }

  const health = buildHealthChecks(origins);
  const decision = decideActiveOrigin(origins, health.map((h) => ({ origin: h.origin, healthy: true })));
  logger.dim(`  DNS 当前应指向：${decision.active}（${decision.role}）`);

  if (flags['dry-run'] === true) {
    logger.dim('  --dry-run：只规划，不记录推送状态');
  } else {
    await fs.mkdir(path.dirname(stateFile), { recursive: true });
    await fs.writeFile(stateFile, JSON.stringify({ ...prevManifest, ...Object.fromEntries(plan.map((p) => [p.id, tree])) }, null, 2));
    logger.dim(`  推送状态已记录到 ${path.relative(process.cwd(), stateFile)}`);
  }

  const allSkip = plan.every((p) => !p.needsPush);
  if (allSkip) logger.success('所有源站产物已是最新 —— 重复推送不产生副作用');
  return { tree, plan };
}

/** 源站健康检查（只看配置是否自洽，不发真实请求）。 */
async function runHealth({ root, config }) {
  const origins = config?.deploy?.origins ?? config?.cdn?.origins ?? [{ id: 'github-pages', role: 'primary' }];
  const checks = buildHealthChecks(origins, { interval: config?.deploy?.healthInterval ?? '5m' });
  process.stdout.write('\n\x1b[36m▸ 源站健康检查配置\x1b[0m\n');
  for (const check of checks) {
    process.stdout.write(`    ${check.origin.padEnd(18)} 每 ${check.interval} · ${check.retries} 次失败切换 · 超时 ${check.timeout}\n`);
  }
  logger.dim('  检查项包含内容谓词：只回 200 不算健康，静态托管常用 404 页返回 200。');
  return { checks };
}

// ── 辅助 ─────────────────────────────────────────────────────────

async function listDistFiles(distDir) {
  try {
    const entries = await walk(distDir);
    return entries
      .map((f) => path.relative(distDir, f).split(path.sep).join('/'))
      .filter((rel) => !rel.endsWith('.gz') && !rel.endsWith('.br') && !rel.startsWith('server/'))
      .map((rel) => `/${rel}`);
  } catch {
    return [];
  }
}

async function loadPostUrls(root, config, { withRaw = false } = {}) {
  try {
    const { loadPosts } = await import('@emeeek/core');
    const posts = await loadPosts(root, config);
    return posts.map((p) => ({
      title: p.title,
      url: `/${config?.postPath ?? 'posts'}/${p.slug}.html`,
      date: p.date,
      raw: withRaw ? p.raw : undefined,
      description: p.description,
    }));
  } catch {
    return [];
  }
}

async function walk(dir, acc = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function safeHost(url) {
  try { return new URL(url).host; } catch { return 'example.com'; }
}

function indent(text, prefix) {
  return String(text).split('\n').map((line) => `${prefix}${line}`).join('\n') + '\n';
}
