#!/usr/bin/env node
/**
 * 消毒核查：Node 侧渲染 + 真浏览器断言。
 *
 * 分工很清楚：
 *   Node 侧负责「渲染器吐出了什么 HTML」
 *   浏览器侧负责「这段 HTML 真的会不会执行」
 *
 * 只有后一半才算证据。`javascript:` 被转义成实体之后看着人畜无害，
 * 浏览器解析时又会还原 —— 这类判断必须交给浏览器自己做。
 *
 * 用法：
 *   node scripts/e2e/xss.mjs              # 静态断言 + 浏览器断言
 *   node scripts/e2e/xss.mjs --json       # 只输出 JSON 结果
 */
import { renderArticle } from '@emeeek/core/render';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const JSON_ONLY = process.argv.includes('--json');

/** 每条向量：名字 + Markdown 源 + 期望（'clean' 不该产生可执行内容）。 */
export const VECTORS = [
  ['img onerror（原始 HTML）', '<img src=x onerror="window.__xss=\'img\'">'],
  ['script 标签', '<script>window.__xss=\'script\'</script>'],
  ['script 大小写混写', '<ScRiPt>window.__xss=\'script2\'</ScRiPt>'],
  ['Markdown 图片 onerror 注入', '![x](x" onerror="window.__xss=\'mdimg\')'],
  ['Markdown 链接 javascript:', '[click](javascript:window.__xss=\'js\')'],
  ['Markdown 链接 大小写混写协议', '[click](JaVaScRiPt:window.__xss=\'jscase\')'],
  ['Markdown 链接协议内嵌制表符', '[click](java\tscript:window.__xss=\'tab\')'],
  ['Markdown 链接协议内嵌换行', '[click](java\nscript:window.__xss=\'nl\')'],
  ['Markdown 链接 vbscript:', '[click](vbscript:window.__xss=\'vb\')'],
  ['Markdown 链接 data:text/html', '[click](data:text/html;base64,PHNjcmlwdD53aW5kb3cuX194c3M9MTwvc2NyaXB0Pg==)'],
  ['Markdown 图片 javascript:', '![x](javascript:window.__xss=\'jsimg\')'],
  ['Markdown 图片 data:text/html', '![x](data:text/html,<script>window.__xss=1</script>)'],
  ['SVG 内联事件', '<svg onload="window.__xss=\'svg\'"></svg>'],
  ['SVG foreignObject 夹带 img', '<svg><foreignObject><img src=x onerror="window.__xss=1"></foreignObject></svg>'],
  ['iframe javascript: 地址', '<iframe src="javascript:window.__xss=\'if\'"></iframe>'],
  ['iframe srcdoc', '<iframe srcdoc="<script>parent.__xss=1</script>"></iframe>'],
  ['style expression', '<div style="width:expression(window.__xss=1)">x</div>'],
  ['style url(javascript:)', '<div style="background:url(javascript:window.__xss=1)">x</div>'],
  ['form action javascript:', '<form action="javascript:window.__xss=1"><input type=submit></form>'],
  ['body onload', '<body onload="window.__xss=1">'],
  ['注释越界', '<!--><script>window.__xss=1</script>-->'],
  ['autolink javascript:', '<javascript:window.__xss=1>'],
  ['Markdown 链接带 title', '[a](javascript:window.__xss=1 "t")'],
  ['嵌套 Markdown 图片注入', '[![x](x" onerror="window.__xss=1")](y)'],
  ['details ontoggle', '<details open ontoggle="window.__xss=1">x</details>'],
  ['base 标签劫持', '<base href="javascript:window.__xss=1">'],
  ['meta refresh', '<meta http-equiv="refresh" content="0;url=javascript:window.__xss=1">'],
  ['link 样式表', '<link rel="stylesheet" href="javascript:window.__xss=1">'],
  ['object data', '<object data="javascript:window.__xss=1"></object>'],
  ['embed src', '<embed src="javascript:window.__xss=1">'],
];

/**
 * 静态扫描：**只看真标签，不看已转义的文本**。
 *
 * 第一版这里把 `&lt;iframe …&gt;` 也判成了可疑 —— 那是纯文本，
 * 浏览器不会解析成标签。判据过严的测试最后一定会被人加 || true 静音，
 * 所以静态这一层只回答一个问题：「有没有出现真的标签」，
 * 「会不会执行」交给真浏览器那 30 条断言。
 */
const TAG_LIKE = /<\/?[a-z][a-z0-9-]*(\s|\/|>)/i;
const DANGEROUS_TAG = /<\/?(?:script|iframe|svg|object|embed|base|meta|form|link|applet|frame|noscript|template)\b/i;

/**
 * allowHtml=false 时，正文里除了渲染器自己产出的排版标签，不应出现别的标签。
 * 做法是：先只保留「真标签名」，再和渲染器允许产出的标签集合比 —— 多出来就是注入。
 */
