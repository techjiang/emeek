import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../util/logger.js';
import { getPlatform, probesFor } from './platforms.js';
import { generateDeployFiles } from './config-files.js';
import { preflight } from './preflight.js';

/**
 * 部署引擎。
 *
 * 设计上把「部署」拆成四个可独立断言的阶段，而不是一个黑盒函数：
 *   plan    → 该平台需要哪些文件、跑什么命令（纯计算，不碰磁盘）
 *   prepare → 生成配置文件（幂等：内容一致则不写入）
 *   verify  → 部署后探测关键页面（可离线注入 fetcher）
 *   deploy  → 编排：build → prepare → push → verify
 *
 * verify 与 push 都接受注入（fetchImpl / runCommand），
 * 否则「部署验证」这四个字在 CI 里就只是祈祷。
 */

/** 生成计划，不产生任何副作用 —— 供 `deploy --dry-run` 与单测使用。 */
export function plan({ target, preview = false, config = {}, options = {} }) {
  const platform = getPlatform(target);
  const files = generateDeployFiles(platform.target, config, options);
  const command = platform.push ? platform.push({ preview, ...options }) : null;
  return {
    target: platform.target,
    name: platform.name,
    mode: platform.mode,
    preview,
    files, // { 相对路径: 内容 }
    command: command ? { bin: command[0], args: command[1] } : null,
    probes: resolveProbes(config, platform.target),
    hints: platform.hints ?? [],
    requires: platform.requires ?? [],
    customDomain: config?.deploy?.customDomain ?? '',
  };
}

/**
 * 探针解析：配置里显式给的优先（用户可能有自定义页面），
 * 否则用平台默认。配置项形如 `[{ path: '/tags.html', label: '标签页' }]`。
 */
function resolveProbes(config, target) {
  const custom = config?.deploy?.probes;
  if (Array.isArray(custom) && custom.length) {
    return custom.map((probe) => ({ path: probe.path, label: probe.label ?? probe.path, expect: null }));
  }
  return probesFor(target);
}

/** 检查必填参数（如 rsync 的 --host / --path）。返回缺失项数组。 */
export function missingRequirements(planResult, options = {}) {
  return (planResult.requires ?? []).filter((key) => !options[key]);
}

/**
 * 写配置文件。幂等的关键：内容与磁盘一致时跳过，不更新 mtime ——
 * 否则每次部署都会让 git 显示一堆「已修改」，或者更糟，触发无意义的重建。
 */
export async function prepare(cwd, planResult, { dryRun = false, only = null } = {}) {
  const written = [];
  const skipped = [];
  for (const [file, content] of Object.entries(planResult.files)) {
    if (only && !only.includes(file)) continue;
    const abs = path.resolve(cwd, file);
    if (dryRun) {
      written.push({ file, abs, dryRun: true, bytes: Buffer.byteLength(content) });
      continue;
    }
    const existing = await readIfExists(abs);
    if (existing === content) {
      skipped.push(file);
      continue;
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
    written.push({ file, abs, bytes: Buffer.byteLength(content) });
  }
  return { written, skipped };
}

async function readIfExists(file) {
  try { return await fs.readFile(file, 'utf8'); } catch { return null; }
}

/**
 * 部署后验证。逐个探测关键路径 + 站点自报的 URL。
 * 任何一条探测失败都返回 ok:false —— 部署命令不能「推完就跑」。
 */
export async function verify({ baseUrl, probes, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  if (!baseUrl) throw new Error('verify 需要一个 baseUrl');
  const base = String(baseUrl).replace(/\/+$/, '');
  const results = [];
  for (const probe of probes ?? probesFor('github-pages')) {
    const url = `${base}${probe.path}`;
    const started = Date.now();
    try {
      const response = await withTimeout(fetchImpl(url, { redirect: 'follow' }), timeoutMs);
      const body = await response.text();
      const ok = response.ok && (probe.expect ? probe.expect(body) : true);
      results.push({
        path: probe.path,
        label: probe.label,
        url,
        status: response.status,
        ok,
        bytes: Buffer.byteLength(body),
        elapsed: Date.now() - started,
        reason: ok ? null : `HTTP ${response.status} 且内容不符合预期`,
      });
    } catch (error) {
      results.push({ path: probe.path, label: probe.label, url, status: 0, ok: false, bytes: 0, elapsed: Date.now() - started, reason: error.message });
    }
  }
  return { url: base, ok: results.every((r) => r.ok), results };
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`请求超时（${ms}ms）`)), ms);
    promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

/**
 * 推送阶段的命令构造。返回 null 表示该平台没有本地推送命令
 * （GitHub Pages 靠 Actions，本地只生成配置）。
 */
export function pushCommand(planResult, options = {}) {
  const platform = getPlatform(planResult.target);
  if (platform.mode === 'actions') return null;
  if (!platform.push) return null;
  const [bin, args] = platform.push({ preview: planResult.preview, ...options });
  return { bin, args };
}

