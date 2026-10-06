import path from 'node:path';
import { loadConfig, loadPosts, partitionPosts, explainStatus, logger, validatePosts } from '@emeeek/core';

/**
 * `emeeek drafts` —— 列出「还没进生产构建」的文章。
 *
 * 存在的理由：草稿和定时发布都会让文章从产物里消失，
 * 而「我明明写了，怎么网站上没有」是这类系统最常见的一类困惑。
 * 一条命令把「为什么没发」摊开：草稿（等手动发布）/ 定时（等到点）。
 *
 * ── 为什么判定要调 partitionPosts 而不是在这里重写一遍 ──
 *
 * 这条命令看到的「已发布 / 草稿 / 定时」必须与**产物里的**完全一致。
 * 自己再写一遍 `p.draft` 判断，迟早会因为构建那边加了「到点发布」
 * 而与命令行分叉 —— 那时用户会看到「命令说已发布，网站上没有」。
 * 判定只有一处（workflow/partitionPosts），这里只是它的一个显示端。
 */
export async function drafts({ cwd, flags }) {
  const root = path.resolve(cwd);
  const { config } = await loadConfig(root);
  const posts = await loadPosts(root, config);

  const { published, drafts, scheduled, reasons } = partitionPosts(posts, {
    now: new Date(),
    schedule: config.workflow?.schedule ?? {},
  });

  logger.step(`内容状态：${posts.length} 篇`);

  logger.raw('');
  logger.success(`已发布：${published.length} 篇`);
  if (flags.verbose) for (const post of published) logger.dim(`  · ${post.title}`);

  logger.raw('');
  if (drafts.length) {
    logger.warn(`草稿：${drafts.length} 篇（不会进入生产构建）`);
    for (const post of drafts) {
      logger.raw(`  · ${post.title}  \u001b[2m${path.relative(root, post.file ?? '')}\u001b[0m`);
      logger.dim(`    ${explainStatus(reasons.get(post))}`);
    }
  } else {
    logger.dim('草稿：0 篇');
  }

  logger.raw('');
  if (scheduled.length) {
    logger.warn(`定时发布：${scheduled.length} 篇（等时间到）`);
    for (const post of scheduled) {
      logger.raw(`  · ${post.title}  \u001b[2m${post.date}\u001b[0m`);
      logger.dim(`    ${explainStatus(reasons.get(post))}`);
    }
  } else {
    logger.dim('定时发布：0 篇');
  }

  // --validate 顺带把内容校验跑一遍。放在这里而不是另开命令：
  // 「哪些没发」与「哪些有问题」通常是一起要看的。
  if (flags.validate) {
    logger.raw('');
    const { issues, counts } = validatePosts(posts, { checks: config.workflow?.checks ?? [], source: config.content?.source ?? 'local' });
    if (!issues.length) logger.success('内容校验：全部通过');
    else {
      logger.warn(`内容校验：${counts.error} 个错误、${counts.warn} 个警告`);
      for (const item of issues) {
        logger.raw(`  ${item.severity === 'error' ? '✗' : '!'} [${item.rule}] ${item.file} · ${item.message}`);
        logger.dim(`      → ${item.fix}`);
      }
    }
  }

  return { live: published.length, drafts: drafts.length, scheduled: scheduled.length };
}