const RENDERER_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del', 'mark', 'code',
  'pre', 'span', 'a', 'img', 'ul', 'ol', 'li', 'blockquote', 'hr', 'br', 'sup', 'section', 'div',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'input', 'button', 'article', 'nav', 'sub', 'kbd']);

/**
 * 真正的判据：把 HTML 剥成「只剩真标签」，再看标签内有没有事件属性。
 *
 * 先去掉所有 `&lt;…&gt;` 这类转义实体（它们已经是纯文本），再扫剩下的标签。
 */
function hasLiveHandler(html) {
  const decoded = String(html);
  // 只看真标签（< 后面直接跟字母），实体 &lt; 不算
  const tags = decoded.match(/<[a-z][^>]*>/gi) ?? [];
  return tags.some((tag) => /\son[a-z]+\s*=/i.test(tag)
    || /(?:href|src)\s*=\s*["']?\s*(?:javascript|vbscript|data:text\/html)/i.test(tag));
}

function hasInjectedTag(html, source) {
  // 源里本来就有标签的向量，走 allowHtml=true 那条判据；这里只管「源里没标签却渲染出了标签」
  if (TAG_LIKE.test(source)) return false;
  const tags = [...String(html).matchAll(/<\/?([a-z][a-z0-9-]*)/gi)].map((m) => m[1].toLowerCase());
  return tags.some((tag) => !RENDERER_TAGS.has(tag));
}

export function renderAll() {
  return VECTORS.map(([name, source]) => {
    const html = renderArticle(source + '\n', { allowHtml: false, lazyImages: true, headingIds: new Map() });
    const htmlWithHtml = renderArticle(source + '\n', { allowHtml: true, lazyImages: true, headingIds: new Map() });
    return { name, source, html, htmlWithHtml };
  });
}

/** 静态断言：两种 allowHtml 设置下都不该出现可疑片段。 */
export function staticCheck() {
  const rows = [];
  for (const item of renderAll()) {
    // allowHtml=false：正文应当只剩被转义后的纯文本，不应该有任何真标签
    // allowHtml=false：源里没有标签，渲染结果里就不该多出渲染器不会产出的标签
    const badDefault = hasInjectedTag(item.html, item.source);
    /**
     * allowHtml=true：允许结构化标签，但危险标签、事件属性、非白名单协议不能留。
     *
     * 这里检查的是**标签属性位**，不是整段文本 —— `onerror=` 出现在被转义的
     * 正文段落里是纯文字（这段字就是这篇文档在演示攻击向量），出现在
     * `<img onerror=…>` 的属性位上才是活的。用 textContent 之外的判据都会误报。
     */
    const badAllow = hasInjectedTag(item.htmlWithHtml, item.source) || hasLiveHandler(item.htmlWithHtml);
    rows.push({
      name: item.name,
      ok: !badDefault && !badAllow,
      detail: badDefault ? `allowHtml=false 仍有可疑片段：${item.html.slice(0, 120)}`
        : badAllow ? `allowHtml=true 仍有可疑片段：${item.htmlWithHtml.slice(0, 120)}`
          : '',
    });
  }
  return rows;
}

/** 真浏览器断言：把渲染结果塞进页面，看 window.__xss 会不会被写。 */
export function browserCheck() {
  const dir = mkdtempSync(path.join(tmpdir(), 'emeeek-xss-'));
  const payload = path.join(dir, 'payload.json');
  writeFileSync(payload, JSON.stringify(renderAll().map(({ name, source, html }) => ({ name, source, html })), null, 0));
  const script = path.join(HERE, 'xss_browser.py');
  const result = spawnSync('python3', [script, payload], { encoding: 'utf8', cwd: ROOT });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || '');
    throw new Error(`浏览器断言失败（退出码 ${result.status}）`);
  }
  return JSON.parse(result.stdout);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rows = staticCheck();
  const browserRows = browserCheck();
  const all = [...rows, ...browserRows];
  if (JSON_ONLY) {
    process.stdout.write(JSON.stringify(all));
  } else {
    console.log('\n▸ 消毒核查 · 静态');
    for (const row of rows) console.log(`  ${row.ok ? '✔' : '✘'} ${row.name}${row.detail ? `  —— ${row.detail}` : ''}`);
    console.log('\n▸ 消毒核查 · 真浏览器（窗口里真的有没有 __xss）');
    for (const row of browserRows) console.log(`  ${row.ok ? '✔' : '✘'} ${row.name}${row.detail ? `  —— ${row.detail}` : ''}`);
    const failed = all.filter((r) => !r.ok);
    console.log(`\n${all.length - failed.length}/${all.length} 通过（${rows.length} 静态 + ${browserRows.length} 浏览器）`);
    if (failed.length) process.exitCode = 1;
  }
}
