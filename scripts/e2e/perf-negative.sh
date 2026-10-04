#!/usr/bin/env bash
# 性能防线的负向验证：「削弱它 → check-perf 必须红」。
#
# 为什么性能防线特别需要这一套：性能检查最容易写成**空转的**。
# 「页面里有 <style>」永远为真（变量块也是 style）；「图有 alt 属性」永远为真
# （空 alt 也是 alt）；「有图标声明」永远为真（声明一个 404 的图也算）。
# 一条削弱之后不会红的防线，只是在文档里写着「我们守住了」。
#
# 用法：bash scripts/e2e/perf-negative.sh
set -uo pipefail

ROOT="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$ROOT"

PASS=0
FAIL=0

# weaken <描述> <文件> <sed 表达式> <检查用的站点>
weaken() {
  local label="$1" file="$2" expr="$3" site="${4:-examples/minimal}"
  cp "$file" "$file.bak"
  # shellcheck disable=SC2016
  sed -i "$expr" "$file"
  if diff -q "$file" "$file.bak" >/dev/null; then
    echo "  ✘ $label —— 削弱没生效（sed 没匹配上），这条负向验证本身就是假的"
    mv "$file.bak" "$file"
    FAIL=$((FAIL + 1))
    return
  fi
  if node scripts/check-perf.mjs --site "$site" >/dev/null 2>&1; then
    echo "  ✘ $label —— 削弱之后仍然通过，说明这条防线没被守住"
    FAIL=$((FAIL + 1))
  else
    echo "  ✔ $label —— 削弱后检查变红（防线确实被守住）"
    PASS=$((PASS + 1))
  fi
  mv "$file.bak" "$file"
}

# weaken_pwa：给 PWA 站点用的便捷包装。
weaken_pwa() {
  weaken "$1" "$2" "$3" examples/pwa-demo
}

# weaken_pair：同时削弱两处（用于分层防线 —— 只削一层不会产生坏产物）。
weaken_pair() {
  local label="$1" file1="$2" expr1="$3" file2="$4" expr2="$5" site="${6:-examples/minimal}"
  cp "$file1" "$file1.bak"; cp "$file2" "$file2.bak"
  # shellcheck disable=SC2016
  sed -i "$expr1" "$file1"; sed -i "$expr2" "$file2"
  if diff -q "$file1" "$file1.bak" >/dev/null || diff -q "$file2" "$file2.bak" >/dev/null; then
    echo "  ✘ $label —— 削弱没生效（其中一处 sed 没匹配上）"
    mv "$file1.bak" "$file1"; mv "$file2.bak" "$file2"
    FAIL=$((FAIL + 1))
    return
  fi
  if node scripts/check-perf.mjs --site "$site" >/dev/null 2>&1; then
    echo "  ✘ $label —— 削弱之后仍然通过，说明这条防线没被守住"
    FAIL=$((FAIL + 1))
  else
    echo "  ✔ $label —— 削弱后检查变红（防线确实被守住）"
    PASS=$((PASS + 1))
  fi
  mv "$file1.bak" "$file1"; mv "$file2.bak" "$file2"
}

echo "▸ 性能负向验证：逐条削弱防线，check-perf 必须红"

# ── 图片 ────────────────────────────────────────────────────────
weaken "首屏图不 eager（EAGER_IMAGE_COUNT=0）" \
  packages/core/src/pipeline/transform/images.js \
  's|export const EAGER_IMAGE_COUNT = 1;|export const EAGER_IMAGE_COUNT = 0;|' \
  examples/themes-demo

weaken "首屏图不补 fetchpriority" \
  packages/core/src/pipeline/transform/images.js \
  "s|if (isEager && !/\\\\bfetchpriority=/.test(next)) next += ' fetchpriority=\"high\"';|if (false) next += ' fetchpriority=\"high\"';|" \
  examples/themes-demo

weaken "空 alt 不兜底（把空串当成「作者写过了」）" \
  packages/core/src/pipeline/transform/images.js \
  "s|const hasRealAlt = altMatch && altMatch\[1\].trim() !== '';|const hasRealAlt = !!altMatch;|" \
  examples/themes-demo

# ── CSS 落位 ────────────────────────────────────────────────────
weaken "主题 CSS 不内联（页面裸奔）" \
  packages/core/src/pipeline/render/output.js \
  's|if (cssPlan.inline.length) {|if (false) {|'

weaken "变量覆盖块放到最前面（会被主题默认值盖掉）" \
  packages/core/src/pipeline/render/output.js \
  's|if (cssPlan.vars) blocks.push(cssPlan.vars);|if (cssPlan.vars) blocks.unshift(cssPlan.vars);|'

