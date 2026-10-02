import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { build as coreBuild, loadConfig, logger } from '@emeeek/core';
import { createWatcher, resolveProjectFile } from '@emeeek/editor';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff2': 'font/woff2',
};

/**
 * 开发服务器：内存里存最后构建结果不合适（产物是文件），
 * 所以直接读 dist 目录，文件变更 → 重建 → 页面刷新。
 * 用 SSE 而不是 WebSocket，省一个依赖。
 */
export async function dev({ cwd, flags }) {
  const root = path.resolve(cwd);
  const port = Number(flags.port ?? 3000);
  const { config } = await loadConfig(root);
  const outDir = path.resolve(root, config.output?.dir ?? 'dist');

  logger.step('首次构建…');
  let stats = await runBuild(root);

  const clients = new Set();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/__emeeek/reload') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 1000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    await serveFile(outDir, url.pathname, res);
  });

  server.listen(port, () => {
    logger.raw('');
    logger.success(`预览地址 http://localhost:${port}`);
    logger.dim(`  监听内容目录与配置变更，保存即重建`);
    logger.dim('  Ctrl+C 退出\n');
  });

  /**
   * 监听范围收敛到内容目录（决策 D4）。
   *
   * 换掉原来的「轮询项目根 + 主题 + 配置」：
   *   · 范围太大 —— 一次 git 操作能造出成百上千个事件，dev server 会被
   *     自己的监听器打瘫，而用户只觉得「编辑器卡死了」
   *   · 事件路径没有过校验 —— symlink 指到外面时，监听器会跟着走到外面去
   *
   * 现在事件的路径过 resolveProjectFile（与 HTTP 入口同一个函数），
   * 监听器自身异常隔离，事件密集时合并重建而不是排队。
   */
  const contentDir = path.resolve(root, config.content?.dir ?? (config.content.localDirs?.[0] ?? 'posts'));
  const watcher = createWatcher({
    root,
    contentDir,
    resolve: resolveProjectFile,
    logger,
    onChange: async ({ reason, path: changed }) => {
      logger.step(`${changed} 变更，重新构建…`);
      try {
        stats = await runBuild(root, { quiet: true });
        logger.success(`重建完成（${stats.posts} 篇文章）`);
      } catch (error) {
        logger.error(`构建失败：${error.message}`);
      }
      for (const client of clients) client.write(`data: ${JSON.stringify({ at: Date.now(), reason, path: changed })}\n\n`);
    },
  }).start();
  logger.dim(`  监听范围：${path.relative(root, contentDir) || '.'}（目录外变更不触发重建）`);

  // 配置与主题仍单独轮询（理由写在 watchConfigFiles 上面）
  await watchConfigFiles(root, config, async (changed) => {
    logger.step(`${path.relative(root, changed)} 变更，重新构建…`);
    try {
      stats = await runBuild(root, { quiet: true });
      logger.success(`重建完成（${stats.posts} 篇文章）`);
    } catch (error) {
      logger.error(`构建失败：${error.message}`);
    }
    for (const client of clients) client.write(`data: ${JSON.stringify({ at: Date.now(), reason: 'config' })}\n\n`);
  });

  // 浏览器端自动刷新脚本：通过 SSE 接收重建事件后整页 reload。
  server.on('listening', () => {
    process.on('SIGINT', () => {
      logger.raw('\n已退出');
      watcher.stop();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 500);
    });
  });

  if (flags.open) {
    const { spawn } = await import('node:child_process');
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawn(opener, [`http://localhost:${port}`], { stdio: 'ignore', detached: true }).unref();
  }

  return new Promise(() => {});
}

async function runBuild(root, { quiet = false } = {}) {
  if (quiet) {
    const original = console.log;
    console.log = () => {};
    try { return await coreBuild({ cwd: root }); } finally { console.log = original; }
  }
  return coreBuild({ cwd: root });
}

async function serveFile(outDir, pathname, res) {
  let relative = decodeURIComponent(pathname).replace(/^\/+/, '');
  if (!relative || relative.endsWith('/')) relative += 'index.html';

  let file = path.join(outDir, relative);
  // 目录穿越防护：解析后的路径必须仍在产物目录内。
  if (!path.resolve(file).startsWith(path.resolve(outDir))) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  let content;
  try {
    content = await fs.readFile(file);
  } catch {
    if (!path.extname(relative)) {
      try {
        file = path.join(outDir, `${relative}.html`);
        content = await fs.readFile(file);
      } catch {
        content = await fs.readFile(path.join(outDir, '404.html')).catch(() => Buffer.from('404'));
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' }).end(injectReload(content));
        return;
      }
    } else {
      const fallback = await fs.readFile(path.join(outDir, '404.html')).catch(() => Buffer.from('404'));
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' }).end(injectReload(fallback));
      return;
    }
  }

  const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  if (type.startsWith('text/html')) {
    res.writeHead(200, { 'Content-Type': type }).end(injectReload(content));
  } else {
    res.writeHead(200, { 'Content-Type': type }).end(content);
  }
}

function injectReload(content) {
  const script = `<script>(function(){var s=new EventSource('/__emeeek/reload');s.onmessage=function(){location.reload()}})()</script>`;
  return String(content).replace('</body>', `${script}</body>`);
}

/**
 * 配置与主题的变更仍然单独看。
 *
 * 它们不在内容目录里（内容目录只放文章），而「改了主题想立刻看到效果」
 * 是完全合理的期待。用轮询而不是 fs.watch：这两个路径通常只有一个文件，
 * 轮询的开销可忽略，而 fs.watch 在不同平台/编辑器上的行为差异很大
 * （有的编辑器是「写临时文件再 rename」，watch 那个 inode 就永远收不到事件）。
 */
async function watchConfigFiles(root, config, onChange) {
  const targets = [
    path.join(root, 'emeeek.config.js'),
    path.join(root, 'themes'),
    path.join(root, 'package', config.theme?.name ?? 'minimal'),
  ];
  let snapshot = new Map();
  const timer = setInterval(async () => {
    for (const target of targets) {
      const stamp = await fingerprint(target);
      if (snapshot.has(target) && snapshot.get(target) !== stamp) {
        try { onChange(target); } catch (error) { logger.warn(`配置变更处理失败：${error.message}`); }
      }
      snapshot.set(target, stamp);
    }
  }, 900);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** 目录/文件的最新 mtime。目录取「所有后代里最新的那个」。 */
async function fingerprint(target) {
  try {
    const stat = await fs.stat(target);
    if (!stat.isDirectory()) return `${stat.mtimeMs}`;
    const entries = await fs.readdir(target, { recursive: true, withFileTypes: true });
    let latest = stat.mtimeMs;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const file = await fs.stat(path.join(entry.parentPath ?? entry.path, entry.name));
      latest = Math.max(latest, file.mtimeMs);
    }
    return String(latest);
  } catch {
    return 'missing';
  }
}
