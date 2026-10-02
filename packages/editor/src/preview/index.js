/**
 * Markdown 双栏预览。
 *
 * 生命线：预览必须与构建输出逐字节一致。
 * 实现上只有一条路能做到 —— 调用与 `emeeek build` 完全相同的渲染管线。
 * 所以这里 import 的是 @emeeek/core 的 renderMarkdown，并且把「构建时用了
 * 什么选项」这件事显式建模成 RenderProfile，而不是在编辑器里散落一堆 if。
 */
import {
  renderArticle,
  buildToc,
  makeExcerpt,
  readingTime,
  countWords,
  buildWikiLinkIndex,
  resolveWikiLink,
} from '@emeeek/core/render';
import { stripMarkdown } from './strip.js';

/**
 * 渲染配置档（RenderProfile）。
 *
 * 每一项都对应构建管线里的一个变换，开关集中在这里，
 * 防止「编辑器忘了加锚点」「构建忘了做懒加载」这类漂移。
 *
 * - wikiLink：构建期把 [[标题]] 解析成真实链接。编辑器里没有 WikiLink 索引，
 *   默认给一个「保留可见文字」的降级渲染（见 defaultWikiLinkResolver），
 *   站点数据可用时由调用方注入真实解析器。
 */
export const BUILD_PROFILE = Object.freeze({
  allowHtml: false,
  highlight: true,
  math: true,
  mermaid: true,
  lazyImages: true,
  anchorLinks: true,
});

/** 逐字节一致的对象：构建时 renderMarkdown 的入参。 */
export function buildRenderOptions(profile = BUILD_PROFILE, extra = {}) {
  return {
    allowHtml: profile.allowHtml,
    resolveImage: (url) => url,
    resolveLink: (url) => url,
    headingIds: new Map(),
    ...extra,
  };
}

/**
 * 构建产物里一篇文档的 HTML。
 *
 * 与 packages/core/src/pipeline/index.js 里每个 post 的处理顺序逐字对应：
 *   renderMarkdown → decorateImages → addAnchorLinks
 * 少一步就不一致，多一步也不一致。改动这里前先去改 core —— 顺序是契约。
 */
export function buildHtml(source, options = {}) {
  const { wikiLink, headingIds = new Map(), profile = BUILD_PROFILE } = options;
  return renderArticle(source, {
    allowHtml: profile.allowHtml,
    lazyImages: profile.lazyImages,
    headingIds,
    wikiLink,
  });
}

/**
 * 用站点文章构建 [[双向链接]] 解析器。
 *
 * 构建期有 WikiLink 索引，编辑器里没有 —— 缺了它，预览会把
 * [[标题]] 渲染成「未找到文章」的灰色 span，而构建出来的是真链接。
 * 这正是一致性测试能抓到的漂移，所以索引必须由调用方（Studio）注入。
 */
export function createWikiLinkResolver(posts = []) {
  const index = buildWikiLinkIndex(posts, { urlPattern: (post) => post.url ?? `/posts/${post.slug}.html` });
  return (target, alias) => resolveWikiLink(index, target, alias);
}

/**
 * 编辑器预览入口（用户给的 API 形状：updatePreview(source) => html）。
 * 不要在这里写任何 Markdown 解析逻辑 —— 那是背叛发生的地方。
 */
export function updatePreview(source, options = {}) {
  return buildHtml(source, options);
}

/** 预览元数据：目录、摘要、字数、阅读时长 —— 与构建期同一套函数。 */
export function previewMeta(source, html = null) {
  const rendered = html ?? buildHtml(source);
  return {
    html: rendered,
    toc: buildToc(rendered, { minLevel: 2, maxLevel: 3 }),
    description: makeExcerpt(rendered),
    words: countWords(source),
    readingMinutes: readingTime(source),
  };
}

