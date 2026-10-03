import path from 'node:path';
import { build as coreBuild, logger, loadConfig, loadTheme, normalizeOverrides } from '@emeeek/core';
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

  /**
   * 主题配置提供者（feature D）。
   *
   * 每次请求时按当前配置重新加载主题，返回描述符与生效值 ——
   * 用户改了 emeeek.config.js 的 theme.name，面板下一次请求就跟上，
   * 不需要重启 Studio。
   */
  const themeProvider = async () => {
    const { config: latest } = await loadConfig(root);
    const theme = await loadTheme(root, latest);
    const { values } = normalizeOverrides(theme.meta, latest.theme ?? {});
    // 生效值 = 主题声明默认值 ← 用户覆盖值，摊平成点号路径表
    const effective = {};
    for (const [group, items] of Object.entries(theme.meta.config ?? {})) {
      for (const [key, item] of Object.entries(items)) {
        if (item?.default !== undefined) effective[`${group}.${key}`] = item.default;
      }
    }
    Object.assign(effective, values);
    return { meta: { name: theme.meta.name, config: theme.meta.config ?? {} }, values: effective };
  };

  instance = await createStudioServer({
    port: Number(flags.port ?? 3000),
    host: String(flags.host ?? 'localhost'),
    build,
    contentDir: path.resolve(root, config.content?.dir ?? 'posts'),
    uploadDir: path.resolve(root, 'public/uploads'),
    // dev 集成：给了 projectRoot 就能读写磁盘上的 Markdown，同时开监听
    // —— 编辑器里的内容与磁盘保持一致，但不自动覆盖本地脏的改动（D4）
    projectRoot: root,
    watch: true,
    themeProvider,
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
