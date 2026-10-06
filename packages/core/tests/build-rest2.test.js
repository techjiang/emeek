import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { build } from '../src/pipeline/index.js';

/**
 * P3-4b-rest-2 的构建级集成：
 *   C 社交分享、D1 阅读统计显示、D2 内容工作流。
 *
 * 单测覆盖了纯函数，这里覆盖**它们真的被接进了产物**——
 * 一个写得再好的模块，只要没人 import，产物里就什么都没有。
 */

async function site(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'emeeek-rest2-'));
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), content, 'utf8');
  }
  return dir;
}
const read = (dir, rel) => fs.readFile(path.join(dir, 'dist', rel), 'utf8');
const exists = async (dir, rel) => fs.access(path.join(dir, 'dist', rel)).then(() => true, () => false);

function cfg(extra = '') {
  return `export default {
    site: { title: '站', description: 'D', url: 'https://s.example.com', author: 'A', language: 'zh-CN' },
    content: { source: 'local', localDirs: ['posts'] },
    ${extra}
  };`;
}
const md = (title, date, extra = '', body = '正文内容。') => `---\ntitle: ${title}\ndate: ${date}\n${extra}---\n\n${body}\n`;

describe('★ C 社交分享：默认关闭', () => {
  test('不配 share 时产物里没有任何分享标记', async () => {
    const dir = await site({ 'emeeek.config.js': cfg(), 'posts/2025-01-01-a.md': md('A', '2025-01-01') });
    await build({ cwd: dir });
    const html = await read(dir, 'posts/a.html');
    assert.ok(!html.includes('data-share'), '默认关闭时不该有分享块');
    assert.ok(!html.includes('twitter.com/intent'), '不该有第三方分享链接');
  });
});

describe('★ C 社交分享：开启后', () => {
  const config = cfg(`share: { enabled: true, platforms: ['twitter', 'weibo', 'wechat', 'copy'], position: 'bottom' },`);

  test('每个平台一个按钮，全部是构建期 <a> 或需要浏览器端的 <button>', async () => {
    const dir = await site({ 'emeeek.config.js': config, 'posts/2025-01-01-a.md': md('标题 A', '2025-01-01') });
    await build({ cwd: dir });
    const html = await read(dir, 'posts/a.html');
    assert.match(html, /share-btn share-twitter/);
    assert.match(html, /share-btn share-weibo/);
    assert.match(html, /data-share-wechat/);
    assert.match(html, /data-share-copy/);
  });

  test('分享链接是绝对地址且带 UTM', async () => {
    const dir = await site({ 'emeeek.config.js': config, 'posts/2025-01-01-a.md': md('标题 A', '2025-01-01') });
    await build({ cwd: dir });
    const html = await read(dir, 'posts/a.html');
    assert.match(html, /https:\/\/twitter\.com\/intent\/tweet\?url=https%3A%2F%2Fs\.example\.com/);
    assert.match(html, /utm_source%3Demeek|utm_source=emeek/);
  });

  test('零第三方 JS：产物里不出现任何分享 SDK 的 script', async () => {
    const dir = await site({ 'emeeek.config.js': config, 'posts/2025-01-01-a.md': md('标题 A', '2025-01-01') });
    await build({ cwd: dir });
    const html = await read(dir, 'posts/a.html');
    for (const sdk of ['platform.twitter.com', 'connect.facebook.net', 'widgets.js', 'share.js', 'addthis']) {
      assert.ok(!html.includes(sdk), `不该出现第三方分享 SDK：${sdk}`);
    }
  });

  test('带微信/复制时内联二维码编码器；纯链接平台时不带', async () => {
    const withWechat = await site({ 'emeeek.config.js': config, 'posts/2025-01-01-a.md': md('A', '2025-01-01') });
    await build({ cwd: withWechat });
    assert.match(await read(withWechat, 'posts/a.html'), /data-share-wechat/, '微信按钮在');

    const linkOnly = await site({
      'emeeek.config.js': cfg(`share: { enabled: true, platforms: ['twitter'] },`),
      'posts/2025-01-01-a.md': md('A', '2025-01-01'),
    });
    await build({ cwd: linkOnly });
    const html = await read(linkOnly, 'posts/a.html');
    assert.ok(!html.includes('data-share-wechat'), '没有微信时不该有二维码容器');
    // 纯链接时不该内联 QR 编码器（体积）
    assert.ok(!html.includes('RS_BLOCK'), '没有微信/复制时不该内联二维码编码器');
  });
});

