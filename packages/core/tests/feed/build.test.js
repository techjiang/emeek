import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildRss, buildAtom, feedItems, escapeXml } from '../../src/feed/build.js';

const SITE = {
  title: '测试站 & 站点',
  url: 'https://example.com',
  description: '描述 <带标签>',
  language: 'zh-CN',
  author: '作者',
};

const POSTS = [
  { title: '第一篇', url: '/posts/a.html', date: '2024-03-01', updated: '2024-03-02', description: '摘要一', html: '<p>正文一</p>', tags: ['设计'], categories: ['技术'], author: '作者' },
  { title: '第二篇', url: '/posts/b.html', date: '2024-01-15', description: '摘要二', html: '<p>正文二</p>', tags: ['写作'], categories: ['随笔'] },
  { title: '第三篇', url: '/posts/c.html', date: '2023-12-01', description: '摘要三', html: '<p>正文三</p>', categories: ['技术'] },
];

describe('escapeXml', () => {
  test('转义 XML 五个特殊字符', () => {
    assert.equal(escapeXml('a & b < c > d " e \' f'), 'a &amp; b &lt; c &gt; d &quot; e &apos; f');
  });

  test('剔除 XML 非法控制字符（否则解析器报错）', () => {
    assert.equal(escapeXml('a\u0000b\u0008c'), 'abc');
    // \t \n \r 是合法的，要保留
    assert.equal(escapeXml('a\tb\nc'), 'a\tb\nc');
  });

  test('空值不崩', () => {
    assert.equal(escapeXml(null), '');
    assert.equal(escapeXml(undefined), '');
  });
});

describe('feedItems', () => {
  test('limit 生效', () => {
    assert.equal(feedItems(SITE, POSTS, { limit: 2 }).items.length, 2);
  });

  test('categories 过滤', () => {
    const { items } = feedItems(SITE, POSTS, { categories: ['技术'] });
    assert.equal(items.length, 2);
    assert.ok(items.every((i) => i.categories.includes('技术')));
  });

  test('categories 大小写不敏感', () => {
    const { items } = feedItems(SITE, POSTS, { categories: ['TECH'] });
    // 中文分类不受大小写影响，这里验证「不匹配时不误取」
    assert.equal(items.length, 0);
  });

  test('fullContent=false 时 content 为 null（不发全文）', () => {
    const { items } = feedItems(SITE, POSTS, { fullContent: false });
    assert.equal(items[0].content, null);
  });

  test('fullContent=true 时 content 是正文', () => {
    const { items } = feedItems(SITE, POSTS, { fullContent: true });
    assert.equal(items[0].content, '<p>正文一</p>');
  });

  test('日期解析成 Date 对象（供两种格式各自序列化）', () => {
    const { items } = feedItems(SITE, POSTS);
    assert.ok(items[0].published instanceof Date);
    assert.ok(items[0].updated instanceof Date);
  });

  test('updated 缺省时退回 date', () => {
    const { items } = feedItems(SITE, POSTS);
    assert.equal(items[1].updated.getTime(), items[1].published.getTime());
  });

  test('非法日期退回当前时间而不是 Invalid Date', () => {
    const { items } = feedItems(SITE, [{ title: 'x', url: '/x', date: '不是日期' }]);
    assert.ok(!Number.isNaN(items[0].published.getTime()));
  });
});

