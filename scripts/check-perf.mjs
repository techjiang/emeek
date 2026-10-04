#!/usr/bin/env node
/**
 * 性能自检。
 *
 * 为什么必须有它，而不是只靠 Lighthouse：
 *
 * Lighthouse 是**端到端黑盒**——它说「LCP 1.2s」，不告诉你为什么。
 * 而性能回归里最常见的那一类（少了一条 preload、首屏图被懒加载了、
 * 某个 CSS 文件悄悄超过内联阈值、PWA 预缓存把整站都塞进去了）在
 * Lighthouse 上的表现只是「分数从 100 掉到 96」——**仍在阈值之上**，
 * 门禁不会红，但站点已经变慢了。
 *
 * 所以这份脚本盯的是**具体的事实**，每条都能单独失败、单独定位：
 *
 *   A. 预算      单页 HTML 体积、内联 CSS 体积、产物总字节
 *   B. 关键 CSS  是否内联、变量覆盖块顺序、超限时是否走外链
 *   C. 图片      首屏图 eager+fetchpriority、其余 lazy、alt 非空、srcset 诚实
 *   D. 资源提示  预取的地址是站内的、有条数上限、不做无意义预连接
 *   E. PWA       manifest 结构、SW 缓存名带指纹、预缓存不是整站、离线页存在
 *
 * 每一类都给出**具体的失败定位**（哪个页面的哪一条），不是一句「性能不达标」。
 *
 * 用法：
 *   node scripts/check-perf.mjs                  # 构建 examples/minimal 并全查
 *   node scripts/check-perf.mjs --dist <目录>     # 只查一个已构建的产物目录
 *   node scripts/check-perf.mjs --budget          # 只看预算（更快）
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const distIndex = args.indexOf('--dist');

/**
 * 预算。数字都标了「依据」——没有依据的阈值会在第一次超标时被随手调大，
 * 然后就再也没有约束力了。
 */
export const BUDGETS = Object.freeze({
  // ── 为什么按 gzip 而不是按原始字节算 ──
  // 原始 HTML 体积几乎完全由「内联了多少 CSS / 索引」决定，而这些内容
  // 在传输时会 gzip 掉 3~4 倍。按原始字节卡阈值，最后一定会变成
  // 「把阈值调大以放过它」—— 因为被卡住的从来不是用户真正下载的字节数。
  // 所以主指标是 gzip 后的传输体积；原始体积只作为「有没有异常膨胀」的
  // 辅助信号，阈值放得很宽。
  //
  // 内容页：Phase 3 目标「首屏 < 1s、压缩后 HTML < 50KB」。实测最小站
  // 9.1KB、主题演示站 12.5KB（内联了整份主题 CSS）。给 20KB 是
  // 「比现状宽一倍」—— 会抓到真正的膨胀（多内联一份大 CSS、某个 partial
  // 内容重复），但不会因为多写一篇文章就红。
  pageHtmlGzip: 20 * 1024,
  // 搜索页：唯一一个自带客户端的应用页，内联了索引 + 匹配逻辑 + DOM 壳。
  // 索引走外链会变成两次往返，首屏搜索反而更慢，所以它必须重。
  // 实测 26.6KB（索引 22.7KB），给 40KB 量级。
  searchPageHtmlGzip: 40 * 1024,
  // 原始体积只做「异常膨胀」告警，不当作目标：实测最大 69KB。
  pageHtmlRaw: 120 * 1024,
  // 内联 CSS 上限。依据：一个 RTT ≈ 100ms，4G 下 24KB ≈ 48ms ——
  // 超过这个数，外链（多一次 RTT）反而更划算。与 CRITICAL_CSS_LIMIT 同源。
  inlineCss: 24 * 1024,
  // 站内总字节。依据：examples/minimal 3 篇文章实测 ~430KB，
  // 预算给 1.5MB 是为了「内容没变但产物翻了 3 倍」这类错误早发现，
  // 不是拦内容本身（文章多了就该更大）。
  totalBytes: 1.5 * 1024 * 1024,
  // SW 预缓存条目上限。依据：预缓存 = 每个首次访客在首屏之后多下载的字节数。
  // 首页 + 离线页 + manifest + 5 篇文章 ≈ 8 条。给 12 条余量，
  // 超过就是「有人在往里面塞全站」。
  prefetchEntries: 12,
});

