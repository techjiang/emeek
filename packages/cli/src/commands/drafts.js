import path from 'node:path';
import { loadConfig, loadPosts, logger } from '@emeeek/core';

/**
 * `emeeek drafts` —— 列出「还没进生产构建」的文章。
 *
 * 存在的理由：草稿和定时发布都会让文章从产物里消失，
 * 而「我明明写了，怎么网站上没有」是这类系统最常见的一类困惑。
 * 一条命令把「为什么没发」摊开：草稿（等手动发布）/ 定时（等到点）。
 */
export async function drafts({ cwd, flags }) {
  const root = path.resolve(cwd);
  const { config } = await loadConfig(root);
  const posts = await loadPosts(root, config);

  const now = Date.now();
  const draftPosts = posts.filter((p) => p.draft);
  const scheduled = posts.filter((p) => !p.draft && p.date && new Date(p.date).getTime() > now);
  const live = posts.filter((p) => !p.draft && (!p.date || new Date(p.date).getTime() <= now));

  logger.step(`内容状态：${posts.length} 篇`);

  logger.raw('');
  logger.success(`已发布：${live.length} 篇`);
  if (flags.verbose) for (const post of live) logger.dim(`  · ${post.title}`);

  logger.raw('');
  if (draftPosts.length) {
    logger.warn(`草稿：${draftPosts.length} 篇（不会进入生产构建）`);
    for (const post of draftPosts) {
      logger.raw(`  · ${post.title}  \u001b[2m${path.relative(root, post.file ?? '')}\u001b[0m`);
    }
    logger.dim('  发布：把 front-matter 里的 draft 改成 false');
  } else {
    logger.dim('草稿：0 篇');
  }

  logger.raw('');
  if (scheduled.length) {
    logger.warn(`定时发布：${scheduled.length} 篇（等时间到）`);
    for (const post of scheduled) {
      logger.raw(`  · ${post.title}  \u001b[2m${post.date}\u001b[0m`);
    }
    logger.dim('  到点后重新构建即自动进入产物；CI 定时任务已覆盖');
  } else {
    logger.dim('定时发布：0 篇');
  }

  return { live: live.length, drafts: draftPosts.length, scheduled: scheduled.length };
}
