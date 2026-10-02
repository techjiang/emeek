/**
 * 原始 HTML 消毒（只在 allowHtml 打开时走这里）。
 *
 * 为什么需要一个「允许写 HTML」的模式：主题作者与进阶用户确实会写
 * `<div class="note">`、`<picture>` 这类结构化标签，一律转义会让这套能力消失。
 *
 * 但「允许写 HTML」不等于「允许执行脚本」。内容可能来自别人提的 Issue、
 * 别人发来的 .md 文件。所以这里是白名单式消毒：
 *
 *   剥掉的：<script>、<style>、<iframe>、<object>、<embed>、<form>、
 *           <base>、<meta>、<link>、所有 on* 事件属性、srcdoc、
 *           以及 href/src 上的非白名单协议
 *   保留的：常规排版标签与它们的普通属性（class/id/title/alt/width/height…）
 *
 * 注释、CDATA、处理指令一并去掉 —— `<!--><script>…</script>-->` 这种
 * 「注释越界」是经典的绕过手法。
 */

/** 直接连内容一起丢弃的标签（连同内部文本）。 */
const DROP_WITH_CONTENT = [
  'script', 'style', 'iframe', 'object', 'embed', 'applet', 'base', 'meta', 'link',
  'form', 'input', 'button', 'select', 'option', 'textarea', 'template', 'noscript',
  'frame', 'frameset', 'portal', 'math', 'svg',
];

/** 保留标签但剥掉标签本身（子内容保留）的标签。 */
const UNWRAP = ['html', 'head', 'body', 'title'];

/**
 * 属性白名单（按全局，不细分到标签）。
 * 事件属性（on*）不在表里，因此自动被剥掉 —— 这比「列出所有 on*」可靠。
 * style 保留但会过一遍 sanitizeStyle（表达式与 url(javascript:) 会被去掉）。
 */
const ALLOWED_ATTRS = new Set([
  'class', 'id', 'title', 'alt', 'width', 'height', 'loading', 'decoding', 'srcset', 'sizes',
  'style', 'role', 'lang', 'dir', 'colspan', 'rowspan', 'scope', 'headers', 'start', 'reversed',
  'href', 'src', 'target', 'rel', 'type', 'checked', 'disabled', 'aria-label', 'aria-hidden',
  'aria-describedby', 'aria-labelledby', 'name', 'value', 'datetime', 'cite', 'download',
  'data-post', 'data-lang', 'data-theme', 'align', 'valign', 'span', 'open', 'datetime',
]);

const URL_ATTRS = new Set(['href', 'src', 'srcset', 'cite', 'action', 'formaction', 'poster', 'data-uri']);

import { sanitizeUrl } from './sanitize-url.js';

export function sanitizeHtml(html) {
  let out = String(html ?? '');

  // 1. 注释 / CDATA / 处理指令：`<!-->` 可以把注释提前结束，用来藏 script
  out = out.replace(/<!--[\s\S]*?-->/g, '');
  out = out.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  out = out.replace(/<\?[\s\S]*?\?>/g, '');

  // 2. 连内容一起丢掉的标签（含嵌套同名标签 —— 用循环吃到没有为止）
  for (const tag of DROP_WITH_CONTENT) {
    const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>|<${tag}\\b[^>]*\\/?>`, 'gi');
    let previous;
    do { previous = out; out = out.replace(re, ''); } while (out !== previous);
  }

  // 3. 剥掉标签本身但保留内容，例如 <body>…</body>
  for (const tag of UNWRAP) {
    out = out.replace(new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi'), '');
  }

  // 4. 非标签的 `<…>`：`<javascript:alert(1)>` 这种既不是合法标签也不是注释，
  //    浏览器会当纯文本 —— 但「当纯文本」这件事不该由我们替浏览器决定，
  //    转义掉最省事，也最不容易在某个浏览器的怪癖上翻车。
  out = out.replace(/<(?=[^a-zA-Z/!?])/g, '&lt;');

  // 5. `<` 后面跟的「名字」不是合法标签名时（含 `:` 等），同样转义。
  //    合法标签名按 HTML 规范是「字母开头的字母数字串」。
  out = out.replace(/<(\/?)([a-z][a-z0-9-]*)([:@][^>]*)>/gi, (_, slash, name, rest) => `&lt;${slash}${name}${rest}&gt;`);

  // 6. 逐个标签过属性白名单
  out = out.replace(/<([a-z][a-z0-9-]*)((?:\s+[^<>]*?)?)(\/?)>/gi, (full, name, attrs, selfClose) => {
    const kept = filterAttributes(attrs);
    return `<${name.toLowerCase()}${kept}${selfClose ? ' /' : ''}>`;
  });

  return out;
}

function filterAttributes(attrs) {
  const out = [];
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g;
  let match;
  while ((match = re.exec(attrs))) {
    const name = match[1].toLowerCase();
    // 事件属性一律拒绝。用前缀判断而不是白名单里没有 —— 漏一个 on* 就是一个 XSS。
    if (name.startsWith('on')) continue;
    if (name === 'srcdoc' || name === 'formaction') continue;
    if (!ALLOWED_ATTRS.has(name)) continue;

    const rawValue = match[2] ?? match[3] ?? match[4] ?? '';
    if (URL_ATTRS.has(name)) {
      const safe = sanitizeUrl(rawValue, { allowData: name === 'src' || name === 'poster' });
      if (safe === null) continue;
      out.push(`${name}="${escapeAttr(safe)}"`);
      continue;
    }
    if (name === 'style') {
      const safe = sanitizeStyle(rawValue);
      if (!safe) continue;
      out.push(`style="${escapeAttr(safe)}"`);
      continue;
    }
    out.push(`${name}="${escapeAttr(rawValue)}"`);
  }
  return out.length ? ` ${out.join(' ')}` : '';
}

const escapeAttr = (value) => String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

/**
 * 样式值消毒。
 *
 * IE 的 `expression(...)` 早就不支持了，但 `url(javascript:…)`、
 * `behavior:`、以及 CSS 里塞 `</style>` 都还有现实意义，所以逐项判：
 * 出现就整条属性丢掉，不做「打补丁式」的部分保留（部分保留最容易漏）。
 */
function sanitizeStyle(value) {
  const text = String(value ?? '');
  if (/expression\s*\(|javascript:|vbscript:|behavior\s*:|-moz-binding|<\/?\w/i.test(text)) return '';
  return text.trim();
}