const failures = [];
const notes = [];

function fail(scope, message) {
  failures.push(`✘ [${scope}] ${message}`);
}

function note(message) {
  notes.push(`· ${message}`);
}

// ── 产物清单 ────────────────────────────────────────────────────
function listFiles(dir, base = dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, base, acc);
    else acc.push({ path: '/' + path.relative(base, full).split(path.sep).join('/'), full, bytes: fs.statSync(full).size });
  }
  return acc;
}

// ── A. 预算 ────────────────────────────────────────────────────
function checkBudgets(dist, files) {
  const htmlFiles = files.filter((f) => f.path.endsWith('.html'));
  // 搜索页按应用页的量级算，其余按内容页。判据是路径而不是内容 ——
  // 搜索页路径可配置，但它的**产物形状**（carriesSearchClient 标记）不随配置变。
  const budgetFor = (file) => (/\/search\/(index\.html)?$/.test(file.path)
    ? { limit: BUDGETS.searchPageHtmlGzip, label: '搜索页（应用页）' }
    : { limit: BUDGETS.pageHtmlGzip, label: '内容页' });
  let worst = null;
  for (const file of htmlFiles) {
    const budget = budgetFor(file);
    const gzip = gzipSize(fs.readFileSync(file.full));
    if (gzip > budget.limit) {
      fail('预算', `${file.path}（${budget.label}）gzip 后 ${kb(gzip)} 超过上限 ${kb(budget.limit)}`);
    }
    if (file.bytes > BUDGETS.pageHtmlRaw) {
      fail('预算', `${file.path} 原始 ${kb(file.bytes)} 异常偏大（上限 ${kb(BUDGETS.pageHtmlRaw)}）—— 检查是否多内联了东西`);
    }
    if (!worst || gzip > worst.gzip) worst = { ...file, gzip, budget };
  }
  if (worst) {
    note(`最大页面 ${worst.path} gzip ${kb(worst.gzip)} / 原始 ${kb(worst.bytes)}（${worst.budget.label}上限 ${kb(worst.budget.limit)}）`);
  }

  const total = files.reduce((sum, f) => sum + f.bytes, 0);
  if (total > BUDGETS.totalBytes) {
    fail('预算', `产物总字节 ${kb(total)} 超过上限 ${kb(BUDGETS.totalBytes)}`);
  }
  note(`产物 ${files.length} 个文件 · 共 ${kb(total)}（上限 ${kb(BUDGETS.totalBytes)}）`);

  // 内联 CSS 体积：从 <style> 块里量。这是「关键 CSS」真正落到页面的部分。
  for (const file of htmlFiles) {
    const html = fs.readFileSync(file.full, 'utf8');
    const inline = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => Buffer.byteLength(m[1]));
    // 首帧防闪烁脚本的 style 很小；主 CSS 是明显最大的那一块。
    const biggest = inline.length ? Math.max(...inline) : 0;
    if (biggest > BUDGETS.inlineCss) {
      fail('预算', `${file.path} 内联 CSS ${kb(biggest)} 超过上限 ${kb(BUDGETS.inlineCss)}`);
    }
    // 外链样式表必须真的存在，否则就是「样式表 404 但构建报成功」那条老路。
    for (const m of html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)) {
      const target = path.join(dist, m[1].replace(/^\//, ''));
      if (!fs.existsSync(target)) fail('预算', `${file.path} 引用了不存在的外链样式表 ${m[1]}`);
    }
  }
}

