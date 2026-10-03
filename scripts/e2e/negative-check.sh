#!/usr/bin/env bash
# 负向验证：「削弱它 → 测试红」。
#
# 一条防线如果削弱了测试还是绿的，那这条防线就没有被测试守住 ——
# 它只是恰好写在那儿。这个脚本做的事就是逐条削弱关键防线，
# 确认对应的测试真的会红，然后恢复原状。
#
# 用法：bash scripts/e2e/negative-check.sh [仓库根目录]
set -uo pipefail

ROOT="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$ROOT"

PASS=0
FAIL=0

# weaken <描述> <文件> <sed 表达式> <必须变红的测试命令>
weaken() {
  local label="$1" file="$2" expr="$3" cmd="$4"
  cp "$file" "$file.bak"
  # shellcheck disable=SC2016
  sed -i "$expr" "$file"
  if diff -q "$file" "$file.bak" >/dev/null; then
    echo "  ✘ $label —— 削弱没生效（sed 表达式没匹配上），这条负向验证本身就是假的"
    mv "$file.bak" "$file"
    FAIL=$((FAIL + 1))
    return
  fi
  if eval "$cmd" >/dev/null 2>&1; then
    echo "  ✘ $label —— 削弱之后测试仍然通过，说明这条防线没被守"
    FAIL=$((FAIL + 1))
  else
    echo "  ✔ $label —— 削弱后测试变红（防线确实被测试守住）"
    PASS=$((PASS + 1))
  fi
  mv "$file.bak" "$file"
}

echo "▸ 负向验证：逐条削弱防线，测试必须红"

# 1. URL 消毒：让 sanitizeUrl 永远放行
weaken "URL 消毒（sanitizeUrl 恒放行）" \
  packages/core/src/pipeline/parse/sanitize-url.js \
  's|^const IGNORED .*|const IGNORED = /(?!)/g; // weakened|' \
  'node --test packages/core/tests/security/xss.test.js'

# 2. 原始 HTML 消毒：让 sanitizeHtml 变成恒等变换
weaken "原始 HTML 消毒（sanitizeHtml 恒等）" \
  packages/core/src/pipeline/parse/sanitize-html.js \
  's|^export function sanitizeHtml(html) {|export function sanitizeHtml(html) { return String(html ?? ""); // weakened|' \
  'node --test packages/core/tests/security/xss.test.js'

# 3. 链接不消毒（把 renderInline 里的 sanitizeUrl 换成直通）
weaken "渲染器链接消毒（resolveLink 直通）" \
  packages/core/src/pipeline/parse/markdown.js \
  's|const safe = sanitizeUrl(ctx.resolveLink(url));|const safe = ctx.resolveLink(url);|' \
  'node --test packages/core/tests/security/xss.test.js'

# 4. Key 存储：让「记住」变成默认（默认替用户勾上 = 替用户决定长期暴露凭证）
weaken "Key 默认不持久化（改成像默认记住）" \
  packages/editor/src/studio/keyring.js \
  's|if (remember) this.#write(this.storage, PERSIST_KEY, value);|this.#write(this.storage, PERSIST_KEY, value); if (false) {|' \
  'node --test packages/editor/tests/keyring.test.js'

# 5. 输出面消毒：让 redact 变成恒等变换
weaken "Key 输出面消毒（redact 恒等）" \
  packages/editor/src/studio/keyring.js \
  's|^export function redact(text, { known = \[\], mask = \x27\*\*\*\x27 } = {}) {|export function redact(text, { known = [], mask = \x27***\x27 } = {}) { return String(text ?? ""); // weakened|' \
  'node --test packages/editor/tests/keyring.test.js'

# 6. 服务端状态接口漏 Key
weaken "AI 状态接口不回 Key" \
  packages/editor/src/studio/ai-proxy.js \
  's|  return { configured: true, provider: server.provider, model: server.model };|  return { configured: true, provider: server.provider, model: server.model, apiKey: server.apiKey };|' \
  'node --test packages/editor/tests/keyring.test.js'

# 7. 落盘时机：摘掉 visibilitychange/pagehide 的绑定（回到「只靠定时器」）
weaken "隐藏/关闭时立即落盘（摘掉事件绑定）" \
  packages/editor/src/studio/drafts.js \
  's|const unbind = events ? bindLifecycle(events) : () => {};|const unbind = () => {}; // weakened|' \
  'node --test packages/editor/tests/drafts.test.js'

