import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  build as coreBuild,
  loadConfig,
  logger,
  planDeploy,
  summarizeDeploy,
  missingRequirements,
  prepareDeploy,
  pushCommand,
  preflight,
  verifyDeploy,
  normalizeTarget,
  listTargets,
} from '@emeeek/core';
import { formatBytes, formatDuration } from '../utils/format.js';

/**
 * `emeeek deploy` —— 部署是「建完博客要做的第一件事」，
 * 所以这条命令必须一条命令走完 build → 校验 → 生成配置 → 推送 → 验证，
 * 而不是让用户去读五份平台的文档。
 *
 * 幂等承诺：重复执行不产生副作用 —— 配置文件内容一致时不重写
 * （mtime 不变），rsync 用 --delete 让远端收敛到同一状态。
 */
export async function deploy({ cwd, flags }) {
  const root = path.resolve(cwd);
  await assertProjectDir(root);

  const { config } = await loadConfig(root);
  const target = normalizeTarget(flags.target ?? config.deploy?.target ?? 'github-pages');
  if (!target) {
    throw new Error(
      `不认识的部署目标：${flags.target}\n  可用目标：\n${listTargets().map((t) => `  - ${t.target.padEnd(14)} ${t.name}`).join('\n')}`
    );
  }

  const preview = bool(flags.preview);
  const dryRun = bool(flags['dry-run']) || bool(flags.dryRun);
  const options = {
    host: flags.host,
    path: flags.path,
    tag: flags.tag,
    project: flags.project,
    branch: flags.branch,
  };

  // 目标平台未知 / 参数缺失要在「构建之前」就报，别让用户等 30 秒构建完才被告知拼错了。
  const plan = planDeploy({ target, preview, config, options });
  const missing = missingRequirements(plan, options);
  if (missing.length) {
    const lines = missing.map((key) => key === 'host'
      ? '  --host <user@server>   远端主机（例：--host root@1.2.3.4）'
      : `  --${key} <值>          必填`).join('\n');
    throw new Error(`目标 ${plan.name} 需要额外参数：\n${lines}`);
  }

  logger.step(`部署到 ${plan.name}${preview ? '（预览）' : ''}`);
  for (const line of summarizeDeploy(plan)) logger.dim(`  ${line}`);

  // ── 1. 构建（默认执行，--no-build 可跳过）────────────────
  const skipBuild = flags.build === false || flags.build === 'false' || bool(flags['no-build']);
  let stats = null;
  if (!skipBuild) {
    logger.raw('');
    logger.step('构建站点…');
    stats = await coreBuild({ cwd: root, configPath: flags.config });
    logger.success(`构建完成：${stats.posts} 篇文章 · ${stats.pages} 个页面 · ${formatDuration(stats.elapsed)}`);
  }

  // ── 2. 部署前门禁 ────────────────────────────────────────
  const distDir = path.resolve(root, config.output?.dir ?? 'dist');
  const gate = await preflight(distDir, { config });
  logger.raw('');
  for (const check of gate.checks) {
    if (check.ok) logger.success(`${check.name}：${check.detail}`);
    else {
      logger.error(`${check.name}：${check.detail}`);
      if (check.hint) logger.dim(`    → ${check.hint}`);
    }
  }
  if (!gate.ok) {
    const failed = gate.checks.filter((c) => !c.ok).length;
    throw new Error(`部署前检查未通过（${failed} 项），已中止，产物未推送`);
  }

  // ── 3. 生成平台配置文件 ──────────────────────────────────
  logger.raw('');
  const prepared = await prepareDeploy(root, plan, { dryRun });
  for (const item of prepared.written) {
    logger.success(`${dryRun ? '[dry-run] 将写入' : '写入'} ${item.file}（${formatBytes(item.bytes)}）`);
  }
  for (const file of prepared.skipped) logger.dim(`  ${file} 内容未变，跳过`);

  // ── 4. 推送 ──────────────────────────────────────────────
  logger.raw('');
  const command = pushCommand(plan, options);
  if (dryRun) {
    logger.warn('dry-run：跳过推送与在线验证');
    logger.raw('');
    logger.success(`部署预演完成。去掉 --dry-run 即真正发布。`);
    return { plan, prepared, dryRun: true };
  }
  if (!command) {
    logger.info('该平台由仓库内 GitHub Actions 发布，本地无需推送');
    logger.dim('  把生成的 workflow 提交并推送到 main 即可触发');
  } else {
    logger.step(`执行：${command.bin} ${command.args.join(' ')}`);
    const result = await runCommand(command.bin, command.args, { cwd: root });
    if (result.code !== 0) {
      throw new Error(`推送失败（退出码 ${result.code}）\n  重试：${command.bin} ${command.args.join(' ')}\n  常见原因：未登录（npx vercel login / npx wrangler login）、缺少 CI 令牌、远端路径不可写`);
    }
    logger.success('推送完成');
  }

  // ── 5. 部署后验证 ────────────────────────────────────────
  const baseUrl = flags.url ?? config.site?.url;
  logger.raw('');
  if (flags.verify === false || flags.verify === 'false' || bool(flags['no-verify'])) {
    logger.warn('已跳过在线验证（--no-verify）');
  } else {
    logger.step(`验证部署：${baseUrl}`);
    const verification = await verifyDeploy({ baseUrl, probes: plan.probes });
    for (const item of verification.results) {
      if (item.ok) logger.success(`${item.label}：HTTP ${item.status} · ${formatBytes(item.bytes)} · ${item.elapsed}ms`);
      else {
        logger.error(`${item.label}：${item.reason}（${item.url}）`);
      }
    }
    if (!verification.ok) {
      logger.warn('验证未通过 —— 产物已推送，但部分页面不可访问');
      logger.dim('  CDN 缓存可能需要 1-2 分钟生效；若持续失败，检查部署日志与自定义域名解析');
      process.exitCode = 1;
      return { plan, prepared, verification };
    }
  }

  logger.raw('');
  logger.success(`部署完成 → ${baseUrl}`);
  if (plan.hints.length) {
    logger.raw('  下一步：');
    for (const hint of plan.hints) logger.dim(`    · ${hint}`);
  }
  return { plan, prepared, verification: null };
}

function bool(value) {
  if (value === undefined) return false;
  if (value === true) return true;
  if (typeof value === 'string') return value !== 'false' && value !== '0';
  return Boolean(value);
}

async function assertProjectDir(root) {
  try {
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) throw new Error(`不是目录：${root}`);
  } catch {
    throw new Error(`目录不存在：${root}\n  检查 --cwd 是否拼写正确`);
  }
}

/** 子进程封装：继承 stdio 让它能显示平台 CLI 的进度条（登录二维码等）。 */
function runCommand(bin, args, { cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('error', (error) => reject(new Error(`无法执行 ${bin}：${error.message}`)));
    child.on('close', (code) => resolve({ code }));
  });
}