// ── B. 关键 CSS 落位 ────────────────────────────────────────────
/**
 * 判断一个 `<style>` 块是不是**主题的样式表**（而不是变量覆盖块或防闪烁脚本）。
 *
 * 为什么必须区分：变量块本身也是 `<style>`，所以「页面里有没有 <style>」
 * 这种检查在主题 CSS 完全没内联时**仍然是绿的** —— 它看起来在守
 * 「关键 CSS 落位」，实际只守住了「有个 style 标签」。这是最典型的那种
 * 削弱之后不会红的假防线。
 *
 * 判据用「有规则块且有选择器」：变量块只有 `:root { --x: y }`，
 * 而主题 CSS 一定有 `.class { ... }` 这类规则。
 */
export function isThemeStylesheet(css) {
  // 去掉 :root 变量块后还有没有规则（`选择器 {` 形式）
  const withoutRoot = css.replace(/:root\s*\{[^}]*\}/g, '');
  return /[.#a-zA-Z][\w-]*[^{}]*\{[^{}]*[a-z-]+\s*:/.test(withoutRoot);
}

function checkCssPlacement(dist, files) {
  for (const file of files.filter((f) => f.path.endsWith('.html'))) {
    const html = fs.readFileSync(file.full, 'utf8');
    const styleBlocks = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)];

    const themeBlockIndex = styleBlocks.findIndex((m) => isThemeStylesheet(m[1]));
    const hasExternal = /<link rel="stylesheet" href="([^"]+)"/.test(html);

    // 主题 CSS 要么内联、要么外链 —— 两者都没有就是「页面裸奔」，
    // 而裸奔的页在浏览器里照样能看（只是没样式），构建也不报错。
    if (themeBlockIndex === -1 && !hasExternal) {
      fail('CSS 落位', `${file.path} 既没有内联主题 CSS 也没有外链样式表（页面裸奔）`);
      continue;
    }

    if (themeBlockIndex === -1) continue; // 走外链的形态，下面单独查变量块顺序

    // 变量覆盖块必须在**最后一个 style 块** —— 与主题 CSS 选择器同权重，
    // 谁后写谁生效。放前面就会出现「用户改了主色却不生效」，
    // 而且从产物里很难看出是谁盖的。
    const varIndexes = styleBlocks
      .map((m, i) => (/:root\s*\{[^}]*--/.test(m[1]) ? i : -1))
      .filter((i) => i >= 0);
    if (varIndexes.length && Math.max(...varIndexes) !== styleBlocks.length - 1) {
      fail('CSS 落位', `${file.path} 变量覆盖块不在最后（后面还有样式块，会被主题内置默认值盖掉）`);
    }
    // 反过来也要守：主题 CSS 必须**在变量块之前**，否则变量根本没机会生效。
    if (varIndexes.length && themeBlockIndex > Math.min(...varIndexes)) {
      fail('CSS 落位', `${file.path} 主题 CSS 排在变量覆盖块之后（变量会被主题默认值盖掉）`);
    }

    const headEnd = html.indexOf('</head>');
    if (headEnd > -1 && styleBlocks.some((m) => m.index > headEnd)) {
      fail('CSS 落位', `${file.path} 的 <style> 出现在 </head> 之后（会阻塞渲染到更晚）`);
    }
  }
}

