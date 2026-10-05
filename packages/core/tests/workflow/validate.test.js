import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validatePosts, VALIDATION_RULES } from '../../src/workflow/validate.js';

/**
 * 内容校验。
 *
 * 这一层的价值全在**「每一条都能真的失败」**：一条永远不触发的检查
 * 等于没有检查。所以下面的用例都是「构造一个真有问题内容 → 断言它被抓到」。
 */

const post = (o = {}) => ({
  title: '正常标题', slug: 'ok', url: '/posts/ok.html', date: '2025-01-01',
  tags: [], categories: [], raw: '正文。', ...o,
});

describe('内容校验 · 标题', () => {
  test('空标题报错（并给出怎么修）', () => {
    const { issues } = validatePosts([post({ title: '' })], { checks: ['title'] });
    assert.equal(issues.length, 1);
    assert.equal(issues[0].severity, 'error');
    assert.equal(issues[0].rule, 'title');
    assert.ok(issues[0].fix, '每条问题都必须带修法');
  });

  test('默认标题 untitled 只是警告（不影响可读性，但值得知道）', () => {
    const { issues } = validatePosts([post({ title: 'untitled' })], { checks: ['title'] });
    assert.equal(issues[0].severity, 'warn');
  });

  test('正常标题不报', () => {
    assert.equal(validatePosts([post()], { checks: ['title'] }).issues.length, 0);
  });
});

describe('内容校验 · 日期', () => {
  test('无法解析的日期是错误', () => {
    const { issues } = validatePosts([post({ date: 'not-a-date' })], { checks: ['date'] });
    assert.equal(issues.length, 1);
    assert.equal(issues[0].severity, 'error');
  });

  test('更新日期早于发布日期是警告', () => {
    const { issues } = validatePosts([post({ date: '2025-05-01', updated: '2025-01-01' })], { checks: ['date'] });
    assert.equal(issues.length, 1);
    assert.equal(issues[0].severity, 'warn');
  });
});

describe('内容校验 · 分类与标签', () => {
  test('含逗号的标签被点出来（`tags: a, b` 在 YAML 里是一整个字符串）', () => {
    const { issues } = validatePosts([post({ tags: ['a, b'] })], { checks: ['taxonomy'] });
    assert.equal(issues.length, 1);
    assert.match(issues[0].message, /逗号/);
    assert.match(issues[0].fix, /数组/);
  });

  test('过长的标签被点出来（多半是整句被误当标签）', () => {
    const { issues } = validatePosts([post({ tags: ['这是一句非常长的话被当成了标签'.repeat(3)] })], { checks: ['taxonomy'] });
    assert.equal(issues.length, 1);
  });

  test('正常标签不报', () => {
    assert.equal(validatePosts([post({ tags: ['技术', 'blog'], categories: ['设计'] })], { checks: ['taxonomy'] }).issues.length, 0);
  });
});

describe('内容校验 · Markdown', () => {
  test('未闭合的代码块围栏是错误（后面全部内容会被吞进代码块）', () => {
    const { issues } = validatePosts([post({ raw: '正文\n```js\nconst a = 1;\n' })], { checks: ['markdown'] });
    assert.equal(issues.length, 1);
    assert.equal(issues[0].severity, 'error');
    assert.match(issues[0].message, /围栏/);
  });

  test('成对的围栏不报', () => {
    assert.equal(validatePosts([post({ raw: '```js\nconst a = 1;\n```\n' })], { checks: ['markdown'] }).issues.length, 0);
  });

  test('空正文是错误', () => {
    const { issues } = validatePosts([post({ raw: '   ' })], { checks: ['markdown'] });
    assert.equal(issues[0].severity, 'error');
  });

  test('未闭合的链接/图片是警告', () => {
    const { issues } = validatePosts([post({ raw: '看这里 [链接](/a' })], { checks: ['markdown'] });
    assert.ok(issues.some((i) => /闭合/.test(i.message)));
  });

  test('Tab 缩进的列表被点出来（不同渲染器展开宽度不一致）', () => {
    const { issues } = validatePosts([post({ raw: '- a\n\t- b\n' })], { checks: ['markdown'] });
    assert.equal(issues.length, 1);
    assert.match(issues[0].message, /Tab/);
  });
});