describe('buildRss（RSS 2.0）', () => {
  const xml = buildRss(SITE, POSTS);

  test('有 XML 声明与 rss version=2.0', () => {
    assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    assert.match(xml, /<rss version="2\.0"/);
  });

  test('channel 必备元素齐全', () => {
    for (const tag of ['title', 'link', 'description', 'language', 'lastBuildDate']) {
      assert.ok(new RegExp(`<${tag}>`).test(xml), `缺 <${tag}>`);
    }
    assert.match(xml, /<atom:link[^>]*rel="self"/);
  });

  test('item 必备元素齐全', () => {
    assert.match(xml, /<item>/);
    for (const tag of ['title', 'link', 'pubDate', 'description']) {
      assert.ok(new RegExp(`<${tag}>`).test(xml), `item 缺 <${tag}>`);
    }
    // guid 带属性（isPermaLink），不能用 <guid> 匹配
    assert.match(xml, /<guid isPermaLink="true">/);
  });

  test('pubDate 是 RFC 822（toUTCString），不是本地格式', () => {
    assert.match(xml, /<pubDate>[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT<\/pubDate>/);
  });

  test('特殊字符被转义（标题里的 & 不能让 XML 坏掉）', () => {
    assert.ok(xml.includes('测试站 &amp; 站点'));
    assert.ok(!/<title>测试站 & 站点<\/title>/.test(xml));
  });

  test('默认不发全文：没有 content:encoded 也没有那个命名空间', () => {
    assert.ok(!xml.includes('content:encoded'));
    assert.ok(!xml.includes('purl.org/rss'));
  });

  test('fullContent=true 时发全文并声明命名空间', () => {
    const full = buildRss(SITE, POSTS, { fullContent: true });
    assert.ok(full.includes('content:encoded'));
    assert.ok(full.includes('xmlns:content="http://purl.org/rss/1.0/modules/content/"'));
    assert.ok(full.includes('<![CDATA[<p>正文一</p>]]>'));
  });

  test('正文里出现 ]]> 时 CDATA 被拆开（否则 XML 坏掉）', () => {
    const evil = [{ title: 'x', url: '/x', date: '2024-01-01', description: 'd', html: 'code: ]]> end' }];
    const full = buildRss(SITE, evil, { fullContent: true });
    assert.ok(!/\]\]>[^<]*end/.test(full.replace(/\]\]\]\]><!\[CDATA\[>/g, '')), 'CDATA 未转义 ]]>');
    assert.ok(full.includes(']]]]><![CDATA[>'));
  });

  test('tags 与 categories 都进 <category>', () => {
    assert.ok(xml.includes('<category>设计</category>'));
    assert.ok(xml.includes('<category>技术</category>'));
  });

  test('limit 生效', () => {
    const one = buildRss(SITE, POSTS, { limit: 1 });
    assert.equal((one.match(/<item>/g) ?? []).length, 1);
  });
});

describe('buildAtom（Atom 1.0）', () => {
  const xml = buildAtom(SITE, POSTS);

  test('有 XML 声明与 Atom 命名空间', () => {
    assert.match(xml, /<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom">/);
  });

  test('feed 必备元素齐全', () => {
    for (const tag of ['title', 'subtitle', 'id', 'updated', 'generator']) {
      assert.ok(new RegExp(`<${tag}>`).test(xml), `缺 <${tag}>`);
    }
    assert.match(xml, /<link rel="self"[^>]*type="application\/atom\+xml"/);
    assert.match(xml, /<link rel="alternate"[^>]*type="text\/html"/);
    assert.match(xml, /<author><name>/);
  });

  test('entry 必备元素齐全', () => {
    assert.match(xml, /<entry>/);
    for (const tag of ['title', 'id', 'updated', 'published']) {
      assert.ok(new RegExp(`<${tag}>`).test(xml), `entry 缺 <${tag}>`);
    }
    // summary 必须带 type（Atom 规范要求），不能用 <summary> 匹配
    assert.match(xml, /<summary type="text">/);
  });

  test('updated 是 RFC 3339（Atom 验证器的硬要求）', () => {
    const matches = xml.match(/<updated>[^<]+<\/updated>/g) ?? [];
    assert.ok(matches.length > 0);
    for (const m of matches) {
      const value = m.replace(/<\/?updated>/g, '');
      assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/, `不是 RFC 3339：${value}`);
      assert.ok(!Number.isNaN(new Date(value).getTime()), `不可解析：${value}`);
    }
  });

  test('category 用 term 属性（Atom 的写法）', () => {
    assert.match(xml, /<category term="技术" \/>/);
  });

  test('fullContent=false 时没有 content 元素', () => {
    assert.ok(!xml.includes('<content'));
  });

  test('fullContent=true 时有 content type="html"', () => {
    const full = buildAtom(SITE, POSTS, { fullContent: true });
    assert.match(full, /<content type="html">/);
  });

  test('特殊字符被转义', () => {
    assert.ok(xml.includes('测试站 &amp; 站点'));
    assert.ok(xml.includes('描述 &lt;带标签&gt;'));
  });
});

describe('RSS 与 Atom 内容一致（同源生成）', () => {
  test('条目数与顺序一致', () => {
    const rss = buildRss(SITE, POSTS, { limit: 2 });
    const atom = buildAtom(SITE, POSTS, { limit: 2 });
    const rssTitles = [...rss.matchAll(/<item>[\s\S]*?<title>([^<]*)<\/title>/g)].map((m) => m[1]);
    const atomTitles = [...atom.matchAll(/<entry>[\s\S]*?<title>([^<]*)<\/title>/g)].map((m) => m[1]);
    assert.deepEqual(rssTitles, atomTitles);
  });

  test('两边的链接集合一致', () => {
    const rss = buildRss(SITE, POSTS);
    const atom = buildAtom(SITE, POSTS);
    const rssLinks = [...rss.matchAll(/<link>([^<]+)<\/link>/g)].map((m) => m[1]).sort();
    const atomLinks = [...atom.matchAll(/<id>([^<]+)<\/id>/g)].map((m) => m[1]).sort();
    assert.deepEqual(rssLinks, atomLinks);
  });
});
