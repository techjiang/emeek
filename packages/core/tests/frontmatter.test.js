import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter, parseYaml } from '../src/pipeline/parse/frontmatter.js';

test('解析基本标量', () => {
  const { data } = parseFrontmatter('---\ntitle: 标题\ncount: 3\nok: true\nnone: null\n---\n正文');
  assert.equal(data.title, '标题');
  assert.equal(data.count, 3);
  assert.equal(data.ok, true);
  assert.equal(data.none, null);
});

test('行内数组与块状数组', () => {
  const { data } = parseFrontmatter('---\ntags: [a, b]\nlist:\n  - x\n  - y\n---\n');
  assert.deepEqual(data.tags, ['a', 'b']);
  assert.deepEqual(data.list, ['x', 'y']);
});

test('单层嵌套对象', () => {
  const { data } = parseFrontmatter('---\nseo:\n  title: T\n  index: false\n---\n');
  assert.deepEqual(data.seo, { title: 'T', index: false });
});

test('多行字符串 | 保留换行，> 折叠为空格', () => {
  const block = parseFrontmatter('---\na: |\n  第一行\n  第二行\n---\n').data.a;
  const folded = parseFrontmatter('---\na: >\n  第一行\n  第二行\n---\n').data.a;
  assert.equal(block, '第一行\n第二行\n');
  assert.equal(folded, '第一行 第二行\n');
});

test('没有 front-matter 时原样返回正文', () => {
  const { data, content, hasFrontmatter } = parseFrontmatter('# 只有正文');
  assert.deepEqual(data, {});
  assert.equal(content, '# 只有正文');
  assert.equal(hasFrontmatter, false);
});

test('忽略注释行', () => {
  assert.deepEqual(parseYaml('# 注释\na: 1'), { a: 1 });
});

test('值里的冒号不会被误当分隔符', () => {
  assert.equal(parseYaml('url: https://a.com/b').url, 'https://a.com/b');
});
