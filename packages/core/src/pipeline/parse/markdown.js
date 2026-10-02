/**
 * 零依赖 Markdown 渲染器。
 *
 * 为什么不用 markdown-it / remark：Phase 1 的性能目标是首屏 < 1s、JS 体积 < 30KB，
 * 而构建期真正需要的是「稳定输出语义化 HTML」这一件事。这里只实现会被用到的语法，
 * 遗留能力（表格、脚注、任务列表、定义列表）都在，体积是同类库的零头。
 *
 * 输出前所有文本都过 escapeHtml，原文里的 HTML 默认按纯文本处理（可通过
 * allowHtml 打开），避免内容仓库被注入。
 */
import { highlight } from './code-block.js';
import { sanitizeUrl } from './sanitize-url.js';
import { sanitizeHtml } from './sanitize-html.js';

export function renderMarkdown(src, options = {}) {
  const { allowHtml = false, resolveImage = (url) => url, resolveLink = (url) => url, headingIds = new Map(), wikiLink } = options;
  const text = String(src).replace(/\r\n?/g, '\n');
  const ctx = {
    allowHtml, resolveImage, resolveLink, headingIds, wikiLink,
    headingSeq: new Map(), footnotes: new Map(), footnoteOrder: [],
    // 脚注 id 前缀取内容指纹而不是随机数。
    // 随机数让同一个输入两次渲染产出不同 HTML —— 构建、预览、增量渲染、
    // 缓存全部依赖于「同一输入 → 同一输出」，随机 id 会直接毁掉一致性。
    docId: options.docId ?? `fn${contentHash(text)}`,
  };

  // 词表切片（A3）：只渲染正文的一小段。
  // 用途是编辑器把大文件切块增量渲染 —— 全文一次渲染会吃掉几百毫秒。
  // 切在「行」边界上，保证块内 Markdown 语法完整（表格/列表/代码块不会被拦腰截断），
  // 跨块的语法由调用方自己处理，本函数不做跨块拼接。
  if (options.slice) {
    const lines = text.split('\n');
    const from = Math.max(0, options.slice.from ?? 0);
    const to = Math.min(lines.length, options.slice.to ?? lines.length);
    return renderBlocks(lines.slice(from, to).join('\n'), ctx).body;
  }
  const { body, footnotesHtml } = renderBlocks(text, ctx);
  const refs = renderFootnoteList(ctx);
  return footnotesHtml || refs ? `${body}\n${footnotesHtml}${refs}` : body;
}

function renderBlocks(text, ctx) {
  const lines = text.split('\n');
  const out = [];
  let footnotesHtml = '';
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i += 1; continue; }
    if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push('<hr />'); i += 1; continue; }
    if (/^#{1,6}\s/.test(line)) {
      const [, hashes, rawTitle] = /^(#{1,6})\s+(.*)$/.exec(line);
      const level = hashes.length;
      const title = renderInline(rawTitle.replace(/\s+#+\s*$/, ''), ctx);
      out.push(`<h${level} id="${slugify(plain(rawTitle), ctx)}">${title}</h${level}>`);
      i += 1;
      continue;
    }
    if (/^\s{0,3}>/.test(line)) { const r = consumeQuote(lines, i, ctx); out.push(r.html); i = r.next; continue; }
    if (/^\s{0,3}(?:[-*+]|\d+[.)])\s/.test(line)) { const r = consumeList(lines, i, ctx); out.push(r.html); i = r.next; continue; }
    if (/^\s{0,3}```/.test(line)) { const r = consumeCode(lines, i); out.push(r.html); i = r.next; continue; }
    if (isTableStart(lines, i)) { const r = consumeTable(lines, i, ctx); out.push(r.html); i = r.next; continue; }
    if (/^\s*\[\^[^\]]+\]:/.test(line)) { const r = consumeFootnoteDef(lines, i); ctx.footnotes.set(footnoteId(r.id), r.text); i = r.next; continue; }

    const para = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines, i)) { para.push(lines[i]); i += 1; }
    out.push(`<p>${renderInline(para.join('\n'), ctx).replace(/\n/g, '<br />\n')}</p>`);
  }
  return { body: out.join('\n'), footnotesHtml };
}

function isBlockStart(lines, i) {
  const line = lines[i];
  return /^\s{0,3}(?:#{1,6}\s|>|```|(?:[-*+]|\d+[.)])\s|\[\^[^\]]+\]:|-{3,}\s*$)/.test(line) || isTableStart(lines, i);
}

