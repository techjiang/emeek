/**
 * 编辑器内核单测。
 *
 * 不需要浏览器：CodeMirror 的 state 层是纯函数式的，命令都是
 * (state, dispatch) => boolean。所以「Ctrl+B 有没有加粗」可以在 Node 里
 * 直接断言 —— 比开一个浏览器点一遍快两个数量级，而且失败信息更准。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EditorState, EditorSelection } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { wrapSelection, insertSnippet, insertLink, headingCommand, toggleLinePrefix, moveLineUp, moveLineDown, insertCodeBlock } from '../src/editor/commands.js';
import { buildOutline, activeHeadingIndex, headingSlug } from '../src/editor/outline.js';
import { countWords, readingTime, stripForCount, editorStats } from '../src/editor/stats.js';
import { SUPPORTED_LANGUAGES, findLanguage, isKnownLanguage, loadLanguageSupport } from '../src/editor/languages.js';
import { slugify } from '@emeeek/core/render';

/**
 * 无 DOM 的执行环境：命令只用到 state 与 dispatch。
 * CodeMirror 的 changeByRange / dispatch 都是纯状态变换，不需要真实视图。
 */
function runCommand(doc, command, { anchor = 0, head = anchor, selections = null } = {}) {
  const state = EditorState.create({
    doc,
    selection: selections ?? EditorSelection.range(anchor, head),
  });
  const view = {
    state,
    dispatch: (...args) => {
      // CodeMirror 的 dispatch 接受多个 spec；逐个叠加成一笔事务。
      // 命令里用的是 state.changeByRange() 的返回值（{changes, range}），
      // 交给 state.update 即可 —— 不需要真的视图。
      view.state = view.state.update(...args).state;
    },
    focus: () => {},
  };
  command(view);
  return { doc: view.state.doc.toString(), selection: view.state.selection.main };
}

describe('编辑命令：选区包裹', () => {
  test('加粗包裹选中文字', () => {
    const { doc } = runCommand('hello world', wrapSelection('**'), { anchor: 0, head: 5 });
    assert.equal(doc, '**hello** world');
  });

  test('没有选区时插入标记并把光标放进中间', () => {
    const { doc, selection } = runCommand('abc', wrapSelection('**'), { anchor: 3 });
    assert.equal(doc, 'abc****');
    assert.equal(selection.from, 5, '光标应落在 ** 与 ** 之间');
  });

  test('斜体与删除线共用同一条实现', () => {
    assert.equal(runCommand('x', wrapSelection('*'), { anchor: 0, head: 1 }).doc, '*x*');
    assert.equal(runCommand('x', wrapSelection('<u>', { closing: '</u>' }), { anchor: 0, head: 1 }).doc, '<u>x</u>');
  });

  test('链接：选区当文字，光标停在 URL 括号里', () => {
    const { doc, selection } = runCommand('点这里', insertLink(), { anchor: 0, head: 3 });
    assert.equal(doc, '[点这里]()');
    assert.equal(selection.from, 6);
  });

  test('图片：![] 前缀', () => {
    const { doc } = runCommand('图', insertLink({ image: true }), { anchor: 0, head: 1 });
    assert.equal(doc, '![图]()');
  });
});

describe('编辑命令：行首前缀切换', () => {
  test('标题：把普通行升级成 H2，再切回来', () => {
    const once = runCommand('标题', headingCommand(2), { anchor: 0 });
    assert.equal(once.doc, '## 标题');
    const twice = runCommand(once.doc, headingCommand(2), { anchor: 0 });
    assert.equal(twice.doc, '标题');
  });

  test('标题：H1 切到 H3 只换级别，不叠加 #', () => {
    // H3 命令作用在 H1 上：isHeading 为真 → 走 strip（去掉现有 #），
    // 但用户想要的是「改成 H3」，所以这里期望直接替换级别。
    // 实现上由 addHeading 负责「已经是标题但级别不同」的情况。
    const { doc } = runCommand('# 标题', headingCommand(3), { anchor: 0 });
    assert.equal(doc, '### 标题');
  });

  test('标题：保留缩进', () => {
    const { doc } = runCommand('    缩进标题', headingCommand(2), { anchor: 0 });
    assert.equal(doc, '    ## 缩进标题');
  });

  test('前缀切换覆盖多行', () => {
    const { doc } = runCommand('a\nb', toggleLinePrefix((t, strip) => (strip ? t.replace(/^- /, '') : t), (t) => `- ${t}`), { anchor: 0, head: 3 });
    assert.equal(doc, '- a\n- b');
  });
});

describe('编辑命令：插入片段', () => {
  test('代码块模板把光标放进块内', () => {
    const { doc, selection } = runCommand('', insertCodeBlock('js'), { anchor: 0 });
    assert.equal(doc, '```js\n\n```');
    assert.equal(selection.from, '```js\n'.length, '光标应在围栏与结束符之间');
  });

  test('光标不在行首时不额外补换行（原地插入）', () => {
    const { doc } = runCommand('正文', insertSnippet('| a |', { cursor: '' }), { anchor: 2 });
    assert.equal(doc, '正文| a |');
  });

  test('行首插入片段且上一行有内容时补一个换行', () => {
    const { doc } = runCommand('正文\n', insertSnippet('| a |', { cursor: '' }), { anchor: 3 });
    assert.equal(doc, '正文\n\n| a |');
  });
});

