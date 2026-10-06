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

// `elsif` 是 Liquid/Jekyll 的写法，主题作者（从 Gmeek/Jekyll 过来的人）会用它。
// 不被识别时**不报错** —— 那个 if 分支不被闭合，两个分支同时渲染。
// 症状是「按钮/条目莫名出现两份」，而模板源码看起来完全正常。
// 我的 share partial 就是这么踩出来的。
test('elsif 与 else if 等价', () => {
  assert.equal(render('{% if a %}A{% elsif b %}B{% else %}C{% endif %}', { a: 1 }), 'A');
  assert.equal(render('{% if a %}A{% elsif b %}B{% else %}C{% endif %}', { b: 1 }), 'B',
    'elsif 命中时只能渲染 elsif 分支 —— 渲染出 C 说明它没被识别');
  assert.equal(render('{% if a %}A{% elsif b %}B{% else %}C{% endif %}', {}), 'C');
});

test('elsif 链式（多级）', () => {
  const tpl = '{% if a %}A{% elsif b %}B{% elsif c %}C{% else %}D{% endif %}';
  assert.equal(render(tpl, { a: 1 }), 'A');
  assert.equal(render(tpl, { b: 1 }), 'B');
  assert.equal(render(tpl, { c: 1 }), 'C');
  assert.equal(render(tpl, {}), 'D');
});

test('elsif 在循环里的分支互斥（不允许两个分支都渲染）', () => {
  const tpl = '{% for item in items %}{% if item.kind == "x" %}X{% elsif item.kind == "y" %}Y{% else %}Z{% endif %}{% endfor %}';
  assert.equal(render(tpl, { items: [{ kind: 'x' }, { kind: 'y' }, { kind: 'z' }] }), 'XYZ');
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
