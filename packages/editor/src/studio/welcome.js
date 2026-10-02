/** 第一次打开发编辑器时的示例内容。自己就是一篇能跑通全部语法的文章。 */
export const WELCOME = `# 欢迎来到 Emeek Studio

这是你第一次打开编辑器，所以给一篇自带示例的文章。**删掉它，开始写你自己的。**

## 你在编辑器里看到的，就是构建出来的

左边写，右边看。右边这块不是「大致差不多」的预览 —— 它和 \`emeeek build\`
调的是同一个渲染函数（\`@emeeek/core\` 的 \`renderArticle\`），
一致性测试逐节点盯着这件事。

## 一段代码

\`\`\`javascript
// 编辑器与构建必须给出同一份 HTML
import { renderArticle } from '@emeeek/core/pipeline';

export function updatePreview(source) {
  return renderArticle(source, { allowHtml: false, lazyImages: true });
}
\`\`\`

## 一张表

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 双栏预览 | 已完成 | 复用 core 渲染 |
| 一致性测试 | 已完成 | 预览 ≡ 构建 |
| 目录导航 | 已完成 | 点击跳转 |
| 自动补全 | 已完成 | \`[[\` / \`\`\`\` / \`![\` |

## 一个任务列表

- [x] 用 CodeMirror 6 替换 textarea
- [x] 预览复用核心渲染器
- [ ] 写下你的第一篇文章

## 双向链接

用 \`[[文章标题]]\` 引用别的文章。目标不存在时它不会假装成功 ——
会渲染成一段带虚线的不可点击文字，并告诉你「未找到文章」。

## 快捷键

按 <kbd>F1</kbd> 看全部快捷键。最常用的是 <kbd>Ctrl</kbd>+<kbd>S</kbd> 保存草稿、
<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> 切换预览模式。

---

写完这篇之后，左边目录会跟着你的标题长出来。
`;
