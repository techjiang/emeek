/**
 * 纯文本剥离。
 *
 * 为什么编辑器里也要一份：预览面板的「阅读时长/字数」要按纯文本算，
 * 而把整篇 Markdown 丢给 core 的双向链接解析器只为拿纯文本太重。
 * 这份实现只做「去标记」，与 core 的 excerpt 口径一致，并有测试对齐。
 */
export function stripMarkdown(markdown) {
  return String(markdown ?? '')
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`\n]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, alias) => alias ?? target)
    .replace(/^\s{0,3}[>#]+\s*/gm, '')
    .replace(/[*_~]/g, '')
    .replace(/<[^>]+>/g, '');
}
