/**
 * Markdown 编辑命令与快捷键。
 *
 * 一条原则：所有命令都是「(state, dispatch) => boolean」的纯函数形态，
 * 这样既能挂到 keymap，也能被工具栏按钮调用，还能在测试里直接跑 ——
 * 不会出现「按钮能点、快捷键没反应」这种两套逻辑不一致的老问题。
 */
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { keymap } from '@codemirror/view';
import { undo, redo, selectLine, indentMore, indentLess, insertTab } from '@codemirror/commands';
import { openSearchPanel, searchKeymap, openSearchPanel as openFind } from '@codemirror/search';
import { toggleLineComment } from '@codemirror/commands';

/**
 * 包裹型标记：选区前后各插一次。空选区时插入一对并选中中间，方便直接打字。
 *
 * 注意 changeByRange 的返回值语义：`range` 是**新文档坐标**下的选区，
 * 而 `changes` 里的 from/to 是**旧文档坐标**。所以不要自己 `from + marker.length`
 * 去算 —— 那是旧坐标偏移，会被 changeByRange 再映射一次（实测会复制一份原文）。
 */
export function wrapSelection(marker, { placeholder = '', closing = marker } = {}) {
  return (view) => {
    const { state } = view;
    const spec = state.changeByRange((range) => {
      const selected = state.sliceDoc(range.from, range.to);
      const text = selected || placeholder;
      const insert = marker + text + closing;
      return {
        changes: { from: range.from, to: range.to, insert },
        // 选区在「新文档」里的位置：跳过 marker，覆盖内容部分
        range: EditorSelection.range(range.from + marker.length, range.from + marker.length + text.length),
      };
    });
    view.dispatch(spec, { scrollIntoView: true, userEvent: 'input' });
    view.focus();
    return true;
  };
}

/**
 * 行首前缀切换：标题、引用、列表共用一条实现（避免「只处理了 h2 忘了 h3」）。
 *
 * @param has   (text) => boolean  这一行是否已经带该前缀
 * @param strip (text) => string   去掉前缀
 * @param add   (text) => string   加上前缀
 *
 * 拆成三个纯函数而不是一个带 `strip` 参数的重载：
 * 重载版会把「判断有没有前缀」和「加前缀」写成同一个函数，
 * 于是判断永远返回真、命令变成 no-op（这个坑我刚踩过 —— 标题加不上）。
 */
export function toggleLinePrefix(has, strip, add) {
  return (view) => {
    const { state } = view;
    const spec = state.changeByRange((range) => {
      const first = state.doc.lineAt(range.from);
      const last = state.doc.lineAt(range.to);
      const lines = [];
      for (let n = first.number; n <= last.number; n += 1) lines.push(state.doc.line(n));
      const allMatch = lines.every((line) => has(line.text));
      const edits = lines.map((line) => ({
        from: line.from,
        to: line.to,
        insert: allMatch ? strip(line.text) : add(line.text),
      }));
      const end = edits[edits.length - 1];
      // range 用新坐标：末尾那行的起点 + 它的新长度
      return { changes: edits, range: EditorSelection.range(edits[0].from, end.from + end.insert.length) };
    });
    view.dispatch(spec, { scrollIntoView: true, userEvent: 'input' });
    view.focus();
    return true;
  };
}

