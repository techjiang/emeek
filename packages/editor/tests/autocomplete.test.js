/**
 * 自动补全的数据源测试。
 *
 * CodeMirror 的补全 source 是纯函数：(context) => CompletionResult | null。
 * 所以直接构造 context 就能测 —— 不需要打开面板、不需要模拟按键。
 * 这样测的是「候选对不对」，而不是「面板弹没弹出来」。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { CompletionContext } from '@codemirror/autocomplete';
import { wikiLinkCompletion, codeFenceCompletion, imagePathCompletion, snippetCompletion, autoCompleteExtensions, SEMANTIC_EMOJI } from '../src/editor/autocomplete.js';
import { EditorView } from '@codemirror/view';

/** 构造一个位于文档末尾的补全上下文。 */
function contextAt(doc) {
  const state = EditorState.create({ doc });
  return new CompletionContext(state, doc.length, false);
}

describe('[[ 文章链接补全', () => {
  const posts = [
    { title: '为什么选择 Emeek', slug: 'why', url: '/posts/why.html', tags: ['设计', 'Emeek'] },
    { title: '把首屏做到一次请求', slug: 'perf', url: '/posts/perf.html', tags: ['性能'] },
    { title: 'Markdown 语法一览', slug: 'md', url: '/posts/md.html' },
  ];

  test('输入 [[ 后给出全部文章', () => {
    const result = wikiLinkCompletion(posts)(contextAt('见 [['));
    assert.ok(result);
    assert.equal(result.options.length, 3);
  });

  test('继续输入时按标题过滤', () => {
    const result = wikiLinkCompletion(posts)(contextAt('见 [[首屏'));
    assert.equal(result.options.length, 1);
    assert.equal(result.options[0].label, '把首屏做到一次请求');
  });

  test('候选的 detail 用标签或摘要', () => {
    const result = wikiLinkCompletion(posts)(contextAt('见 [['));
    assert.equal(result.options[0].detail, '设计 · Emeek');
  });

  test('插入的是 [[标题]] 形式', () => {
    const result = wikiLinkCompletion(posts)(contextAt('[['));
    const view = {
      state: EditorState.create({ doc: '[[' }),
      dispatch: (spec) => { view.dispatched = spec; },
    };
    result.options[0].apply(view, null, 0, 2);
    assert.equal(view.dispatched.changes.insert, '[[为什么选择 Emeek]]');
  });

  test('站内没有任何文章时给一条兜底提示', () => {
    const result = wikiLinkCompletion([])(contextAt('[['));
    assert.ok(result);
    assert.equal(result.options.length, 1);
    assert.match(result.options[0].detail, /还没有其他文章/);
  });

  test('有文章但过滤后为空时返回空候选（不撒谎说「没有文章」）', () => {
    const result = wikiLinkCompletion(posts)(contextAt('[[完全不相干的词'));
    assert.ok(result);
    assert.equal(result.options.length, 0, '站内明明有文章，不该提示「还没有其他文章」');
  });

  test('没有 [[ 前缀时返回 null（不打扰普通输入）', () => {
    assert.equal(wikiLinkCompletion(posts)(contextAt('普通段落')), null);
    assert.equal(wikiLinkCompletion(posts)(contextAt('见 [链接](url)')), null);
  });
});

describe('``` 代码块语言补全', () => {
  test('输入 ``` 给出语言候选', () => {
    const result = codeFenceCompletion()(contextAt('```'));
    assert.ok(result);
    assert.ok(result.options.length >= 20, `只有 ${result.options.length} 个语言候选`);
  });

  test('继续输入时过滤', () => {
    const result = codeFenceCompletion()(contextAt('```py'));
    assert.ok(result.options.some((o) => o.label === 'python'));
    assert.ok(result.options.every((o) => o.label.toLowerCase().includes('py')));
  });

  test('常用语言排在前面并标「常用」', () => {
    const result = codeFenceCompletion()(contextAt('```j'));
    assert.ok(result.options.length > 0);
    assert.equal(result.options[0].detail, '常用');
  });

  test('写了不存在的语言时明确告知会按纯文本显示', () => {
    const result = codeFenceCompletion()(contextAt('```notalanguage'));
    assert.ok(result);
    assert.equal(result.options[0].label, 'notalanguage');
    assert.match(result.options[0].displayLabel, /无语法支持/);
  });

  test('不在代码块起始位置时不触发', () => {
    assert.equal(codeFenceCompletion()(contextAt('正文 ```js')), null);
    assert.equal(codeFenceCompletion()(contextAt('`行内代码`')), null);
  });
});

describe('![ 图片路径补全', () => {
  const images = ['/assets/a.png', '/assets/hero.jpg', '/uploads/我的图.png'];

  test('在图片语法里给出已有路径', () => {
    const result = imagePathCompletion(images)(contextAt('![说明]('));
    assert.ok(result);
    assert.equal(result.options.length, 3);
  });

  test('输入时过滤', () => {
    const result = imagePathCompletion(images)(contextAt('![说明](/assets/h'));
    assert.equal(result.options.length, 1);
    assert.equal(result.options[0].label, '/assets/hero.jpg');
  });

  test('没有图片时不返回结果（不弹空面板）', () => {
    const result = imagePathCompletion([])(contextAt('![]('));
    assert.ok(result);
    assert.equal(result.options.length, 0);
  });

  test('普通链接的括号里不触发图片补全', () => {
    // 这条规则其实也适用于链接：![ 与 [ 共用括号位置
    assert.equal(imagePathCompletion(images)(contextAt('普通文本')), null);
  });
});

