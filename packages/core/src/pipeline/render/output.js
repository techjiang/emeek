import fs from 'node:fs/promises';
import path from 'node:path';
import { logger, progress } from '../../util/logger.js';

/**
 * 写盘阶段。所有 HTML 在写之前统一做一次压缩与关键 CSS 内联，
 * 避免每个页面各自处理一遍。产物清单回传给调用方，便于 CLI 汇报体积。
 */
export async function writeOutput({ outDir, pages, extraFiles, theme, config, cwd, onProgress }) {
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });

  const manifest = { files: [], html: 0, totalBytes: 0 };
  const bar = progress('写入页面', pages.length);

  // theme 对象在整个进程里复用（一次构建一个主题），所以外链标记必须先清空，
  // 否则上一次留下的会污染这一次。清在这里、写在第 30 行之后，责任单一。
  delete theme.__externalCss;
  delete theme.__externalCssUrl;

  for (const page of pages) {
    let html = finalizeHtml(page.html, config);
    if (config.perf?.criticalCSS !== false) {
      html = inlineCriticalCss(html, theme);
    }
    const target = path.join(outDir, page.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, html, 'utf8');
    manifest.files.push({ path: page.path, bytes: Buffer.byteLength(html) });
    manifest.html += Buffer.byteLength(html);
    manifest.totalBytes += Buffer.byteLength(html);
    bar.tick();
  }
  bar.done();

  // 主题 CSS 走外链时必须真的落盘。inlineCriticalCss 会在体积超阈值时
  // 改成 <link href="/assets/theme.css">，此前这条路径没有任何地方写文件 ——
  // 主题一旦超过 24 KB 就会得到一个 404 的样式表，页面裸奔且构建照报成功。
  // 阈值以内的主题（Inkstone 21 KB 等）走不到这里，所以这个洞一直没被发现。
  // 只在本轮真的产出过外链时才写。跑之前先清掉上一轮的残留：theme 对象是
  // 跨构建复用的，留着会让「另一个站点、阈值以内」的场景凭空多出一份 CSS。
  if (theme.__externalCss) {
    const cssPath = '/assets/theme.css';
    extraFiles.push({ path: cssPath, content: theme.__externalCss });
    theme.__externalCssUrl = cssPath;
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
  return manifest;
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

/**
 * 关键 CSS 内联。按整份样式表内联，是因为内置主题的 CSS 本身就小于
 * 一个 RTT 的收益阈值；主题 CSS 超过阈值时退回外链，避免首屏 HTML 膨胀。
 *
 * 变量覆盖块（themeVars）必须排在内联主题 CSS **之后** —— 两者选择器都是
 * 同权重的 :root，谁后写谁生效。放在前面会被主题 CSS 里那套内置默认值盖掉，
 * 于是「用户改了主色却不生效」。
 */
function inlineCriticalCss(html, theme) {
  const css = theme.styles.map((s) => s.content).join('\n');
  const vars = theme.__varsOverride ?? '';
  if (Buffer.byteLength(css) > 24 * 1024) {
    // 交给写盘阶段落成 /assets/theme.css（见 writeOutput 里的 __externalCss）。
    theme.__externalCss = css;
    return html.replace('</head>', `<link rel="stylesheet" href="/assets/theme.css" />${vars}\n</head>`);
  }
  return html.replace('</head>', `<style>${css}</style>${vars}\n</head>`);
}
