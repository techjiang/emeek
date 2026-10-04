import fs from 'node:fs/promises';
import path from 'node:path';
import { buildAssetMap, rewriteHtmlReferences, FINGERPRINT_EXTENSIONS } from './fingerprint.js';
import { buildHeaderManifest, cacheHeaders, classifyCache } from './cache-headers.js';
import { precompress, shouldCompress } from './compress.js';
import { getProvider, validateCdnConfig, PROVIDER_IDS } from './providers.js';
import { checkIcp, scanBlockedHosts, planFontSubset } from './china.js';
import { selectPreloadTargets, renderPreloadTags, buildEarlyHintsHeader, renderNginxSnippet, renderCaddySnippet } from './hints.js';
import { hashTree } from './origins.js';
import { logger } from '../util/logger.js';

/**
 * 加速管线（P3-4b-accel）。
 *
 * 顺序是有依赖的，不能换：
 *   1. 指纹：先算，后面 HTML 改写、缓存头、预压缩都要用它的产物路径
 *   2. HTML 引用改写：指纹出来立刻改，否则产物仍指向旧文件名
 *   3. 预压缩：对最终字节压，压早了白压
 *   4. 缓存头：依赖「这个文件有没有指纹」的判断
 *   5. 加速配置：依赖前四步的结果
 */
export async function accelerate({
  outDir,
  files,
  html = [],
  config = {},
  cdn = null,
  posts = [],
  stableAssets = null,
  dryRun = false,
  onProgress,
} = {}) {
  const cdnConfig = cdn ?? config.cdn ?? {};
  const enabled = cdnConfig.enabled !== false;
  const started = Date.now();

  if (!enabled) {
    logger.info('加速已关闭（cdn.enabled = false），跳过指纹与预压缩');
    return { enabled: false, elapsed: Date.now() - started };
  }

  // ── 1. 指纹 ────────────────────────────────────────────────
  const assetFiles = files.filter((f) => f.path !== undefined);
  const stable = stableAssets instanceof Set ? stableAssets : new Set(stableAssets ?? []);
  const { map, assets: fingerprinted } = buildAssetMap(assetFiles, {
    extensions: cdnConfig.fingerprint?.extensions ?? FINGERPRINT_EXTENSIONS,
    enabled: cdnConfig.fingerprint?.enabled !== false,
    stable,
  });

  // ── 2. HTML 引用改写 ───────────────────────────────────────
  let rewritten = 0;
  const rewrittenHtml = new Map();
  for (const page of html) {
    const next = rewriteHtmlReferences(page.content, map);
    if (next !== page.content) rewritten += 1;
    rewrittenHtml.set(page.path, next);
  }

  // ── 3. 缓存头 ──────────────────────────────────────────────
  const headerManifest = buildHeaderManifest(
    fingerprinted.map((f) => ({ path: f.path, fingerprint: f.fingerprint })),
  );

  // ── 4. 预压缩 ──────────────────────────────────────────────
  const compressionEnabled = cdnConfig.compression?.enabled !== false;
  let compression = { variants: [], summary: null };
  if (compressionEnabled && !dryRun) {
    const targets = [
      ...fingerprinted.map((f) => ({ path: f.path, content: f.content })),
      ...[...rewrittenHtml.entries()].map(([p, content]) => ({ path: p, content })),
    ];
    compression = await precompress(targets, { onProgress });
  }

  // ── 5. 加速配置 ────────────────────────────────────────────
  const preload = selectPreloadTargets(
    fingerprinted.map((f) => ({ path: f.path, bytes: Buffer.byteLength(f.content) })),
  );

  const artifacts = {
    headerManifest,
    preload,
    preloadTags: renderPreloadTags(preload),
    earlyHints: buildEarlyHintsHeader(preload),
    compression,
  };

  if (cdnConfig.provider) {
    const provider = getProvider(cdnConfig.provider);
    const { errors, warnings } = validateCdnConfig(cdnConfig);
    if (errors.length) {
      const message = errors.map((e) => `  - ${e.path}: ${e.message}`).join('\n');
      throw new Error(`CDN 配置校验失败：\n${message}`);
    }
    for (const warning of warnings) logger.warn(`cdn: ${warning.message}`);
    artifacts.cdn = {
      provider: provider.id,
      providerName: provider.name,
      headers: provider.buildHeaders({
        immutable: 'public, max-age=31536000, immutable',
        html: 'public, max-age=300, stale-while-revalidate=3600',
        data: 'public, max-age=60, must-revalidate',
        noStore: 'no-store',
      }),
    };
    const icp = checkIcp({ cdn: cdnConfig, site: config.site });
    if (icp.enabled) {
      artifacts.icp = icp;
      for (const blocker of icp.blockers) logger.warn(`中国大陆加速：${blocker.message}`);
    }
  }

  // 国内不可达域名扫描与 CDN 是否配置无关 ——
  // 引了 Google Fonts 的站点，哪怕没配 CDN，在国内也是首屏卡死。
  // 这类问题必须在构建期暴露，不能等用户反馈「打开是白的」。
  const blocked = new Map();
  for (const page of rewrittenHtml.values()) {
    for (const hit of scanBlockedHosts(page)) blocked.set(hit.host, hit);
  }
  if (blocked.size) artifacts.blockedHosts = [...blocked.values()];

  // ── 6. 服务器配置片段 ──────────────────────────────────────
  const serverConfigs = {};
  if (cdnConfig.server !== false) {
    serverConfigs.nginx = renderNginxSnippet({
      serverName: config.site?.url ? new URL(config.site.url).host : 'example.com',
      earlyHints: preload,
    });
    serverConfigs.caddy = renderCaddySnippet({
      serverName: config.site?.url ? new URL(config.site.url).host : 'example.com',
    });
  }

  const fonts = planFontSubset(posts);

  return {
    enabled: true,
    elapsed: Date.now() - started,
    fingerprint: {
      map: [...map.entries()].map(([from, to]) => ({ from, to })),
      assets: fingerprinted.map((a) => ({ path: a.path, originalPath: a.originalPath, fingerprint: a.fingerprint })),
      rewrittenHtml: rewritten,
    },
    rewrittenHtml,
    fingerprinted,
    compression,
    ...artifacts,
    serverConfigs,
    fonts,
  };
}

