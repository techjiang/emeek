import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildToc, addAnchorLinks, stripTags } from '../src/pipeline/transform/toc.js';
import { makeExcerpt, readingTime, countWords } from '../src/pipeline/transform/excerpt.js';
import { buildWikiLinkIndex, resolveWikiLink, computeBacklinks, extractWikiTargets } from '../src/pipeline/transform/links.js';
import { decorateImages, createImageResolver, deriveAlt } from '../src/pipeline/transform/images.js';
import { buildSitemap, buildRss, buildRobots, buildSearchIndex, truncate, absolutize } from '../src/pipeline/transform/seo.js';

test('从 HTML 抽取目录，跳过一级标题', () => {
  const html = '<h1 id="a">A</h1><h2 id="b">B</h2><h3 id="c">C</h3>';
  const toc = buildToc(html);
  assert.deepEqual(toc.map((t) => t.id), ['b', 'c']);
});

test('addAnchorLinks 的锚点文字不进目录', () => {
  const decorated = '<h2 id="x">标题</h2>';
  const toc = buildToc(decorated);
  const withAnchors = addAnchorLinks(decorated);
  assert.match(withAnchors, /<a class="anchor" href="#x"/);
  // 目录必须先于锚点生成，否则这里会变成 “标题#”。
  assert.equal(toc[0].text, '标题');
});

test('stripTags 折叠空白', () => {
  assert.equal(stripTags('<p>a <b>b</b>\n c</p>'), 'a b c');
});

test('countWords 中英文混排', () => {
  assert.equal(countWords('你好世界'), 4);
  assert.equal(countWords('hello world'), 2);
  assert.equal(countWords('你好 world'), 3);
});

test('readingTime 至少返回 1 分钟', () => {
  assert.equal(readingTime('短'), 1);
  assert.ok(readingTime('字'.repeat(1500)) >= 3);
});

test('makeExcerpt 跳过代码块，取第一个段落', () => {
  const html = '<div class="code-block"><pre>code</pre></div><p>这是真正的摘要内容，足够长。</p>';
  assert.match(makeExcerpt(html), /这是真正的摘要内容/);
});

test('makeExcerpt 超长时截断并加省略号', () => {
  const excerpt = makeExcerpt(`<p>${'啊'.repeat(500)}</p>`, 100);
  assert.ok(excerpt.length <= 101);
  assert.ok(excerpt.endsWith('…'));
});

test('wiki 链接命中时生成真实链接', () => {
  const posts = [{ title: '目标文章', slug: 'target' }];
  const index = buildWikiLinkIndex(posts, { urlPattern: (p) => `/posts/${p.slug}.html` });
  const html = resolveWikiLink(index, '目标文章', '别名');
  assert.match(html, /<a class="wiki-link" href="\/posts\/target.html"/);
  assert.match(html, />别名</);
});

test('wiki 链接未命中时降级为带提示的文本', () => {
  const index = buildWikiLinkIndex([], {});
  const html = resolveWikiLink(index, '不存在的文章');
  assert.match(html, /wiki-link--missing/);
  assert.match(html, /未找到文章/);
});

test('wiki 链接按 slug 也能命中', () => {
  const index = buildWikiLinkIndex([{ title: '标题', slug: 'the-slug' }], { urlPattern: (p) => p.slug });
  assert.match(resolveWikiLink(index, 'The-Slug'), /<a class="wiki-link"/);
});

test('反向引用忽略代码块与行内代码', () => {
  assert.deepEqual(extractWikiTargets('看 [[真链接]]'), ['真链接']);
  assert.deepEqual(extractWikiTargets('`[[示例]]`'), []);
  assert.deepEqual(extractWikiTargets('```\n[[示例]]\n```'), []);
});

test('computeBacklinks 统计被引用次数与来源', () => {
  const posts = [
    { title: 'A', slug: 'a', raw: '看 [[B]]' },
    { title: 'B', slug: 'b', raw: '' },
  ];
  computeBacklinks(posts);
  assert.equal(posts[1].backlinks, 1);
  assert.deepEqual(posts[1].backlinkSources, ['a']);
  assert.equal(posts[0].backlinks, 0);
});

test('图片地址归一化：外链原样、站内补域名', () => {
  const resolve = createImageResolver({ baseUrl: 'https://a.com/', assetBase: '/assets' });
  assert.equal(resolve('https://cdn.com/x.png'), 'https://cdn.com/x.png');
  assert.equal(resolve('/assets/x.png'), 'https://a.com/assets/x.png');
  assert.equal(resolve('img/x.png'), 'https://a.com/img/x.png');
});

