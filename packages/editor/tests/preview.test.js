/**
 * 预览层测试：增量渲染、分块、DOM 规范化、元数据。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { updatePreview, buildHtml, previewMeta, createIncrementalRenderer, splitBlocks, createWikiLinkResolver, BUILD_PROFILE, contentFingerprint, canonicalize } from '../src/preview/index.js';
import { stripMarkdown } from '../src/preview/strip.js';
import { canonicalizeHtml, htmlEquivalent, parseHtml, normalizeTree } from '../src/preview/dom.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

describe('增量渲染（诚实版：只做结果缓存，不做分块重渲染）', () => {
  test('内容不变时复用上次结果', () => {
    const render = createIncrementalRenderer({ render: updatePreview });
    const source = read('basic.md');
    const first = render(source);
    assert.equal(first.mode, 'full');
    const second = render(source);
    assert.equal(second.mode, 'cached');
    assert.equal(second.rendered, 0);
    assert.equal(second.html, first.html, '缓存命中的 HTML 必须与首次完全相同');
  });

  test('任何改动都走整篇渲染（保证与构建一致）', () => {
    const render = createIncrementalRenderer({ render: updatePreview });
    const source = '第一段\n\n第二段\n\n第三段';
    render(source);
    const changed = render(source.replace('第二段', '第二段改了'));
    assert.equal(changed.mode, 'full', '有改动就必须整篇渲染 —— 分块重渲染无法保证去重计数与脚注 id 正确');
    assert.ok(changed.html.includes('第二段改了'));
  });

  test('增量结果与整篇渲染永远一致（所有 fixture）', () => {
    for (const name of ['basic.md', 'with-tasks.md', 'with-table.md', 'with-links.md', 'edge-cases.md', 'with-footnotes.md', 'large-document.md']) {
      const source = read(name);
      const render = createIncrementalRenderer({ render: updatePreview });
      const first = render(source);
      const second = render(source);
      assert.equal(canonicalizeHtml(first.html), canonicalizeHtml(updatePreview(source)), `${name} 首次结果不一致`);
      assert.equal(canonicalizeHtml(second.html), canonicalizeHtml(updatePreview(source)), `${name} 缓存结果不一致`);
    }
  });

  test('关闭增量时行为相同（都是整篇渲染）', () => {
    const render = createIncrementalRenderer({ render: updatePreview, enabled: false });
    assert.equal(render('a\n\nb').mode, 'full');
  });

  test('内容指纹能区分细微改动', () => {
    assert.notEqual(contentFingerprint('abc'), contentFingerprint('abd'));
    assert.notEqual(contentFingerprint('abc'), contentFingerprint('abc '));
    assert.equal(contentFingerprint('abc'), contentFingerprint('abc'));
  });

  test('结构指纹能抓到标签层面的差异', () => {
    assert.notEqual(canonicalize('<p>a</p>'), canonicalize('<div>a</div>'));
    assert.notEqual(canonicalize('<ul><li>a</li></ul>'), canonicalize('<ul><li>a</li><li>a</li></ul>'));
    assert.equal(canonicalize('<p class="x">a</p>'), canonicalize('<p>a</p>'));
  });
});

describe('块切分（仅用于统计，不参与渲染）', () => {
  test('按顶层块切分', () => {
    assert.deepEqual(splitBlocks('# 标题\n\n段落'), ['# 标题', '段落']);
  });

  test('代码块内的空行不切', () => {
    const blocks = splitBlocks('```js\nconst a = 1;\n\nconst b = 2;\n```\n\n之后');
    assert.equal(blocks.length, 2);
    assert.ok(blocks[0].includes('const b = 2;'));
  });

  test('引用块的连续行不切', () => {
    const blocks = splitBlocks('> 第一行\n> 第二行\n>\n> 第三段\n\n之后');
    assert.equal(blocks.length, 2);
    assert.ok(blocks[0].includes('第三段'));
  });

  test('相邻列表项不切（切开会让编号与嵌套漂移）', () => {
    const blocks = splitBlocks('- [x] 一\n- [ ] 二\n- [X] 三\n\n段落');
    assert.equal(blocks.length, 2, '三个任务项必须在同一块里');
    assert.equal((blocks[0].match(/^- /gm) ?? []).length, 3);
  });

  test('表格的多行不切', () => {
    const blocks = splitBlocks('| a | b |\n| --- | --- |\n| 1 | 2 |\n\n之后');
    assert.equal(blocks.length, 2);
    assert.ok(blocks[0].split('\n').length >= 3);
  });

  test('列表的缩进续行不切', () => {
    const blocks = splitBlocks('- 第一项\n- 第二项\n\n  缩进段落\n\n后面');
    assert.ok(blocks.length <= 3);
    assert.ok(blocks[0].includes('缩进段落'), '缩进段落应与列表同块');
  });
});

describe('HTML 规范化', () => {
  test('属性顺序不影响等价判断', () => {
    assert.ok(htmlEquivalent('<a href="x" class="y">t</a>', '<a class="y" href="x">t</a>'));
  });

  test('void 元素的自闭合写法等价', () => {
    assert.ok(htmlEquivalent('<img src="a" />', '<img src="a">'));
  });

  test('标签名大小写不敏感', () => {
    assert.ok(htmlEquivalent('<P>a</P>', '<p>a</p>'));
  });

  test('HTML 实体等价于字面字符', () => {
    assert.ok(htmlEquivalent('<p>a &amp; b</p>', '<p>a &amp; b</p>'));
  });

  test('空白折叠（pre 之外）', () => {
    assert.ok(htmlEquivalent('<p>a   b</p>', '<p>a b</p>'));
  });

  test('pre 内部空白必须保留', () => {
    assert.equal(htmlEquivalent('<pre>a  b</pre>', '<pre>a b</pre>'), false);
  });

  test('结构差异一定判为不等价', () => {
    for (const [a, b] of [
      ['<p><img src="a" loading="lazy"></p>', '<p><img src="a"></p>'],
      ['<div class="code-block"><pre>x</pre></div>', '<pre>x</pre>'],
      ['<h2 id="a">t</h2>', '<h3 id="a">t</h3>'],
      ['<p>a</p>', '<p>b</p>'],
      ['<ul><li>a</li></ul>', '<ol><li>a</li></ol>'],
      ['<p><strong>a</strong></p>', '<p>a</p>'],
    ]) {
      assert.equal(htmlEquivalent(a, b), false, `${a} 与 ${b} 不该判为等价`);
    }
  });

  test('parseHtml 给出结构化的树', () => {
    const tree = parseHtml('<div class="x"><p>a</p></div>');
    assert.equal(tree.children[0].tag, 'div');
    assert.equal(tree.children[0].attrs.class, 'x');
    assert.equal(tree.children[0].children[0].tag, 'p');
  });

  test('normalizeTree 输出可读的规范形式', () => {
    assert.equal(normalizeTree(parseHtml('<p class="b" id="a">x</p>')), '<p class="b" id="a">x</p>');
  });
});

describe('预览元数据', () => {
  test('目录、摘要、字数、阅读时长齐备', () => {
    const meta = previewMeta(read('basic.md'));
    // 默认 minLevel=2（与构建期的主题配置一致）：h1 不进目录
    assert.ok(meta.toc.length >= 2);
    assert.ok(meta.toc.every((item) => item.level >= 2));
    assert.equal(meta.toc.length, 2, 'basic.md 有 h2 与 h3 各一个');
    assert.ok(meta.words > 0);
    assert.ok(meta.readingMinutes >= 1);
    assert.ok(meta.description.length > 0);
  });

  test('目录项 id 与 HTML 里的锚点一致', () => {
    const source = read('with-table.md');
    const meta = previewMeta(source);
    for (const item of meta.toc) {
      assert.ok(meta.html.includes(`id="${item.id}"`), `目录 ${item.id} 无对应锚点`);
    }
  });

  test('摘要里不含 HTML 标签', () => {
    assert.doesNotMatch(previewMeta(read('with-code.md')).description, /<[a-z/]/i);
  });
});

describe('纯文本剥离', () => {
  test('去掉标记、保留正文', () => {
    assert.equal(stripMarkdown('# 标题\n\n**粗** *斜* `码`').replace(/\s+/g, ' ').trim(), '标题 粗 斜 码');
  });

  test('front-matter 不算正文', () => {
    assert.equal(stripMarkdown('---\ntitle: x\n---\n\n正文').trim(), '正文');
  });

  test('双向链接保留显示文字', () => {
    assert.equal(stripMarkdown('见 [[目标|别名]]').trim(), '见 别名');
    assert.equal(stripMarkdown('见 [[目标]]').trim(), '见 目标');
  });

  test('图片保留 alt 文字', () => {
    assert.equal(stripMarkdown('![说明](/a.png)').trim(), '说明');
  });
});

describe('双向链接解析器', () => {
  const posts = [{ title: '另一篇', slug: 'other', url: '/posts/other.html' }];

  test('命中时给出真链接', () => {
    const html = updatePreview('见 [[另一篇]]。', { wikiLink: createWikiLinkResolver(posts) });
    assert.match(html, /href="\/posts\/other\.html"/);
  });

  test('未命中时给出带提示的 span，不假装成功', () => {
    const html = updatePreview('见 [[不存在]]。', { wikiLink: createWikiLinkResolver(posts) });
    assert.match(html, /wiki-link--missing/);
    assert.doesNotMatch(html, /<a /);
  });

  test('没有索引时退化为纯 span（与构建期一致）', () => {
    const html = updatePreview('见 [[另一篇]]。');
    assert.match(html, /<span class="wiki-link">/);
  });
});

describe('渲染配置档', () => {
  test('BUILD_PROFILE 的默认值与构建一致', () => {
    assert.equal(BUILD_PROFILE.allowHtml, false, '构建默认不信任内容里的 HTML');
    assert.equal(BUILD_PROFILE.lazyImages, true);
    assert.equal(BUILD_PROFILE.anchorLinks, true);
  });

  test('buildHtml 与 updatePreview 是同一件事', () => {
    const source = read('with-code.md');
    assert.equal(canonicalizeHtml(buildHtml(source)), canonicalizeHtml(updatePreview(source)));
  });

  test('allowHtml 关闭时脚本被转义', () => {
    const html = updatePreview('<script>alert(1)</script>');
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;/);
  });
});