# 8. 移动端兜底间隔：改回与桌面一致
weaken "移动端兜底间隔更短" \
  packages/editor/src/studio/drafts.js \
  's|const effectiveInterval = mobile ? DRAFT_LIMITS.mobileIntervalMs : intervalMs;|const effectiveInterval = intervalMs; // weakened|' \
  'node --test packages/editor/tests/drafts.test.js'

# 9. 快捷键声明审计：把一条 handler 的名字改错
weaken "快捷键声明审计（handler 名改错）" \
  packages/editor/src/studio/client.js \
  "s|    'toggle-theme': () => toggleTheme(),|    'toggle-theme-typo': () => toggleTheme(),|" \
  'node scripts/check-shortcuts.mjs'

# 10. 快捷键声明审计：往声明表里加一条没有实现的条目
weaken "快捷键声明审计（表里有实现没有）" \
  packages/editor/src/studio/shortcuts.js \
  "s|  { id: 'save', label: '保存草稿'|  { id: 'ghost', label: '幽灵条目', keys: 'Ctrl+Alt+Z', group: '编辑', handler: 'global', match: { key: 'z', alt: true }, touch: null },\n  { id: 'save', label: '保存草稿'|" \
  'node scripts/check-shortcuts.mjs'

# 11. 监听范围：把校验摘掉（任何路径都放行）
weaken "监听范围收敛（resolveProjectFile 摘掉）" \
  packages/editor/src/studio/watcher.js \
  "s|    if (!resolve) return { absolute, relative: path.relative(root, absolute).split(path.sep).join('/') };|    return { absolute, relative: path.relative(root, absolute).split(path.sep).join('/') };|" \
  'node --test packages/editor/tests/watcher.test.js'

# 12. 插件能力：未声明也放行
weaken "插件能力声明（未声明也放行）" \
  packages/core/src/plugin/hooks.js \
  "s|        if (required \&\& !plugin.guard?.has(required)) {|        if (false) {|" \
  'node --test packages/core/tests/plugin.test.js'

# 13. 凭证剔除：让 stripSecrets 变成恒等
weaken "凭证不进插件（stripSecrets 恒等）" \
  packages/core/src/plugin/capabilities.js \
  "s|export function stripSecrets(value, depth = 0) {|export function stripSecrets(value, depth = 0) { return value; // weakened|" \
  'node --test packages/core/tests/plugin.test.js'

# 14. 热更新：把冲突判定改成「永远刷新」（= 自动合并的另一种形式）
weaken "本地脏时不自动合并" \
  packages/editor/src/studio/sync.js \
  "s|  if (!localDirty) {|  if (true) {|" \
  'node --test packages/editor/tests/sync.test.js'

# 15. Key 状态机：把「服务端已配置」与「已记住」混成同一句话
weaken "Key 状态四档文案不合并" \
  packages/editor/src/studio/keyring.js \
  "s|  persisted: '已记住',|  persisted: '服务端已配置',|" \
  'node --test packages/editor/tests/ai-panel.test.js'

# 16. 服务端状态接口：把环境变量名也吐出去
weaken "服务端状态不吐内部配置信息" \
  packages/editor/src/studio/ai-proxy.js \
  "s|  return { configured: true, provider: server.provider, model: server.model };|  return { configured: true, provider: server.provider, model: server.model, from: server.from };|" \
  'node --test packages/editor/tests/keyring.test.js'

# 17. 会话级 Key 也走服务端转发（改成直连会暴露在浏览器网络面板）
weaken "会话级 Key 仍走服务端转发" \
  packages/editor/src/studio/server.js \
  "s|      if (!effective?.apiKey) {|      if (true) {|" \
  'node --test packages/editor/tests/keyring.test.js'