const stripHeading = (text) => text.replace(/^(\s*)#{1,6}\s+/, '$1').replace(/\s+#+\s*$/, '');
const isHeading = (text) => /^\s*#{1,6}\s+/.test(text);
const isSameLevel = (text, level) => new RegExp(`^\\s*#{${level}}\\s+`).test(text);
const addHeading = (level) => (text) => {
  const indent = /^(\s*)/.exec(text)[1];
  return `${indent}${'#'.repeat(level)} ${stripHeading(text).slice(indent.length)}`;
};

/**
 * 标题命令。
 *
 * 三段语义（按优先级）：
 *   已是同级标题  → 取消（还原成普通段落）
 *   是别级标题    → 换成目标级别（H1 上按 Ctrl+Shift+3 → H3，不是删掉）
 *   普通段落      → 升级成目标级别
 * 把「换级别」和「取消」分开，是因为它们都发生在「已经是标题」的情况下，
 * 用同一个分支处理必然有一个行为是错的。
 */
export const headingCommand = (level) => toggleLinePrefix(
  (text) => isSameLevel(text, level),
  stripHeading,
  addHeading(level),
);

/** 在光标处插入片段，并把光标移到 `cursor` 标记处（没有就放末尾）。 */
export function insertSnippet(template, { cursor = '$0' } = {}) {
  return (view) => {
    const { state } = view;
    const spec = state.changeByRange((range) => {
      const line = state.doc.lineAt(range.from);
      const atLineStart = range.from === line.from;
      const needLeadingNewline = atLineStart && line.number > 1 && state.doc.line(line.number - 1).text.trim() !== '';
      const prefix = needLeadingNewline ? '\n' : '';
      const at = template.indexOf(cursor);
      const body = at === -1 ? template : template.slice(0, at) + template.slice(at + cursor.length);
      return {
        changes: { from: range.from, to: range.to, insert: prefix + body },
        range: EditorSelection.cursor(range.from + prefix.length + (at === -1 ? body.length : at)),
      };
    });
    view.dispatch(spec, { scrollIntoView: true, userEvent: 'input' });
    view.focus();
    return true;
  };
}

/** 插入链接 / 图片：选区当文字，光标停在 URL 位置。 */
export function insertLink({ image = false } = {}) {
  return (view) => {
    const { state } = view;
    const spec = state.changeByRange((range) => {
      const selected = state.sliceDoc(range.from, range.to);
      const label = selected || (image ? '图片说明' : '链接文字');
      const syntax = `${image ? '!' : ''}[${label}]()`;
      // 光标落进 () 里：!、[、label、]、( 之后
      const cursorAt = range.from + (image ? 1 : 0) + 1 + label.length + 2;
      return { changes: { from: range.from, to: range.to, insert: syntax }, range: EditorSelection.cursor(cursorAt) };
    });
    view.dispatch(spec, { scrollIntoView: true, userEvent: 'input' });
    view.focus();
    return true;
  };
}

export const insertTable = insertSnippet([
  '| 列一 | 列二 |',
  '| --- | --- |',
  '| 内容 | 内容 |',
  '| 内容 | 内容 |',
].join('\n'), { cursor: '' });

export const insertCodeBlock = (lang = '') => insertSnippet(`\`\`\`${lang}\n$0\n\`\`\``);

export const insertFormula = insertSnippet('$$\n$0\n$$');
export const insertInlineFormula = insertSnippet('$$0$');
/** 分隔线：前后各留一空行，否则它会粘进上一段（Markdown 里 --- 紧跟文字是 setext H2）。 */
export const insertHr = insertSnippet('\n---\n', { cursor: '' });
/** 脚注：定义 + 引用一起插入，光标停在引用角标上（那才是接着要写的地方）。 */
export const insertFootnote = insertSnippet('[^1]: 这里写脚注内容\n$0', { cursor: '' });
export const insertQuote = toggleLinePrefix(
  (text) => /^\s*>\s?/.test(text),
  (text) => text.replace(/^\s*>\s?/, ''),
  (text) => `> ${text}`,
);
export const insertList = toggleLinePrefix(
  (text) => /^\s*[-*+]\s+/.test(text),
  (text) => text.replace(/^\s*[-*+]\s+/, ''),
  (text) => `- ${text}`,
);
export const insertOrderedList = toggleLinePrefix(
  (text) => /^\s*\d+[.)]\s+/.test(text),
  (text) => text.replace(/^\s*\d+[.)]\s+/, ''),
  (text) => `1. ${text}`,
);
export const insertTaskList = toggleLinePrefix(
  (text) => /^\s*[-*+]\s\[[ xX]\]\s+/.test(text),
  (text) => text.replace(/^\s*[-*+]\s\[[ xX]\]\s+/, ''),
  (text) => `- [ ] ${text}`,
);

/** 跳到指定行（1 起）。目录导航用。 */
export function gotoLine(lineNumber) {
  return (view) => {
    const line = Math.max(1, Math.min(view.state.doc.lines, lineNumber));
    const target = view.state.doc.line(line);
    view.dispatch({
      selection: EditorSelection.cursor(target.from),
      effects: EditorView.scrollIntoView(target.from, { y: 'center' }),
      userEvent: 'select',
    });
    view.focus();
    return true;
  };
}