// ── C. 图片 ────────────────────────────────────────────────────
function checkImages(dist, files) {
  for (const file of files.filter((f) => f.path.endsWith('.html'))) {
    const html = fs.readFileSync(file.full, 'utf8');
    const imgs = [...html.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
    let first = true;
    for (const img of imgs) {
      // 首屏图不能懒加载：LCP 图通常就是首屏那张，lazy 会让「最快内容绘制」更慢。
      if (first) {
        if (/loading="lazy"/.test(img)) {
          fail('图片', `${file.path} 首屏图被懒加载（LCP 会因此变慢）：${truncate(img)}`);
        }
        if (!/fetchpriority="high"/.test(img)) {
          fail('图片', `${file.path} 首屏图缺少 fetchpriority="high"：${truncate(img)}`);
        }
      } else if (!/loading="lazy"/.test(img)) {
        fail('图片', `${file.path} 首屏之外的图没有 loading="lazy"：${truncate(img)}`);
      }
      // alt 不能是空字符串 —— 空 alt 让图片对屏幕阅读器与图片搜索完全消失。
      const alt = /alt="([^"]*)"/.exec(img);
      if (!alt) fail('图片', `${file.path} 有图片没有 alt：${truncate(img)}`);
      else if (!alt[1].trim()) fail('图片', `${file.path} 图片 alt 为空：${truncate(img)}`);
      // 有 width/height 就必须配 height:auto，否则图会被拉伸成属性尺寸。
      if (/width="/.test(img) && /height="/.test(img) && !/style="[^"]*height:\s*auto/.test(img)) {
        fail('图片', `${file.path} 有 width/height 但没有 height:auto（图会被压扁）：${truncate(img)}`);
      }
      // srcset 里出现的每个地址都必须是站内的 —— 假 srcset 比没有 srcset 更糟，
      // 浏览器会真的去请求并拿到 404。站外地址我们无法保证存在。
      const srcset = /srcset="([^"]*)"/.exec(img);
      if (srcset && srcset[1].split(',').some((entry) => !entry.trim().startsWith('/'))) {
        fail('图片', `${file.path} srcset 里有非站内地址（我们无法保证它存在）：${truncate(srcset[1])}`);
      }
      if (srcset && !/sizes="/.test(img)) {
        fail('图片', `${file.path} 有 srcset 但没有 sizes（浏览器会按 100vw 选图）`);
      }
      first = false;
    }
  }
}

