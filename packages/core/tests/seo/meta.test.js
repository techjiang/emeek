import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSeoView, renderSeoTags, absolutize } from '../../src/pipeline/transform/seo.js';

const SITE = { title: 'Emeek 演示站', description: '站点描述', url: 'https://emeeek.example.com', language: 'zh-CN' };

/** 从一段标签 HTML 里抠出 meta 的 content。 */
function meta(html, key) {
  const m = new RegExp(`(?:property|name)="${key}" content="([^"]*)"`).exec(html);
  return m ? m[1] : null;
}

test('标题带站点名，首页用站点标题不重复拼接', () => {
  const home = renderSeoTags(buildSeoView({ site: SITE, page: { title: null, type: 'home' }, canonical: 'https://x/' }));
  assert.match(home, /<title>Emeek 演示站<\/title>/);

  const article = renderSeoTags(buildSeoView({ site: SITE, page: { title: '一篇文章', type: 'article' }, canonical: 'https://x/p.html' }));
  assert.match(article, /<title>一篇文章 · Emeek 演示站<\/title>/);
});

test('OG 六项基础标签齐备且各一个', () => {
  const html = renderSeoTags(buildSeoView({ site: SITE, page: { title: 'T', description: 'D', type: 'article' }, canonical: 'https://x/p' }));
  for (const key of ['og:type', 'og:title', 'og:description', 'og:url', 'og:site_name', 'og:locale']) {
    assert.equal((html.match(new RegExp(`property="${key}"`, 'g')) ?? []).length, 1, key);
  }
  assert.equal(meta(html, 'og:type'), 'article');
  assert.equal(meta(html, 'og:locale'), 'zh_CN', 'locale 用下划线形式');
});

test('首页 og:type 是 website，不是 article', () => {
  const html = renderSeoTags(buildSeoView({ site: SITE, page: { title: null, type: 'home' }, canonical: 'https://x/' }));
  assert.equal(meta(html, 'og:type'), 'website');
  assert.doesNotMatch(html, /article:published_time/, 'website 不该有 article:* 标签');
});

test('文章页输出 article:published_time / modified_time / tag', () => {
  const html = renderSeoTags(buildSeoView({
    site: SITE,
    page: {
      title: 'T', type: 'article',
      publishedTime: '2024-01-15T08:00:00Z',
      modifiedTime: '2024-01-16T10:00:00Z',
      articleTags: ['博客', '引擎'],
    },
    canonical: 'https://x/p',
  }));
  assert.equal(meta(html, 'article:published_time'), '2024-01-15T08:00:00Z');
  assert.equal(meta(html, 'article:modified_time'), '2024-01-16T10:00:00Z');
  assert.equal((html.match(/property="article:tag"/g) ?? []).length, 2);
});

test('有图时 twitter:card 用大图，无图时用 summary', () => {
  const withImg = renderSeoTags(buildSeoView({ site: SITE, page: { title: 'T', type: 'article', image: '/a.jpg' }, canonical: 'https://x/p' }));
  assert.equal(meta(withImg, 'twitter:card'), 'summary_large_image');
  assert.equal(meta(withImg, 'og:image'), 'https://emeeek.example.com/a.jpg');
  assert.equal(meta(withImg, 'twitter:image'), 'https://emeeek.example.com/a.jpg');

  const noImg = renderSeoTags(buildSeoView({ site: SITE, page: { title: 'T', type: 'article' }, canonical: 'https://x/p' }));
  assert.equal(meta(noImg, 'twitter:card'), 'summary');
  // summary 卡片没有图时不能输出空的 og:image —— 部分平台会抓到一张白图。
  assert.equal(meta(noImg, 'og:image'), null);
});

test('noindex 页面输出 robots noindex, follow', () => {
  const html = renderSeoTags(buildSeoView({ site: SITE, page: { title: '404', type: 'website', noindex: true }, canonical: 'https://x/404.html' }));
  assert.equal(meta(html, 'robots'), 'noindex, follow');
  const normal = renderSeoTags(buildSeoView({ site: SITE, page: { title: 'T', type: 'website' }, canonical: 'https://x/a.html' }));
  assert.equal(meta(normal, 'robots'), null);
});

test('分页 rel=prev / rel=next 用绝对地址', () => {
  const html = renderSeoTags(buildSeoView({
    site: SITE,
    page: { title: null, type: 'home' },
    canonical: 'https://x/page/2.html',
    prev: 'https://x/',
    next: 'https://x/page/3.html',
  }));
  assert.match(html, /<link rel="prev" href="https:\/\/x\/" \/>/);
  assert.match(html, /<link rel="next" href="https:\/\/x\/page\/3\.html" \/>/);
});

test('description 超长会被截断，且不含 HTML', () => {
  const view = buildSeoView({
    site: SITE,
    page: { title: 'T', description: `<p>${'啊'.repeat(500)}</p>`, type: 'article' },
    canonical: 'https://x/p',
  });
  assert.ok(view.description.length <= 200);
  assert.doesNotMatch(view.description, /<[a-z/]/i);
});

test('标签内容会被 HTML 转义（标题里的引号不会破坏属性）', () => {
  const html = renderSeoTags(buildSeoView({
    site: SITE,
    page: { title: '带 "引号" 与 <尖括号> 的标题', type: 'article' },
    canonical: 'https://x/p',
  }));
  assert.doesNotMatch(html, /content="[^"]*"[^>]*"[^"]*"/, '属性里不应出现裸引号');
  assert.match(html, /&quot;引号&quot;/);
  assert.match(html, /&lt;尖括号&gt;/);
});

test('absolute 地址不会再拼一次域名', () => {
  assert.equal(absolutize('https://a.com', 'https://b.com/x.png'), 'https://b.com/x.png');
  assert.equal(absolutize('https://a.com/', '/x.png'), 'https://a.com/x.png');
  assert.equal(absolutize('https://a.com', 'x.png'), 'https://a.com/x.png');
});