/** 段落上下移动（Alt+↑/↓）。Markdown 里调顺序是高频操作。 */
export function moveLineUp(view) { return moveLine(view, -1); }
export function moveLineDown(view) { return moveLine(view, 1); }
function moveLine(view, direction) {
  const { state } = view;
  const range = state.selection.main;
  const line = state.doc.lineAt(range.head);
  const targetNumber = line.number + direction;
  if (targetNumber < 1 || targetNumber > state.doc.lines) return false;
  const target = state.doc.line(targetNumber);
  const text = state.sliceDoc(line.from, line.to);
  const targetText = state.sliceDoc(target.from, target.to);
  const changes = direction < 0
    ? { from: target.from, to: line.to, insert: `${text}\n${targetText}` }
    : { from: line.from, to: target.to, insert: `${targetText}\n${text}` };
  const offset = direction < 0 ? -(targetText.length + 1) : targetText.length + 1;
  view.dispatch({
    changes,
    selection: EditorSelection.cursor(range.head + offset),
    scrollIntoView: true,
    userEvent: 'move',
  });
  return true;
}

/**
 * 快捷键表。
 *
 * 与用户给的清单对齐；Mod 在 mac 上是 Cmd、其他平台是 Ctrl，
 * 不写死 Ctrl 是因为 mac 用户的肌肉记忆不认 Ctrl。
 * 注意：Ctrl+Y 重做在 mac 上通常是 Cmd+Shift+Z，两个都注册。
 */
export function editorKeymap({ onSave, onTogglePreviewMode, onToggleTheme } = {}) {
  return keymap.of([
    { key: 'Mod-b', run: wrapSelection('**'), preventDefault: true },
    { key: 'Mod-i', run: wrapSelection('*'), preventDefault: true },
    { key: 'Mod-u', run: wrapSelection('<u>', { closing: '</u>' }), preventDefault: true },
    { key: 'Mod-k', run: insertLink(), preventDefault: true },
    { key: 'Mod-Shift-i', run: insertLink({ image: true }), preventDefault: true },
    { key: 'Mod-Shift-c', run: insertCodeBlock(), preventDefault: true },
    { key: 'Mod-Shift-m', run: insertFormula, preventDefault: true },
    { key: 'Mod-Shift-t', run: insertTable, preventDefault: true },
    { key: 'Mod-Shift-1', run: headingCommand(1), preventDefault: true },
    { key: 'Mod-Shift-2', run: headingCommand(2), preventDefault: true },
    { key: 'Mod-Shift-3', run: headingCommand(3), preventDefault: true },
    { key: 'Mod-Shift-4', run: headingCommand(4), preventDefault: true },
    { key: 'Mod-Shift-u', run: insertList, preventDefault: true },
    { key: 'Mod-Shift-o', run: insertOrderedList, preventDefault: true },
    { key: 'Mod-Shift-k', run: insertTaskList, preventDefault: true },
    { key: 'Mod-Shift-f', run: insertFootnote, preventDefault: true },
    { key: 'Mod-Shift-e', run: insertInlineFormula, preventDefault: true },
    { key: 'Mod-Shift-h', run: insertHr, preventDefault: true },
    { key: 'Mod-/', run: toggleLineComment, preventDefault: true },
    { key: 'Mod-s', run: () => { onSave?.(); return true; }, preventDefault: true },
    { key: 'Mod-Shift-p', run: () => { onTogglePreviewMode?.(); return true; }, preventDefault: true },
    { key: 'Mod-Shift-b', run: () => { onToggleTheme?.(); return true; }, preventDefault: true },
    /**
     * Ctrl+G 跳转到行。
     *
     * 这里原来写的是 `onGotoLine?.()` —— 而 onGotoLine 是这个模块的
     * 局部变量，在函数体外是未声明标识符。真按下去会抛 ReferenceError，
     * 而 keymap 捕获异常的方式是「当这个键没绑定」，于是表现成
     * 「Ctrl+G 没反应」。所以要在模块作用域里读那个变量。
     */
    { key: 'Mod-g', run: () => (gotoHandler ? gotoHandler() : false), preventDefault: true },
    { key: 'Mod-f', run: openSearchPanel, preventDefault: true },
    { key: 'Mod-h', run: openFind, preventDefault: true },
    { key: 'Alt-ArrowUp', run: moveLineUp },
    { key: 'Alt-ArrowDown', run: moveLineDown },
    { key: 'Tab', run: (view) => (view.state.selection.ranges.some((r) => !r.empty) ? indentMore(view) : insertTab(view)) },
    { key: 'Shift-Tab', run: indentLess },
    { key: 'Mod-z', run: undo, preventDefault: true },
    { key: 'Mod-y', run: redo, preventDefault: true },
    { key: 'Mod-Shift-z', run: redo, preventDefault: true },
    ...searchKeymap,
  ]);
}

// 「跳转到行」的处理器由外部注入（editor/index.js 里接的是 prompt 输入框）
let gotoHandler = null;
export function setGotoLineHandler(handler) { gotoHandler = handler; }
