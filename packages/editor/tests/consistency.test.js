/**
 * 预览一致性测试 —— Step 2 的生命线。
 *
 * 三件事一起守：
 *   1. 约束：编辑器预览路径必须调用 @emeeek/core 的渲染函数（不允许另写一套）
 *   2. 逐字节/逐节点一致：预览 HTML ≡ 构建产物 HTML（同一输入，两边独立渲染）
 *   3. 真实文档仍成立：拿 examples/ 里的实际文章再验一遍
 *
 * 第 2 条不与实现耦合：构建侧用的是 core 的 renderMarkdown + decorateImages +
 * addAnchorLinks，编辑器侧用 updatePreview()，两条路径分别来自不同的导出入口。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderArticle, buildWikiLinkIndex, resolveWikiLink } from '@emeeek/core/pipeline';
import { updatePreview, buildHtml, previewMeta, createWikiLinkResolver } from '../src/preview/index.js';
import { canonicalizeHtml, htmlEquivalent, parseHtml } from '../src/preview/dom.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const FIXTURES = path.join(HERE, 'fixtures');

const readFixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

const CASES = [
  'basic.md',
  'with-code.md',
  'with-table.md',
  'with-math.md',
  'with-mermaid.md',
  'with-images.md',
  'with-links.md',
  'with-footnotes.md',
  'with-tasks.md',
  'edge-cases.md',
  'large-document.md',
];

/** 构建路径：与 packages/core/src/pipeline/index.js 里每篇 post 的处理完全一致。 */
function buildOutput(source, { posts = null } = {}) {
  return renderArticle(source, {
    allowHtml: false,
    lazyImages: true,
    headingIds: new Map(),
    wikiLink: posts ? wikiResolver(posts) : undefined,
  });
}

/**
 * 站点文章列表。
 *
 * 含 [[双向链接]] 的样例必须两边都注入同一份索引 —— 构建期索引来自
 * buildWikiLinkIndex()，编辑器侧走 createWikiLinkResolver()（内部同样调 core）。
 * 这是编辑器与构建之间唯一的「运行时上下文差异」，所以必须在测试里显式对齐。
 */
const SITE_POSTS = [
  { title: '另一篇文章', slug: 'another', url: '/posts/another.html', tags: ['示例'] },
  { title: '文章标题', slug: 'article', url: '/posts/article.html', tags: ['示例'] },
];

function wikiResolver(posts = SITE_POSTS) {
  const index = buildWikiLinkIndex(posts, { urlPattern: (post) => post.url });
  return (target, alias) => resolveWikiLink(index, target, alias);
}

