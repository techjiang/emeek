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
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleClient, bundleFailureNotice, readAsset } from './bundle.js';
import { detectServerKey, runProxiedTask, serverKeyStatus, describeServerKey, safeLog } from './ai-proxy.js';
import { createWatcher } from './watcher.js';
import { decideSync, SYNC_DECISION } from './sync.js';

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
 *   /__studio/files       可编辑文件索引（emeeek dev 集成时才非空）
 *   /__studio/file        读写内容目录内的 Markdown（GET / PUT）
 *   /__studio/ai/status   服务端是否托管了 AI Key（只说有没有，不说值）
 *   /__studio/ai/run      服务端代理转发 AI 任务（Key 不进浏览器）
 */
export async function createStudioServer({
  port = 3000,
  host = 'localhost',
  build,
  contentDir = null,
  uploadDir = null,
  /**
   * 项目根目录。给了它才开启「读写本地 Markdown 文件」（emeeek dev 集成）。
   *
   * 刻意做成可选：只跑 `emeeek studio` 时编辑器是纯草稿模式，
   * 那时它没有任何理由去碰用户的磁盘。
   */
  projectRoot = null,
  /**
   * 服务端托管的 AI Key（决策 D1 第一层）。默认从进程环境探测。
   *
   * 刻意**不接受来自配置文件的 Key**：配置文件进 git，
   * 而「把 Key 提交上去」是这类事故里最常见的一种。
   * 想覆盖探测结果，用环境变量，或者显式传进来（测试用）。
   */
  serverKey = undefined,
  /**
   * 是否监听内容目录并把磁盘变更推给编辑器（emeeek dev 集成时开）。
   *
   * 默认关：只跑 `emeeek studio` 时，用户改的是草稿不是文件，
   * 没有东西可监听，开了只是白占 inotify 句柄。
   */
  watch = false,
  /**
   * 主题配置的提供者：返回 { meta, values }（见 createStudioServer 的路由
   * `/__studio/theme/config`）。给了它，Studio 才能渲染「主题配置」面板。
   * 不给则面板隐藏 —— 不做「面板在但改不动」的假界面。
   */
  themeProvider = null,
  logger = console,
} = {}) {
  const aiKey = serverKey === undefined ? detectServerKey() : serverKey;
  if (aiKey) safeLog(logger, 'info', describeServerKey(aiKey));

  const state = {
    files: new Map(),       // URL 路径 → 内容（入口 + 语言 chunk）
    bundleError: null,
    building: null,
    site: { posts: [], images: [] },
    lastBuild: null,
    buildMs: null,
    stats: null,
    /**
     * 热更新订阅者（SSE 连接）。
     *
     * 与 dev 的 `/__emeeek/reload` 分开是因为这个通道承载的是
     * 「文件变了 + 当时本地脏不脏」—— 后者只有编辑器知道，dev 那条只有变更事件。
     */
    syncClients: new Set(),
    /** 最近一次磁盘变更（编辑器拉取用，避免错过 SSE 的那一瞬）。 */
    lastDiskChange: null,
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

    /**
     * 可编辑文件列表。
     *
     * 只列 contentDir 下的 .md，且只列文件名与标题 —— 编辑器侧栏要的是
     * 「有哪些稿子」，不是完整的目录树。
     */
    if (pathname === '/__studio/files' && request.method === 'GET') {
      const root = projectRoot;
      if (!root || !contentDir) return send(response, 200, MIME['.json'], JSON.stringify({ mode: 'draft', files: [] }));
      try {
        const files = await listMarkdownFiles(root, contentDir);
        return send(response, 200, MIME['.json'], JSON.stringify({ mode: 'file', root: path.basename(root), dir: path.relative(root, contentDir), files }));
      } catch (error) {
        return send(response, 500, MIME['.json'], JSON.stringify({ mode: 'file', files: [], error: error.message }));
      }
    }

    /**
     * 读一个 Markdown 文件。
     *
     * 路径校验是这里唯一重要的事：客户端传来的 path 绝不能读到项目目录之外。
     * 见 resolveProjectFile —— 它做的是「解析后必须仍在 contentDir 之内」，
     * 而不是「字符串里没有 ..」（后者挡不住符号链接和绝对路径）。
     */
    if (pathname === '/__studio/file' && request.method === 'GET') {
      const target = resolveProjectFile(projectRoot, contentDir, url.searchParams.get('path'));
      if (!target) return send(response, 400, MIME['.json'], JSON.stringify({ error: '路径不合法：只能读写内容目录内的 Markdown 文件' }));
      try {
        const content = await fs.readFile(target.absolute, 'utf8');
        return send(response, 200, MIME['.json'], JSON.stringify({
          path: target.relative,
          content,
          fingerprint: fingerprint(content),
          bytes: Buffer.byteLength(content),
        }));
      } catch {
        return send(response, 404, MIME['.json'], JSON.stringify({ error: `文件不存在：${target.relative}` }));
      }
    }

    /** 写回 Markdown 文件（编辑器里 Ctrl+S 的落点）。 */
    if (pathname === '/__studio/file' && (request.method === 'PUT' || request.method === 'POST')) {
      const requested = request.headers['x-file-path'] ? decodeURIComponent(request.headers['x-file-path']) : url.searchParams.get('path');
      const target = resolveProjectFile(projectRoot, contentDir, requested);
      if (!target) return send(response, 400, MIME['.json'], JSON.stringify({ error: '路径不合法：只能读写内容目录内的 Markdown 文件' }));
      const content = await readBody(request);
      try {
        await fs.mkdir(path.dirname(target.absolute), { recursive: true });
        // 先写临时文件再 rename：中途断电/被杀不会留下一个被截断的稿件。
        // 「草稿不丢」在这里的等价物是「文件不会写坏」。
        const temporary = `${target.absolute}.emeeek-tmp`;
        await fs.writeFile(temporary, content, 'utf8');
        await fs.rename(temporary, target.absolute);
        return send(response, 200, MIME['.json'], JSON.stringify({
          path: target.relative,
          bytes: Buffer.byteLength(content),
          fingerprint: fingerprint(content),
        }));
      } catch (error) {
        return send(response, 500, MIME['.json'], JSON.stringify({ error: `写入失败：${error.message}` }));
      }
    }

    /**
     * 热更新通道（决策 D4）。
     *
     * 只推「磁盘变了」这个事实，**不推该不该刷新** —— 那个判断要本地脏不脏，
     * 而只有编辑器手里有这份信息。服务端替它做决定，就成了自动刷新。
     */
    if (pathname === '/__studio/sync' && request.method === 'GET') {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      response.write('retry: 1000\n\n');
      // 连上先补发最近一次变更，避免「断线那几秒」正好错过
      if (state.lastDiskChange) response.write(`data: ${JSON.stringify(state.lastDiskChange)}\n\n`);
      state.syncClients.add(response);
      request.on('close', () => state.syncClients.delete(response));
      return;
    }

    /**
     * 由本地内容指纹 + 磁盘指纹得到同步决策。
     *
     * 这个端点存在的理由是「让决定可测」：把判断放在浏览器里，
     * 测它就要起浏览器；放在这里，可以拿两个指纹直接断言。
     */
    if (pathname === '/__studio/sync/decide' && request.method === 'POST') {
      const raw = await readBody(request);
      let payload;
      try { payload = JSON.parse(raw || '{}'); } catch {
        return send(response, 400, MIME['.json'], JSON.stringify({ error: '请求体不是合法 JSON' }));
      }
      const result = decideSync({
        localDirty: Boolean(payload.localDirty),
        localFingerprint: payload.localFingerprint ?? null,
        remoteFingerprint: payload.remoteFingerprint ?? null,
        currentRemote: payload.currentRemote ?? null,
      });
      return send(response, 200, MIME['.json'], JSON.stringify(result));
    }

    /**
     * AI 服务端状态（决策 D1 第一层）。
     *
     * 只回「有没有配置」与 provider/model —— 不回 Key，一个字符都不回。
     * 前端拿到 configured:true 之后就不再向用户要 Key 了，
     * 这正是分层的意义：用户在有服务端的场景下根本不需要接触凭证。
     */
    if (pathname === '/__studio/ai/status' && request.method === 'GET') {
      return send(response, 200, MIME['.json'], JSON.stringify(serverKeyStatus(aiKey)));
    }

    /**
     * AI 代理转发。
     *
     * 浏览器 POST 任务，服务端带 Key 转发给 provider，回结果。
     * 这里是「Key 不进浏览器」这条承诺的兑现点，所以有两件必须做的事：
     *   1. 请求体过一遍大小上限（不能变成一个免费的大文件上传通道）
     *   2. 回给浏览器的错误信息先消毒（上游 401 的响应体里常带回 Key）
     */
    if (pathname === '/__studio/ai/run' && request.method === 'POST') {
      // 服务端没托管 Key 时不能直接拒 —— 会话级 Key 也在请求体里，
      // 要等解析完请求体才知道有没有（第一版在这里提前 return，把会话级
      // Key 这条路整个堵死了）

      const raw = await readBody(request);
      if (Buffer.byteLength(raw) > 2 * 1024 * 1024) {
        return send(response, 413, MIME['.json'], JSON.stringify({ ok: false, error: { code: 'too_large', message: '输入超过 2MB' } }));
      }
      let payload;
      try { payload = JSON.parse(raw || '{}'); } catch {
        return send(response, 400, MIME['.json'], JSON.stringify({ ok: false, error: { code: 'bad_request', message: '请求体不是合法 JSON' } }));
      }
      /**
       * 会话级 Key（决策 D1 第二层）。
       *
       * 用户没有服务端托管时，Key 存在浏览器会话里；但**仍然不直连 provider** ——
       * 直连会把 Key 暴露在 DevTools 网络面板、每个浏览器扩展、
       * 以及「把请求复制成 curl 贴进 Issue」的风险里。
       * 所以它通过请求体交给服务端，由服务端转发。
       *
       * 为什么走请求体而不是 URL 参数：URL 会进访问日志、浏览器历史、
       * Referer 头。凭证不该出现在这三个地方。
       */
      const sessionOptions = payload.options ?? {};
      const sessionKey = typeof sessionOptions.apiKey === 'string' && sessionOptions.apiKey.trim() ? sessionOptions.apiKey.trim() : null;
      const { apiKey: _drop, provider: sessionProvider, model: sessionModel, ...passthrough } = sessionOptions;
      const effective = sessionKey
        ? { provider: sessionProvider ?? 'openai', apiKey: sessionKey, model: sessionModel ?? null, from: 'session' }
        : aiKey;

      if (!effective?.apiKey) {
        return send(response, 200, MIME['.json'], JSON.stringify({
          ok: false,
          error: { code: 'not_configured', message: '没有可用的 AI Key。在「AI 设置」里填入会话级 Key，或用环境变量启动 emeeek studio 由服务端托管。' },
        }));
      }

      const outcome = await runProxiedTask({
        input: String(payload.input ?? ''),
        task: String(payload.task ?? 'summarize'),
        options: passthrough,
        server: effective,
      });
      if (!outcome.ok) safeLog(logger, 'warn', `AI 代理失败（${outcome.error.code}）：${outcome.error.message}`);
      return send(response, 200, MIME['.json'], JSON.stringify(outcome));
    }

    /**
     * 主题配置（P3-1b-3b feature D）。
     *
     * 返回主题声明的配置描述符（type/min/max/options）与当前生效值。
     * 面板据此画控件 —— 控件类型完全由主题自己声明，Studio 不猜。
     *
     * 只回描述符与值，不回任何可执行内容：customCSS/customHead/customFooter
     * 不进这里（它们有各自的消毒器，且不由面板编辑）。
     */
    if (pathname === '/__studio/theme/config' && request.method === 'GET') {
      if (!themeProvider) return send(response, 200, MIME['.json'], JSON.stringify({ available: false }));
      try {
        const payload = await themeProvider();
        return send(response, 200, MIME['.json'], JSON.stringify({ available: true, ...payload }));
      } catch (error) {
        return send(response, 500, MIME['.json'], JSON.stringify({ available: false, error: error.message }));
      }
    }

    /**
     * 校验一份运行时覆盖：值是否对得上描述符。
     *
     * 面板改一下就 PATCH 一次，拿回规范化后的值 + 被拒的键 ——
     * 拒绝原因直接显示在面板上，而不是静默失效。
     */
    if (pathname === '/__studio/theme/override' && request.method === 'POST') {
      const raw = await readBody(request);
      let payload;
      try { payload = JSON.parse(raw || '{}'); } catch {
        return send(response, 400, MIME['.json'], JSON.stringify({ error: '请求体不是合法 JSON' }));
      }
      if (!themeProvider) return send(response, 200, MIME['.json'], JSON.stringify({ available: false }));
      try {
        const { normalizeOverrides } = await import('@emeeek/core');
        const { meta, values } = await themeProvider();
        const { values: normalized, rejected } = normalizeOverrides(meta, payload.overrides ?? {});
        return send(response, 200, MIME['.json'], JSON.stringify({ available: true, accepted: normalized, rejected, defaults: values }));
      } catch (error) {
        return send(response, 500, MIME['.json'], JSON.stringify({ error: error.message }));
      }
    }

    if (pathname === '/__studio/status') {
      return send(response, 200, MIME['.json'], JSON.stringify({
        bundle: state.files.size ? 'ready' : state.bundleError ? 'failed' : 'pending',
        bundleError: state.bundleError,
        bundleStats: state.stats,
        buildMs: state.buildMs,
        posts: state.site?.posts?.length ?? 0,
        ai: serverKeyStatus(aiKey),
        watch: watcher
          ? { active: true, dir: path.relative(projectRoot, contentDir).split(path.sep).join('/'), rejected: watcher.rejected.length, flooded: watcher.flooded }
          : { active: false },
      }));
    }

    return send(response, 404, 'text/plain; charset=utf-8', 'Not found');
  }

  /**
   * 内容目录监听（决策 D4）。
   *
   * 只有给了 projectRoot + contentDir 才开 —— 也就是 emeeek dev 集成模式。
   * 事件路径走的是 **HTTP 入口同一个** resolveProjectFile，
   * 不为监听新写一套判断（S2-3a 那个 symlink 的洞就是这样来的）。
   */
  const watcher = watch && projectRoot && contentDir
    ? createWatcher({
      root: projectRoot,
      contentDir,
      resolve: resolveProjectFile,
      logger,
      onChange: async (event) => {
        /**
         * 事件里要带上**磁盘当前内容的指纹**。
         *
         * 不带的话，编辑器那侧只能拿到「路径变了」这个事实，
         * 而 decideSync 需要三个指纹才能做判断 —— 缺一个就会退化成
         * 「什么都没发生」（实测就是这样：同步静默失效，而日志里一切正常）。
         */
        // 变量名不要叫 fingerprint —— 会把上面那个函数名遮蔽掉，
        // 于是 `fingerprint(...)` 变成「调用 null」，参数求值时静默抛错被 catch 吞掉，
        // 最后推送出去的 fingerprint 永远是 null，同步静默失效（踩过）
        let diskFingerprint = null;
        try {
          diskFingerprint = fingerprint(await fs.readFile(event.absolute, 'utf8'));
        } catch (error) {
          logger.warn?.(`读取变更文件算指纹失败：${error.message}`);
        }
        state.lastDiskChange = { ...event, fingerprint: diskFingerprint, at: Date.now() };
        for (const client of state.syncClients) {
          try { client.write(`data: ${JSON.stringify(state.lastDiskChange)}\n\n`); } catch { state.syncClients.delete(client); }
        }
        logger.info?.(`内容目录变更：${event.path}`);
      },
    }).start()
    : null;

  await new Promise((resolve) => server.listen(port, host, resolve));
  // 端口传 0（测试）时真正监听到的端口才是答案 —— 用传入的 port 会拼出 :0
  const address = server.address();
  return {
    server,
    port: address.port,
    url: `http://${host}:${address.port}/studio`,
    state,
    refreshSite,
    close: () => new Promise((resolve) => {
      watcher?.stop();
      for (const client of state.syncClients) { try { client.end(); } catch { /* 已断开 */ } }
      state.syncClients.clear();
      server.close(resolve);
    }),
    /** 测试与诊断用：直接看监听器。 */
    watcher,
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
 * 列出内容目录下的 Markdown 文件。
 *
 * 只扫一层 + 递归但设深度上限：个人博客的 posts/ 就该是平的，
 * 而「递归整个目录树」在用户误把 projectRoot 指到家目录时会变成灾难。
 */
async function listMarkdownFiles(root, contentDir, maxDepth = 3) {
  const base = path.resolve(contentDir);
  const out = [];
  async function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (!path.resolve(full).startsWith(base)) continue;
      if (entry.isDirectory()) { await walk(full, depth + 1); continue; }
      if (!/\.(md|markdown)$/i.test(entry.name)) continue;
      const stat = await fs.stat(full);
      const head = await fs.readFile(full, 'utf8');
      out.push({
        path: path.relative(root, full).split(path.sep).join('/'),
        name: entry.name,
        title: firstHeading(head) || entry.name.replace(/\.md$/i, ''),
        bytes: stat.size,
        mtime: stat.mtimeMs,
      });
    }
  }
  await walk(base, 0);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function firstHeading(markdown) {
  const front = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(markdown);
  const body = front ? markdown.slice(front[0].length) : markdown;
  const title = /^title:\s*(.+)$/m.exec(front?.[0] ?? '');
  if (title) return title[1].trim().replace(/^["']|["']$/g, '');
  const heading = /^#{1,6}\s+(.+)$/m.exec(body);
  return heading ? heading[1].trim() : '';
}

function fingerprint(text) {
  let hash = 0x811c9dc5;
  const value = String(text ?? '');
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${value.length.toString(36)}-${hash.toString(36)}`;
}

/**
 * 把客户端给的路径解析成内容目录内的绝对路径。
 *
 * 三条防线，缺一不可：
 *   1. 拒绝 NUL 字节（会把底层 fs 调用的路径截断）
 *   2. 解析后必须是绝对路径，且仍在 contentDir 之内（挡 ../ 与绝对路径）
 *   3. 真实路径（realpath）也要在之内 —— 挡符号链接指到外面
 *
 * @returns {null | {absolute: string, relative: string}}
 */
export function resolveProjectFile(projectRoot, contentDir, requested) {
  if (!projectRoot || !contentDir || !requested || typeof requested !== 'string') return null;
  if (requested.includes('\0')) return null;
  const base = path.resolve(contentDir);
  const absolute = path.resolve(projectRoot, requested);
  if (!isInside(base, absolute)) return null;

  /**
   * 符号链接检查。
   *
   * 必须看**目标本身**，不能只看它的父目录 —— `posts/escape.md` 的父目录
   * 老老实实待在 posts/ 里，而文件本身是指向 /etc/passwd 的软链。
   * 只看 dirname 的写法放过去过一次（就是被这一组测试抓到的），
   * 所以这里对「文件存在」与「文件不存在」两条路分别求真实路径。
   */
  const realBase = realpathOf(base);
  if (!realBase) return null;
  const realTarget = realpathOf(absolute);
  if (realTarget) {
    if (!isInside(realBase, realTarget)) return null;
  } else {
    // 文件还不存在（新建）：只要父目录的真实路径在内容目录内即可。
    // 父目录是软链指到外面时也一并挡住。
    const realParent = realpathOf(path.dirname(absolute));
    if (!realParent || !isInside(realBase, realParent)) return null;
  }
  return { absolute, relative: path.relative(projectRoot, absolute).split(path.sep).join('/') };
}

/** realpath，失败返回 null（不存在、权限不足、路径太长都算失败）。 */
function realpathOf(target) {
  try { return fsSync.realpathSync.native(target); } catch { return null; }
}

function isInside(base, target) {
  const normalized = path.resolve(base);
  const candidate = path.resolve(target);
  return candidate === normalized || candidate.startsWith(normalized + path.sep);
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
