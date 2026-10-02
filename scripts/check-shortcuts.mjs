#!/usr/bin/env node
/**
 * 快捷键声明审计（决策 D5）。
 *
 * 把「修一个 Ctrl+G」变成「这类 bug 无法再发生」——差别在于靠人记得检查，
 * 还是靠门禁不让它过。
 *
 * 双向核对，两个方向都报红：
 *   表里有、实现没有  → 用户按下去没反应（这是 Ctrl+G）
 *   实现有、表里没有  → 用户永远不知道有这个键位
 *
 * 三层，缺一层都会漏：
 *   1. 声明 ↔ 全局 handler 注册表
 *   2. 声明 ↔ CodeMirror keymap（编辑器内的键位在那边）
 *   3. 声明 ↔ 命令表（工具栏 tooltip 与 F1 表说的要是同一套键位）
 *
 * 用法：node scripts/check-shortcuts.mjs [--json]
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SHORTCUTS, TOUCH_ALTERNATIVES, groupShortcuts } from '@emeeek/editor/shortcuts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JSON_OUT = process.argv.includes('--json');

const failures = [];
const notes = [];
const fail = (message) => failures.push(message);

const clientSource = readFileSync(path.join(ROOT, 'packages/editor/src/studio/client.js'), 'utf8');
const commandsSource = readFileSync(path.join(ROOT, 'packages/editor/src/editor/commands.js'), 'utf8');
const htmlSource = readFileSync(path.join(ROOT, 'packages/editor/src/assets/studio.html'), 'utf8');

/** 从 client.js 里取出 GLOBAL_HANDLERS 的键集合。 */
function globalHandlerIds() {
  const match = /const GLOBAL_HANDLERS = \{([\s\S]*?)\n  \};/.exec(clientSource);
  if (!match) { fail('client.js 里找不到 GLOBAL_HANDLERS —— 审计脚本与实现对不上了'); return new Set(); }
  return new Set([...match[1].matchAll(/^\s*(?:'([^']+)'|([A-Za-z_$][\w$]*))\s*:/gm)].map((m) => m[1] ?? m[2]));
}

/** 从 commands.js 里取出 CodeMirror keymap 的键位集合（Mod-xxx 形式）。 */
function editorKeymapKeys() {
  return new Set([...commandsSource.matchAll(/key:\s*'([^']+)'/g)].map((m) => m[1]));
}

/** 声明表里的键位 → CodeMirror 的键位写法（Mod + 方向键 / 功能键）。 */
function toEditorKey(item) {
  const key = item.match.key;
  if (key === 'F1') return null;                     // F1 由全局监听处理
  if (/^Arrow/.test(key)) return `Alt-${key}`;        // Alt+↑/↓
  if (/^Home|^End$/.test(key)) return `Mod-${key}`;   // Ctrl+Home/End
  const parts = [];
  parts.push('Mod');
  if (item.match.shift) parts.push('Shift');
  parts.push(item.match.code ? item.match.code.replace(/^Digit/, '') : key.length === 1 ? key : key);
  return parts.join('-');
}

// ── 第 1 层：声明 ↔ 全局 handler ──────────────────────────
const handlerIds = globalHandlerIds();
const declaredGlobal = SHORTCUTS.filter((item) => item.handler === 'global');
for (const item of declaredGlobal) {
  if (!handlerIds.has(item.id)) fail(`声明了 ${item.keys}（${item.label}）但没有 handler —— 按下去不会触发`);
}
const declaredIds = new Set(SHORTCUTS.map((item) => item.id));
for (const id of handlerIds) {
  if (!declaredIds.has(id)) fail(`handler「${id}」没有出现在快捷键声明表里 —— 用户永远不知道有这个键位`);
}

// ── 第 2 层：声明 ↔ CodeMirror keymap ─────────────────────
const keymap = editorKeymapKeys();
for (const item of SHORTCUTS.filter((i) => i.handler === 'editor')) {
  const expected = toEditorKey(item);
  if (!expected) continue;
  if (!keymap.has(expected)) {
    fail(`声明了 ${item.keys}（${item.label}），但 CodeMirror keymap 里没有 ${expected}`);
  }
}

// ── 第 3 层：声明 ↔ 工具栏命令表 ──────────────────────────
const commandKeysMatch = /export const COMMAND_KEYS = Object\.freeze\(\{([\s\S]*?)\n\}\);/.exec(clientSource);
if (!commandKeysMatch) {
  fail('client.js 里找不到 COMMAND_KEYS —— 工具栏 tooltip 与 F1 表可能已经分叉');
} else {
  const commandKeys = new Map([...commandKeysMatch[1].matchAll(/'?([\w-]+)'?\s*:\s*'([^']+)'/g)].map((m) => [m[1], m[2]]));
  for (const [id, keys] of commandKeys) {
    const declared = SHORTCUTS.find((item) => item.id === id);
    if (!declared) { fail(`工具栏命令「${id}」的快捷键 ${keys} 不在声明表里`); continue; }
    if (declared.keys !== keys) fail(`「${id}」在两处说法不一致：命令表 ${keys}，声明表 ${declared.keys}`);
  }
}

// ── 触屏替代：声明的 selector 必须真的在 DOM 里 ────────────
for (const item of TOUCH_ALTERNATIVES) {
  if (!item.selector) {
    // 明说「没有等价入口」的条目不算缺陷 —— 那是如实告知，正是我们要的
    if (!item.note) fail(`触屏替代「${item.action}」既没有 selector 也没有说明为什么没有`);
    continue;
  }
  const id = item.selector.startsWith('#') ? item.selector.slice(1) : null;
  if (id && !htmlSource.includes(`id="${id}"`)) fail(`触屏替代「${item.action}」指向的 #${id} 不在页面里`);
}

// ── 展示面：F1 对话框必须由声明表渲染，不能再有手写副本 ────
if (htmlSource.includes('id="help-dialog-legacy"')) fail('studio.html 里还留着旧的快捷键 HTML 副本 —— 两份声明必然分叉');

// ── 输出 ─────────────────────────────────────────────────
const stats = {
  declared: SHORTCUTS.length,
  global: declaredGlobal.length,
  editor: SHORTCUTS.filter((i) => i.handler === 'editor').length,
  touchAlternatives: TOUCH_ALTERNATIVES.length,
  groups: groupShortcuts().map((g) => `${g.name}(${g.items.length})`),
  failures,
};

if (JSON_OUT) {
  process.stdout.write(JSON.stringify(stats));
} else {
  console.log('▸ 快捷键声明审计');
  console.log(`  声明 ${stats.declared} 条（全局 ${stats.global} / 编辑器 ${stats.editor}）· 分组 ${stats.groups.join(' ')}`);
  console.log(`  触屏替代 ${stats.touchAlternatives} 条`);
  if (notes.length) for (const note of notes) console.log(`  · ${note}`);
  if (failures.length) {
    console.log(`\n✘ ${failures.length} 处不一致：`);
    for (const message of failures) console.log(`  · ${message}`);
  } else {
    console.log('  ✔ 声明与实现双向一致');
  }
}

process.exitCode = failures.length ? 1 : 0;
