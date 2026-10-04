import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectPreloadTargets,
  renderPreloadTags,
  buildEarlyHintsHeader,
  renderNginxSnippet,
  renderCaddySnippet,
} from '../../src/accel/hints.js';

describe('资源提示与 Early Hints', () => {
  test('CSS 优先于字体优先于 JS', () => {
    const targets = selectPreloadTargets([
      { path: '/app.a1b2c3d4.js', bytes: 1000 },
      { path: '/theme.a1b2c3d4.css', bytes: 500 },
      { path: '/f.a1b2c3d4.woff2', bytes: 800 },
    ]);
    assert.deepEqual(targets.map((t) => t.as), ['style', 'font', 'script']);
  });

  test('HTML 与数据文件不进 preload', () => {
    const targets = selectPreloadTargets([
      { path: '/index.html', bytes: 1000 },
      { path: '/search-index.json', bytes: 1000 },
    ]);
    assert.equal(targets.length, 0);
  });

  test('preload 数量有上限（多了等于不 preload）', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ path: `/x${i}.a1b2c3d4.css`, bytes: 100 }));
    assert.equal(selectPreloadTargets(many, { limit: 3 }).length, 3);
  });

  test('字体 preload 带 crossorigin（否则二次下载）', () => {
    const tags = renderPreloadTags([{ path: '/f.woff2', as: 'font' }]);
    assert.match(tags, /crossorigin/);
    const cssTags = renderPreloadTags([{ path: '/a.css', as: 'style' }]);
    assert.doesNotMatch(cssTags, /crossorigin/);
  });

  test('Early Hints 头格式正确', () => {
    const header = buildEarlyHintsHeader([{ path: '/a.css', as: 'style' }, { path: '/f.woff2', as: 'font' }]);
    assert.match(header, /<\/a\.css>; rel=preload; as=style/);
    assert.match(header, /as=font; crossorigin/);
  });

  test('Nginx 片段包含三个关键开关', () => {
    const conf = renderNginxSnippet({ serverName: 'blog.example.com' });
    assert.match(conf, /gzip_static on/);
    assert.match(conf, /brotli_static on/);
    assert.match(conf, /immutable/);
    assert.match(conf, /no-store/);
  });

  test('Nginx 片段在有 preload 时开 103 Early Hints', () => {
    const conf = renderNginxSnippet({ earlyHints: [{ path: '/a.css', as: 'style' }] });
    assert.match(conf, /http2_push_preload on/);
    assert.match(conf, /add_header Link/);
  });

  test('Caddy 片段自带 br/gzip 编码', () => {
    const conf = renderCaddySnippet({ serverName: 'blog.example.com' });
    assert.match(conf, /encode zstd br gzip/);
  });
});