describe('内容校验 · 本地文件引用', () => {
  const knownFiles = new Set(['/assets/exists.png']);

  test('引用了不存在的本地图片 → 警告', () => {
    const { issues } = validatePosts([post({ raw: '![图](/assets/missing.png)' })], { checks: ['links'], knownFiles });
    assert.equal(issues.length, 1);
    assert.match(issues[0].message, /不存在/);
    assert.match(issues[0].fix, /\/assets\/missing\.png/);
  });

  test('存在的图片不报', () => {
    assert.equal(validatePosts([post({ raw: '![图](/assets/exists.png)' })], { checks: ['links'], knownFiles }).issues.length, 0);
  });

  test('远程地址不查（构建期不联网）', () => {
    assert.equal(validatePosts([post({ raw: '![图](https://cdn.example.com/a.png)' })], { checks: ['links'], knownFiles }).issues.length, 0);
  });

  test('拿不到文件清单时跳过（宁可少查一项，也不凭猜报警）', () => {
    assert.equal(validatePosts([post({ raw: '![图](/assets/missing.png)' })], { checks: ['links'] }).issues.length, 0);
  });
});

describe('内容校验 · 站内链接', () => {
  const urlSet = new Set(['/posts/a.html', '/archive.html']);

  test('内链指向不存在的页面 → 警告', () => {
    const { issues } = validatePosts([post({ raw: '[看](/posts/typo.html)' })], { checks: ['internal-links'], urlSet });
    assert.equal(issues.length, 1);
    assert.match(issues[0].message, /没有对应页面/);
  });

  test('存在的内链不报', () => {
    assert.equal(validatePosts([post({ raw: '[看](/posts/a.html)' })], { checks: ['internal-links'], urlSet }).issues.length, 0);
  });

  test('图片语法不算内链（![...] 不参与站内链接检查）', () => {
    assert.equal(validatePosts([post({ raw: '![图](/posts/whatever.png)' })], { checks: ['internal-links'], urlSet }).issues.length, 0);
  });

  test('带锚点的内链按页面判断（# 后面的片段不参与）', () => {
    assert.equal(validatePosts([post({ raw: '[看](/posts/a.html#section)' })], { checks: ['internal-links'], urlSet }).issues.length, 0);
  });
});

describe('内容校验 · 总体', () => {
  test('checks 为空时跑全部规则', () => {
    const { issues } = validatePosts([post({ title: '' })], { checks: [] });
    assert.ok(issues.some((i) => i.rule === 'title'));
  });

  test('counts 分别统计 error 与 warn', () => {
    const { counts } = validatePosts([
      post({ title: '', raw: '- a\n\t- b\n' }),
    ], { checks: [] });
    assert.equal(counts.error, 1, '空标题 = 1 个错误');
    assert.equal(counts.warn, 1, 'Tab 列表 = 1 个警告');
  });

  test('规则名清单是稳定契约', () => {
    assert.deepEqual(VALIDATION_RULES, ['title', 'date', 'links', 'markdown', 'taxonomy', 'internal-links']);
  });

  test('每条问题都带 file / rule / message / fix 四要素', () => {
    const { issues } = validatePosts([post({ title: '', file: '/x/posts/bad.md' })], { checks: [] });
    for (const item of issues) {
      assert.ok(item.file, 'file');
      assert.ok(item.rule, 'rule');
      assert.ok(item.message, 'message');
      assert.ok(item.fix, 'fix');
    }
  });

  test('文件路径不泄漏绝对路径（只留 posts/ 之后的部分）', () => {
    const { issues } = validatePosts([post({ title: '', file: '/home/user/secret-project/posts/bad.md' })], { checks: ['title'] });
    assert.equal(issues[0].file, 'posts/bad.md');
    assert.ok(!issues[0].file.includes('/home/user'));
  });
});
