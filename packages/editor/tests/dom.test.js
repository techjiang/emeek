/**
 * 需要 DOM 的模块：编辑器装配、主题切换、补全面板、图片拖拽。
 *
 * 用 jsdom 而不是真浏览器：这些测试要验证的是「装配出来的状态对不对」，
 * 不涉及渲染引擎行为。真浏览器留给 UI 验收（截图），自动化留给这里 ——
 * 两者测的东西不一样，不该互相替代。
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { THEMES, themeExtensions, isDarkTheme } from '../src/editor/themes.js';
import { findLanguage, isKnownLanguage, codeLanguageDescriptions } from '../src/editor/languages.js';

const { setupDom, createHost } = await import('./helpers/dom.js');
await setupDom();

const { createEmeekEditor } = await import('../src/editor/index.js');

describe('编辑器装配', () => {
  let host;
  before(() => { host = document.getElementById('host'); });

  test('能创建编辑器并拿到文档内容', () => {
    const editor = createEmeekEditor({ doc: '# 标题\n\n正文', parent: host });
    assert.equal(editor.getText(), '# 标题\n\n正文');
    editor.destroy();
  });

  test('onChange 在文档变化时收到新内容', () => {
    const seen = [];
    const editor = createEmeekEditor({ doc: 'a', parent: host, onChange: (text) => seen.push(text) });
    editor.setText('b');
    assert.deepEqual(seen, ['b']);
    editor.destroy();
  });

  test('onOutlineChange 在标题变化时刷新目录', () => {
    const outlines = [];
    const editor = createEmeekEditor({ doc: '# 一', parent: host, onOutlineChange: (outline) => outlines.push(outline.length) });
    assert.ok(outlines.length >= 1, '装配完成时应立刻给一次目录');
    editor.setText('# 一\n\n## 二');
    assert.equal(outlines.at(-1), 2);
    editor.destroy();
  });

  test('onStats 随光标移动更新', () => {
    const stats = [];
    const editor = createEmeekEditor({ doc: '第一行\n第二行', parent: host, onStats: (s) => stats.push(s.line) });
    editor.jumpToLine(2);
    assert.equal(stats.at(-1), 2);
    editor.destroy();
  });

  test('setText 替换全文后目录跟着变', () => {
    const editor = createEmeekEditor({ doc: '# 旧', parent: host });
    editor.setText('# 新\n\n## 子标题');
    assert.deepEqual(editor.outline().map((i) => i.text), ['新', '子标题']);
    editor.destroy();
  });

  test('cursorPosition 反映行列', () => {
    const editor = createEmeekEditor({ doc: 'abc\ndef', parent: host });
    editor.jumpToLine(2);
    const pos = editor.cursorPosition();
    assert.equal(pos.line, 2);
    assert.equal(pos.total, 2);
  });

  test('runCommand 与 exec 都能执行命令对象', async () => {
    const { wrapSelection } = await import('../src/editor/commands.js');
    const editor = createEmeekEditor({ doc: 'hello', parent: host });
    editor.view.dispatch({ selection: { anchor: 0, head: 5 } });
    // 工具栏走 exec（先聚焦），快捷键走同一批命令对象 —— 保证两条路径行为一致
    editor.runCommand(wrapSelection('**'));
    assert.equal(editor.getText(), '**hello**');
    editor.destroy();
  });

  test('exec 与 runCommand 对同一输入给出同一结果', async () => {
    const { wrapSelection } = await import('../src/editor/commands.js');
    const a = createEmeekEditor({ doc: 'word', parent: host });
    a.view.dispatch({ selection: { anchor: 0, head: 4 } });
    a.exec(wrapSelection('*'));
    const b = createEmeekEditor({ doc: 'word', parent: host });
    b.view.dispatch({ selection: { anchor: 0, head: 4 } });
    b.runCommand(wrapSelection('*'));
    assert.equal(a.getText(), b.getText());
    a.destroy(); b.destroy();
  });

  test('themes getter 暴露可用主题', () => {
    const editor = createEmeekEditor({ doc: '', parent: host });
    assert.ok(editor.themes.length >= 3);
    editor.destroy();
  });
});

describe('主题', () => {
  test('至少提供 3 种主题（含暗色与亮色）', () => {
    assert.ok(THEMES.length >= 3);
    assert.ok(THEMES.some((t) => t.dark));
    assert.ok(THEMES.some((t) => !t.dark));
  });

  test('isDarkTheme 区分明暗', () => {
    assert.equal(isDarkTheme('one-dark'), true);
    assert.equal(isDarkTheme('dracula'), true);
    assert.equal(isDarkTheme('github-light'), false);
    assert.equal(isDarkTheme('one-light'), false);
  });

  test('未知主题退回暗色（不返回空数组，否则编辑器会没样式）', () => {
    const extensions = themeExtensions('不存在的主题');
    assert.ok(Array.isArray(extensions));
    assert.ok(extensions.length > 0);
  });

  test('每种主题都能产出扩展数组', () => {
    for (const theme of THEMES) {
      const ext = themeExtensions(theme.id);
      assert.ok(Array.isArray(ext) && ext.length > 0, `${theme.id} 没有产出扩展`);
    }
  });

  test('切换主题不改变文档内容与撤销栈之外的可见状态', () => {
    const editor = createEmeekEditor({ doc: '# 标题', parent: document.getElementById('host') });
    const before = editor.getText();
    editor.setTheme('github-light');
    assert.equal(editor.getText(), before);
    editor.setTheme('dracula');
    assert.equal(editor.getText(), before);
    editor.destroy();
  });

  test('主题切换只重配 Compartment（view 对象不变）', () => {
    const editor = createEmeekEditor({ doc: 'x', parent: document.getElementById('host') });
    const view = editor.view;
    editor.setTheme('one-light');
    assert.equal(editor.view, view, '切换主题不该重建 EditorView（会丢光标与撤销栈）');
    editor.destroy();
  });
});

describe('软换行与只读开关', () => {
  test('setLineWrapping 不重建视图', () => {
    const editor = createEmeekEditor({ doc: 'x', parent: document.getElementById('host') });
    const view = editor.view;
    editor.setLineWrapping(false);
    editor.setLineWrapping(true);
    assert.equal(editor.view, view);
    editor.destroy();
  });

  test('setReadOnly 阻止编辑', () => {
    const editor = createEmeekEditor({ doc: 'x', parent: document.getElementById('host') });
    editor.setReadOnly(true);
    assert.equal(editor.state.readOnly, true);
    editor.destroy();
  });
});

describe('自动补全的候选来源', () => {
  test('代码块语言候选来自懒加载注册表', () => {
    const names = codeLanguageDescriptions.map((d) => d.name);
    for (const lang of ['JavaScript', 'Python', 'SQL', 'LaTeX']) {
      assert.ok(names.includes(lang));
    }
  });

  test('未知语言不会被列为候选', () => {
    assert.equal(isKnownLanguage('notalanguage'), false);
    assert.equal(findLanguage('notalanguage'), null);
  });
});
