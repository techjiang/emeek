/**
 * Markdown 排版样式：把文档结构标记（#、**、```）视觉降级，正文提上来。
 *
 * 只做「颜色/字重」级别的事，不做「隐藏标记」。
 * 隐藏标记（所见即所得的那种）会让光标定位、选区、删除全部失去参照 ——
 * 用户点在一个看不见的字符旁边却不知道删的是什么。降级可以，隐藏不行。
 */
import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

export const markdownStyle = [
  EditorView.baseTheme({
    '.cm-md-heading1': { fontSize: '1.5em', fontWeight: '700' },
    '.cm-md-heading2': { fontSize: '1.3em', fontWeight: '700' },
    '.cm-md-heading3': { fontSize: '1.15em', fontWeight: '600' },
    '.cm-md-strong': { fontWeight: '700' },
    '.cm-md-emphasis': { fontStyle: 'italic' },
    '.cm-md-strike': { textDecoration: 'line-through', opacity: '0.75' },
  }),
];

/**
 * 文档结构的语法样式。
 *
 * 注意 HighlightStyle.define() 本身不是扩展 —— 它得经 syntaxHighlighting()
 * 包装才能进 extensions 数组。少了这层包装，CodeMirror 会抛
 * 「Unrecognized extension value」，而且报错不说是哪一个（踩过一次）。
 */
export const markdownHighlightStyle = HighlightStyle.define([
    { tag: t.heading1, class: 'cm-md-heading1' },
    { tag: t.heading2, class: 'cm-md-heading2' },
    { tag: t.heading3, class: 'cm-md-heading3' },
    { tag: t.heading, fontWeight: '600' },
    { tag: t.strong, fontWeight: '700' },
    { tag: t.emphasis, fontStyle: 'italic' },
    { tag: t.strikethrough, textDecoration: 'line-through' },
    { tag: t.link, textDecoration: 'underline' },
    { tag: t.url, textDecoration: 'underline', opacity: '0.8' },
    { tag: t.monospace, class: 'cm-md-code' },
    { tag: t.quote, fontStyle: 'italic' },
    { tag: t.list, color: 'inherit' },
    { tag: t.processingInstruction, class: 'cm-md-marker' },
    { tag: t.contentSeparator, class: 'cm-md-marker' },
]);

export const markdownDecorations = syntaxHighlighting(markdownHighlightStyle, { fallback: true });