/**
 * 把 <link rel="preload"> 插到 </head> 前。
 *
 * 只用字符串定位 </head>，不解析 DOM：这一步发生在产物已是最终形态之后，
 * 任何 DOM 序列化都会顺带改掉别的东西（属性顺序、自闭合写法），
 * 让「产物可复现」变得不可靠。
 */
function injectPreload(html, tags) {
  const at = html.indexOf('</head>');
  if (at === -1) return html;
  return `${html.slice(0, at)}${tags}\n${html.slice(at)}`;
}

/**
 * 把加速结果落盘：指纹文件重命名、HTML 覆写、预压缩产物、加速配置清单。
 *
 * writeOutput 已经把原始文件写进 outDir；这里只做「改名 + 增补」，
 * 避免二次全量写盘。
 */
export async function applyAcceleration(outDir, result) {
  if (!result?.enabled) return { renamed: 0, added: 0 };
  await fs.mkdir(outDir, { recursive: true });
  let renamed = 0;
  let added = 0;

  for (const asset of result.fingerprinted) {
    if (asset.originalPath === asset.path) continue;
    const from = path.join(outDir, asset.originalPath);
    const to = path.join(outDir, asset.path);
    try {
      await fs.rename(from, to);
      renamed += 1;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // 资源不在 outDir 根部（例如主题资源在别处）：直接写一份。
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.writeFile(to, asset.content);
      added += 1;
    }
  }

  // 资源提示必须在引用改写之后注入：preload 指向的是指纹后的文件名。
  const preloadTags = result.preloadTags ?? '';
  for (const [pagePath, content] of result.rewrittenHtml ?? []) {
    const withHints = preloadTags ? injectPreload(content, preloadTags) : content;
    await fs.writeFile(path.join(outDir, pagePath), withHints, 'utf8');
  }

  for (const variant of result.compression?.variants ?? []) {
    const target = path.join(outDir, variant.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(`${target}.gz`, variant.gzip);
    await fs.writeFile(`${target}.br`, variant.brotli);
    added += 2;
  }

  // 加速清单：给 CDN 与运维看的，不进 HTML。
  // 刻意不写 generatedAt 时间戳：产物必须逐字节可复现，
  // 否则「同一份内容二次构建摘要一致」这个幂等判据永远为假，
  // 多源站推送会每次都误判成「有变化」。
  const manifest = {
    fingerprint: result.fingerprint,
    headers: result.headerManifest,
    preload: result.preload,
    earlyHints: result.earlyHints,
    compression: result.compression?.summary ?? null,
    cdn: result.cdn ?? null,
    icp: result.icp ?? null,
    blockedHosts: result.blockedHosts ?? [],
    fonts: result.fonts ?? null,
  };
  await fs.writeFile(path.join(outDir, 'acceleration.json'), JSON.stringify(manifest, null, 2));

  if (result.serverConfigs?.nginx) {
    await fs.mkdir(path.join(outDir, 'server'), { recursive: true });
    await fs.writeFile(path.join(outDir, 'server', 'nginx.conf'), result.serverConfigs.nginx);
    await fs.writeFile(path.join(outDir, 'server', 'Caddyfile'), result.serverConfigs.caddy);
  }

  return { renamed, added, tree: await hashTree(outDir) };
}

export {
  buildAssetMap,
  rewriteHtmlReferences,
  contentHash,
  fingerprintPath,
  shouldFingerprint,
  FINGERPRINT_EXTENSIONS,
} from './fingerprint.js';
export { cacheHeaders, classifyCache, buildHeaderManifest, CACHE_CLASS } from './cache-headers.js';
export { precompress, compressVariants, shouldCompress } from './compress.js';
export { PROVIDERS, PROVIDER_IDS, getProvider, validateCdnConfig, readCredentialsFromEnv } from './providers.js';
export { loadCredentials, saveCredentials, parseCredentials, ensureGitignored } from './credentials.js';
export { checkIcp, scanBlockedHosts, planFontSubset, analyzeImages, buildLocalFontFace, BLOCKED_HOSTS } from './china.js';
export { selectPreloadTargets, renderPreloadTags, buildEarlyHintsHeader, renderNginxSnippet, renderCaddySnippet } from './hints.js';
export { hashTree, diffTrees, planFanout, buildHealthChecks, decideActiveOrigin } from './origins.js';
