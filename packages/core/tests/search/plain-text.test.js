import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { toPlainText, makeSnippet, locateTerms } from '../../src/search/plain-text.js';

describe('toPlainText', () => {
  test('剥掉 front-matter（元数据不该被搜到）', () => {
    const text = toPlainText('---\ntitle: x\ndraft: true\n---\n正文内容');
    assert.ok(!text.includes('draft'), `front-matter 泄漏进正文：${text}`);
    assert.ok(text.includes('正文内容'));
  });

  test('围栏代码块内容不参与检索', () => {
    const text = toPlainText('前文\n```js\nconst secret = 1;\n```\n后文');
    assert.ok(!text.includes('secret'), `代码块内容泄漏：${text}`);
    assert.ok(text.includes('前文') && text.includes('后文'));
  });

  test('图片整段丢弃，链接只留文字', () => {
    const text = toPlainText('![图](/a/b.png) 看 [这里](https://x.com) 结束');
    assert.ok(!text.includes('.png'), `图片路径泄漏：${text}`);
    assert.ok(!text.includes('x.com'), `链接 URL 泄漏：${text}`);
    assert.ok(text.includes('这里'));
  });

  test('行首标记（标题/引用/列表）被剥掉', () => {
    const text = toPlainText('# 标题\n> 引用\n- 列表项');
    assert.ok(!text.includes('#') && !text.includes('>'), text);
    assert.ok(text.includes('标题') && text.includes('列表项'));
  });

  test('模板注释被丢弃（不是正文）', () => {
    const text = toPlainText('前{# 这是模板注释 #}后');
    assert.ok(!text.includes('模板注释'), text);
  });

  test('模板注释内的词不参与检索', () => {
    const text = toPlainText('正文{# AI生成的内容 #}');
    assert.ok(!text.includes('AI生成'));
  });

  test('裸 URL 被移除', () => {
    const text = toPlainText('访问 https://example.com/path 获取');
    assert.ok(!text.includes('example.com'), text);
  });
});

describe('makeSnippet', () => {
  test('以命中词为中心截取（而非从头）', () => {
    const head = '甲'.repeat(200);
    const plain = `${head}命中词在很后面`;
    const { excerpt, offset } = makeSnippet(plain, ['命中词'], { limit: 60, lead: 10 });
    assert.ok(excerpt.includes('命中词'), `摘要里没有命中词：${excerpt}`);
    assert.ok(offset > 100, `offset 应指向命中处之后：${offset}`);
  });

  test('无命中词时从头截', () => {
    const { offset, excerpt } = makeSnippet('开头内容'.repeat(50), []);
    assert.equal(offset, 0);
    assert.ok(excerpt.startsWith('开头内容'));
  });

  test('按码点切，不劈开代理对', () => {
    const plain = '😀'.repeat(100);
    const { excerpt } = makeSnippet(plain, [], { limit: 10 });
    // 劈开代理对会产生 \ufffd 或孤立代理
    assert.ok(!/[\ud800-\udfff]/.test(excerpt.replace(/[\ud800-\udbff][\udc00-\udfff]/g, '')), '截断劈开了代理对');
    assert.equal([...excerpt].length, 10);
  });

  test('terms 只回在摘要窗口内的命中词', () => {
    const plain = `${'甲'.repeat(300)}目标词`;
    const { terms } = makeSnippet(plain, ['目标词', '不存在'], { limit: 40, lead: 5 });
    assert.ok(terms.includes('目标词'));
    assert.ok(!terms.includes('不存在'));
  });

  test('空文本返回空，不抛', () => {
    assert.deepEqual(makeSnippet('', ['x']), { excerpt: '', offset: 0, terms: [] });
  });
});

describe('locateTerms', () => {
  test('大小写不敏感，返回全部出现位置并升序', () => {
    const found = locateTerms('Blog 和 blog', ['blog']);
    assert.equal(found.length, 2);
    assert.ok(found[0].index < found[1].index);
  });

  test('空 needle 被忽略', () => {
    assert.deepEqual(locateTerms('abc', ['', null]), []);
  });
});