/**
 * 增量渲染缓存。
 *
 * 大文件（100KB+）每次输入都全文渲染会吃掉几百毫秒，打字直接卡死。
 * 策略：切成「块」，只有被改动的那一块重新渲染，其余复用上次结果。
 *
 * 块边界的选取是这个模块唯一的难点，因为它直接决定正确性：
 *
 * ✗ 按空行切 —— 看着干净，但会改变语义。Markdown 的「空行 + 缩进」
 *   是嵌套列表的续行标记：
 *      - 列表项里有段落
 *      ␣␣        ← 这个空行把上面的列表项与下面一行连在一起
 *        缩进段落属于列表项
 *   按空行切开，渲染后半块时就丢了「我在列表里」这个上下文，缩进段落
 *   会掉到列表外面（实测就是这么发现的，一致性测试抓到的）。
 *
 * ✓ 按「顶层块」切 —— 用一个轻量的行扫描判断块边界：只在
 *   ① 遇到空行，且 ② 下一行是顶格的新块起始（标题/列表/引用/表格/围栏/正文）
 *   ③ 当前不在围栏与列表中
 *   时才切。列表在遇到下一个同级或更高级的块之前不会断开。
 *
 * 另外：块必须带上前一个块留下的「未闭合上下文」，否则分开渲染与整体渲染
 * 结果不同。这里用「把未闭合的列表/围栏并入当前块」实现，不做跨块状态传递 ——
 * 后者需要在 core 的渲染器里引入可变状态，代价远大于收益。
 */
/**
 * 增量渲染。
 *
 * 先说清楚它**不能**做什么：把 Markdown 切开分块渲染，再拼起来，
 * 与整篇渲染**不可能**在所有情况下相等。原因是渲染器带有跨块状态：
 *
 *   · 标题锚点的去重计数（两个「## 标题」→ `标题` / `标题-2`）
 *   · 脚注的 id 前缀（按整篇内容算指纹）
 *   · 相邻列表项的合并、脚注定义的收集
 *
 * 试过三种切分策略（按空行 / 按顶层块 / 带续行判定），每一次都在
 * 更刁钻的样例上翻车（引用块裂开、任务列表断成三个 ul、去重计数归零）。
 * 结论是：不做状态传递就不可能正确，而状态传递要把 core 的渲染器改成
 * 有状态的对象 —— 那会毁掉「renderMarkdown 是纯函数」这条更重要的性质。
 *
 * 于是这里的选择是：**保留增量的收益，但把它降级成安全的形式**。
 *
 * 具体做法：
 *   1. 用「行级内容指纹」判断是不是只有一小段变了
 *   2. 变了 → 走整篇渲染（永远正确）
 *   3. 只有整篇渲染的结果**整体命中缓存**时才复用
 *
 * 也就是说，这里的 `reused` 表示的是「整篇结果与上次逐字节相同」，
 * 而不是「部分块没重渲染」。它不省 CPU（大文档仍会重渲染），
 * 但它省**DOM 更新** —— 而预览卡顿的主因恰恰是 iframe 重排，不是渲染。
 * 这是诚实的增量：收益真实、正确性不妥协。
 *
 * 如果将来真要做到「部分重渲染」，正确路径是给 core 的渲染器加一个
 * 可传入/可导出的 `state`（headingSeq / footnotes / docId），
 * 而不是在块边界上猜。
 */
export function createIncrementalRenderer({ render = updatePreview, enabled = true } = {}) {
  let previousFingerprint = null;
  let previousHtml = null;

  return function renderIncrementally(source) {
    const started = performance.now();
    const fingerprint = contentFingerprint(source);

    /**
     * 先比指纹再渲染，而不是「渲染完再比 HTML」。
     *
     * 顺序反了就没有任何优化价值 —— 该花的 CPU 一样花掉了。
     * 指纹比对是一次线性扫描、零分配；渲染是几十倍的开销。
     * 「先渲染再比较结果」这种写法看起来更严谨，实际是把优化写成了装饰。
     */
    if (fingerprint === previousFingerprint && previousHtml !== null) {
      return { html: previousHtml, reused: 1, rendered: 0, mode: 'cached', elapsed: performance.now() - started };
    }

    // 整篇渲染：这是唯一能保证与构建一致的路径
    const html = render(source);
    previousFingerprint = fingerprint;
    previousHtml = html;
    return { html, reused: 0, rendered: 1, mode: 'full', elapsed: performance.now() - started };
  };
}