/**
 * 把 planResult 摘要成人类可读的行，供 CLI 打印与测试断言。
 */
export function summarize(planResult) {
  const lines = [];
  lines.push(`目标平台：${planResult.name}（${planResult.target}）`);
  if (planResult.preview) lines.push('部署模式：预览（不发布到生产）');
  if (planResult.customDomain) lines.push(`自定义域名：${planResult.customDomain}`);
  const fileList = Object.keys(planResult.files);
  lines.push(`将生成 ${fileList.length} 个配置文件：${fileList.join(', ')}`);
  if (planResult.command) lines.push(`推送命令：${planResult.command.bin} ${planResult.command.args.join(' ')}`);
  else lines.push('推送方式：仓库内 GitHub Actions（本地不执行 git push）');
  return lines;
}

export { preflight } from './preflight.js';
export { getPlatform, normalizeTarget, listTargets, probesFor, PLATFORMS } from './platforms.js';
export { generateDeployFiles, slugify } from './config-files.js';

/**
 * 编排一次完整部署：build → preflight → prepare → push → verify。
 *
 * 每个阶段都能通过参数注入替身（runCommand / fetchImpl / buildFn），
 * 于是「部署流程」本身可以在单测里跑完，而不用真的连网 ——
 * 这是「部署脚本幂等」能写成断言的前提。
 *
 * 任何阶段失败立即终止，不继续往下走：
 * 构建失败就推一份旧产物上去，比直接报错更糟。
 */
export async function deploy({
  cwd = process.cwd(),
  target,
  preview = false,
  config = {},
  options = {},
  dryRun = false,
  skipBuild = false,
  skipChecks = false,
  baseUrl = null,
  buildFn = null,
  runCommand = null,
  fetchImpl = globalThis.fetch,
  onEvent = null,
} = {}) {
  const emit = (event) => onEvent?.(event);
  const planResult = plan({ target, preview, config, options });

  const missing = missingRequirements(planResult, options);
  if (missing.length) {
    const hints = missing.map((key) => `  --${key} 缺失（${key === 'host' ? 'user@server' : '/远端/路径'}）`).join('\n');
    throw new Error(`目标 ${planResult.target} 需要额外参数：\n${hints}`);
  }

  const distDir = path.resolve(cwd, config.output?.dir ?? 'dist');

  // ── 1. 构建 ──────────────────────────────────────────────
  let buildStats = null;
  if (!skipBuild && buildFn) {
    emit({ phase: 'build', status: 'start' });
    buildStats = await buildFn({ cwd });
    emit({ phase: 'build', status: 'done', stats: buildStats });
  }

  // ── 2. 部署前门禁 ────────────────────────────────────────
  if (!skipChecks) {
    emit({ phase: 'preflight', status: 'start' });
    const result = await preflight(distDir, { config });
    emit({ phase: 'preflight', status: result.ok ? 'done' : 'failed', checks: result.checks });
    if (!result.ok) {
      const failed = result.checks.filter((c) => !c.ok);
      const lines = failed.map((c) => `  ✖ ${c.name}：${c.detail}${c.hint ? `\n      → ${c.hint}` : ''}`).join('\n');
      throw new Error(`部署前检查未通过（${failed.length} 项）：\n${lines}`);
    }
  }

  // ── 3. 生成平台配置文件（幂等）──────────────────────────
  emit({ phase: 'prepare', status: 'start' });
  const prepared = await prepare(cwd, planResult, { dryRun });
  emit({ phase: 'prepare', status: 'done', ...prepared });

  // ── 4. 推送 ──────────────────────────────────────────────
  const command = pushCommand(planResult, options);
  let pushResult = { skipped: true, reason: planResult.mode === 'actions' ? '由仓库 Actions 发布' : 'dry-run' };
  if (!dryRun && command) {
    if (!runCommand) throw new Error('需要 runCommand 才能执行推送（或使用 skipBuild/dryRun 做干跑）');
    emit({ phase: 'push', status: 'start', command });
    pushResult = { skipped: false, ...(await runCommand(command.bin, command.args, { cwd })) };
    if (pushResult.code !== 0) {
      emit({ phase: 'push', status: 'failed', result: pushResult });
      throw new Error(
        `推送失败（退出码 ${pushResult.code}）\n  重试：${command.bin} ${command.args.join(' ')}`
        + '\n  常见原因：未登录平台 CLI、CI 缺少令牌、远端路径不可写'
      );
    }
    emit({ phase: 'push', status: 'done', result: pushResult });
  }

  // ── 5. 部署后验证 ────────────────────────────────────────
  let verification = null;
  const url = baseUrl ?? config.site?.url ?? null;
  if (!dryRun && url) {
    emit({ phase: 'verify', status: 'start', url });
    verification = await verify({ baseUrl: url, probes: planResult.probes, fetchImpl });
    emit({ phase: 'verify', status: verification.ok ? 'done' : 'failed', verification });
  }

  return { plan: planResult, prepared, pushResult, verification, buildStats, distDir, dryRun };
}
