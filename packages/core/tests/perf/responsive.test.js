import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitVariant, buildSrcset, detectWidth, decorateResponsive } from '../../src/pipeline/transform/responsive.js';

test('splitVariant：保留扩展名，多位小数点不误伤', () => {
  assert.equal(splitVariant('/a/b.png', 400), '/a/b-400.png');
  assert.equal(splitVariant('/a/b.min.js', 400), '/a/b.min-400.js');
  assert.equal(splitVariant('b.png', 400), 'b-400.png');
  assert.equal(splitVariant('noext', 400), 'noext-400');
});

test('buildSrcset：只输出作者声明的候选，不编造地址', () => {
  assert.equal(buildSrcset('/a.png', []), '', '没有候选集就不生成 srcset（不编造）');
  assert.equal(buildSrcset('/a.png', [{ width: 400 }, { width: 800 }]), '/a-400.png 400w, /a-800.png 800w');
  assert.equal(buildSrcset('/a.png', [{ width: 400, url: '/cdn/opt-400.webp' }]), '/cdn/opt-400.webp 400w', '候选可以显式给 url（换成 webp 时不改文件名约定）');
  // 非法宽度被跳过，而不是变成 "NaN w"
  assert.equal(buildSrcset('/a.png', [{ width: 0 }, { width: 'x' }]), '');
});

test('buildSrcset：原图按文件名宽度补进候选，并按宽度去重', () => {
  const set = buildSrcset('/a-800.png', [{ width: 400 }, { width: 800 }]);
  const widths = set.split(', ').map((e) => e.split(' ')[1]);
  assert.deepEqual(widths.sort(), ['400w', '800w'], '原图 800w 与候选重复时只留一条');
});

test('detectWidth：只认结尾数字，不在日期文件名上误判', () => {
  assert.equal(detectWidth('/a/photo-1600.webp'), 1600);
  assert.equal(detectWidth('/a/photo_800.png'), 800);
  // 这两条是关键：更激进的猜测会把日期当宽度，写出假的描述符，
  // 于是浏览器按错误比例选图 —— 要么模糊要么过大。
  assert.equal(detectWidth('/a/2024-01-15-why.md'), null);
  assert.equal(detectWidth('/a/posts/2024-01-15-why.md'), null);
  assert.equal(detectWidth('/a/x-99999.png'), null, '超出合理范围的不认');
});

test('decorateResponsive：给了 width/height 就一定配 style=height:auto', () => {
  const out = decorateResponsive(' src="/a.png"', { dimensionsBySrc: { '/a.png': { width: 1200, height: 630 } } });
  assert.match(out, /width="1200"/);
  assert.match(out, /height="630"/);
  // 没有这行，有尺寸属性的图会被压扁 —— 这是补 width/height 时最常见的翻车。
  assert.match(out, /style="height:auto"/);
});

test('decorateResponsive：responsive 关闭时不生成 srcset', () => {
  const out = decorateResponsive(' src="/a.png"', { responsive: false, variantsBySrc: { '/a.png': [{ width: 400 }] } });
  assert.doesNotMatch(out, /srcset/);
});

test('decorateResponsive：生成 srcset 时一定带 sizes', () => {
  const out = decorateResponsive(' src="/a.png"', { responsive: true, variantsBySrc: { '/a.png': [{ width: 400 }] } });
  assert.match(out, /srcset="/);
  // 不给 sizes 时浏览器按 100vw 算，移动端会选一个没必要的大图。
  assert.match(out, /sizes="/);
});

test('decorateResponsive：已有属性的图不被二次覆盖', () => {
  const out = decorateResponsive(' src="/a.png" srcset="/a-400.png 400w" sizes="50vw"', {
    responsive: true, variantsBySrc: { '/a.png': [{ width: 800 }] },
  });
  assert.equal((out.match(/srcset=/g) ?? []).length, 1);
  assert.match(out, /sizes="50vw"/);
});