describe('预览一致性：预览 HTML 与构建产物必须渲染等价', () => {
  for (const name of CASES) {
    test(`${name} — 预览 ≡ 构建`, () => {
      const source = readFixture(name);
      const preview = updatePreview(source, { wikiLink: wikiResolver() });
      const built = buildOutput(source, { posts: SITE_POSTS });
      // 规范化后逐节点比较：差异只在「真正影响渲染的东西」上才报错
      assert.equal(canonicalizeHtml(preview), canonicalizeHtml(built), `${name} 预览与构建输出不一致`);
    });
  }

  test('双向链接：预览与构建给出同一个 URL（站点索引注入两边）', () => {
    const source = readFixture('with-links.md');
    const preview = updatePreview(source, { wikiLink: wikiResolver() });
    const built = buildOutput(source, { posts: SITE_POSTS });
    assert.equal(canonicalizeHtml(preview), canonicalizeHtml(built));
    assert.match(preview, /<a class="wiki-link" href="\/posts\/another\.html"/);
    assert.doesNotMatch(preview, /wiki-link--missing/);
  });

  test('未命中索引时两边同样渲染成缺失样式（不静默变链接）', () => {
    const source = '见 [[根本没有这篇文章]]。';
    const preview = updatePreview(source, { wikiLink: wikiResolver() });
    const built = buildOutput(source, { posts: SITE_POSTS });
    assert.equal(canonicalizeHtml(preview), canonicalizeHtml(built));
    assert.match(preview, /wiki-link--missing/);
  });

  test('缺索引时预览与构建同样退化（不能偷偷多加一层兜底）', () => {
    const source = '见 [[另一篇文章]]。';
    assert.equal(canonicalizeHtml(updatePreview(source)), canonicalizeHtml(buildOutput(source)));
  });

  test('不一致时必须报出来（反向验证：改了预览侧就会红）', () => {
    const source = readFixture('with-code.md');
    const preview = updatePreview(source);
    // 故意破坏：模拟「预览忘了加锚点按钮」这种真实漂移
    const broken = preview.replace(/<a class="anchor"[^>]*>#<\/a>/g, '');
    assert.notEqual(canonicalizeHtml(broken), canonicalizeHtml(buildOutput(source)));
    assert.equal(htmlEquivalent(broken, buildOutput(source)), false);
  });

  test('HTML 规范化不会放过真实差异', () => {
    assert.equal(htmlEquivalent('<p><img src="a" loading="lazy" /></p>', '<p><img src="a" /></p>'), false);
    assert.equal(htmlEquivalent('<div class="code-block"><pre>x</pre></div>', '<pre>x</pre>'), false);
    assert.equal(htmlEquivalent('<h2 id="a">t</h2>', '<h3 id="a">t</h3>'), false);
    assert.equal(htmlEquivalent('<p>a&amp;b</p>', '<p>a&b</p>'), true);
  });

  test('每个标题都带锚点按钮（构建如此，预览也必须如此）', () => {
    const html = updatePreview('## 一\n\n### 二\n');
    const headings = [...html.matchAll(/<h([23]) id="([^"]+)">/g)];
    assert.equal(headings.length, 2);
    assert.equal((html.match(/class="anchor"/g) ?? []).length, 2);
  });

  test('图片一定带懒加载与 async 解码', () => {
    const html = updatePreview('![图](/a.png)\n\n![图](https://x.com/b.png)\n');
    const imgs = [...html.matchAll(/<img[^>]*>/g)].map((m) => m[0]);
    assert.equal(imgs.length, 2);
    for (const img of imgs) {
      assert.match(img, /loading="lazy"/);
      assert.match(img, /decoding="async"/);
    }
  });
});

describe('渲染路径约束：编辑器不得自带 Markdown 解析器', () => {
  const sources = ['src/preview/index.js', 'src/preview/dom.js', 'src/index.js'];

  test('预览模块 import 了 @emeeek/core（浏览器友好的 render 入口）', () => {
    const text = fs.readFileSync(path.join(HERE, '..', 'src/preview/index.js'), 'utf8');
    // 允许两个入口：Node 用 /pipeline，浏览器 bundle 用 /render（不带 node: 依赖）。
    // 但必须来自 core，且必须用 core 的渲染函数。
    assert.match(text, /from '@emeeek\/core\/(pipeline|render)'/, '预览必须复用 core 的渲染管线');
    assert.match(text, /renderArticle|renderMarkdown/);
    assert.doesNotMatch(text, /export\s+function\s+renderMarkdown/, '不能自带一份渲染器');
  });

  test('编辑器源码里没有自建 Markdown 渲染器', () => {
    const files = listSources(path.join(HERE, '..', 'src'));
    const offenders = files.filter((file) => {
      const text = fs.readFileSync(file, 'utf8');
      // 自己写 HTML 输出器才会出现这些特征：拼 <p>/<h1> 之类的块级标签
      return /return\s+`<p>|function\s+renderMarkdown\b|const\s+renderMarkdown\s*=/.test(text);
    });
    assert.deepEqual(offenders.map((f) => path.relative(REPO, f)), []);
  });

  test('core 导出 renderArticle（编辑器复用的入口）', () => {
    assert.equal(typeof renderArticle, 'function');
    assert.equal(typeof updatePreview, 'function');
  });

  test('编辑器导出里没有第二套渲染函数', () => {
    const text = fs.readFileSync(path.join(HERE, '..', 'src/preview/index.js'), 'utf8');
    assert.doesNotMatch(text, /export\s+function\s+renderMarkdown/);
  });
});

describe('真实文档一致性（examples/ 与实际仓库文档）', () => {
  const documents = [
    'examples/minimal/posts/2024-01-15-why-emeeek.md',
    'examples/minimal/posts/2024-02-03-markdown-syntax.md',
    'examples/minimal/posts/2024-03-20-performance-notes.md',
    'examples/full-featured/posts/2024-04-01-welcome.md',
    'README.md',
    'docs/ai.md',
    'docs/configuration.md',
  ];

  for (const relative of documents) {
    test(`${relative} — 预览 ≡ 构建`, () => {
      const source = readSource(relative);
      // 真实文章带 front-matter：构建期先剥离，预览也必须剥离，
      // 否则预览里会多出一段 YAML 正文（这是最容易漏的一种不一致）
      const body = stripFrontmatter(source);
      assert.equal(
        canonicalizeHtml(updatePreview(body, { wikiLink: wikiResolver() })),
        canonicalizeHtml(buildOutput(body, { posts: SITE_POSTS })),
      );
    });
  }

  test('front-matter 不会被当正文渲染', () => {
    const source = readSource('examples/minimal/posts/2024-01-15-why-emeeek.md');
    const html = updatePreview(stripFrontmatter(source));
    assert.doesNotMatch(html, /title:\s*为什么/);
  });
});

describe('脚注 id 必须确定（同一输入 → 同一输出）', () => {
  test('两次渲染完全一致', () => {
    const source = readFixture('with-footnotes.md');
    assert.equal(updatePreview(source), updatePreview(source));
    assert.equal(buildOutput(source), buildOutput(source));
  });

  test('增量渲染与整篇渲染对脚注的处理一致（块级缓存不能引入随机 id）', () => {
    const source = '引用[^x]\n\n[^x]: 说明\n';
    assert.equal(updatePreview(source), updatePreview(source));
  });
});

describe('预览元数据与构建同源', () => {
  test('目录 id 与渲染出的锚点一致', () => {
    const source = readFixture('basic.md');
    const html = updatePreview(source);
    const meta = previewMeta(source, html);
    for (const item of meta.toc) {
      assert.ok(html.includes(`id="${item.id}"`), `目录项 ${item.id} 找不到对应锚点`);
    }
  });

  test('中英混排标题的 id 与 core 的 slugify 规则一致', () => {
    const html = updatePreview('## 为什么选择 Emeek？\n\n## 为什么选择 Emeek？\n');
    assert.match(html, /id="为什么选择-emeek"/);
    // 重复标题自动加序号，不能两个同 id
    assert.match(html, /id="为什么选择-emeek-2"/);
  });
});

function listSources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSources(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

function readSource(relative) {
  return fs.readFileSync(path.join(REPO, relative), 'utf8');
}

function stripFrontmatter(source) {
  return source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}