describe('编辑命令：段落上下移动', () => {
  test('Alt+↑ 把当前行与上一行互换', () => {
    const { doc } = runCommand('第一行\n第二行', moveLineUp, { anchor: 5 });
    assert.equal(doc, '第二行\n第一行');
  });

  test('Alt+↓ 同理', () => {
    const { doc } = runCommand('第一行\n第二行', moveLineDown, { anchor: 1 });
    assert.equal(doc, '第二行\n第一行');
  });

  test('首行向上移动是 no-op（不抛错）', () => {
    const { doc } = runCommand('唯一一行', moveLineUp, { anchor: 1 });
    assert.equal(doc, '唯一一行');
  });
});

/**
 * 目录抽取必须在「带 Markdown 解析器」的状态上测。
 *
 * 裸 EditorState 没有语法树，buildOutline 会返回空数组 —— 那样的测试
 * 看起来通过（断言空数组也「没错」），实际什么都没验证。所以这里显式带上扩展。
 */
const mdState = (doc) => EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });

describe('目录抽取', () => {
  const doc = [
    '# 一', '', '正文', '',
    '## 1.1', '',
    '```', '# 这不是标题，是代码注释', '```', '',
    '## 1.2', '',
    '### 1.2.1', '',
    '## 1.2', '',
  ].join('\n');

  test('只认真正的标题，不认代码块里的 #', () => {
    const outline = buildOutline(mdState(doc));
    const texts = outline.map((item) => item.text.replace(/#+$/, ''));
    assert.deepEqual(texts, ['一', '1.1', '1.2', '1.2.1', '1.2']);
    assert.ok(!texts.some((t) => t.includes('代码注释')));
  });

  test('层级与行号正确', () => {
    const outline = buildOutline(mdState(doc));
    assert.deepEqual(outline.map((i) => i.level), [1, 2, 2, 3, 2]);
    assert.deepEqual(outline.map((i) => i.line), [1, 5, 11, 13, 15]);
  });

  test('重复标题加序号，与 core 的锚点规则一致', () => {
    const outline = buildOutline(mdState('# 标题\n\n# 标题\n'));
    assert.deepEqual(outline.map((i) => i.id), ['标题', '标题-2']);
  });

  test('当前章节索引：光标在第一篇之前是 -1', () => {
    const outline = buildOutline(mdState(doc));
    assert.equal(activeHeadingIndex(outline, 0), -1);
    assert.equal(activeHeadingIndex(outline, 6), 1);
    assert.equal(activeHeadingIndex(outline, 14), 3);
  });
});

describe('标题锚点规则与 core 一致（不允许两份实现漂移）', () => {
  const cases = ['标题', 'Hello World', '为什么选择 Emeek？', 'a  b', '!!!', '中English混排', '  首尾空格  ', '符号 @#$% 与 emoji 🎉'];

  for (const text of cases) {
    test(`slugify("${text}") 与 core 相同`, () => {
      // core 的去重计数用 headingSeq，编辑器侧用同一套基名规则
      assert.equal(headingSlug(text), slugify(text, { headingSeq: new Map() }));
    });
  }
});

describe('统计口径与 core 的 excerpt 一致', () => {
  test('中文字符按字计，英文按词计', () => {
    assert.equal(countWords('你好世界'), 4);
    assert.equal(countWords('hello world'), 2);
    assert.equal(countWords('你好 world'), 3);
  });

  test('front-matter 与代码块不计入字数', () => {
    const doc = '---\ntitle: x\n---\n\n正文\n\n```js\nconst aVeryLongVariableName = 1;\n```\n';
    assert.equal(countWords(doc), 2, '只应统计「正文」两个字');
  });

  test('行内代码与链接文字按可见文本计', () => {
    assert.equal(countWords('`code`'), 0, '行内代码是代码，不是正文');
    assert.equal(countWords('[链接文字](https://x.com)'), 4);
  });

  test('阅读时长最小 1 分钟', () => {
    assert.equal(readingTime(''), 1);
    assert.equal(readingTime('字'), 1);
  });

  test('stripForCount 保留正文、去掉标记', () => {
    assert.equal(stripForCount('# 标题\n\n> 引用\n\n- 列表').replace(/\s+/g, ' ').trim(), '标题 引用 列表');
  });

  test('editorStats 给出行列与选中长度', () => {
    // 「第一行\n第二行」：offset 0-2 是「第一行」，3 是换行，4-6 是「第二行」
    // range(4,7) → 光标头在 7 即第二行末尾之后
    const state = EditorState.create({ doc: '第一行\n第二行', selection: EditorSelection.range(4, 7) });
    const stats = editorStats(state);
    assert.equal(stats.lines, 2);
    assert.equal(stats.selected, 3);
    // 光标头 7 落在第二行（从 4 开始）内，列 = 7 - 4 + 1 = 4
    assert.equal(stats.line, 2);
    assert.equal(stats.column, 4);
  });
});