describe('★ D1 阅读统计显示', () => {
  test('文章页有阅读时间与字数', async () => {
    const dir = await site({ 'emeeek.config.js': cfg(), 'posts/2025-01-01-a.md': md('A', '2025-01-01') });
    await build({ cwd: dir });
    const html = await read(dir, 'posts/a.html');
    assert.match(html, /分钟读完/);
    assert.match(html, /字</);
  });

  test('列表卡片有阅读时间徽章', async () => {
    const dir = await site({ 'emeeek.config.js': cfg(), 'posts/2025-01-01-a.md': md('A', '2025-01-01') });
    await build({ cwd: dir });
    const html = await read(dir, 'index.html');
    assert.match(html, /card-reading/);
  });

  test('reading.showTime = false 时不显示阅读时间', async () => {
    const dir = await site({
      'emeeek.config.js': cfg('reading: { showTime: false },'),
      'posts/2025-01-01-a.md': md('A', '2025-01-01'),
    });
    await build({ cwd: dir });
    assert.ok(!(await read(dir, 'posts/a.html')).includes('分钟读完'));
    assert.ok(!(await read(dir, 'index.html')).includes('card-reading'));
  });

  test('没有评论数据源时不显示评论数（不是显示 0）', async () => {
    const dir = await site({ 'emeeek.config.js': cfg(), 'posts/2025-01-01-a.md': md('A', '2025-01-01') });
    await build({ cwd: dir });
    const html = await read(dir, 'posts/a.html');
    assert.ok(!html.includes('0 条评论'), 'local 源没有评论数，不该显示 0');
  });

  test('wordsPerMinute 影响阅读时长', async () => {
    const long = '句子。'.repeat(500); // 1000 字
    const slow = await site({
      'emeeek.config.js': cfg('reading: { wordsPerMinute: 200 },'),
      'posts/2025-01-01-a.md': md('A', '2025-01-01', '', long),
    });
    await build({ cwd: slow });
    const slowHtml = await read(slow, 'posts/a.html');
    const fast = await site({
      'emeeek.config.js': cfg('reading: { wordsPerMinute: 1000 },'),
      'posts/2025-01-01-a.md': md('A', '2025-01-01', '', long),
    });
    await build({ cwd: fast });
    const fastHtml = await read(fast, 'posts/a.html');
    const mins = (h) => Number(/<span>(\d+) 分钟读完/.exec(h)?.[1] ?? 0);
    assert.ok(mins(slowHtml) > mins(fastHtml), `200 字/分 (${mins(slowHtml)} 分) 必须比 1000 字/分 (${mins(fastHtml)} 分) 长`);
  });
});

describe('★ D2 内容工作流：草稿绝不进生产', () => {
  test('草稿完全不出现在产物、sitemap、feed 里', async () => {
    const dir = await site({
      'emeeek.config.js': cfg(),
      'posts/2025-01-01-live.md': md('已发布文章', '2025-01-01'),
      'posts/2025-02-01-draft.md': md('草稿秘密', '2025-02-01', 'draft: true\n'),
    });
    await build({ cwd: dir });
    assert.equal(await exists(dir, 'posts/draft.html'), false, '草稿页面不该存在');
    for (const f of ['index.html', 'archive.html', 'sitemap.xml', 'rss.xml', 'atom.xml', 'search-index.json']) {
      const content = await read(dir, f);
      assert.ok(!content.includes('草稿秘密'), `${f} 里不该出现草稿标题`);
    }
  });

  test('定时未到点的文章同样不进任何产物', async () => {
    const dir = await site({
      'emeeek.config.js': cfg(),
      'posts/2025-01-01-live.md': md('已发布', '2025-01-01'),
      'posts/2999-01-01-future.md': md('未来文章', '2999-01-01'),
    });
    await build({ cwd: dir });
    assert.equal(await exists(dir, 'posts/future.html'), false);
    assert.ok(!(await read(dir, 'sitemap.xml')).includes('future'));
    assert.ok(!(await read(dir, 'rss.xml')).includes('未来文章'));
  });
});

describe('★ D2 内容工作流：分类页与总览页', () => {
  const withCats = {
    'emeeek.config.js': cfg(),
    'posts/2025-01-01-a.md': md('A', '2025-01-01', 'categories: [设计]\ntags: [CSS]\n'),
    'posts/2025-02-01-b.md': md('B', '2025-02-01', 'categories: [工程]\ntags: [JS]\n'),
  };

  test('分类总览页 /categories.html 存在且进 sitemap', async () => {
    const dir = await site(withCats);
    await build({ cwd: dir });
    assert.equal(await exists(dir, 'categories.html'), true);
    assert.match(await read(dir, 'sitemap.xml'), /categories\.html/);
  });

  test('分类页 /categories/<slug>.html 存在', async () => {
    const dir = await site(withCats);
    await build({ cwd: dir });
    const html = await read(dir, 'categories.html');
    assert.match(html, /设计/);
    assert.match(html, /工程/);
  });

  test('有分类时导航出现「分类」入口', async () => {
    const dir = await site(withCats);
    await build({ cwd: dir });
    assert.match(await read(dir, 'index.html'), /href="\/categories\.html"/);
  });

  test('没有分类时导航不出现「分类」（点进去空无一物比没有更糟）', async () => {
    const dir = await site({ 'emeeek.config.js': cfg(), 'posts/2025-01-01-a.md': md('A', '2025-01-01') });
    await build({ cwd: dir });
    assert.ok(!(await read(dir, 'index.html')).includes('href="/categories.html"'));
  });
});

describe('★ D2 内容工作流：构建期校验', () => {
  const broken = {
    'emeeek.config.js': cfg(),
    'posts/2025-01-01-ok.md': md('好的', '2025-01-01'),
    'posts/2025-02-01-bad.md': md('坏的', '2025-02-01', '', '```js\n未闭合\n'),
  };

  test('默认 warn：有问题也构建成功，不阻塞发文', async () => {
    const dir = await site(broken);
    const stats = await build({ cwd: dir });
    assert.ok(stats.validation, '校验结果要挂在构建统计上');
    assert.ok(stats.validation.counts.error > 0);
  });

  test('validate = error：有错误时构建失败', async () => {
    const dir = await site({ ...broken, 'emeeek.config.js': cfg("workflow: { validate: 'error' },") });
    await assert.rejects(() => build({ cwd: dir }), /内容校验失败/);
  });

  test('validate = off：完全不跑', async () => {
    const dir = await site({ ...broken, 'emeeek.config.js': cfg("workflow: { validate: 'off' },") });
    const stats = await build({ cwd: dir });
    assert.equal(stats.validation, null);
  });

  test('checks 白名单：只跑指定项', async () => {
    const dir = await site({ ...broken, 'emeeek.config.js': cfg("workflow: { validate: 'warn', checks: ['title'] },") });
    const stats = await build({ cwd: dir });
    assert.equal(stats.validation.issues.length, 0, '空标题/围栏不在白名单里，不该被查');
  });
});