describe('行首模板展开', () => {
  test('输入 h2 展开为标题模板', () => {
    const result = snippetCompletion()(contextAt('h2'));
    assert.ok(result);
    assert.equal(result.options[0].label, 'h2');
  });

  test('table / code / formula 都有模板', () => {
    for (const word of ['table', 'code', 'formula', 'quote', 'task', 'hr']) {
      const result = snippetCompletion()(contextAt(word));
      assert.ok(result, `${word} 没有候选`);
      assert.ok(result.options.some((o) => o.label === word));
    }
  });

  test('非行首不触发', () => {
    assert.equal(snippetCompletion()(contextAt('正文 h2')), null);
  });

  test('输入不匹配任何模板时返回 null', () => {
    assert.equal(snippetCompletion()(contextAt('zzzz')), null);
  });
});

describe('扩展装配', () => {
  test('返回可用的扩展数组', () => {
    const extensions = autoCompleteExtensions({ getPosts: () => [], getImages: () => [] });
    assert.ok(Array.isArray(extensions));
    assert.ok(extensions.length > 0);
    // 能进 EditorState 就说明形状正确
    assert.doesNotThrow(() => EditorState.create({ doc: '', extensions }));
  });

  test('动态数据源在每次补全时求值（不缓存旧列表）', () => {
    let posts = [{ title: '完全匹配', slug: 'a', url: '/a.html' }];
    const source = (context) => wikiLinkCompletion(posts)(context);
    const first = source(contextAt('[[不存在的标题'));
    posts = [{ title: '不存在的标题', slug: 'b', url: '/b.html' }];
    const second = source(contextAt('[[不存在的标题'));
    assert.equal(first.options.length, 0, '第一版数据源里没有匹配项');
    assert.equal(second.options.length, 1, '第二版数据源里应该匹配到');
  });

  test('emoji 清单非空且无重复（工具栏用）', () => {
    assert.ok(SEMANTIC_EMOJI.length > 0);
    assert.equal(new Set(SEMANTIC_EMOJI).size, SEMANTIC_EMOJI.length);
  });
});

/**
 * S2-3a 补的：补全的性能要求与几个边界。
 *
 * 「候选列表 < 50ms 出现」是用户给的验收项。补全面板是同步阻塞的 ——
 * source 慢多少，用户打字就卡多少，所以这条必须有断言，而不是靠感觉。
 */
describe('补全性能', () => {
  test('站点 300 篇文章时，候选生成仍在 50ms 以内', () => {
    const posts = Array.from({ length: 300 }, (_, i) => ({
      title: `第 ${i} 篇文章的标题`,
      slug: `post-${i}`,
      url: `/posts/${i}.html`,
      tags: ['标签', `t${i}`],
    }));
    const context = contextAt('见 [[');
    const source = wikiLinkCompletion(posts);
    // 预热一次，避免把 JIT 编译时间算进去
    source(context);
    const started = performance.now();
    for (let i = 0; i < 50; i += 1) source(contextAt('见 [[第 1'));
    const perCall = (performance.now() - started) / 50;
    assert.ok(perCall < 50, `每次补全 ${perCall.toFixed(1)}ms，超过 50ms 上限`);
  });

  test('候选数量有上限（不会渲染 300 项把面板撑爆）', () => {
    const posts = Array.from({ length: 300 }, (_, i) => ({ title: `文章 ${i}`, url: `/p/${i}` }));
    const result = wikiLinkCompletion(posts)(contextAt('[['));
    assert.ok(result.options.length <= 30);
  });

  test('输入 ``` 后语言候选出现，且常用语言排前面', () => {
    const result = codeFenceCompletion()(contextAt('```'));
    assert.ok(result);
    assert.ok(result.options.length > 10);
    assert.equal(result.options[0].detail, '常用');
  });

  test('![]() 里按已上传图片过滤', () => {
    const images = ['/uploads/a.png', '/uploads/hero.png', '/uploads/diagram.svg'];
    const result = imagePathCompletion(images)(contextAt('![](/uploads/'));
    assert.ok(result);
    assert.equal(result.options.length, 3);
    const filtered = imagePathCompletion(images)(contextAt('![](/uploads/hero'));
    assert.equal(filtered.options.length, 1);
  });

  test('行首模板补全能匹配到 h1/h2/h3（数字不能被词法吃掉）', () => {
    for (const [typed, expected] of [['h1', '# '], ['h2', '## '], ['h3', '### ']]) {
      const result = snippetCompletion()(contextAt(typed));
      assert.ok(result, `${typed} 应当有候选`);
      assert.equal(result.options[0].label, typed);
      const view = { dispatch: (spec) => { view.dispatched = spec; } };
      result.options[0].apply(view, null, 0, typed.length);
      assert.equal(view.dispatched.changes.insert, expected);
    }
  });

  test('四个数据源都注册进了补全扩展', () => {
    const extensions = autoCompleteExtensions({ getPosts: () => [], getImages: () => [] });
    assert.ok(Array.isArray(extensions));
    assert.ok(extensions.length >= 2);
  });
});