# ── 资源提示 ────────────────────────────────────────────────────
# 预取的站内校验是**两层**的（planPrefetch 的 isHintable + applyHints 的再过滤）。
# 「只削弱过滤函数」不会让产物变坏 —— 没有坏输入，过滤掉的是零个东西。
# 这不是防线失效，是分层生效；但也意味着削弱过滤函数**不能**作为负向验证。
#
# 真正的回归形状是「有人加了一个不走过滤的新来源」。所以这里同时做两件事：
# 塞一个外链源 + 抽掉第二层过滤（applyHints）。检查必须红。
# 第一层（planPrefetch 的 isHintable）挡不住 concat 加进来的东西 —— 它只过滤
# 自己的候选集，所以这里真正需要抽掉的是第二层。
weaken_pair "预取里混进外链且两层过滤都被抽掉" \
  packages/core/src/pipeline/index.js \
  "s|planPrefetch({ layout: 'post', related, newer })|planPrefetch({ layout: 'post', related, newer }).concat(['https://evil.example.com/x'])|" \
  packages/core/src/pipeline/index.js \
  "s|data.prefetch = Array.isArray(data.prefetch) ? data.prefetch.filter(isHintable) : \[\];|data.prefetch = Array.isArray(data.prefetch) ? data.prefetch : [];|" \
  examples/themes-demo

weaken "预取不校验地址存在（白下一次请求 + 404）" \
  packages/core/src/pipeline/index.js \
  "s|planPrefetch({ layout: 'post', related, newer })|planPrefetch({ layout: 'post', related, newer }).concat(['/does-not-exist.html'])|" \
  examples/themes-demo

weaken "预取条数上限失效" \
  packages/core/src/pipeline/transform/hints.js \
  's|return candidates.slice(0, policy.maxPrefetch);|return candidates.concat(Array(20).fill("/index.html"));|' \
  examples/themes-demo

# ── PWA ────────────────────────────────────────────────────────
weaken_pwa "SW 缓存名去掉内容指纹（缓存永不失效）" \
  packages/core/src/pipeline/pwa/service-worker.js \
  's|return `emeeek-${version}`;|return `emeeek-fixed`;|'

weaken_pwa "SW 自动 skipWaiting（新 SW 立刻接管正在读的页面）" \
  packages/core/src/pipeline/pwa/service-worker.js \
  "s|      .catch((error) => {|      .then(() => self.skipWaiting())\n      .catch((error) => {|"

weaken_pwa "manifest 声明不存在的图标（安装会被拒）" \
  packages/core/src/pipeline/pwa/manifest.js \
  "s|src: url,|src: '/nope-'+url,|"

weaken_pwa "离线页不进预缓存（它自己也要靠网络拿）" \
  packages/core/src/pipeline/index.js \
  "s|'/manifest.webmanifest',|'/manifest.webmanifest', '/offline.html',|"

weaken_pwa "预缓存塞进全站（每个访客多下载一整站）" \
  packages/core/src/pipeline/index.js \
  "s|const precachePosts = sorted.slice(0, Number(config.pwa?.precachePosts ?? 5));|const precachePosts = sorted;|"

# ── Service Worker 的运行时行为（真浏览器） ────────────────────
#
# 上面那些都是**静态**检查（读产物文本）。这一条不一样：把导航改成
# cache-first —— 那是最诱人也最错的做法，Lighthouse 分数会更好看 ——
# 然后用真浏览器确认 offline 回落真的坏掉。
# 静态检查看不出这个，因为两种写法产出的 sw.js 都「语法正确、结构齐全」。
echo ""
echo "▸ SW 运行时行为：导航改成 cache-first（分数更好看，但读者永远看不到新文章）"
SW=packages/core/src/pipeline/pwa/service-worker.js
cp "$SW" "$SW.bak"
python3 - "$SW" <<'PYEOF'
import sys
p = sys.argv[1]
s = open(p, encoding="utf-8").read()
# 把 network-first 的导航分支改成 cache-first：缓存命中就返回，永不请求网络。
s = s.replace("fetch(request)\n        .then((response) => {", "caches.match(request).then((hit) => hit || fetch(request)).then((response) => {")
open(p, "w", encoding="utf-8").write(s)
PYEOF
if diff -q "$SW" "$SW.bak" >/dev/null; then
  echo "  ✘ SW 导航 cache-first —— 削弱没生效（没匹配上）"
  FAIL=$((FAIL + 1))
elif node scripts/e2e/pwa.mjs >/dev/null 2>&1; then
  echo "  ✘ SW 导航 cache-first —— 削弱之后仍然通过，说明这条防线没被守住"
  FAIL=$((FAIL + 1))
else
  echo "  ✔ SW 导航 cache-first —— 削弱后真浏览器 e2e 变红（防线确实被守住）"
  PASS=$((PASS + 1))
fi
mv "$SW.bak" "$SW"

echo "  ── $PASS 条防线被守住，$FAIL 条没守住"
[ "$FAIL" -eq 0 ]
