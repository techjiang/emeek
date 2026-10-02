/**
 * 编辑器主题。
 *
 * One Dark 直接复用官方包；GitHub Light 与 Dracula 用 lezer 的 classHighlighter
 * 把语法 token 映射成 CSS class，主题只是 CSS —— 加第三、第四个主题是改字符串，
 * 不是写新代码。这是「主题可切换」能落地的关键。
 */
import { EditorView } from '@codemirror/view';
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { oneDark, oneDarkHighlightStyle } from '@codemirror/theme-one-dark';
import { tags as t } from '@lezer/highlight';

export const THEMES = [
  { id: 'one-dark', name: 'One Dark', dark: true, owner: 'dark' },
  { id: 'github-light', name: 'GitHub Light', dark: false, owner: 'light' },
  { id: 'dracula', name: 'Dracula', dark: true, owner: 'dracula' },
  { id: 'one-light', name: 'One Light', dark: false, owner: 'light' },
];

const PALETTE = {
  'one-light': {
    dark: false,
    ui: { bg: '#fafafa', fg: '#383a42', gutter: '#9d9d9f', gutterBg: '#f0f0f1', caret: '#526fff', selection: '#e5e5e6', activeLine: '#f2f2f2', panel: '#ffffff', border: '#e0e0e0', accent: '#4078f2' },
    tokens: {
      keyword: { color: '#a626a4' }, atom: { color: '#986801' }, number: { color: '#986801' },
      string: { color: '#50a14f' }, comment: { color: '#a0a1a7', fontStyle: 'italic' },
      variableName: { color: '#e45649' }, def: { color: '#4078f2' }, typeName: { color: '#c18401' },
      heading: { color: '#4078f2', fontWeight: '700' }, link: { color: '#0184bc', textDecoration: 'underline' },
      meta: { color: '#986801' }, tagName: { color: '#e45649' }, attributeName: { color: '#986801' },
      propertyName: { color: '#e45649' }, operator: { color: '#0184bc' }, invalid: { color: '#ffffff', backgroundColor: '#e45649' },
    },
  },
  'github-light': {
    dark: false,
    ui: { bg: '#ffffff', fg: '#1f2328', gutter: '#8c959f', gutterBg: '#f6f8fa', caret: '#0969da', selection: '#b6e3ff', activeLine: '#f6f8fa', panel: '#ffffff', border: '#d1d9e0', accent: '#0969da' },
    tokens: {
      keyword: { color: '#cf222e' }, atom: { color: '#0550ae' }, number: { color: '#0550ae' },
      string: { color: '#0a3069' }, comment: { color: '#6e7781', fontStyle: 'italic' },
      variableName: { color: '#953800' }, def: { color: '#8250df' }, typeName: { color: '#953800' },
      heading: { color: '#0969da', fontWeight: '700' }, link: { color: '#0969da', textDecoration: 'underline' },
      meta: { color: '#0550ae' }, tagName: { color: '#116329' }, attributeName: { color: '#0550ae' },
      propertyName: { color: '#0550ae' }, operator: { color: '#cf222e' }, invalid: { color: '#82071e', backgroundColor: '#ffebe9' },
    },
  },
  dracula: {
    dark: true,
    ui: { bg: '#282a36', fg: '#f8f8f2', gutter: '#6272a4', gutterBg: '#21222c', caret: '#f8f8f0', selection: '#44475a', activeLine: '#323544', panel: '#21222c', border: '#191a21', accent: '#bd93f9' },
    tokens: {
      keyword: { color: '#ff79c6' }, atom: { color: '#bd93f9' }, number: { color: '#bd93f9' },
      string: { color: '#f1fa8c' }, comment: { color: '#6272a4', fontStyle: 'italic' },
      variableName: { color: '#f8f8f2' }, def: { color: '#50fa7b' }, typeName: { color: '#8be9fd', fontStyle: 'italic' },
      heading: { color: '#bd93f9', fontWeight: '700' }, link: { color: '#8be9fd', textDecoration: 'underline' },
      meta: { color: '#f1fa8c' }, tagName: { color: '#ff79c6' }, attributeName: { color: '#50fa7b' },
      propertyName: { color: '#8be9fd' }, operator: { color: '#ff79c6' }, invalid: { color: '#f8f8f2', backgroundColor: '#ff5555' },
    },
  },
};

const uiTheme = (palette) => EditorView.theme({
  '&': {
    color: palette.ui.fg,
    backgroundColor: palette.ui.bg,
    fontSize: 'var(--studio-font-size, 14px)',
    fontFamily: 'var(--font-mono)',
    height: '100%',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.7', overflow: 'auto' },
  '.cm-content': { caretColor: palette.ui.caret, padding: '16px 8px 40vh' },
  '.cm-line': { padding: '0 8px' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: palette.ui.caret, borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: palette.ui.selection,
  },
  '.cm-gutters': {
    backgroundColor: palette.ui.gutterBg,
    color: palette.ui.gutter,
    border: 'none',
    borderRight: `1px solid ${palette.ui.border}`,
  },
  '.cm-activeLine': { backgroundColor: palette.ui.activeLine },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: palette.ui.fg },
  '.cm-foldPlaceholder': { backgroundColor: 'transparent', border: 'none', color: palette.ui.gutter },
  '.cm-panels': { backgroundColor: palette.ui.panel, color: palette.ui.fg },
  '.cm-panels.cm-panels-top': { borderBottom: `1px solid ${palette.ui.border}` },
  '.cm-panels.cm-panels-bottom': { borderTop: `1px solid ${palette.ui.border}` },
  '.cm-searchMatch': { backgroundColor: 'transparent', outline: `1px solid ${palette.ui.accent}` },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: palette.ui.selection },
  '.cm-tooltip': {
    backgroundColor: palette.ui.panel,
    border: `1px solid ${palette.ui.border}`,
    borderRadius: '6px',
    color: palette.ui.fg,
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: palette.ui.accent, color: '#fff' },
  '.cm-panels .cm-textfield': { backgroundColor: palette.ui.bg, color: palette.ui.fg, border: `1px solid ${palette.ui.border}`, borderRadius: '4px' },
  '.cm-panels .cm-button': { backgroundColor: palette.ui.gutterBg, backgroundImage: 'none', border: `1px solid ${palette.ui.border}`, borderRadius: '4px', color: palette.ui.fg },
  // 文档结构标记：Markdown 的 #、**、``` 之类的「语法噪声」压低对比度，
  // 让正文更好读，同时不隐藏 —— 隐藏了就没法选中删除。
  '.cm-md-marker': { color: palette.ui.gutter, opacity: '0.75' },
  '.cm-md-code': { backgroundColor: palette.ui.activeLine, borderRadius: '2px' },
  '&.cm-studio-lean .cm-md-marker': { opacity: '0.28' },
}, { dark: palette.dark });

const tokenStyle = (palette) => HighlightStyle.define(Object.entries(palette.tokens).map(([tag, style]) => ({
  tag: t[tag] ?? t.content,
  ...style,
})));

/** 返回主题扩展数组。id 未知时退回 one-dark。 */
export function themeExtensions(id = 'one-dark') {
  if (id === 'one-dark') return [oneDark, EditorView.theme({ '.cm-content': { padding: '16px 8px 40vh' } }, { dark: true })];
  const palette = PALETTE[id] ?? null;
  if (!palette) return [oneDark, oneDarkHighlightStyle];
  return [uiTheme(palette), syntaxHighlighting(tokenStyle(palette))];
}

export function isDarkTheme(id) {
  return THEMES.find((theme) => theme.id === id)?.dark ?? true;
}
