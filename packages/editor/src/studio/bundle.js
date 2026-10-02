/**
 * 浏览器端 JS 打包。
 *
 * 编辑器必须在真实浏览器里跑，而它的依赖（CodeMirror、Lezer）是 npm 包，
 * 浏览器不认识裸模块名。所以需要一次打包。
 *
 * 打包器优先用 esbuild（原生二进制，~50ms）；环境不允许装原生二进制时
 * 退回 esbuild-wasm。两个都装不上（离线安装、无网）时不报错退出 ——
 * 而是产出一个**明确告知失败原因**的引导页：
 * 服务照常起来，页面告诉你缺什么。比「服务起不来」容易排查得多。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';


const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CLIENT_ENTRY = path.join(HERE, 'client.js');

const BUILD_OPTIONS = {
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  minify: false,
  legalComments: 'none',
  define: {
    'process.env.NODE_ENV': '"production"',
    // 排障开关：EMEEEK_DEBUG=1 emeeek studio 时在浏览器里逐个校验扩展
    'process.env.EMEEEK_DEBUG_EXTENSIONS': JSON.stringify(process.env.EMEEEK_DEBUG_EXTENSIONS ?? ''),
  },
  // node: 内置模块交给 nodeBuiltinStub 处理（不能留 external，见下）
  plugins: [nodeBuiltinStub()],
};

/**
 * node: 内置模块的桩。
 *
 * 为什么不是 external：external 会把 `import('node:fs')` 原样留在产物里，
 * 浏览器解析到它会直接抛 CORS 错误，整个模块图崩掉 —— 实测编辑器白屏，
 * 只剩 boot 页。桩则让「Node 专用分支」在浏览器里保持惰性，
 * 真的被调用时才报一条能看懂的错。
 */
function nodeBuiltinStub() {
  return {
    name: 'node-builtin-stub',
    setup(build) {
      /**
       * node:path 与 node:url 给「能算但不碰文件系统」的实现。
       *
       * 为什么不能一律抛错：core 里有几个模块在顶层就算路径
       * （prompts/loader.js 的 TEMPLATE_DIR），浏览器里这些变量根本用不到，
       * 但模块被加载时就会求值。一律抛错会让编辑器直接白屏 —— 实测就是这样。
       *
       * 而 fs / zlib 这类「一旦调用就是真在碰 Node」的模块保持抛错：
       * 走错了必须立刻知道，不能静默拿到假的文件内容。
       */
      build.onResolve({ filter: /^node:/ }, (args) => ({ path: args.path, namespace: 'node-stub' }));
      build.onLoad({ filter: /.*/, namespace: 'node-stub' }, (args) => ({ contents: stubSource(args.path), loader: 'js' }));
    },
  };
}

function stubSource(specifier) {
  if (specifier === 'node:path') {
    return `
      const sep = '/';
      const join = (...parts) => parts.filter(Boolean).join('/').replace(/\\/+/g, '/');
      const dirname = (p) => String(p).replace(/\\/[^/]*$/, '') || '.';
      const basename = (p) => String(p).split('/').pop() ?? '';
      const extname = (p) => { const b = basename(p); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i) : ''; };
      const resolve = (...parts) => join(...parts);
      const relative = (from, to) => String(to).replace(String(from).replace(/\\/?$/, '') + '/', '');
      export { sep, join, dirname, basename, extname, resolve, relative };
      export default { sep, join, dirname, basename, extname, resolve, relative, posix: { sep, join, dirname, basename, extname, resolve, relative } };
    `;
  }
  if (specifier === 'node:url') {
    return `
      const fileURLToPath = (url) => {
        const value = url instanceof URL || typeof url === 'string' ? String(url) : String(url?.url ?? '');
        return value.replace(/^file:\\/\\//, '/').replace(/[?#].*$/, '');
      };
      const pathToFileURL = (p) => new URL('file://' + String(p).replace(/^\\//, '/'));
      export { fileURLToPath, pathToFileURL };
      export default { fileURLToPath, pathToFileURL };
    `;
  }
  const message = `${specifier} 是 Node 专用模块，浏览器端不可用`;
  return `
    const fail = () => { throw new Error(${JSON.stringify(message)}); };
    export default new Proxy({}, { get: () => fail });
    export const readFileSync = fail, writeFileSync = fail, gunzipSync = fail, createRequire = fail;
    export const promises = new Proxy({}, { get: () => fail });
  `;
}

