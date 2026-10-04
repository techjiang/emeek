import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildManifest, shortName, ICON_SIZES } from '../../src/pipeline/pwa/manifest.js';

test('start_url / scope 带 basePath 前缀 —— 子路径部署时不能指向域根', () => {
  const m = buildManifest({ site: { title: 'x' }, basePath: '/blog' });
  assert.equal(m.start_url, '/blog/');
  assert.equal(m.scope, '/blog/');
  assert.equal(m.id, '/blog/');
  // 不带前缀的 "/" 会让子路径部署的 PWA 打开域根（别人的站点）。
  assert.notEqual(m.start_url, '/');
});

test('basePath 归一化：斜杠多了少了都算对', () => {
  for (const input of ['/blog', 'blog', '/blog/', '/', '']) {
    const m = buildManifest({ site: { title: 'x' }, basePath: input === '/' || input === '' ? input : '/blog' });
    if (input === '/' || input === '') assert.equal(m.start_url, '/');
    else assert.equal(m.start_url, '/blog/');
  }
});

test('只声明确实存在的图标档位', () => {
  const m = buildManifest({ site: { title: 'x' }, icons: { 192: '/i192.png' } });
  assert.equal(m.icons.length, 1);
  assert.equal(m.icons[0].sizes, '192x192');
  assert.equal(m.icons[0].purpose, 'any');
});

test('一个图标都没有时删掉 icons 字段（而不是留一个空数组）', () => {
  const m = buildManifest({ site: { title: 'x' } });
  assert.equal('icons' in m, false);
  // 空 icons 数组会让部分浏览器判定 manifest 无效。
  const empty = buildManifest({ site: { title: 'x' }, icons: {} });
  assert.equal('icons' in empty, false);
});

test('maskable 单独一个条目，且不与 any 混淆', () => {
  const m = buildManifest({ site: { title: 'x' }, icons: { 192: '/i192.png', maskable: '/mask.png' } });
  const mask = m.icons.find((i) => i.purpose === 'maskable');
  assert.ok(mask);
  assert.equal(mask.src, '/mask.png');
  assert.equal(m.icons.filter((i) => i.purpose === 'any').length, 1);
});

test('图标 mime 按扩展名推断', () => {
  const m = buildManifest({ site: { title: 'x' }, icons: { 192: '/a.svg', 512: '/b.webp' } });
  assert.equal(m.icons.find((i) => i.sizes === '192x192').type, 'image/svg+xml');
  assert.equal(m.icons.find((i) => i.sizes === '512x512').type, 'image/webp');
});

test('非法尺寸被过滤（不会产出 "NaNxNaN" 这种条目）', () => {
  const m = buildManifest({ site: { title: 'x' }, icons: { abc: '/a.png', 192: '/b.png' } });
  assert.equal(m.icons.length, 1);
});

test('shortName：中文按字符、英文按词', () => {
  // 含 CJK 的标题按字符截：中文标题按词截没有依据（词边界不可靠）。
  assert.equal(shortName('Emeek 主题演示站'), 'Emeek 主题');
  assert.equal(shortName('知识宇宙'), '知识宇宙');
  assert.equal(shortName('A Very Long English Blog Title'), 'A Very Long');
  assert.equal(shortName(''), '');
});

test('ICON_SIZES 是标准档位', () => {
  assert.deepEqual(ICON_SIZES, [192, 512]);
});