function consumeCode(lines, start) {
  const fence = /^\s{0,3}```([^\s`]*)/.exec(lines[start]);
  const lang = (fence[1] || '').toLowerCase();
  const body = [];
  let i = start + 1;
  while (i < lines.length && !/^\s{0,3}```/.test(lines[i])) { body.push(lines[i]); i += 1; }
  const code = body.join('\n');
  const highlighted = highlight(code, lang);
  const langLabel = lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : '';
  const copy = '<button class="code-copy" type="button" aria-label="复制代码">复制</button>';
  return {
    html: `<div class="code-block">${langLabel}${copy}<pre><code${lang ? ` class="language-${escapeHtml(lang)}"` : ''}>${highlighted}</code></pre></div>`,
    next: i + 1,
  };
}

function consumeQuote(lines, start, ctx) {
  const body = [];
  let i = start;
  while (i < lines.length && /^\s{0,3}>/.test(lines[i])) { body.push(lines[i].replace(/^\s{0,3}>\s?/, '')); i += 1; }
  const inner = renderBlocks(body.join('\n'), ctx).body;
  return { html: `<blockquote>\n${inner}\n</blockquote>`, next: i };
}

function consumeList(lines, start, ctx) {
  const ordered = /^\s{0,3}\d+[.)]\s/.test(lines[start]);
  const baseIndent = indentOf(lines[start]);
  const items = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      // 空行后仍是同级列表项才算连续列表，否则列表结束。
      const next = lines[i + 1] ?? '';
      if (next.trim() && indentOf(next) >= baseIndent && isListItem(next, baseIndent)) { i += 1; continue; }
      break;
    }
    if (!isListItem(line, baseIndent)) break;

    const marker = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    const [checked, text] = parseTaskMarker(marker[2]);
    const chunks = [text];
    i += 1;
    // 收集该项的续行：缩进更深的行都是它的子内容（嵌套列表、续写段落），
    // 交给 renderBlocks 递归处理，才能还原层级而不是压平成兄弟项。
    while (i < lines.length) {
      const child = lines[i];
      if (!child.trim()) {
        const next = lines[i + 1] ?? '';
        if (next.trim() && indentOf(next) > baseIndent) { chunks.push(''); i += 1; continue; }
        break;
      }
      if (indentOf(child) <= baseIndent) break;
      chunks.push(child.slice(baseIndent + 2).replace(/\s+$/, ''));
      i += 1;
    }
    const inner = renderBlocks(chunks.join('\n'), ctx).body;
    // 纯文本项不套 <p>：单行列表项包一层段落只会带来冗余样式与多余边距。
    const body = inner.startsWith('<p>') ? stripSingleP(inner) : inner;
    // 复选框必须带可访问名称，否则屏幕阅读器只会读到一个无标签的表单控件。
    items.push(checked === null
      ? `<li>${body}</li>`
      : `<li class="task"><input type="checkbox" disabled${checked ? ' checked' : ''} aria-label="${checked ? '已完成' : '未完成'}" /> ${body}</li>`);
  }

  const tag = ordered ? 'ol' : 'ul';
  const startAttr = ordered && /^\s{0,3}(\d+)/.test(lines[start]) && Number(/^\s{0,3}(\d+)/.exec(lines[start])[1]) !== 1
    ? ` start="${Number(/^\s{0,3}(\d+)/.exec(lines[start])[1])}"`
    : '';
  return { html: `<${tag}${startAttr}>\n${items.join('\n')}\n</${tag}>`, next: i };
}

function parseTaskMarker(text) {
  const m = /^\[([ xX])\]\s+(.*)$/.exec(text);
  if (!m) return [null, text];
  return [m[1].toLowerCase() === 'x', m[2]];
}

function isListItem(line, indent) {
  const m = /^(\s*)(?:[-*+]|\d+[.)])\s/.exec(line);
  if (!m) return false;
  return m[1].length >= Math.min(indent, 3);
}

function indentOf(line) { return line.length - line.trimStart().length; }

function consumeFootnoteDef(lines, start) {
  const m = /^\s*\[\^([^\]]+)\]:\s*(.*)$/.exec(lines[start]);
  const id = m[1];
  const parts = [m[2]];
  let i = start + 1;
  while (i < lines.length && lines[i].trim() && indentOf(lines[i]) > 0) { parts.push(lines[i].trim()); i += 1; }
  return { id, text: parts.join(' '), next: i };
}

function renderFootnoteList(ctx) {
  if (!ctx.footnotes.size) return '';
  const items = orderFootnotes(ctx).map(([id, text]) => {
    const anchor = footnoteId(id);
    return `<li id="${ctx.docId}-fn-${anchor}">${renderInline(text, ctx)} <a href="#${ctx.docId}-fnref-${anchor}" class="footnote-back" aria-label="返回正文">↩</a></li>`;
  });
  return `<section class="footnotes">\n<ol>\n${items.join('\n')}\n</ol>\n</section>`;
}

function isTableStart(lines, i) {
  const header = lines[i];
  const divider = lines[i + 1];
  if (!header || !divider) return false;
  return header.includes('|') && /^\s{0,3}\|?[\s:-]*-[\s|:-]*\|?\s*$/.test(divider) && divider.includes('-');
}

function consumeTable(lines, start, ctx) {
  const splitRow = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const headers = splitRow(lines[start]);
  const aligns = splitRow(lines[start + 1]).map((c) => {
    if (/^:-+:$/.test(c)) return 'center';
    if (/^:-+/.test(c)) return 'left';
    if (/-+:$/.test(c)) return 'right';
    return null;
  });
  const rows = [];
  let i = start + 2;
  while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { rows.push(splitRow(lines[i])); i += 1; }

  const head = headers.map((h, idx) => `<th${aligns[idx] ? ` style="text-align:${aligns[idx]}"` : ''}>${renderInline(h, ctx)}</th>`).join('');
  const body = rows.map((row) => {
    const cells = headers.map((_, idx) => `<td${aligns[idx] ? ` style="text-align:${aligns[idx]}"` : ''}>${renderInline(row[idx] ?? '', ctx)}</td>`).join('');
    return `<tr>${cells}</tr>`;
  }).join('\n');
  return { html: `<div class="table-wrap"><table>\n<thead><tr>${head}</tr></thead>\n<tbody>\n${body}\n</tbody>\n</table></div>`, next: i };
}

function renderInline(text, ctx) {
  const stash = [];
  const keep = (html) => `\u0000${stash.push(html) - 1}\u0000`;

  let out = text;
  // 行内代码先取出，避免内部的下划线/星号被当成强调。
  out = out.replace(/(`+)([\s\S]*?)\1/g, (_, __, code) => keep(`<code>${escapeHtml(code.trim())}</code>`));
  /**
   * URL 消毒是硬性的：链接与图片地址先过 sanitizeUrl，被拒的一律**不生成标签**，
   * 退回纯文本。`[点我](javascript:…)` 渲染成可点链接 = 每次点击都是一次 XSS，
   * 而 Markdown 的来源（Issue、别人发的 .md）完全不可信。
   */
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_, alt, url, title) => {
    const safe = sanitizeUrl(ctx.resolveImage(url), { allowData: true });
    if (safe === null) return keep(`<span class="unsafe-url">![${escapeHtml(alt)}]</span>`);
    return keep(`<img src="${escapeHtml(safe)}" alt="${escapeHtml(alt)}"${title ? ` title="${escapeHtml(title)}"` : ''} loading="lazy" decoding="async" />`);
  });
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_, label, url, title) => {
    const safe = sanitizeUrl(ctx.resolveLink(url));
    if (safe === null) return keep(`<span class="unsafe-url">${escapeHtml(label)}</span>`);
    return keep(`<a href="${escapeHtml(safe)}"${title ? ` title="${escapeHtml(title)}"` : ''}>${renderInline(label, ctx)}</a>`);
  });
  // 双向链接 [[文章标题]] / [[标题|别名]]
  out = out.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, alias) =>
    keep(ctx.wikiLink ? ctx.wikiLink(target.trim(), alias?.trim()) : `<span class="wiki-link">${escapeHtml(alias ?? target)}</span>`));
  // 脚注引用
  let footnoteSeq = 0;
  out = out.replace(/\[\^([^\]]+)\]/g, (_, id) => {
    const anchor = footnoteId(id);
    ctx.footnoteOrder ??= [];
    if (!ctx.footnoteOrder.includes(anchor)) ctx.footnoteOrder.push(anchor);
    return keep(`<sup class="footnote-ref"><a href="#${ctx.docId}-fn-${anchor}" id="${ctx.docId}-fnref-${anchor}">[${ctx.footnoteOrder.indexOf(anchor) + 1}]</a></sup>`);
  });
  // 先转义再补强调标签：反过来的话，<strong> 会被 escapeHtml 一并逃逸掉。
  /**
   * allowHtml 不等于「原样输出」。
   *
   * 打开它只是允许结构化标签（<div class="note">），脚本、事件属性、
   * 非白名单协议仍然会被剥掉 —— 内容作者的 HTML 与「可执行的内容」
   * 是两件事，后者在 Issue 驱动的站点里等于「任何能提 Issue 的人都能 XSS」。
   */
  out = ctx.allowHtml ? sanitizeHtml(out) : escapeHtml(out);
  out = out.replace(/~~([\s\S]+?)~~/g, '<del>$1</del>');
  out = out.replace(/\*\*\*([\s\S]+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  out = out.replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+?)\*/g, '$1<em>$2</em>');
  out = out.replace(/(^|[^\w])_([^_\n]+?)_(?=[^\w]|$)/g, '$1<em>$2</em>');
  out = out.replace(/==([\s\S]+?)==/g, '<mark>$1</mark>');
  return out.replace(/\u0000(\d+)\u0000/g, (_, idx) => stash[Number(idx)]);
}

