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
  's|return { configured: true, provider: server.provider, model: server.model, from: server.from };|return { configured: true, provider: server.provider, model: server.model, from: server.from, apiKey: server.apiKey };|' \
  'node --test packages/editor/tests/keyring.test.js'

echo "  ── ${PASS} 条防线被守住，${FAIL} 条没守住"
[ "$FAIL" -eq 0 ] || exit 1
