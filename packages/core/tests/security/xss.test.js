/**
 * 消毒的回归测试。
 *
 * 这一组不是「顺手加的」，它是 PR-1 的验收本体：
 * 每一条断言都对应一个真的能在浏览器里执行脚本的向量。
 * 削弱消毒 → 这里必须红。
 *
 * 真浏览器那一段（点一下链接看 window.__xss 会不会被写）在
 * scripts/e2e/xss.mjs 里，因为它需要 Chromium 与一个进程外断言。
 * 这里守的是「渲染器吐出的 HTML 结构」——它更早、更快、能进普通 CI。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../../src/pipeline/parse/markdown.js';
import { renderArticle } from '../../src/pipeline/render/index.js';
import { sanitizeUrl, isSafeUrl } from '../../src/pipeline/parse/sanitize-url.js';
import { sanitizeHtml } from '../../src/pipeline/parse/sanitize-html.js';
import { resolveWikiLink, buildWikiLinkIndex } from '../../src/pipeline/transform/links.js';

const render = (src, options = {}) => renderMarkdown(String(src), options);

/** 一段 HTML 里有没有「活的」东西：真标签上的事件属性或危险协议。 */
function liveDanger(html) {
  const tags = String(html).match(/<[a-z][^>]*>/gi) ?? [];
  return tags.filter((tag) => /\son[a-z]+\s*=/i.test(tag)
    || /(?:href|src)\s*=\s*["']?\s*(?:javascript|vbscript|data:text\/html)/i.test(tag));
}

describe('URL 消毒', () => {
  test('放行常规协议与相对路径', () => {
    for (const url of ['http://a.example/x', 'https://a.example', 'mailto:a@b.c', 'tel:+8610', '/rel/path', './x.md', '#anchor', '?q=1', '//host/path', 'a/b']) {
      assert.equal(isSafeUrl(url), true, `${url} 应当放行`);
    }
  });

  test('拒绝可执行协议，大小写与空白都不放过', () => {
    const rejected = [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      '  javascript:alert(1)',
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      'java\rscript:alert(1)',
      '\u0000javascript:alert(1)',
      'vbscript:msgbox(1)',
      'data:text/html,<script>alert(1)</script>',
      'blob:https://a/b',
      'file:///etc/passwd',
      'filesystem:http://a/temporary/x',
    ];
    for (const url of rejected) {
      assert.equal(isSafeUrl(url), false, `${url} 必须被拒绝`);
    }
  });

  test('data: 只让图片 MIME 通过', () => {
    assert.equal(isSafeUrl('data:image/png;base64,iVBORw0KGgo=', { allowData: true }), true);
    assert.equal(isSafeUrl('data:image/svg+xml,<svg/>', { allowData: true }), true);
    assert.equal(isSafeUrl('data:text/html,<script>x</script>', { allowData: true }), false);
    assert.equal(isSafeUrl('data:image/png;base64,x', { allowData: false }), false, '没显式放开时 data: 一律拒');
  });

  test('sanitizeUrl 返回原值而不是改写（改写会让相对路径的语义漂移）', () => {
    assert.equal(sanitizeUrl('/a/b?c=1#d'), '/a/b?c=1#d');
    assert.equal(sanitizeUrl('javascript:1'), null);
  });
});

describe('渲染链路：链接与图片', () => {
  test('javascript: 链接不生成 <a>，退回纯文本', () => {
    for (const src of [
      '[x](javascript:alert(1))',
      '[x](JaVaScRiPt:alert(1))',
      '[x](vbscript:alert(1))',
      '[x](data:text/html,<script>alert(1)</script>)',
      '[x](javascript:alert(1) "title")',
    ]) {
      const html = render(src);
      assert.equal(liveDanger(html).length, 0, `${src} 渲染出了活的链接：${html}`);
      assert.doesNotMatch(html, /<a\b/, `${src} 不该生成 <a>`);
    }
  });

  test('javascript: 图片地址不生成 <img>', () => {
    const html = render('![x](javascript:alert(1))');
    assert.doesNotMatch(html, /<img\b/);
  });

  test('data:text/html 图片被拒，data:image 图片放行', () => {
    assert.doesNotMatch(render('![x](data:text/html,<script>alert(1)</script>)'), /<img\b/);
    assert.match(render('![x](data:image/png;base64,iVBORw0KGgo=)'), /<img\b/);
  });

  test('合法的外链与相对链接不受影响', () => {
    assert.match(render('[a](https://a.example)'), /<a href="https:\/\/a\.example">/);
    assert.match(render('[a](/posts/x.html)'), /<a href="\/posts\/x\.html">/);
    assert.match(render('[a](#p-1)'), /<a href="#p-1">/);
  });

  test('resolveLink 返回危险地址时同样被拒（消毒在 resolve 之后）', () => {
    const html = render('[a](x)', { resolveLink: () => 'javascript:alert(1)' });
    assert.doesNotMatch(html, /<a\b/);
  });
});

describe('渲染链路：原始 HTML', () => {
  test('allowHtml=false 时一切标签都是纯文本', () => {
    for (const src of [
      '<img src=x onerror="window.__xss=1">',
      '<script>window.__xss=1</script>',
      '<svg onload="window.__xss=1"></svg>',
      '<iframe srcdoc="<script>parent.__xss=1</script>"></iframe>',
      '<div style="width:expression(window.__xss=1)">x</div>',
      '<!--><script>window.__xss=1</script>-->',
      '<details open ontoggle="window.__xss=1">x</details>',
      '<base href="javascript:window.__xss=1">',
      '<meta http-equiv="refresh" content="0;url=javascript:window.__xss=1">',
      '<object data="javascript:window.__xss=1"></object>',
    ]) {
      const html = render(src, { allowHtml: false });
      assert.equal(liveDanger(html).length, 0, `${src} 渲染出了活标签：${html}`);
      // 渲染器自己只产出这些标签，多出来就是正文里的原始标签漏了出去
      const tags = [...html.matchAll(/<\/?([a-z][a-z0-9-]*)/gi)].map((m) => m[1].toLowerCase());
      for (const tag of tags) {
        assert.ok(['p', 'br'].includes(tag), `allowHtml=false 下不该出现 <${tag}>：${html}`);
      }
    }
  });

  test('allowHtml=true 时结构化标签保留，可执行部分剥掉', () => {
    const html = render('<div class="note"><script>window.__xss=1</script><b>正文</b></div>', { allowHtml: true });
    assert.match(html, /<div class="note">/, '普通标签要留下');
    assert.match(html, /<b>正文<\/b>/);
    assert.doesNotMatch(html, /<script/i);
    assert.equal(liveDanger(html).length, 0);
  });

  test('allowHtml=true 时事件属性与非白名单协议仍被剥', () => {
    const html = render('<img src=x onerror="window.__xss=1"><a href="javascript:window.__xss=1">x</a>', { allowHtml: true });
    assert.doesNotMatch(html, /onerror/i);
    assert.doesNotMatch(html, /javascript:/i);
    assert.equal(liveDanger(html).length, 0);
  });

  test('注释越界（<!--> 提前结束注释）不能藏脚本', () => {
    const html = render('<!--><script>window.__xss=1</script>-->', { allowHtml: true });
    assert.doesNotMatch(html, /<script/i);
  });
});

describe('sanitizeHtml 单测', () => {
  test('drop-with-content 标签被连内容一起丢掉', () => {
    assert.equal(sanitizeHtml('<script>bad()</script>ok'), 'ok');
    assert.equal(sanitizeHtml('<iframe src="x"></iframe>ok'), 'ok');
  });

  test('style 里的 expression / url(javascript:) 整条属性丢掉', () => {
    assert.doesNotMatch(sanitizeHtml('<div style="width:expression(alert(1))">x</div>'), /style=/);
    assert.doesNotMatch(sanitizeHtml('<div style="background:url(javascript:alert(1))">x</div>'), /style=/);
    assert.match(sanitizeHtml('<div style="color:red">x</div>'), /style="color:red"/);
  });

  test('非标签的尖括号被转义', () => {
    assert.equal(sanitizeHtml('<javascript:alert(1)>'), '&lt;javascript:alert(1)&gt;');
  });

  test('属性值里的引号编码后跳不出属性', () => {
    // 实体形式的引号在属性值内部不结束属性，所以 onmouseover 只是文字；
    // 关键是它不能变成一个真的属性 —— 真属性的形态是空格 + 名字（未被编码）。
    const out = sanitizeHtml('<div title="a&quot; onmouseover=&quot;x">y</div>');
    assert.match(out, /title="/, 'title 应当保留');
    // 出现形态是 `&amp;quot;`（编码后的引号）而不是 `"` —— 说明它留在属性值里面，
    // 没有把 title 提前结束、也没有升格成同级属性。
    assert.match(out, /onmouseover=&amp;quot;/, 'onmouseover 应当仍被包在 title 的值里');
    assert.doesNotMatch(out, /\sonmouseover="/, '不该出现以真引号开头的 onmouseover 属性');
  });
});

describe('双向链接', () => {
  test('urlPattern 返回危险地址时不生成 <a>', () => {
    const index = buildWikiLinkIndex([{ title: 'A', slug: 'a' }], { urlPattern: () => 'javascript:window.__xss=1' });
    const html = resolveWikiLink(index, 'A');
    assert.doesNotMatch(html, /<a\b/);
  });

  test('正常 urlPattern 照常生成链接，且 slug 被转义', () => {
    const index = buildWikiLinkIndex([{ title: 'A', slug: 'a"><img onerror=x>' }], { urlPattern: (p) => `/posts/${p.slug}.html` });
    const html = resolveWikiLink(index, 'A');
    assert.match(html, /<a class="wiki-link"/);
    assert.doesNotMatch(html, /<img/);
  });
});

describe('整篇渲染（renderArticle）', () => {
  test('frontmatter 里的 HTML 不会被当成正文渲染出脚本', () => {
    const src = '---\ntitle: "x<script>window.__xss=1</script>"\n---\n\n正文\n';
    const html = renderArticle(src, { allowHtml: true, lazyImages: true, headingIds: new Map() });
    assert.doesNotMatch(html, /<script/i);
  });

  test('代码块里的脚本只是文本，不执行', () => {
    const html = renderArticle('```html\n<script>window.__xss=1</script>\n```\n', { lazyImages: true, headingIds: new Map() });
    // 高亮器会把 <script> 拆成多个 span，所以按「有没有真正的 <script> 标签」判，
    // 而不是按「字符串里有没有 &lt;script&gt;」判 —— 后者会被高亮切碎。
    assert.equal(liveDanger(html).length, 0);
    const tags = [...html.matchAll(/<\/?([a-z][a-z0-9-]*)/gi)].map((m) => m[1].toLowerCase());
    assert.ok(!tags.includes('script'), '代码块里的 script 不该成为真标签');
    assert.match(html, /tok-/, '高亮应当生效（说明走的是渲染链路而不是转义后直出）');
  });
});
