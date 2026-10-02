import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from '../src/pipeline/index.js';

/** 在临时目录里搭一个最小站点，跑完整构建后断言产物。 */
async function withFixture(files, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'emeeek-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      const target = path.join(dir, name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, 'utf8');
    }
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const CONFIG = `export default {
  site: { title: '测试站', description: '描述', url: 'https://test.example.com', author: 'A', language: 'zh-CN' },
  content: { source: 'local', localDirs: ['posts'] },
};`;

const read = (dir, file) => fs.readFile(path.join(dir, 'dist', file), 'utf8');

test('完整构建产出全部页面与 SEO 文件', async () => {
  await withFixture({
    'emeeek.config.js': CONFIG,
    'posts/2024-01-01-a.md': '---\ntitle: 甲\ntags: [x]\n---\n# 甲\n\n正文甲。',
    'posts/2024-01-02-b.md': '---\ntitle: 乙\ndraft: true\n---\n\n草稿不应出现。',
    'posts/2024-01-03-c.md': '---\ntitle: 丙\npinned: true\n---\n\n正文丙。',
  }, async (dir) => {
    const stats = await build({ cwd: dir });
    assert.equal(stats.posts, 2, '草稿不应计入');
    assert.equal(stats.drafts, 1);

    const index = await read(dir, 'index.html');
    assert.match(index, /<title>测试站<\/title>/);
    assert.match(index, /甲/);
    assert.match(index, /丙/);
    assert.ok(!index.includes('草稿不应出现'), '草稿内容不应进入产物');

    await assert.doesNotReject(read(dir, 'posts/a.html'));
    await assert.doesNotReject(read(dir, 'archive.html'));
    await assert.doesNotReject(read(dir, 'tags.html'));
    await assert.doesNotReject(read(dir, '404.html'));
    await assert.doesNotReject(read(dir, 'sitemap.xml'));
    await assert.doesNotReject(read(dir, 'rss.xml'));
    await assert.doesNotReject(read(dir, 'robots.txt'));
    await assert.doesNotReject(read(dir, 'search-index.json'));
  });
});

test('置顶文章排在列表最前', async () => {
  await withFixture({
    'emeeek.config.js': CONFIG,
    'posts/a.md': '---\ntitle: 普通\ndate: 2024-06-01\n---\n\nA',
    'posts/b.md': '---\ntitle: 置顶\npin: true\ndate: 2020-01-01\n---\n\nB',
  }, async (dir) => {
    await build({ cwd: dir });
    const index = await read(dir, 'index.html');
    assert.ok(index.indexOf('置顶') < index.indexOf('普通'), '置顶文章应更靠前');
  });
});

test('front-matter 的 description 优先生成摘要', async () => {
  await withFixture({
    'emeeek.config.js': CONFIG,
    'posts/a.md': '---\ntitle: T\ndescription: 手写摘要优先\n---\n\n正文内容很长很长很长。',
  }, async (dir) => {
    await build({ cwd: dir });
    const index = await read(dir, 'index.html');
    assert.match(index, /手写摘要优先/);
  });
});

test('构建结果可复现：两次构建的 HTML 一致', async () => {
  await withFixture({
    'emeeek.config.js': CONFIG,
    'posts/a.md': '---\ntitle: T\n---\n\n正文。',
  }, async (dir) => {
    await build({ cwd: dir });
    const first = await read(dir, 'index.html');
    await build({ cwd: dir });
    const second = await read(dir, 'index.html');
    // 只比较占位符以外的结构：脚注 id 含随机串，属于已知的非确定性。
    const strip = (h) => h.replace(/fn[a-z0-9]{6}/g, 'FN');
    assert.equal(strip(first), strip(second));
  });
});

test('配置非法时抛出可读的错误', async () => {
  await withFixture({
    'emeeek.config.js': `export default { site: { url: '不是链接' } };`,
  }, async (dir) => {
    await assert.rejects(() => build({ cwd: dir }), (error) => {
      assert.match(error.message, /配置校验失败/);
      assert.match(error.message, /site\.url/);
      return true;
    });
  });
});

test('没有配置文件时用默认值也能构建', async () => {
  await withFixture({
    'posts/a.md': '---\ntitle: T\n---\n\n正文。',
  }, async (dir) => {
    await fs.mkdir(path.join(dir, 'posts'), { recursive: true });
    await fs.writeFile(path.join(dir, 'posts/a.md'), '---\ntitle: 默认配置\n---\n\n正文。', 'utf8');
    const stats = await build({ cwd: dir });
    assert.equal(stats.posts, 1);
    assert.match(await read(dir, 'index.html'), /默认配置/);
  });
});

test('ABOUT.md 自动渲染成关于页', async () => {
  await withFixture({
    'emeeek.config.js': CONFIG,
    'ABOUT.md': '# 关于我\n\n这里是关于内容。',
    'posts/a.md': '---\ntitle: T\n---\n\n正文。',
  }, async (dir) => {
    await build({ cwd: dir });
    const about = await read(dir, 'about.html');
    assert.match(about, /关于我/);
    assert.match(about, /这里是关于内容/);
  });
});

test('标题带特殊字符时 slug 仍然安全', async () => {
  await withFixture({
    'emeeek.config.js': CONFIG,
    'posts/a.md': '---\ntitle: "含 / 斜杠 与 <标签> 的标题"\nslug: safe-slug\n---\n\n正文。',
  }, async (dir) => {
    await build({ cwd: dir });
    await assert.doesNotReject(read(dir, 'posts/safe-slug.html'));
  });
});

test('hybrid 源在 GitHub 不可用时降级为仅本地内容', async () => {
  await withFixture({
    'emeeek.config.js': `export default {
      site: { title: 'T', url: 'https://t.example.com' },
      content: { source: 'hybrid', repo: 'nobody/nothing', localDirs: ['posts'] },
    };`,
    'posts/a.md': '---\ntitle: 本地文章\n---\n\n正文。',
  }, async (dir) => {
    // 仓库不存在 → API 404；hybrid 模式必须继续用本地内容构建成功。
    const stats = await build({ cwd: dir });
    assert.equal(stats.posts, 1);
    assert.match(await read(dir, 'index.html'), /本地文章/);
  });
});

test('纯 github-issues 源失败时抛错而不是产出空站点', async () => {
  await withFixture({
    'emeeek.config.js': `export default {
      site: { title: 'T', url: 'https://t.example.com' },
      content: { source: 'github-issues', repo: 'nobody/nothing' },
    };`,
  }, async (dir) => {
    await assert.rejects(() => build({ cwd: dir }), /404|GitHub API/);
  });
});
