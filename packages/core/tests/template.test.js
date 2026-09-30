import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, clearTemplateCache } from '../src/pipeline/render/liquid.js';

test('插值默认转义', () => {
  assert.equal(render('{{ x }}', { x: '<b>' }), '&lt;b&gt;');
});

test('三花括号输出原始 HTML', () => {
  assert.equal(render('{{{ x }}}', { x: '<b>hi</b>' }), '<b>hi</b>');
});

test('undefined 与 null 渲染为空', () => {
  assert.equal(render('[{{ missing }}]', {}), '[]');
  assert.equal(render('[{{ nil }}]', { nil: null }), '[]');
});

test('if / else if / else', () => {
  assert.equal(render('{% if a %}A{% else if b %}B{% else %}C{% endif %}', { a: 1 }), 'A');
  assert.equal(render('{% if a %}A{% else if b %}B{% else %}C{% endif %}', { b: 1 }), 'B');
  assert.equal(render('{% if a %}A{% else if b %}B{% else %}C{% endif %}', {}), 'C');
});

test('遍历数组暴露 loop 元信息', () => {
  const out = render('{% for x in xs %}{{ loop.index }}{{ loop.first ? "F" : "" }}{{ loop.last ? "L" : "" }}{% endfor %}', { xs: ['a', 'b'] });
  assert.equal(out, '1F2L');
});

test('遍历对象按键值对', () => {
  assert.equal(render('{% for k, v in m %}{{ k }}:{{ v }};{% endfor %}', { m: { a: 1, b: 2 } }), 'a:1;b:2;');
});

test('数组双变量形式给出值与下标', () => {
  assert.equal(render('{% for x, i in xs %}{{ i }}:{{ x }};{% endfor %}', { xs: ['a', 'b'] }), '0:a;1:b;');
});

test('嵌套循环的作用域互不污染', () => {
  const out = render('{% for g in gs %}{% for t in g %}{{ t }}{% endfor %}|{% endfor %}', { gs: [['a', 'b'], ['c']] });
  assert.equal(out, 'ab|c|');
});

test('循环内可访问顶层变量', () => {
  assert.equal(render('{% for x in xs %}{{ prefix }}{{ x }} {% endfor %}', { xs: [1, 2], prefix: 'n' }), 'n1 n2 ');
});

test('include 会拿到当前循环变量', () => {
  const out = render('{% for item in items %}[{% include "row" %}]{% endfor %}', {
    items: [{ n: 1 }, { n: 2 }],
    __render: (name, locals) => `${locals.item.n}`,
  });
  assert.equal(out, '[1][2]');
});

test('模板编译结果被缓存，行为一致', () => {
  clearTemplateCache();
  const a = render('{{ x }}', { x: 1 });
  const b = render('{{ x }}', { x: 2 });
  assert.equal(a, '1');
  assert.equal(b, '2');
});

test('未知标签被忽略而不是抛错', () => {
  assert.equal(render('a{% wat %}b', {}), 'ab');
});
