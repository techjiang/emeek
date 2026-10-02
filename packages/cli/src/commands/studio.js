import path from 'node:path';
import { build as coreBuild, logger, loadConfig } from '@emeeek/core';
import { createStudioServer } from '@emeeek/editor';

/**
 * `emeeek studio` —— 打开写作编辑器。
 *
 * 与 `emeeek dev` 的关系：dev 是「看站点」，studio 是「写文章」。
 * 两者共用同一个构建函数，所以编辑器里的预览与这里的构建结果同源。
 *
 * 刻意不做成「studio 自己有一套渲染」：那样就有两处渲染，而两处渲染
 * 迟早会分叉。这里 studio 只是把构建结果喂给编辑器。
 */
export async function studio({ cwd, flags }) {
  const root = path.resolve(cwd);
  const { config } = await loadConfig(root);

  let instance = null;
  const build = async () => {
    const stats = await coreBuild({ cwd: root });
    // 编辑器需要的是「站点里有哪些文章」，不是产物路径
    instance?.state && (instance.state.lastStats = stats);
    return stats;
  };

  instance = await createStudioServer({
    port: Number(flags.port ?? 3000),
    host: String(flags.host ?? 'localhost'),
    build,
    contentDir: path.resolve(root, config.content?.dir ?? 'posts'),
    uploadDir: path.resolve(root, 'public/uploads'),
    logger,
  });

  // 先构建一次：编辑器的 [[ 补全与双向链接解析需要站点索引
  logger.step('首次构建（为编辑器准备站点索引）…');
  try {
    const stats = await build();
    logger.success(`站点已就绪：${stats.posts} 篇文章 · ${stats.siteIndex.titles.length} 个可用链接目标`);
  } catch (error) {
    logger.warn(`构建失败，编辑器仍会打开，但 [[ 补全只能看到已加载的内容：${error.message}`);
  }

  logger.raw('');
  logger.success(`Emeek Studio  http://${flags.host ?? 'localhost'}:${instance.port}/studio`);
  logger.dim('  预览与 emeeek build 使用同一个渲染器，一致性由测试盯着');
  logger.dim('  Ctrl+C 退出\n');

  if (flags.open) {
    const { spawn } = await import('node:child_process');
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawn(opener, [instance.url], { stdio: 'ignore', detached: true }).unref();
  }

  const shutdown = async () => {
    logger.raw('\n已退出');
    await instance.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return new Promise(() => {});
}