test('decorateImages：首屏图 eager，其余懒加载', () => {
  // 第一张图给 eager + fetchpriority=high：它通常就是 LCP 那张，
  // 给它 loading="lazy" 会让「最快内容绘制」反而更慢。
  const one = decorateImages('<img src="a.png" />');
  assert.match(one, /loading="eager"/);
  assert.match(one, /fetchpriority="high"/);
  assert.match(one, /decoding="async"/);

  const many = decorateImages('<img src="a.png" /><img src="b.png" /><img src="c.png" />');
  const lazy = many.match(/loading="lazy"/g) ?? [];
  assert.equal(lazy.length, 2, '首屏之外的两张图应懒加载');
  assert.equal((many.match(/fetchpriority="high"/g) ?? []).length, 1, '只有首屏图提优先级');
});

test('decorateImages：alt 从文件名推导，并标记为推导值', () => {
  const html = decorateImages('<img src="/assets/cover-photo.jpg" />');
  assert.match(html, /alt="cover photo"/);
  // data-alt-inferred 让 SEO 自检能区分「作者写的」与「引擎猜的」——
  // 悄悄替作者编 alt 再自己给自己打勾，是自欺。
  assert.match(html, /data-alt-inferred="true"/);
});

test('decorateImages：空 alt 必须被兜底替换 —— `![]()` 不是「作者写过了」', () => {
  // Markdown 渲染器对 `![](...)` 会写出 alt=""，而空 alt 让图片对
  // 屏幕阅读器与图片搜索**完全消失**。
  // 只判断「有没有 alt 属性」会把这个空串当成作者的决定，
  // 兜底永远不触发 —— 这是最初真实存在的缺陷。
  const html = decorateImages('<img src="/assets/my-photo.png" alt="" />');
  assert.doesNotMatch(html, /alt=""/);
  assert.match(html, /alt="my photo"/);
  assert.match(html, /data-alt-inferred="true"/);
});

test('decorateImages：仅空白的 alt 也算没写', () => {
  const html = decorateImages('<img src="/assets/x.png" alt="   " />');
  assert.doesNotMatch(html, /alt="   "/);
  assert.match(html, /alt="x"/);
});

test('decorateImages：作者写了 alt 就完全不动它', () => {
  const html = decorateImages('<img src="x.png" alt="作者写的说明" />');
  assert.match(html, /alt="作者写的说明"/);
  assert.doesNotMatch(html, /data-alt-inferred/);
});

test('deriveAlt 从地址推导可读文本', () => {
  assert.equal(deriveAlt('src="/a/b/design-notes_v2.png"'), 'design notes v2');
  assert.equal(deriveAlt('src="https://x.com/%E4%B8%AD%E6%96%87.png"'), '中文');
  assert.equal(deriveAlt(''), '');
});

test('sitemap 包含全部条目与最后修改时间', () => {
  const xml = buildSitemap({ url: 'https://a.com' }, [{ url: 'https://a.com/', priority: '1.0' }, { url: 'https://a.com/p.html', lastmod: '2024-01-01' }]);
  assert.match(xml, /<loc>https:\/\/a.com\/<\/loc>/);
  assert.match(xml, /<lastmod>2024-01-01<\/lastmod>/);
});

test('RSS 按 limit 截断并转义标题', () => {
  const posts = Array.from({ length: 5 }, (_, i) => ({ title: `文章 ${i} & 更多`, url: `/p${i}.html`, date: '2024-01-01', description: 'd', tags: ['t'] }));
  const xml = buildRss({ url: 'https://a.com', title: 'T', description: 'D', language: 'zh-CN' }, posts, { limit: 3 });
  assert.equal((xml.match(/<item>/g) ?? []).length, 3);
  assert.match(xml, /文章 0 &amp; 更多/);
});

test('robots 指向 sitemap', () => {
  assert.match(buildRobots({ url: 'https://a.com' }), /Sitemap: https:\/\/a.com\/sitemap.xml/);
});

test('搜索索引剔除 HTML 标签', () => {
  const index = buildSearchIndex([{ slug: 'a', title: 'T', url: '/a', tags: [], date: '2024-01-01', html: '<p>正文</p>' }]);
  assert.equal(index[0].body, '正文');
});

test('truncate 与 absolutize', () => {
  assert.equal(truncate('a'.repeat(10), 5), 'aaaa…');
  assert.equal(absolutize('https://a.com/', '/x.png'), 'https://a.com/x.png');
  assert.equal(absolutize('https://a.com', 'https://b.com/y'), 'https://b.com/y');
});