/**
 * 标题 → 锚点 id 的基名（不含去重序号）。
 *
 * 这份规则同时被三处使用：渲染器、目录导航（编辑器）、脚注。多写一份就是
 * 定时炸弹 —— 上一轮的「句末标点漏判」就是这么来的。编辑器通过
 * `emeeek studio --dump-spec` 从 core 取这份定义，不允许自己实现。
 */
export function slugifyBase(text) {
  return String(text)
    .toLowerCase()
    .trim()
    .replace(/[\s\u3000]+/g, '-')
    .replace(/[^\p{L}\p{N}-]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '') || 'section';
}

/** 内容指纹：FNV-1a 32 位，十六进制。用于生成稳定且几乎不会碰撞的前缀。 */
export function contentHash(text) {
  let hash = 0x811c9dc5;
  const value = String(text);
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, '0').slice(0, 7);
}

/** 标题锚点：中文标题直接保留，空白转连字符，重复标题加序号保证唯一。 */
export function slugify(text, ctx = {}) {
  const base = slugifyBase(text);

  const map = ctx.headingSeq ?? new Map();
  const count = map.get(base) ?? 0;
  map.set(base, count + 1);
  const id = count === 0 ? base : `${base}-${count + 1}`;
  ctx.headingIds?.set(String(text).trim(), id);
  return id;
}

function plain(md) { return md.replace(/[*_`~\[\]]/g, ''); }

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function stripSingleP(html) {
  const trimmed = html.trim();
  const m = /^<p>([\s\S]*)<\/p>$/.exec(trimmed);
  // 只有当整段就是「一个段落」时才剥掉，避免把段落与后续块级元素混在一起。
  if (!m) return html;
  return /<(?:p|ul|ol|div|table|blockquote|pre)\b/.test(m[1]) ? html : m[1];
}

/** 脚注只做安全字符转换，不走 slugify —— 后者带去重计数，会把 id 越加越长。 */
function footnoteId(id) {
  return String(id).trim().toLowerCase().replace(/[^\p{L}\p{N}-]/gu, '-');
}

function orderFootnotes(ctx) {
  const order = ctx.footnoteOrder ?? [];
  const entries = [...ctx.footnotes.entries()];
  return entries.sort(([a], [b]) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia === -1 ? Infinity : ia) - (ib === -1 ? Infinity : ib);
  });
}