# 18. e2e 的落盘目的地断言：把「隐藏瞬间落盘」的触发摘掉。
#
# 这一条针对的是 e2e 自身的一个真实教训：那条断言原来只认 localStorage，
# 而 PR #5 给 studio 开了 projectRoot 之后落盘目的地变成了磁盘 ——
# 行为是对的，断言绑错了地方，结果 e2e 变红而负向验证却是绿的
# （削弱代码它也不会变红，因为它根本没在看对的地方）。
# 现在两种模式各有一条断言，这里确认削弱后确实会红。
weaken "隐藏瞬间落盘（visibilitychange 触发）" \
  packages/editor/src/studio/drafts.js \
  "s|      if (targets.document.visibilityState === 'hidden') flush('hidden');|      if (false) flush('hidden');|" \
  'node --test packages/editor/tests/drafts.test.js'

# 19. 文档数字与代码一致：让文档写错一个数字。
#
# 文档里「N 种语言」「N 个按钮」这类数字，错了不会让任何功能测试变红 ——
# 所以专门有一条测试盯着它。这里确认那条测试真的守得住。
weaken "文档数字与代码一致（语言数量写错）" \
  README.md \
  "s|\\*\\*36 种语言\\*\\*代码块高亮|**37 种语言**代码块高亮|" \
  'node --test packages/editor/tests/studio-client.test.js'

# 20. 布局差异化：把 Minimal 的单栏改回网格。
#
# 「4 套主题两两可辨」这条如果削弱了还是绿的，说明它没被守住 ——
# 而它正是 P3-1b-3 的核心交付之一。
weaken "Minimal 单栏化（.post-grid 改回网格）" \
  packages/theme-minimal/styles/main.css \
  "s|^.post-grid { display: block; }|.post-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); }|" \
  'node --test packages/core/tests/theme/layouts.test.js'

# 21. 主题发现：把脚本里写死的主题数组塞回去。
#
# 「新主题自动纳入」靠的是动态扫描。把发现逻辑换成一份常量表，
# 断言必须变红，否则它只在「现在恰好对」而不是「一直对」。
weaken "主题动态发现（listThemes 改回写死数组）" \
  scripts/lib/themes.mjs \
  "s|  const names = found.map((t) => t.name);|  const names = ['aurora', 'minimal', 'inkstone', 'magazine'];|" \
  'node --test packages/core/tests/theme/discovery.test.js'

# 22. 版面结构签名：让列数永远算成 0。
#
# 「两两可辨」的比较逻辑一旦退化（列数都算成 0），网格与单栏会被判成相同。
# 这条确认那个纯函数被单测守着。
weaken "版面结构签名（列数恒为 0）" \
  scripts/e2e/theme_signature.mjs \
  "s|  return parts.length;|  return 0; // weakened|" \
  'node --test packages/core/tests/theme/layouts.test.js'

# 23. 自定义配置覆盖链：让 normalizeOverrides 不再校验（全部放行）。
#
# 「配置面板能改但不能改坏」是 feature D 的底线。削弱校验后断言必须红。
weaken "自定义配置校验（normalizeOverrides 全放行）" \
  packages/core/src/theme/override.js \
  "s|      const desc = descriptors|      const desc = { type: 'string' }, _orig = descriptors|" \
  'node --test packages/core/tests/theme/override.test.js'

# 24. 切换按钮禁用：拔掉 noscript 兜底与属性转义。
#
# 无 JS 时按钮必须消失（不留死浮层）；label 必须转义（不产生注入）。
weaken "切换按钮 label 转义（escapeHtml 直通）" \
  packages/core/src/theme/switcher.js \
  "s|function escapeHtml(text) {|function escapeHtml(text) { return String(text ?? ''); // weakened\nfunction _unused(text) {|" \
  'node --test packages/core/tests/theme/switcher.test.js packages/core/tests/theme/integration.test.js'

# 25. 主题注册表：让项目内同名主题不再覆盖内置（优先级退化）。
weaken "项目内主题优先于内置（改成内置覆盖项目）" \
  packages/core/src/theme/registry.js \
  "s|  for (const theme of \[\.\.\.builtin, \.\.\.projectPackages, \.\.\.project\]) byName.set(theme.name, theme);|  for (const theme of [...project, ...projectPackages, ...builtin]) byName.set(theme.name, theme);|" \
  'node --test packages/core/tests/theme/registry.test.js'

echo "  ── ${PASS} 条防线被守住，${FAIL} 条没守住"
[ "$FAIL" -eq 0 ] || exit 1
