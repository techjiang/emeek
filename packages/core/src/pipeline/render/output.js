import fs from 'node:fs/promises';
import path from 'node:path';
import { logger, progress } from '../../util/logger.js';
import { rewriteCssUrls, splitCriticalStyles, CRITICAL_CSS_LIMIT } from './asset-url.js';
import { collectPreconnect, renderResourceHints } from '../transform/hints.js';

/**
 * 写盘阶段。所有 HTML 在写之前统一做一次压缩、CSS 落位与资源提示注入，
 * 避免每个页面各自处理一遍。产物清单回传给调用方，便于 CLI 汇报体积。
 */
export async function writeOutput({ outDir, pages, extraFiles, theme, config, cwd, onProgress }) {
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });

  const manifest = { files: [], html: 0, totalBytes: 0 };
  const bar = progress('写入页面', pages.length);

  // theme 对象在整个进程里复用（一次构建一个主题），所以外链标记必须先清空，
  // 否则上一次留下的会污染这一次。清在这里、写在下面，责任单一。
  delete theme.__externalCss;

  const cssPlan = planStyles(theme, config);
  cssPlan.vars = theme.__varsOverride ?? '';
  const headExtra = buildHeadExtra(cssPlan, config);

  for (const page of pages) {
    let html = finalizeHtml(page.html, config);
    html = injectAssets(html, { cssPlan, headExtra });
    const target = path.join(outDir, page.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, html, 'utf8');
    manifest.files.push({ path: page.path, bytes: Buffer.byteLength(html) });
    manifest.html += Buffer.byteLength(html);
    manifest.totalBytes += Buffer.byteLength(html);
    bar.tick();
  }
  bar.done();

  // 外链样式表必须真的落盘。此前这条路径没有任何地方写文件 ——
  // 主题一旦超过 24 KB 就会得到一个 404 的样式表，页面裸奔且构建照报成功。
  // 阈值以内的主题（Inkstone 21 KB 等）走不到这里，所以这个洞一直没被发现。
  for (const style of cssPlan.external) {
    extraFiles.push({ path: style.publicPath, content: rewriteCssUrls(style.content, { base: cssPlan.base }) });
    theme.__externalCss = true;
  }

  for (const file of extraFiles) {
    const target = path.join(outDir, file.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.content, 'utf8');
    manifest.files.push({ path: file.path, bytes: Buffer.byteLength(file.content) });
    manifest.totalBytes += Buffer.byteLength(file.content);
  }

  // 主题静态资源（图标等）原样拷贝。
  try {
    await fs.cp(theme.assetsDir, path.join(outDir, 'assets'), { recursive: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  // 站点自己的静态资源（封面图等）拷进同一个 /assets。
  // 从前只拷主题的资源，站点的 assets/ 永远进不了产物 —— 于是 front-matter 里
  // cover: /assets/covers/x.svg 全部 404。这类 404 不报错，只在浏览器控制台里
  // 留一行，然后 Lighthouse 的 best-practices 扣分、读者看到破图。
  // 顺序上放在主题之后：同名时主题资源优先（主题不该被站点内容意外覆盖）。
  if (cwd) {
    for (const dir of config?.content?.assetDirs ?? ['assets']) {
      const source = path.resolve(cwd, dir);
      if (source === path.resolve(theme.dir)) continue;
      try {
        await fs.cp(source, path.join(outDir, 'assets'), { recursive: true, force: false });
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }

  manifest.avgHtmlBytes = Math.round(manifest.html / Math.max(1, pages.length));
  manifest.criticalCss = {
    inlineBytes: cssPlan.inline.reduce((sum, s) => sum + s.bytes, 0),
    external: cssPlan.external.map((s) => ({ path: s.publicPath, bytes: s.bytes })),
    limit: cssPlan.limit,
  };
  return manifest;
}

/**
 * 决定主题 CSS 的落位：内联还是外链。
 *
 * 选择的关键 CSS 在 `/head` 之前落位；超阈值的那几份走外链落到 `/assets/`。
 * 这里**不做关键路径推断** —— 理由写在 asset-url.js 的 CRITICAL_CSS_LIMIT 上，
 * 一句话：猜错首屏样式的代价（无样式内容闪一下）远大于多内联几 KB。
 */
export function planStyles(theme, config) {
  const base = String(config?.site?.basePath ?? '').replace(/\/+$/, '');
  const enabled = config?.perf?.criticalCSS !== false;
  const limit = Number(config?.perf?.criticalCssLimit ?? CRITICAL_CSS_LIMIT);

  if (!enabled) {
    // 关掉内联就整份外链：合成一个文件，而不是每个 CSS 一个请求。
    return {
      base,
      limit,
      vars: '',
      inline: [],
      external: [{ name: 'theme.css', publicPath: '/assets/theme.css', content: theme.styles.map((s) => s.content).join('\n'), bytes: 0 }],
    };
  }

  const { inline, external } = splitCriticalStyles(theme.styles, { limit });
  // 主题可能把样式拆成 3 个文件（main / typography / print），
  // 每个都单独外链就是 3 个请求。合成一份是纯收益：它们总是一起用。
  const merged = external.length
    ? [{ name: 'theme.css', publicPath: '/assets/theme.css', content: external.map((s) => s.content).join('\n'), bytes: external.reduce((sum, s) => sum + s.bytes, 0) }]
    : [];
  return { base, limit, vars: '', inline, external: merged };
}

/**
 * `<head>` 尾部要注入的东西：资源提示 + 外链样式 + 变量覆盖。
 *
 * 顺序是硬约束，写在这里而不是散在模板里：
 *   1. 变量覆盖块（themeVars）必须排在**内联主题 CSS 之后** —— 两者选择器
 *      都是同权重的 `:root`，谁后写谁生效。放前面会被主题 CSS 里那套内置
 *      默认值盖掉，于是「用户改了主色却不生效」。
 *   2. 内联 CSS 必须排在主题 CSS 之前，否则主题默认值会盖掉变量覆盖。
 */
function buildHeadExtra(cssPlan, config) {
  const preconnect = collectPreconnect([config?.site?.url], { siteUrl: config?.site?.url });
  const hintParts = [];
  if (config?.perf?.preconnect !== false) {
    hintParts.push(renderResourceHints({ preconnect }));
  }
  if (cssPlan.external.length) {
    hintParts.push(cssPlan.external.map((s) => `<link rel="stylesheet" href="${s.publicPath}" />`).join('\n'));
  }
  return hintParts.filter(Boolean).join('\n');
}

/** 把 CSS 与 head 附加内容落进页面。 */
export function injectAssets(html, { cssPlan, headExtra }) {
  const blocks = [];
  if (cssPlan.inline.length) {
    const css = cssPlan.inline.map((s) => rewriteCssUrls(s.content, { base: cssPlan.base })).join('\n');
    blocks.push(`<style>${css}</style>`);
  }
  if (headExtra) blocks.push(headExtra);
  // 变量覆盖块（themeVarsOverride / customCSS）必须排在**最后** ——
  // 它与主题 CSS 的选择器同权重，谁后写谁生效。放前面就会出现
  // 「用户改了主色却不生效」，而且从产物里很难看出是谁盖的。
  if (cssPlan.vars) blocks.push(cssPlan.vars);
  if (!blocks.length) return html;
  return html.replace('</head>', `${blocks.join('\n')}\n</head>`);
}

/**
 * HTML 压缩：只做安全变换（去注释、折叠缩进）。刻意不压缩 <pre> 与 <code>
 * 内部 —— 那会破坏代码块里刻意保留的空白。
 */
export function finalizeHtml(html, config) {
  const blocks = [];
  // <pre> 与 <style> 都要原样保留：
  //   · <pre> —— 空白是代码的一部分
  //   · <style> —— 空白可能是 CSS 值的一部分（content: "a  b"、
  //     grid-template-columns 的对齐、自定义属性里的多空格串）。
  //     折叠空格看起来「只是省几个字节」，实则会悄悄改掉样式，且很难往回查。
  const stash = (re) => (match) => `\u0000BLK${blocks.push(match) - 1}\u0000`;
  let out = String(html);
  out = out.replace(/<pre[\s\S]*?<\/pre>/g, stash());
  out = out.replace(/<style[\s\S]*?<\/style>/g, stash());
  out = out.replace(/<!--(?!\[if)[\s\S]*?-->/g, '');
  out = out.replace(/>\s+</g, '><');
  out = out.replace(/[ \t]{2,}/g, ' ');
  out = out.replace(/\n{2,}/g, '\n');
  out = out.replace(/\u0000BLK(\d+)\u0000/g, (_, idx) => blocks[Number(idx)]);
  return out.trim();
}
