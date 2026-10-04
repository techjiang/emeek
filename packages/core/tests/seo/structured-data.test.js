import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStructuredData, buildBreadcrumbJsonLd, renderJsonLd, jsonLdSafe,
  buildSeoView, renderSeoTags,
} from '../../src/pipeline/transform/seo.js';

const SITE = {
  title: 'Emeek 演示站',
  description: '用 Markdown 写文章',
  url: 'https://emeeek.example.com',
  author: 'Emeek Demo',
  language: 'zh-CN',
};

function post(overrides = {}) {
  return {
    title: '为什么选择 Emeek',
    description: 'Emeek 是一个博客引擎',
    date: '2024-01-15T08:00:00.000Z',
    updated: '2024-01-16T10:00:00.000Z',
    tags: ['博客', '引擎'],
    ...overrides,
  };
}

test('文章页产出 BlogPosting，含富媒体所需的全部字段', () => {
  const data = buildStructuredData({
    kind: 'blogpost',
    site: SITE,
    url: 'https://emeeek.example.com/posts/why-emeeek.html',
    post: post(),
    authorUrl: 'https://docs.asoe.cn',
  });
  const node = data['@graph'][0];
  assert.equal(node['@type'], 'BlogPosting');
  assert.equal(node.headline, '为什么选择 Emeek');
  assert.equal(node.datePublished, '2024-01-15T08:00:00.000Z');
  assert.equal(node.dateModified, '2024-01-16T10:00:00.000Z');
  assert.equal(node.author.name, 'Emeek Demo');
  assert.equal(node.author.url, 'https://docs.asoe.cn');
  assert.equal(node.mainEntityOfPage['@id'], 'https://emeeek.example.com/posts/why-emeeek.html');
  assert.equal(node.keywords, '博客, 引擎');
  assert.equal(node.inLanguage, 'zh-CN');
});

test('没有封面图时不输出 image —— 不编造字段', () => {
  const withCover = buildStructuredData({ kind: 'blogpost', site: SITE, url: 'https://x/p/', post: post({ cover: '/assets/c.jpg' }) });
  assert.equal(withCover['@graph'][0].image, 'https://emeeek.example.com/assets/c.jpg');

  const noCover = buildStructuredData({ kind: 'blogpost', site: SITE, url: 'https://x/p/', post: post() });
  assert.ok(!('image' in noCover['@graph'][0]));
});

test('站点没有 logo 时 publisher 不带空 logo 节点', () => {
  const data = buildStructuredData({ kind: 'blogpost', site: SITE, url: 'https://x/p/', post: post() });
  const publisher = data['@graph'][0].publisher;
  assert.equal(publisher['@type'], 'Organization');
  assert.ok(!('logo' in publisher), 'logo 缺失时不该输出空 url —— 校验器会报错');
});

test('首页产出 Blog，标签页产出 CollectionPage，关于页产出 AboutPage', () => {
  assert.equal(buildStructuredData({ kind: 'blog', site: SITE, url: 'https://x/' })['@graph'][0]['@type'], 'Blog');
  assert.equal(buildStructuredData({ kind: 'collection', site: SITE, url: 'https://x/tags/a.html', page: { title: '标签：主题' } })['@graph'][0]['@type'], 'CollectionPage');
  assert.equal(buildStructuredData({ kind: 'about', site: SITE, url: 'https://x/about.html', page: { title: '关于' } })['@graph'][0]['@type'], 'AboutPage');
});

test('未知 kind 退到 WebPage，而不是硬套一个错的 @type', () => {
  assert.equal(buildStructuredData({ kind: 'nonsense', site: SITE, url: 'https://x/' })['@graph'][0]['@type'], 'WebPage');
  assert.equal(buildStructuredData({ site: SITE, url: 'https://x/' })['@graph'][0]['@type'], 'WebPage');
});

test('面包屑 position 从 1 递增，且只有一项时不输出', () => {
  const crumbs = [
    { name: '首页', url: 'https://x/' },
    { name: '归档', url: 'https://x/archive.html' },
    { name: '文章', url: 'https://x/p.html' },
  ];
  const ld = buildBreadcrumbJsonLd(crumbs);
  assert.equal(ld.itemListElement.length, 3);
  assert.deepEqual(ld.itemListElement.map((i) => i.position), [1, 2, 3]);

  const data = buildStructuredData({ kind: 'blogpost', site: SITE, url: 'https://x/p.html', post: post(), breadcrumbs: crumbs });
  assert.equal(data['@graph'].length, 2, 'BlogPosting + BreadcrumbList');
  assert.equal(data['@graph'][1]['@type'], 'BreadcrumbList');

  const noCrumbs = buildStructuredData({ kind: 'blogpost', site: SITE, url: 'https://x/p.html', post: post(), breadcrumbs: [] });
  assert.equal(noCrumbs['@graph'].length, 1);
});

test('JSON-LD 里的 </script 不会提前闭合标签', () => {
  // 标题里带 </script> 是真实场景：写「如何防 XSS」的文章正文里就有。
  const data = buildStructuredData({
    kind: 'blogpost',
    site: SITE,
    url: 'https://x/p.html',
    post: post({ title: '如何防 </script><img src=x onerror=alert(1)>' }),
  });
  const html = renderJsonLd(data);
  assert.equal((html.match(/<\/script>/g) ?? []).length, 1, '只有一个 </script>');
  assert.match(html, /\\u003c\/script/);
  // 关键：转义后仍然是合法 JSON。
  const body = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)[1];
  const parsed = JSON.parse(body);
  assert.equal(parsed['@graph'][0].headline, '如何防 </script><img src=x onerror=alert(1)>');
});

test('jsonLdSafe 处理 U+2028 / U+2029（JS 里是换行，会打断解析）', () => {
  const out = jsonLdSafe({ text: 'a\u2028b\u2029c' });
  assert.doesNotMatch(out, /[\u2028\u2029]/);
  assert.equal(JSON.parse(out).text, 'a\u2028b\u2029c');
});

test('jsonLdSafe 与 JSON.stringify 语义一致（只有危险序列被转义）', () => {
  const value = { 'a"b': '<x>', arr: [1, null, true], nested: { c: '&' } };
  assert.deepEqual(JSON.parse(jsonLdSafe(value)), value);
});
