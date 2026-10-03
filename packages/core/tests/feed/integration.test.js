import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRss, buildAtom } from '../../src/feed/build.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../../..');
const THEMES = ['aurora', 'inkstone', 'minimal', 'magazine'];

describe('Feed 在主题里接线正确', () => {
  for (const theme of THEMES) {
    test(`${theme} 的 head 有 discovery 循环`, () => {
      const head = fs.readFileSync(path.join(ROOT, 'packages', `theme-${theme}`, 'partials', 'head.html'), 'utf8');
      assert.ok(head.includes('feedLinks'), `${theme} head 缺 feedLinks`);
      assert.match(head, /rel="alternate"/);
    });

    test(`${theme} 的 layout 里没有硬编码的 discovery 标签`, () => {
      // 硬编码那份不跟配置、且只在首页/文章页有 —— 集中在 head partial 才有唯一来源。
      const dir = path.join(ROOT, 'packages', `theme-${theme}`, 'layouts');
      for (const file of fs.readdirSync(dir)) {
        const html = fs.readFileSync(path.join(dir, file), 'utf8');
        assert.ok(!/href="\/rss\.xml"/.test(html), `${theme}/${file} 里还硬编码着 /rss.xml`);
      }
    });

    test(`${theme} 的页脚有 RSS 与 Atom 两个图标链接`, () => {
      const footer = fs.readFileSync(path.join(ROOT, 'packages', `theme-${theme}`, 'partials', 'footer.html'), 'utf8');
      assert.ok(footer.includes('href="/rss.xml"'), `${theme} 页脚缺 RSS`);
      assert.ok(footer.includes('href="/atom.xml"'), `${theme} 页脚缺 Atom`);
      assert.ok(footer.includes('feed-icon'), `${theme} 页脚缺 SVG 图标`);
    });

    test(`${theme} 有 feed 图标样式，且跟随主题强调色`, () => {
      const css = fs.readFileSync(path.join(ROOT, 'packages', `theme-${theme}`, 'styles', 'main.css'), 'utf8');
      assert.ok(css.includes('.feed-link'), `${theme} 缺 .feed-link`);
      assert.ok(/\.feed-link:hover\s*{[^}]*var\(--accent\)/.test(css), `${theme} 图标未跟随 --accent`);
    });
  }
});

describe('中文站点的日期格式', () => {
  const SITE = { title: '中文站', url: 'https://x.com', description: 'd', language: 'zh-CN', author: 'a' };
  const POSTS = [{ title: '中文标题', url: '/a', date: '2024-01-15', description: '摘要', html: '<p>x</p>' }];

  test('RSS pubDate 用 RFC 822（阅读器能解析），不是中文格式', () => {
    const xml = buildRss(SITE, POSTS);
    const m = xml.match(/<pubDate>([^<]+)<\/pubDate>/);
    assert.ok(m, '缺 pubDate');
    assert.match(m[1], /GMT$/);
    assert.ok(!Number.isNaN(new Date(m[1]).getTime()));
    assert.ok(!/年|月/.test(m[1]), 'feed 里不该出现中文日期');
  });

  test('Atom updated 用 RFC 3339', () => {
    const xml = buildAtom(SITE, POSTS);
    const m = xml.match(/<updated>([^<]+)<\/updated>/);
    assert.match(m[1], /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(!/年|月/.test(m[1]));
  });

  test('中文字符原样保留（不转义成数字实体）', () => {
    const xml = buildRss(SITE, POSTS);
    assert.ok(xml.includes('中文标题'), '中文标题被转义了');
  });
});
