import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSitemap, buildSitemapIndex, planSitemapShards, buildRobots, SITEMAP_URL_LIMIT, SITEMAP_POLICY,
} from '../../src/pipeline/transform/seo.js';

const SITE = { url: 'https://emeeek.example.com' };

test('sitemap 是合法 XML 结构（声明 + 命名空间 + urlset）', () => {
  const xml = buildSitemap(SITE, [{ url: 'https://emeeek.example.com/', priority: '1.0', changefreq: 'daily' }]);
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.match(xml, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  assert.ok(xml.endsWith('</urlset>\n'));
});

test('url 子元素按 XSD 的 sequence 顺序输出', () => {
  // sitemaps.org 的 XSD 是 sequence，顺序错了整份 sitemap 无效 ——
  // 而浏览器打开它看起来完全正常。
  const xml = buildSitemap(SITE, [{ url: 'https://x/p', lastmod: '2024-01-01', changefreq: 'monthly', priority: '0.8' }]);
  const body = /<url>([\s\S]*?)<\/url>/.exec(xml)[1];
  const order = ['<lastmod>', '<changefreq>', '<priority>', '<loc>'].map((t) => body.indexOf(t));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test('缺省字段不输出空元素', () => {
  const xml = buildSitemap(SITE, [{ url: 'https://x/p' }]);
  assert.doesNotMatch(xml, /<lastmod><\/lastmod>/);
  assert.doesNotMatch(xml, /<priority><\/priority>/);
});

test('loc 里的 & 与 < 会被转义（否则整份 XML 坏掉）', () => {
  const xml = buildSitemap(SITE, [{ url: 'https://x/a?b=1&c=2' }]);
  assert.match(xml, /a\?b=1&amp;c=2/);
  assert.doesNotMatch(xml, /[^&]&[^a]/);
});

test('超过 50000 条时拆成分片 + sitemap-index', () => {
  const many = Array.from({ length: SITEMAP_URL_LIMIT + 10 }, (_, i) => ({ url: `https://x/p${i}` }));
  const shards = planSitemapShards(many);
  assert.equal(shards.length, 2);
  assert.equal(shards[0].entries.length, SITEMAP_URL_LIMIT);
  assert.equal(shards[1].entries.length, 10);

  const index = buildSitemapIndex(SITE, shards);
  assert.match(index, /<sitemapindex xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  assert.equal((index.match(/<sitemap>/g) ?? []).length, 2);
  assert.match(index, /https:\/\/emeeek\.example\.com\/sitemap-1\.xml/);

  // 未超限时不拆 —— 不经思考地永远输出 index 会让搜索引擎多一跳。
  assert.equal(planSitemapShards(many.slice(0, 10)), null);
});

test('SITEMAP_POLICY 覆盖四档且 priority 都是合法值', () => {
  for (const [kind, policy] of Object.entries(SITEMAP_POLICY)) {
    assert.match(policy.priority, /^[01]\.\d$/, `${kind} 的 priority 格式非法`);
    assert.ok(['always', 'hourly', 'daily', 'weekly', 'monthly', 'yearly', 'never'].includes(policy.changefreq), `${kind} 的 changefreq 非法`);
  }
  assert.equal(SITEMAP_POLICY.home.priority, '1.0');
  assert.equal(SITEMAP_POLICY.post.priority, '0.8');
});

test('robots 屏蔽搜索页与查询参数', () => {
  const text = buildRobots(SITE);
  assert.match(text, /^User-agent: \*$/m);
  assert.match(text, /^Allow: \/$/m);
  assert.match(text, /^Disallow: \/search\/$/m);
  assert.match(text, /^Disallow: \/\*\?q=$/m);
  assert.match(text, /^Disallow: \/\*\?page=$/m);
  assert.match(text, /^Sitemap: https:\/\/emeeek\.example\.com\/sitemap\.xml$/m);
});

test('robots 支持追加规则，但内置屏蔽不可取消', () => {
  const text = buildRobots(SITE, { disable: ['/drafts/', '/private/'] });
  assert.match(text, /^Disallow: \/drafts\/$/m);
  assert.match(text, /^Disallow: \/private\/$/m);
  // 关键：即使调用方传了规则，搜索页仍然被屏蔽 ——
  // 允许收录搜索页会产生「重复内容」，那不是偏好问题。
  assert.match(text, /^Disallow: \/search\/$/m);
});

test('robots 支持自定义爬虫段', () => {
  const text = buildRobots(SITE, {
    custom: [{ userAgent: 'BadBot', disallow: ['/'] }, { userAgent: 'GoodBot', allow: ['/'] }],
  });
  assert.match(text, /User-agent: BadBot\nDisallow: \//);
  assert.match(text, /User-agent: GoodBot\nAllow: \//);
});

test('robots 里 sitemap 地址不会出现双斜杠', () => {
  const text = buildRobots({ url: 'https://x.com/' });
  assert.match(text, /Sitemap: https:\/\/x\.com\/sitemap\.xml/);
  assert.doesNotMatch(text, /\.com\/\/sitemap/);
});
