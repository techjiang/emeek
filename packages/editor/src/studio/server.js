/**
 * Emeek Studio 服务端。
 *
 * 为什么需要服务端，而不是一个纯静态页面：
 * 1. 预览必须与构建同源 —— 渲染在 Node 侧由 @emeeek/core 完成
 * 2. 词表（408KB gz）不能进首屏 —— 只在用到分词时按需取
 * 3. 图片上传需要一个落点
 *
 * 它是 `emeeek dev` 的一个附加模式（`--studio`），而不是独立的第二套服务器：
 * 站点预览与编辑器共用一个进程，/studio 是编辑器的入口。
 * 两个服务器意味着「编辑器看到的是另一个站」，这本身就埋下了不一致。
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleClient, bundleFailureNotice, readAsset } from './bundle.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.gz': 'application/gzip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/**
 * 启动 Studio。
 *
 * 路由：
 *   /studio               编辑器页面
 *   /__studio/client.js   浏览器端 bundle（首次请求时打包，之后缓存）
 *   /__studio/preview.css 预览 iframe 的样式
 *   /__studio/site.json   站点文章/图片索引（[[ 补全与双向链接解析用）
 *   /__studio/dict/*      中文词表（惰性，只有点了 AI 分析才会请求）
 *   /__studio/render      服务端渲染预览（可选，用于「预览=构建」的兜底校验）
 *   /__studio/upload      图片上传
 */
