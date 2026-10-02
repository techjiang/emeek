/**
 * 快捷键声明表（决策 D5）。
 *
 * ## 为什么要有这个文件
 *
 * F1 表此前是手写的静态 HTML，handler 绑在另一处代码。两者之间没有任何
 * 机制保证一致 —— `Ctrl+G` 跳到行写在表里，实际按下去毫无反应，因为
 * 根本没有 handler。修掉它只值五分钟，真正的问题是**这类不一致会不断发生**。
 *
 * 所以声明只留一份，三个消费者都读它：
 *   1. F1 对话框的渲染          （用户看到的）
 *   2. handler 注册             （真的触发）
 *   3. 声明审计脚本 / CI        （表里有实现没有、实现有表里没有，都报红）
 *
 * ## 字段说明
 *
 *   id        命令名，与 COMMANDS / handler 注册表里的键一致
 *   label     用户看到的作用
 *   keys      键位描述（展示用，可含 `Ctrl+Shift+1/2/3` 这种简写）
 *   match     真实匹配规则：修饰键 + 键名 + 可选的 shiftKey 断言
 *   group     分组（F1 表的分栏）
 *   handler   由哪里处理：'editor'（CodeMirror 命令）| 'global'（document 监听）
 *   touch     触屏替代入口（没有就写 null —— 不写等于假装触屏上也能用）
 *   declared  是否出现在 F1 表里（body 输入框类的补全提示不算「快捷键」）
 */

