/**
 * 渲染管线的浏览器友好入口。
 *
 * 与 `@emeeek/core`（`.`）的区别只有一个：不带 node: 依赖。
 * 编辑器要在浏览器里跑，而根入口会拖进 fs / path / child_process。
 *
 * 为什么单开一个入口而不是把根入口改成同构：
 * 构建（Node）需要用 fs 读写文件，编辑器（浏览器）不需要。
 * 强行合并只有两种结果 —— 要么给浏览器打包一堆 polyfill，
 * 要么在浏览器里 import 到一个只要被求值就会炸的模块。
 * 分开是诚实的：谁需要什么，谁就 import 什么。
 */
export { renderMarkdown, slugify, slugifyBase, contentHash, escapeHtml } from '../parse/markdown.js';
export { buildToc, renderToc, addAnchorLinks, stripTags } from '../transform/toc.js';
export { decorateImages, createImageResolver } from '../transform/images.js';
export { makeExcerpt, readingTime, countWords } from '../transform/excerpt.js';
export { buildWikiLinkIndex, resolveWikiLink, extractWikiTargets, normalize } from '../transform/links.js';
export { parseFrontmatter } from '../parse/frontmatter.js';
export { highlight } from '../parse/code-block.js';

import { renderMarkdown } from '../parse/markdown.js';
import { addAnchorLinks } from '../transform/toc.js';
import { decorateImages } from '../transform/images.js';

/**
 * 构建期对单篇 Markdown 做的全部变换：渲染 → 图片 → 锚点。
 *
 * 这个函数是「预览 = 构建」唯一的落点：编辑器调它，构建也调它。
 * 顺序（先图片后锚点）是契约 —— 反过来的话锚点按钮会被图片装饰重写。
 */
export function renderArticle(raw, {
  allowHtml = false,
  lazyImages = true,
  headingIds = new Map(),
  wikiLink,
  resolveImage = (url) => url,
} = {}) {
  const html = renderMarkdown(raw, {
    allowHtml,
    resolveImage,
    resolveLink: (url) => url,
    headingIds,
    wikiLink,
  });
  return addAnchorLinks(decorateImages(html, { lazy: lazyImages }));
}