export async function createStudioServer({
  port = 3000,
  host = 'localhost',
  build,
  contentDir = null,
  uploadDir = null,
  logger = console,
} = {}) {
  const state = {
    files: new Map(),       // URL 路径 → 内容（入口 + 语言 chunk）
    bundleError: null,
    building: null,
    site: { posts: [], images: [] },
    lastBuild: null,
    buildMs: null,
    stats: null,
  };

  async function ensureBundle() {
    if (state.files.size) return state.files;
    if (state.building) return state.building;
    state.building = (async () => {
      const result = await bundleClient();
      state.bundleError = result.error;
      state.files = new Map(result.files.map((file) => [file.path, file.contents]));
      if (result.code) {
        // 入口体积与 chunk 数是首屏性能的直接指标，启动时就报出来
        state.stats = {
          entryBytes: result.bytes,
          entryKB: Math.round(result.bytes / 1024),
          chunks: result.chunks.length,
          chunkKB: Math.round(result.chunks.reduce((sum, c) => sum + c.contents.length, 0) / 1024),
          mode: result.mode,
        };
        logger.info?.(`客户端 bundle 就绪（${result.mode}）入口 ${state.stats.entryKB}KB + ${state.stats.chunks} 个按需 chunk（共 ${state.stats.chunkKB}KB）`);
      } else {
        logger.warn?.(`客户端 bundle 失败：${result.error}`);
      }
      state.building = null;
      return state.files;
    })();
    return state.building;
  }

  async function refreshSite() {
    if (typeof build !== 'function') return state.site;
    try {
      const stats = await build();
      state.lastBuild = stats;
      state.buildMs = stats.elapsed;
      if (stats.siteIndex) state.site = stats.siteIndex;
    } catch (error) {
      logger.error?.(`构建失败：${error.message}`);
    }
    return state.site;
  }

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    try {
      await route(url, request, response);
    } catch (error) {
      logger.error?.(error.stack ?? error.message);
      send(response, 500, 'text/plain; charset=utf-8', `Studio 内部错误：${error.message}`);
    }
  });

  async function route(url, request, response) {
    const pathname = decodeURIComponent(url.pathname);

    if (pathname === '/studio' || pathname === '/studio/') {
      const html = await readAsset('studio.html');
      return send(response, 200, MIME['.html'], html);
    }

    if (pathname === '/__studio/client.js') {
      const files = await ensureBundle();
      const code = files.get('/__studio/client.js');
      if (!code) return send(response, 503, MIME['.html'], bundleFailureNotice(state.bundleError));
      return send(response, 200, MIME['.js'], code);
    }

    // 按需加载的语言 chunk（代码分割的产物）。
    // 浏览器只有在文档里真的出现某种语言的代码块时才会请求到这里。
    if (pathname.startsWith('/__studio/chunks/') || /\.js$/.test(pathname) && state.files.has(pathname)) {
      const files = await ensureBundle();
      const chunk = files.get(pathname);
      if (chunk) return send(response, 200, MIME['.js'], chunk, { 'cache-control': 'public, max-age=3600' });
      return send(response, 404, 'text/plain; charset=utf-8', 'chunk not found');
    }

    if (pathname === '/__studio/preview.css') {
      return send(response, 200, MIME['.css'], await readAsset('preview.css'));
    }

    if (pathname === '/__studio/studio.css') {
      return send(response, 200, MIME['.css'], await readAsset('studio.css'));
    }

    if (pathname === '/__studio/site.json') {
      if (!state.site?.posts?.length && typeof build === 'function') await refreshSite();
      return send(response, 200, MIME['.json'], JSON.stringify(state.site));
    }

    if (pathname.startsWith('/__studio/dict/')) {
      // 惰性词表：只有真的要用分词时才会请求到这里。
      // 首屏 HTML 里对它的引用为零 —— 编辑器首屏不加载 408KB。
      const name = path.basename(pathname);
      const dir = await resolveDictDir();
      if (!dir) return send(response, 404, 'text/plain; charset=utf-8', '找不到 core 的词表目录');
      try {
        const data = await fs.readFile(path.join(dir, name));
        return send(response, 200, MIME['.gz'], data, { 'cache-control': 'public, max-age=86400' });
      } catch {
        return send(response, 404, 'text/plain; charset=utf-8', `词表不存在：${name}`);
      }
    }

    if (pathname === '/__studio/render' && request.method === 'POST') {
      const body = await readBody(request);
      // 渲染在服务端做（Node 侧 core），返回的就是构建会写出的 HTML。
      // 编辑器默认在浏览器里渲染（快），这个端点用来做「预览=构建」的独立复核。
      const { renderArticle } = await import('@emeeek/core/pipeline');
      const html = renderArticle(body, { allowHtml: false, lazyImages: true, headingIds: new Map() });
      return send(response, 200, MIME['.json'], JSON.stringify({ html }));
    }

    if (pathname === '/__studio/upload' && request.method === 'POST') {
      const target = uploadDir ?? path.resolve(process.cwd(), 'public/uploads');
      await fs.mkdir(target, { recursive: true });
      const name = decodeURIComponent(request.headers['x-filename'] ?? `image-${Date.now()}.png`);
      const safe = path.basename(name).replace(/[^\w.-]+/gu, '-');
      const buffer = await readRaw(request);
      await fs.writeFile(path.join(target, safe), buffer);
      return send(response, 200, MIME['.json'], JSON.stringify({ url: `/uploads/${safe}`, bytes: buffer.length }));
    }

    if (pathname === '/__studio/status') {
      return send(response, 200, MIME['.json'], JSON.stringify({
        bundle: state.files.size ? 'ready' : state.bundleError ? 'failed' : 'pending',
        bundleError: state.bundleError,
        bundleStats: state.stats,
        buildMs: state.buildMs,
        posts: state.site?.posts?.length ?? 0,
      }));
    }

    return send(response, 404, 'text/plain; charset=utf-8', 'Not found');
  }

  await new Promise((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  return {
    server,
    port: address.port,
    url: `http://${host}:${address.port}/studio`,
    state,
    refreshSite,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function send(response, status, type, body, extraHeaders = {}) {
  const headers = { 'content-type': type, ...extraHeaders };
  response.writeHead(status, headers);
  response.end(body);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function readRaw(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

/**
 * 词表目录。
 *
 * 通过 import.meta.resolve('@emeeek/core/ai/browser') 反查 core 的安装位置，
 * 而不是按相对路径猜 —— 相对路径在 workspace（软链）与发布后（node_modules）
 * 两种布局下是不一样的，猜错的结果是「AI 分析静默退化成单字」。
 */
async function resolveDictDir() {
  if (resolveDictDir.cached !== undefined) return resolveDictDir.cached;
  const candidates = [];
  try {
    const coreEntry = import.meta.resolve('@emeeek/core/ai/browser');
    candidates.push(path.join(path.dirname(fileURLToPath(coreEntry)), 'local/dict'));
  } catch { /* 包解析失败，退回相对路径 */ }
  candidates.push(path.resolve(HERE, '../ai/local/dict'));
  candidates.push(path.resolve(HERE, '../../core/src/ai/local/dict'));
  for (const dir of candidates) {
    try {
      await fs.access(path.join(dir, 'zh-words.txt.gz'));
      resolveDictDir.cached = dir;
      return dir;
    } catch { /* 试下一个 */ }
  }
  resolveDictDir.cached = null;
  return null;
}