// ── D. 资源提示 ────────────────────────────────────────────────
function checkHints(dist, files) {
  for (const file of files.filter((f) => f.path.endsWith('.html'))) {
    const html = fs.readFileSync(file.full, 'utf8');

    for (const m of html.matchAll(/<link rel="prefetch" href="([^"]+)"/g)) {
      const href = m[1];
      // 外链预取 = 替第三方提前发起请求（还连带建立连接，隐私问题）。
      if (!href.startsWith('/') || href.startsWith('//')) {
        fail('资源提示', `${file.path} 预取了非站内地址 ${href}`);
      }
      // 预取的地址必须真的存在，否则每次访问都白下一次请求 + 收到 404。
      if (!fs.existsSync(path.join(dist, href.replace(/^\//, '')))) {
        fail('资源提示', `${file.path} 预取了一个不存在的地址 ${href}`);
      }
    }

    const prefetchCount = (html.match(/rel="prefetch"/g) ?? []).length;
    if (prefetchCount > BUDGETS.prefetchEntries) {
      fail('资源提示', `${file.path} 有 ${prefetchCount} 条预取（上限 ${BUDGETS.prefetchEntries}）—— 预取不是「都拿过来」`);
    }

    for (const m of html.matchAll(/rel="preconnect" href="([^"]+)"/g)) {
      // 预连接自身 origin 是纯浪费（DNS/TLS 已经在用了），Lighthouse 也会判它无效。
      const siteOrigin = new RegExp(`^https?://[^/]+`).exec(html);
      if (siteOrigin && m[1] === siteOrigin[0]) {
        fail('资源提示', `${file.path} 对自身 origin ${m[1]} 做了 preconnect（无效项）`);
      }
    }
  }
}

// ── E. PWA ────────────────────────────────────────────────────
function checkPwa(dist, files, config) {
  const enabled = config?.pwa?.enabled === true;
  const hasManifest = fs.existsSync(path.join(dist, 'manifest.webmanifest'));
  const hasSw = fs.existsSync(path.join(dist, 'sw.js'));
  const hasOffline = fs.existsSync(path.join(dist, 'offline.html'));

  if (!enabled) {
    // 关掉时**一个 PWA 产物都不该有**：留着会让「下次访问突然被 SW 接管」，
    // 而站点主人以为 PWA 是关的。
    if (hasSw || hasManifest) {
      fail('PWA', 'pwa.enabled=false 但产物里出现了 manifest/sw.js —— 关掉就该真的没有');
    }
    note('PWA 未启用（pwa.enabled=false），跳过 PWA 检查');
    return;
  }

  if (!hasManifest) return fail('PWA', '缺少 manifest.webmanifest');
  if (!hasSw) return fail('PWA', '缺少 sw.js');
  if (!hasOffline) return fail('PWA', '缺少 offline.html（断网时的最后一根稻草）');

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dist, 'manifest.webmanifest'), 'utf8'));
  } catch (error) {
    return fail('PWA', `manifest.webmanifest 不是合法 JSON：${error.message}`);
  }
  for (const key of ['name', 'start_url', 'scope', 'display', 'icons']) {
    if (!(key in manifest)) fail('PWA', `manifest 缺少 ${key}`);
  }
  // start_url 必须在 scope 内 —— 否则点开 PWA 会跳到 scope 外（子路径部署下是域根）。
  if (manifest.start_url && manifest.scope && !manifest.start_url.startsWith(manifest.scope)) {
    fail('PWA', `manifest.start_url ${manifest.start_url} 不在 scope ${manifest.scope} 内`);
  }
  // 声明的每个图标都必须真的存在：安装时缺一个就是「安装失败」，
  // 而失败信息在控制台里很不显眼，表现成「PWA 功能好像没做」。
  for (const icon of manifest.icons ?? []) {
    const target = path.join(dist, String(icon.src).replace(/^\//, ''));
    if (!fs.existsSync(target)) fail('PWA', `manifest 声明了不存在的图标 ${icon.src}`);
  }
  if (!(manifest.icons ?? []).length) fail('PWA', 'manifest 没有任何图标（安装会被拒绝）');

  const sw = fs.readFileSync(path.join(dist, 'sw.js'), 'utf8');
  // 缓存名必须带内容指纹。只写 emeeek-v1 而内容每次都变，浏览器按字节比对
  // 永远不会重新安装，于是缓存永不失效 —— 读者会一直看到旧页面。
  const cacheName = /const CACHE = "([^"]+)"/.exec(sw);
  if (!cacheName) fail('PWA', 'sw.js 里找不到缓存名');
  else if (!/-[0-9a-f]{6,}$/.test(cacheName[1])) {
    fail('PWA', `缓存名 ${cacheName[1]} 看不出内容指纹（内容变了缓存名不变=缓存永不失效）`);
  }
  // 不做自动 skipWaiting：新 SW 直接接管会让正在读的页面拿到不匹配的资源组合。
  if (/skipWaiting/.test(sw)) {
    fail('PWA', 'sw.js 调用了 skipWaiting —— 新 SW 会立刻接管正在阅读的页面');
  }
  // 导航必须 network-first。
  if (!/request\.mode === 'navigate'/.test(sw)) fail('PWA', 'sw.js 没有区分导航请求（HTML 必须走 network-first）');

  const precache = JSON.parse(/const PRECACHE = (\[[^\]]*\])/.exec(sw)?.[1] ?? '[]');
  if (!precache.length) fail('PWA', 'sw.js 的预缓存列表是空的（离线时什么都拿不到）');
  if (!precache.includes('/offline.html') && !precache.some((u) => u.endsWith('/offline.html'))) {
    fail('PWA', '离线页不在预缓存列表里（它自己也要靠网络拿，那它就永远用不上）');
  }
  if (precache.length > BUDGETS.prefetchEntries) {
    fail('PWA', `预缓存 ${precache.length} 个地址（上限 ${BUDGETS.prefetchEntries}）—— 全站预缓存等于给每个访客加一次全站下载`);
  }
  // 预缓存的地址必须真的存在，否则 install 会因 addAll 失败而整个放弃。
  for (const url of precache) {
    const target = url.endsWith('/') ? path.join(dist, url, 'index.html') : path.join(dist, url.replace(/^\//, ''));
    if (!fs.existsSync(target)) fail('PWA', `预缓存了不存在的地址 ${url}（会让 install 整体失败）`);
  }
  note(`PWA：缓存 ${cacheName[1]} · 预缓存 ${precache.length} 条`);

  // 页面必须真的引用 manifest，否则 SW 装了也没有应用身份。
  const index = path.join(dist, 'index.html');
  if (fs.existsSync(index)) {
    const html = fs.readFileSync(index, 'utf8');
    if (!/rel="manifest"/.test(html)) fail('PWA', 'index.html 没有引用 manifest');
    if (!/serviceWorker\.register/.test(html)) fail('PWA', 'index.html 没有注册 Service Worker');
  }
}

/**
 * gzip 体积。产物目录里的文件都是明文，浏览器拿到的是压缩后的 ——
 * 所以「用户实际下载了多少」只能这样量。
 *
 * 用同步 gzipSync：这是构建期脚本，不是热路径；异步会让主流程读起来
 * 多一层 Promise 而没有实际收益。
 */
export function gzipSize(buffer, level = 9) {
  return zlib.gzipSync(buffer, { level }).length;
}

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)}KB`;
}

function truncate(text, limit = 90) {
  const value = String(text);
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

// ── 主流程 ──────────────────────────────────────────────────────
let dist = distIndex >= 0 ? path.resolve(args[distIndex + 1]) : null;
let config = null;

if (!dist) {
  // 默认查 examples/minimal（性能基线站点）。但它**没有任何图片** ——
  // 图片相关的规则在这个站点上是空转的，永远绿。
  // 所以 `--site` 可以换成 examples/themes-demo（那边有首屏图、正文图、
  // 无 alt 图、数字文件名各一张），CI 里两个都跑才不算自欺。
  //
  // `--pwa` 用 PWA 演示站（examples/pwa-demo），因为 pwa.enabled 默认是 false ——
  // 在没开 PWA 的站点上，整套 PWA 检查是空转的（只输出一句「未启用」），
  // 永远绿。开了 PWA 的站点单独一个示例，就是为了让这些检查有对象。
  const siteArg = args.indexOf('--site');
  const site = siteArg >= 0
    ? path.resolve(args[siteArg + 1])
    : (args.includes('--pwa') ? path.join(ROOT, 'examples/pwa-demo') : path.join(ROOT, 'examples/minimal'));
  console.log(`▸ 构建 ${path.relative(ROOT, site)}…`);
  const result = spawnSync(process.execPath, [path.join(ROOT, 'packages/cli/bin/emeeek.js'), 'build', '--cwd', site], { encoding: 'utf8' });
  if (result.status !== 0) {
    console.error(result.stderr || result.stdout);
    process.exit(1);
  }
  dist = path.join(site, 'dist');
  // 配置从产物目录反推：examples/minimal 的配置可能被测试临时改过，
  // 所以直接读它是唯一准确的做法。
  const { loadConfig } = await import(new URL('../packages/core/src/config/loader.js', import.meta.url));
  const loaded = await loadConfig(site);
  config = loaded.config;
}

if (!fs.existsSync(dist)) {
  console.error(`✖ 产物目录不存在：${dist}`);
  process.exit(1);
}
const files = listFiles(dist);

const onlyBudget = args.includes('--budget');
checkBudgets(dist, files);
if (!onlyBudget) {
  checkCssPlacement(dist, files);
  checkImages(dist, files);
  checkHints(dist, files);
  checkPwa(dist, files, config);
}

if (notes.length) console.log(notes.join('\n'));
if (failures.length) {
  console.error(`\n✖ 性能自检发现 ${failures.length} 个问题：`);
  for (const line of failures) console.error(`  ${line}`);
  process.exit(1);
}
console.log('\n✔ 性能自检全部通过');