/** @type {ReadonlyArray<object>} */
export const SHORTCUTS = Object.freeze([
  // ── 编辑：走 CodeMirror 命令，与工具栏共用同一批命令对象 ──
  { id: 'bold', label: '加粗', keys: 'Ctrl+B', group: '编辑', handler: 'editor', match: { key: 'b' }, touch: '工具栏「B」' },
  { id: 'italic', label: '斜体', keys: 'Ctrl+I', group: '编辑', handler: 'editor', match: { key: 'i' }, touch: '工具栏「I」' },
  { id: 'underline', label: '下划线', keys: 'Ctrl+U', group: '编辑', handler: 'editor', match: { key: 'u' }, touch: '工具栏「U」' },
  { id: 'link', label: '插入链接', keys: 'Ctrl+K', group: '编辑', handler: 'editor', match: { key: 'k' }, touch: '工具栏「链接」' },
  { id: 'image', label: '插入图片', keys: 'Ctrl+Shift+I', group: '编辑', handler: 'editor', match: { key: 'i', shift: true }, touch: '工具栏「图片」/ 拖拽' },
  { id: 'code-block', label: '插入代码块', keys: 'Ctrl+Shift+C', group: '编辑', handler: 'editor', match: { key: 'c', shift: true }, touch: '工具栏「代码」' },
  { id: 'formula', label: '插入公式', keys: 'Ctrl+Shift+M', group: '编辑', handler: 'editor', match: { key: 'm', shift: true }, touch: '工具栏「公式」' },
  { id: 'formula-inline', label: '行内公式', keys: 'Ctrl+Shift+E', group: '编辑', handler: 'editor', match: { key: 'e', shift: true }, touch: '工具栏「行内公式」' },
  { id: 'table', label: '插入表格', keys: 'Ctrl+Shift+T', group: '编辑', handler: 'editor', match: { key: 't', shift: true }, touch: '工具栏「表格」/ 行首 table' },
  { id: 'h1', label: '标题 H1', keys: 'Ctrl+Shift+1', group: '编辑', handler: 'editor', match: { key: '!', shift: true, code: 'Digit1' }, touch: '工具栏「H1」/ 行首 h1' },
  { id: 'h2', label: '标题 H2', keys: 'Ctrl+Shift+2', group: '编辑', handler: 'editor', match: { key: '@', shift: true, code: 'Digit2' }, touch: '工具栏「H2」/ 行首 h2' },
  { id: 'h3', label: '标题 H3', keys: 'Ctrl+Shift+3', group: '编辑', handler: 'editor', match: { key: '#', shift: true, code: 'Digit3' }, touch: '工具栏「H3」/ 行首 h3' },
  { id: 'list', label: '无序列表', keys: 'Ctrl+Shift+U', group: '编辑', handler: 'editor', match: { key: 'u', shift: true }, touch: '工具栏「列表」' },
  { id: 'ordered-list', label: '有序列表', keys: 'Ctrl+Shift+O', group: '编辑', handler: 'editor', match: { key: 'o', shift: true }, touch: '工具栏「有序」' },
  { id: 'task', label: '任务列表', keys: 'Ctrl+Shift+K', group: '编辑', handler: 'editor', match: { key: 'k', shift: true }, touch: '工具栏「任务」' },
  { id: 'footnote', label: '脚注', keys: 'Ctrl+Shift+F', group: '编辑', handler: 'editor', match: { key: 'f', shift: true }, touch: '工具栏「脚注」' },
  { id: 'quote', label: '引用块', keys: 'Ctrl+Shift+Q', group: '编辑', handler: 'editor', match: { key: 'q', shift: true }, touch: '工具栏「引用」' },
  { id: 'hr', label: '分隔线', keys: 'Ctrl+Shift+H', group: '编辑', handler: 'editor', match: { key: 'h', shift: true }, touch: '工具栏「分隔线」' },
  { id: 'move-line-up', label: '上移段落', keys: 'Alt+↑', group: '编辑', handler: 'editor', match: { key: 'ArrowUp', alt: true }, touch: null },
  { id: 'move-line-down', label: '下移段落', keys: 'Alt+↓', group: '编辑', handler: 'editor', match: { key: 'ArrowDown', alt: true }, touch: null },
  { id: 'save', label: '保存草稿', keys: 'Ctrl+S', group: '编辑', handler: 'global', match: { key: 's' }, touch: '工具栏「保存」' },

  // ── 导航与视图：global 监听 + CodeMirror 自带命令 ──
  { id: 'find', label: '查找', keys: 'Ctrl+F', group: '导航与视图', handler: 'editor', match: { key: 'f' }, touch: null },
  { id: 'replace', label: '替换', keys: 'Ctrl+H', group: '导航与视图', handler: 'editor', match: { key: 'h' }, touch: null },
  { id: 'goto-line', label: '跳转到行', keys: 'Ctrl+G', group: '导航与视图', handler: 'global', match: { key: 'g' }, touch: null },
  { id: 'doc-start', label: '文档开头', keys: 'Ctrl+Home', group: '导航与视图', handler: 'editor', match: { key: 'Home' }, touch: null },
  { id: 'doc-end', label: '文档结尾', keys: 'Ctrl+End', group: '导航与视图', handler: 'editor', match: { key: 'End' }, touch: null },
  { id: 'toggle-preview', label: '切换预览模式', keys: 'Ctrl+Shift+P', group: '导航与视图', handler: 'global', match: { key: 'p', shift: true }, touch: '工具栏「◫」' },
  { id: 'toggle-theme', label: '切换暗色 / 亮色', keys: 'Ctrl+Shift+B', group: '导航与视图', handler: 'global', match: { key: 'b', shift: true }, touch: '工具栏（移动端主题按钮）' },
  { id: 'select-next', label: '选中下一个相同词', keys: 'Ctrl+D', group: '导航与视图', handler: 'editor', match: { key: 'd' }, touch: null },
  { id: 'ai-panel', label: 'AI 面板', keys: 'Ctrl+Shift+A', group: '导航与视图', handler: 'global', match: { key: 'a', shift: true }, touch: '工具栏「✨ AI」' },
  // F1 刻意不带修饰键（mod: false）—— Ctrl+F1 是浏览器的帮助键，我们的不该抢
  { id: 'help', label: '打开本快捷键表', keys: 'F1', group: '导航与视图', handler: 'global', match: { key: 'F1', mod: false }, touch: '工具栏「?」与状态栏「快捷键」' },
]);

