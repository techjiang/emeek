/**
 * 一致性验证用的 HTML → DOM 树转换。
 *
 * 「逐字节比较」不成立的原因：编辑器预览是塞进 DOM 的活文档，浏览器会把
 * `<img />` 规范成 `<img>`、把 `&apos;` 解码成 `'`、表格里补 `<tbody>`。
 * 拿字符串直接比，比的是「序列化方言」而不是「渲染结果」——
 * 那种测试会因为一个自闭合斜杠天天报警，最后被人加 `|| true` 静音掉。
 *
 * 所以：两边都走同一份解析器得到同一棵树，再比较这棵树的规范序列化。
 * 差异只要真实存在（少了锚点、懒加载丢了、代码高亮缺一段）就一定报出来；
 * 差异如果只是写法的方言，就不报。测试守的是「看到的东西」。
 *
 * 解析器用 markdown-it 的规则集（html: true + xhtmlOut: true）：
 * 它按 HTML5 规范补 tbody、处理 void 元素，行为与浏览器一致，
 * 而它本身就是零依赖、无 DOM 的纯 JS —— 不需要 jsdom 就能在 Node 里跑。
 */
import MarkdownIt from 'markdown-it';

const parser = new MarkdownIt('commonmark', { html: true, xhtmlOut: true, breaks: false });
// markdown-it 的 html_block/html_inline 规则对原始 HTML 的容忍度决定了一致性
// 比对的覆盖范围。开到底（html: true 已开），但关掉 typographer ——
// 任何「自作聪明」的字符替换都会引入 core 不做的差异。

/** 自闭合元素（HTML5 void elements），规范序列化时统一成无斜杠形式。 */
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
const decode = (text) => String(text).replace(/&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/gi, (all, dec, hex, name) => {
  if (dec) return String.fromCodePoint(Number(dec));
  if (hex) return String.fromCodePoint(parseInt(hex, 16));
  return NAMED[name.toLowerCase()] ?? all;
});

/**
 * 解析 HTML，返回简化树。
 * 节点形如：{ tag, attrs, children, text }。
 * 属性按名排序，值解码 —— 顺序不承载语义，不该进比较。
 */
export function parseHtml(html) {
  const tokens = parser.parse(String(html ?? ''), {});
  const root = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  // 块级/内联的都走 token，嵌套靠 nesting 记账
  for (const token of tokens) {
    const parent = stack[stack.length - 1];
    if (token.type === 'text' || token.type === 'code_inline' || token.type === 'html_inline') {
      const value = token.type === 'code_inline' ? token.content : token.content;
      if (token.type === 'html_inline' && /^<\//.test(value)) {
        if (stack.length > 1 && parent.tag === value.slice(2).replace(/[\s>].*$/, '')) stack.pop();
        continue;
      }
      if (token.type === 'html_inline' && /^<[a-z0-9!]/i.test(value)) {
        const selfClosing = /\/>\s*$/.test(value) || VOID.has(/^<([a-z0-9]+)/i.exec(value)?.[1]?.toLowerCase() ?? '');
        const node = inlineTagToNode(value);
        parent.children.push(node);
        if (!selfClosing && node.tag) stack.push(node);
        continue;
      }
      pushText(parent, value);
      continue;
    }

    if (token.type === 'fence' || token.type === 'code_block') {
      const node = { tag: 'pre', attrs: {}, children: [{ tag: 'code', attrs: {}, children: [], text: token.content + (token.type === 'code_block' ? '\n' : '') }] };
      parent.children.push(node);
      continue;
    }
    if (token.type === 'hardbreak') { parent.children.push({ tag: 'br', attrs: {}, children: [] }); continue; }
    if (token.type === 'softbreak') { pushText(parent, '\n'); continue; }

    if (token.type === 'html_block') {
      // 原始 HTML 块：多数是 core 输出的 <div> 包裹（code-block / table-wrap）。
      // 逐标签压栈，保持与真实 DOM 相同的嵌套，否则块内的文本会归错父节点。
      consumeRawHtml(token.content, stack, root);
      continue;
    }

    if (token.nesting === 1) {
      const node = { tag: lowerName(token.tag), attrs: attrsOf(token), children: [] };
      parent.children.push(node);
      stack.push(node);
    } else if (token.nesting === -1) {
      const top = stack[stack.length - 1];
      if (top.tag === lowerName(token.tag)) stack.pop();
      else {
        // 容错：找最近的同名节点弹出，避免单标签不配对把整棵树带歪
        const index = stack.map((n) => n.tag).lastIndexOf(lowerName(token.tag));
        if (index > 0) stack.length = index;
      }
    } else {
      parent.children.push({ tag: lowerName(token.tag), attrs: attrsOf(token), children: [], text: token.content || undefined, void: VOID.has(lowerName(token.tag)) });
    }
  }
  return root;
}

