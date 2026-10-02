import fs from 'node:fs/promises';
import path from 'node:path';
import { build as coreBuild, logger } from '@emeeek/core';
import { formatBytes, formatDuration } from '../utils/format.js';

export async function build({ cwd, flags }) {
  const root = path.resolve(cwd);
  await assertProjectDir(root);
  logger.step(`构建 ${root}`);

  const stats = await coreBuild({
    cwd: root,
    configPath: flags.config,
  });

  logger.raw('');
  logger.success(`构建完成：${stats.posts} 篇文章 · ${stats.pages} 个页面 · 耗时 ${formatDuration(stats.elapsed)}`);
  if (stats.drafts) logger.dim(`  已跳过 ${stats.drafts} 篇草稿`);
  logger.dim(`  产物目录：${path.relative(process.cwd(), stats.outDir) || '.'}`);
  logger.dim(`  HTML 平均体积：${formatBytes(stats.manifest.avgHtmlBytes)}（共 ${formatBytes(stats.manifest.html)}）`);
  logger.dim(`  全部文件：${stats.manifest.files.length} 个 · ${formatBytes(stats.manifest.totalBytes)}`);

  return stats;
}

/**
 * 拒绝在不存在的目录里构建。
 * 否则 `--cwd` 打错一个字就会静默生成一个空站点：产物、退出码都正常，
 * 而问题要等到部署之后才暴露。
 */
async function assertProjectDir(root) {
  let stat;
  try {
    stat = await fs.stat(root);
  } catch {
    throw new Error(`目录不存在：${root}\n  检查 --cwd 是否拼写正确，或先运行 emeeek init <dir>`);
  }
  if (!stat.isDirectory()) throw new Error(`不是目录：${root}`);
}