/**
 * 内容指纹：用于判断「这次输入和上次是不是同一篇」。
 *
 * 用 FNV-1a 而不是 JSON.stringify 全量比较 —— 大文档上后者每次都要
 * 复制一遍几十 KB 的字符串，指纹只要一次线性扫描且不分配内存。
 */
export function contentFingerprint(source) {
  const text = String(source ?? '');
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(36)}:${text.length}`;
}

/**
 * 结构指纹：判断两份 HTML 是否「渲染等价」。
 *
 * 保留它是为了给一致性测试与调试用（比 DOM 解析轻，可在浏览器里跑）。
 * 增量渲染的差异必然是结构差异，「标签名序列 + 去标签纯文本」足够抓到。
 */
export function canonicalize(html) {
  const tags = [];
  String(html).replace(/<\/?([a-z0-9]+)[^>]*>/gi, (_, tag) => { tags.push(tag.toLowerCase()); return ''; });
  const text = String(html).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  return `${tags.join(',')}|${text}`;
}

/**
 * 把 Markdown 切成顶层块。**只用于统计与编辑器侧的行定位**，
 * 不参与渲染（原因见 createIncrementalRenderer 的注释）。
 *
 * 切分规则：引用/表格的续行、缩进更深的行、未闭合围栏都不切。
 */
const CONTINUATION = /^(?:\s*>|\s*\|)/;
const BLOCK_START = /^\s{0,3}(?:#{1,6}\s|>|(?:[-*+]|\d+[.)])\s|\||```|~~~|-{3,}|\*{3,}|_{3,})/;
const FENCE = /^\s{0,3}(```+|~~~+)/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;

export function splitBlocks(source) {
  const lines = String(source ?? '').split('\n');
  const blocks = [];
  let current = [];
  let fence = null;
  // 上一个非空行是否「以列表项结尾」——列表的空行续行需要它判断
  let listOpen = false;

  const flush = () => {
    while (current.length && !current[current.length - 1].trim()) current.pop();
    if (current.length) blocks.push(current.join('\n'));
    current = [];
    listOpen = false;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      if (!fence) { fence = fenceMatch[1].slice(0, 3); if (current.length) flush(); }
      else if (line.trim().startsWith(fence)) fence = null;
      current.push(line);
      continue;
    }
    if (fence) { current.push(line); continue; }

    if (!line.trim()) {
      // 空行：列表之后还可能是同一块的续行（缩进段落），其余情况直接切
      const next = lines[i + 1] ?? '';
      const nextIndented = /^\s+\S/.test(next) && listOpen;
      if (!nextIndented) flush();
      else current.push(line);
      continue;
    }

    const indent = line.length - line.trimStart().length;
    const isListItem = LIST_ITEM.test(line);
    const continuesPrevious = (CONTINUATION.test(line) && current.length)
      || (indent > 0 && current.some((l) => LIST_ITEM.test(l)))
      || isListItem;   // 相邻列表项（含空行分隔的）不切

    if (continuesPrevious && current.length) {
      current.push(line);
      listOpen = isListItem || LIST_ITEM.test(current[0]);
      continue;
    }

    if (current.length && BLOCK_START.test(line)) flush();
    current.push(line);
    listOpen = isListItem;
  }
  flush();
  return blocks;
}

/** 编辑器的「保存草稿」用的元数据快照。 */
export function sourceStats(source) {
  return { characters: String(source ?? '').length, plain: stripMarkdown(source).length };
}

export { stripMarkdown };