/**
 * 触屏替代入口清单。
 *
 * 移动端没有功能键，所以「表里写了 Ctrl+Shift+1」对触屏用户等于没说。
 * 这一份数据的作用是：把「触屏上能怎么做到同一件事」明确列出来 ——
 * 不列等于假装可用（决策 D5）。
 *
 * 每一项都对应一个真的存在的按钮/手势，审计脚本会核对按钮 id 是否真的在 DOM 里。
 */
export const TOUCH_ALTERNATIVES = Object.freeze([
  { action: '粗体 / 斜体 / 下划线等格式', via: '工具栏按钮（触屏目标 ≥ 40px）', selector: '[data-command]' },
  { action: '插入链接 / 图片', via: '工具栏按钮；图片还可直接拖拽或粘贴', selector: '[data-command="link"]' },
  { action: '保存', via: '工具栏「保存」按钮', selector: '#btn-save' },
  { action: '切换预览', via: '工具栏「◫」按钮', selector: '#btn-toggle-preview' },
  { action: '段落上下移动', via: '长按选中后用系统剪贴板', selector: null, note: '触屏上没有等价快捷键，如实说明' },
  { action: '查找 / 替换', via: '系统在页面内的「在页面中查找」', selector: null, note: '触屏上没有等价入口，如实说明' },
  { action: '快捷键表', via: '工具栏「?」或状态栏「快捷键」', selector: '#btn-mobile-help' },
]);

/**
 * 按键事件是否符合某条声明的 match 规则。
 *
 * 审计脚本与运行时共用这一个判定 —— 两处各写一份「Ctrl 到底要不要」，
 * 迟早会出现「审计说绑上了、实际按不出来」。
 *
 * 四组需要显式处理的规则：
 *
 *   1. **Ctrl 与 Cmd 等价**：macOS 上用户的「Mod」是 Cmd，判据必须是
 *      `ctrlKey || metaKey`，只看 ctrlKey 会让 Mac 用户全部按不出来。
 *   2. **修饰键要精确匹配**：`Ctrl+S` 不该被 `Ctrl+Shift+S` 触发，
 *      反之亦然。只判「按了 Ctrl」是不够的。
 *   3. **F1 这类功能键不带修饰键**：`Ctrl+F1` 不该打开帮助。
 *   4. **`Ctrl+Shift+1` 的 event.key 是 `!`**：Shift 改了字符。
 *      所以带 code 的条目用 `event.code` 判，不靠字符比。
 *
 * 提前 return 的写法比一串嵌套条件好读，也更好测 —— 上面四条各有一个
 * 用例，坏了能直接定位到是哪条规则。
 */
export function matchesShortcut(event, match) {
  if (!match) return false;

  // 键名：功能键与带 code 的键位走原样比较；普通字符大小写不敏感
  if (match.code) {
    if (event.code !== match.code) return false;
  } else if (String(event.key).toLowerCase() !== String(match.key).toLowerCase()) {
    return false;
  }

  const hasMod = Boolean(event.ctrlKey || event.metaKey);
  // `mod: false` 表示「这个键位刻意不要修饰键」（F1）；不写就是默认要
  const wantsMod = match.mod !== false && !match.alt;
  if (wantsMod !== hasMod) return false;
  if (Boolean(event.altKey) !== Boolean(match.alt)) return false;
  if (Boolean(event.shiftKey) !== Boolean(match.shift)) return false;

  return true;
}

/** 按 group 分栏，F1 表渲染用。 */
export function groupShortcuts() {
  const groups = new Map();
  for (const item of SHORTCUTS) {
    if (!groups.has(item.group)) groups.set(item.group, []);
    groups.get(item.group).push(item);
  }
  return [...groups.entries()].map(([name, items]) => ({ name, items }));
}

/** 声明表里符合 match 的条目（运行时用）。 */
export function findShortcut(event) {
  return SHORTCUTS.find((item) => matchesShortcut(event, item.match)) ?? null;
}
