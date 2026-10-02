import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, escapeHtml } from '../src/pipeline/parse/markdown.js';

test('渲染标题并生成锚点 id', () => {
  const html = renderMarkdown('# 你好 世界');
  assert.match(html, /<h1 id="你好-世界">你好 世界<\/h1>/);
});

test('重复标题的锚点 id 保持唯一', () => {
  const html = renderMarkdown('# 标题\n\n# 标题');
  assert.match(html, /id="标题"/);
  assert.match(html, /id="标题-2"/);
});

test('粗体、斜体、行内代码', () => {
  const html = renderMarkdown('**粗** *斜* `code` ~~删~~ ==高亮==');
  assert.match(html, /<strong>粗<\/strong>/);
  assert.match(html, /<em>斜<\/em>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<del>删<\/del>/);
  assert.match(html, /<mark>高亮<\/mark>/);
});

test('HTML 默认被转义，防止内容注入', () => {
  const html = renderMarkdown('<script>alert(1)</script>');
  assert.ok(!html.includes('<script>'), '不应输出原始 script 标签');
  assert.match(html, /&lt;script&gt;/);
});

test('allowHtml 打开后保留原标签', () => {
  const html = renderMarkdown('<div class="x">ok</div>', { allowHtml: true });
  assert.match(html, /<div class="x">ok<\/div>/);
});

test('代码块内的高亮不会破坏缩进', () => {
  const html = renderMarkdown('```js\n  const a = 1;\n```');
  assert.match(html, /tok-keyword">const</);
  assert.ok(html.includes('  <span'), '代码块内的前导空格应保留');
});

test('表格带对齐声明', () => {
  const html = renderMarkdown('| A | B |\n| :-- | --: |\n| 1 | 2 |');
  assert.match(html, /<th style="text-align:left">A<\/th>/);
  assert.match(html, /<th style="text-align:right">B<\/th>/);
  assert.match(html, /<td style="text-align:right">2<\/td>/);
});

test('任务列表渲染为禁用复选框', () => {
  const html = renderMarkdown('- [x] 完成\n- [ ] 待办');
  assert.match(html, /<input type="checkbox" disabled checked aria-label="已完成" \/> 完成/);
  assert.match(html, /<input type="checkbox" disabled aria-label="未完成" \/> 待办/);
});

test('嵌套列表保持层级', () => {
  const html = renderMarkdown('- 外层\n  - 内层');
  assert.match(html, /外层/);
  // 内层列表必须嵌在外层 <li> 之内，而不是被压平成兄弟节点。
  const outer = /<li>(?:(?!<\/li>)[\s\S])*?<ul>\s*<li>内层<\/li>\s*<\/ul>\s*<\/li>/.test(html);
  assert.ok(outer, `内层列表应嵌套在外层 li 中，实际输出：\n${html}`);
});

test('脚注生成引用与回跳', () => {
  const html = renderMarkdown('正文[^1]\n\n[^1]: 说明');
  assert.match(html, /class="footnote-ref"/);
  assert.match(html, /class="footnote-back"/);
  assert.match(html, /<li id="[^"]+-fn-1">说明/);
});

test('脚注按引用顺序排列', () => {
  const html = renderMarkdown('先[^b]后[^a]\n\n[^a]: A\n[^b]: B');
  const first = html.indexOf('B</li>') !== -1 ? 'B' : 'A';
  assert.ok(html.indexOf(`>B <a`) < html.indexOf(`>A <a`), `脚注顺序应为 B 在前，实际：${html}`);
});

test('引用块与分隔线', () => {
  const html = renderMarkdown('> 引用\n\n---');
  assert.match(html, /<blockquote>[\s\S]*<p>引用<\/p>[\s\S]*<\/blockquote>/);
  assert.match(html, /<hr \/>/);
});

test('图片带上懒加载与转义后的 alt', () => {
  const html = renderMarkdown('![描述 "引号"](/a.png)');
  assert.match(html, /loading="lazy"/);
  assert.match(html, /alt="描述 &quot;引号&quot;"/);
});

test('相对图片地址经 resolveImage 归一化', () => {
  const html = renderMarkdown('![](./img/a.png)', { resolveImage: (u) => `https://cdn.example.com${u.replace('./', '/')}` });
  assert.match(html, /src="https:\/\/cdn.example.com\/img\/a.png"/);
});

test('escapeHtml 覆盖五个危险字符', () => {
  assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
});

test('未闭合的代码块不会吞掉后续内容', () => {
  const html = renderMarkdown('```js\nconst a = 1;');
  assert.match(html, /const/);
});