/**
 * 打包客户端。
 *
 * `splitting: true` 是必须的，不是优化项：
 * 语言语法走动态 import，只有开启代码分割，打包器才会把它们切成独立文件。
 * 关掉的话 esbuild 会把所有动态 import 的模块内联回主 bundle ——
 * 「懒加载」就退化成一个永远不会被兑现的承诺（实测 2.9MB 全进首屏）。
 *
 * 返回 { code, files, chunks }，files 是 [{ path, contents }]，路径形如
 * /__studio/client.js 与 /__studio/chunks/xxx.js。
 *
 * sourcemap 默认 external 而不是 inline：inline 会把整个源码塞进入口
 * bundle（实测 +800KB），而调试价值完全可以用一个 .map 文件换到。
 */
export async function bundleClient({ entry = CLIENT_ENTRY, sourcemap = 'external', minify = false } = {}) {
  const attempts = [];
  for (const [mode, loader] of [['esbuild', () => import('esbuild')], ['esbuild-wasm', () => import('esbuild-wasm')]]) {
    try {
      const mod = await loader();
      const esbuild = mod.default ?? mod;
      if (mode === 'esbuild-wasm' && esbuild.initialize) {
        await esbuild.initialize({ worker: false, wasmURL: undefined }).catch(() => {});
      }
      const result = await esbuild.build({
        ...BUILD_OPTIONS,
        sourcemap,
        minify,
        entryPoints: { client: entry },
        splitting: true,
        chunkNames: 'chunks/[name]-[hash]',
        write: false,
        outdir: 'out',
      });
      // esbuild 的 path 形如 <cwd>/out/client.js、<cwd>/out/chunks/xxx.js。
      // 取 out/ 之后的部分作为 URL 路径，目录结构必须保留 ——
      // 运行时会请求 /__studio/chunks/xxx.js，路径压平就会 404，
      // 语言语法加载失败、代码块静默退化成纯文本。
      const files = result.outputFiles
        .filter((file) => !file.path.endsWith('.map'))
        .map((file) => {
          const rel = path.relative(path.join(process.cwd(), 'out'), file.path).split(path.sep).join('/');
          return { path: `/__studio/${rel}`, contents: file.contents, text: file.text };
        });
      const entryFile = files.find((file) => file.path === '/__studio/client.js') ?? files[0];
      const chunks = files.filter((file) => file !== entryFile);
      return {
        code: entryFile.text,
        files,
        chunks,
        mode,
        error: null,
        bytes: entryFile.contents.length,
        totalBytes: files.reduce((sum, file) => sum + file.contents.length, 0),
      };
    } catch (error) {
      attempts.push(`${mode}: ${error.message.split('\n')[0]}`);
    }
  }
  return { code: null, files: [], chunks: [], mode: 'none', error: attempts.join('\n') };
}

/** 打包失败时给用户的解释页（不是白屏）。 */
export function bundleFailureNotice(error) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>Emeek Studio — 客户端未打包</title>
<style>
  :root { color-scheme: dark light; }
  body { max-width: 720px; margin: 8vh auto; padding: 0 24px; font: 15px/1.7 ui-sans-serif, system-ui, -apple-system, "Noto Sans SC", sans-serif; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  .sub { color: #888; margin-top: 0; }
  pre { background: #0002; padding: 14px 16px; border-radius: 8px; overflow: auto; font-size: 13px; }
  code { background: #0002; padding: 2px 5px; border-radius: 4px; }
  ol { padding-left: 22px; } li { margin: 6px 0; }
  .why { border-left: 3px solid #d29922; padding-left: 14px; color: #a80; margin: 18px 0; }
</style></head><body>
<h1>Emeek Studio 的客户端还没打包</h1>
<p class="sub">服务是活的，只是浏览器端 JS 没生成出来。</p>
<div class="why"><strong>为什么？</strong>编辑器依赖需要一次打包才能在浏览器里跑，
本机没能加载打包器（esbuild / esbuild-wasm 都试过了）。</div>
<p>试一下：</p>
<ol>
  <li><code>pnpm install</code> —— 装上 esbuild</li>
  <li>或者 <code>pnpm approve-builds</code> 允许 esbuild 执行安装脚本</li>
  <li>然后重新打开本页（服务会自动重新打包）</li>
</ol>
<p>如果只是想在浏览器里验证渲染管线，可以先用
<code>node packages/editor/tests/bench/preview-bench.mjs</code> 看 Node 侧的渲染结果。</p>
<pre>${escapeHtml(error ?? 'unknown error')}</pre>
</body></html>`;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

/** 静态资源（HTML / CSS / 预览样式）的定位。 */
export const ASSETS_DIR = path.resolve(HERE, '..', 'assets');
export async function readAsset(name) {
  return fs.readFile(path.join(ASSETS_DIR, name), 'utf8');
}