function lowerName(tag) { return String(tag ?? '').toLowerCase(); }

function attrsOf(token) {
  const attrs = {};
  for (const [name, value] of token.attrs ?? []) attrs[name.toLowerCase()] = decode(value ?? '');
  return attrs;
}

function inlineTagToNode(raw) {
  const match = /^<([a-z0-9-]+)((?:\s[^>]*?)?)\/?>$/i.exec(raw.trim());
  if (!match) return { tag: null, attrs: {}, children: [], text: raw };
  const attrs = {};
  for (const attr of match[2].matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    attrs[attr[1].toLowerCase()] = decode(attr[2] ?? attr[3] ?? attr[4] ?? '');
  }
  return { tag: match[1].toLowerCase(), attrs, children: [] };
}

/** 处理原始 HTML 块：按标签扫描，维护嵌套栈。 */
function consumeRawHtml(raw, stack, root) {
  const parts = raw.split(/(<\/?[a-z][^>]*?>)/i);
  for (const part of parts) {
    if (!part) continue;
    const close = /^<\/([a-z0-9-]+)/i.exec(part);
    if (close) {
      const index = stack.map((n) => n.tag).lastIndexOf(close[1].toLowerCase());
      if (index > 0) stack.length = index;
      continue;
    }
    const open = /^<([a-z0-9-]+)/i.exec(part);
    if (open) {
      const node = inlineTagToNode(part);
      stack[stack.length - 1].children.push(node);
      const selfClosing = /\/>$/.test(part) || VOID.has(open[1].toLowerCase());
      if (!selfClosing && node.tag) stack.push(node);
      continue;
    }
    pushText(stack[stack.length - 1], decode(part));
  }
}

function pushText(parent, value) {
  const text = String(value);
  if (!text) return;
  const last = parent.children[parent.children.length - 1];
  if (last && last.tag === '#text') last.text += text;
  else parent.children.push({ tag: '#text', attrs: {}, children: [], text });
}

/**
 * 规范序列化。
 *
 * 忽略规则都是「不承载渲染结果」的：
 * - 属性顺序（按名排序）
 * - 布尔属性写法（disabled / disabled="" 等价）
 * - 空白折叠：HTML 里连续空白视觉上等价（<pre> 内部除外，见下）
 * - void 元素的自闭合斜杠
 *
 * 不忽略的（也就是测试真正在守的）：
 * - 标签名、层级、任何属性的存在与取值（class / id / loading / alt …）
 * - <pre> 与 <code> 内部的空白（缩进就是内容）
 */
export function normalizeTree(node, { inPre = false } = {}) {
  if (!node) return '';
  if (node.tag === '#root') {
    return node.children.map((child) => normalizeTree(child, { inPre })).filter(Boolean).join('');
  }
  if (node.tag === '#text') {
    const text = inPre ? node.text : collapse(node.text);
    return text ? esc(text) : '';
  }

  const nextInPre = inPre || node.tag === 'pre';
  const attrs = Object.entries(node.attrs ?? {})
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}="${esc(value === '' ? '' : value)}"`)
    .join(' ');
  const children = (node.children ?? []).map((child) => normalizeTree(child, { inPre: nextInPre })).join('');
  if (VOID.has(node.tag) && !children) return `<${node.tag}${attrs ? ` ${attrs}` : ''}>`;
  return `<${node.tag}${attrs ? ` ${attrs}` : ''}>${children}</${node.tag}>`;
}

const collapse = (text) => String(text).replace(/\s+/g, ' ');
const esc = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 便捷入口：HTML 字符串 → 规范形式。 */
export function canonicalizeHtml(html) {
  return normalizeTree(parseHtml(html));
}

/** 两个 HTML 是否「渲染等价」。 */
export function htmlEquivalent(a, b) {
  return canonicalizeHtml(a) === canonicalizeHtml(b);
}
