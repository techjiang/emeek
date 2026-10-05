#!/usr/bin/env bash
set -uo pipefail
PASS=0; FAIL=0
check() { if eval "$2"; then echo "  ✔ $1"; PASS=$((PASS+1)); else echo "  ✘ $1"; FAIL=$((FAIL+1)); fi; }

WORK=$(mktemp -d)
cd "$WORK"
mkdir -p posts
cat > emeeek.config.js <<'JS'
export default {
  site: { title: 'E2E', url: 'https://e2e.test' },
  content: { source: 'local', localDirs: ['posts'] },
};
JS
cat > posts/a.md <<'MD'
---
title: 你好
date: 2024-06-01
tags: [测试]
---

# 你好

这是一篇用于端到端验证的文章。中文内容用于字体子集规划。
MD

EMEEK=/workspace/packages/cli/bin/emeeek.js

echo "▸ 1. 构建 + 加速产物"
node "$EMEEK" build --cwd "$WORK" >/dev/null 2>&1
check "acceleration.json 生成" "test -f dist/acceleration.json"
check "nginx 片段生成" "test -f dist/server/nginx.conf"
check "Caddyfile 生成" "test -f dist/server/Caddyfile"
check "存在指纹资源" "ls dist/assets/ | grep -qE '\.[0-9a-f]{8}\.svg'"
check "存在 .gz 预压缩" "test -n \"\$(find dist -name '*.gz' -print -quit)\""
check "存在 .br 预压缩" "test -n \"\$(find dist -name '*.br' -print -quit)\""

echo "▸ 2. 缓存头正确"
check "静态资源 immutable" "node -e \"const m=require('./dist/acceleration.json'); process.exit(m.headers.some(h=>h.class==='immutable'&&/immutable/.test(h.headers['Cache-Control']))?0:1)\""
check "HTML 短缓存" "node -e \"const m=require('./dist/acceleration.json'); process.exit(m.headers.some(h=>h.class==='html'&&/max-age=300/.test(h.headers['Cache-Control']))?0:1)\""
check "索引不缓存久" "node -e \"const m=require('./dist/acceleration.json'); const d=m.headers.find(h=>h.class==='data'); process.exit(d&&!/immutable/.test(d.headers['Cache-Control'])?0:1)\""

echo "▸ 3. 幂等"
D1=$(node -e "console.log(require('./dist/acceleration.json').compression.count)")
node "$EMEEK" build --cwd "$WORK" >/dev/null 2>&1
D2=$(node -e "console.log(require('./dist/acceleration.json').compression.count)")
check "二次构建预压缩数量一致" "[ '$D1' = '$D2' ]"
node "$EMEEK" accelerate --fanout --cwd "$WORK" >/dev/null 2>&1
OUT=$(node "$EMEEK" accelerate --fanout --cwd "$WORK" 2>&1)
check "多源站重复推送被跳过" "echo \"\$OUT\" | grep -q '重复推送不产生副作用'"

echo "▸ 4. 中文加速规划"
PLAN=$(node "$EMEEK" accelerate --plan --cwd "$WORK" 2>&1)
check "字体子集规划输出分片" "echo \"\$PLAN\" | grep -q 'subset-0.woff2'"
check "国内不可达扫描执行" "echo \"\$PLAN\" | grep -q '国内不可达引用'"

echo "▸ 5. 凭据不泄露（负向验证）"
export CF_API_KEY="e2e-secret-token-must-not-leak-12345"
export CF_ZONE_ID="zone-e2e"
node "$EMEEK" build --cwd "$WORK" >/dev/null 2>&1
check "产物中无 API Key" "! grep -rq 'e2e-secret-token-must-not-leak' dist/"
check "配置中无 API Key" "! grep -q 'e2e-secret-token-must-not-leak' emeeek.config.js"

echo "▸ 6. 把 Key 写进配置 → 构建必须失败（负向验证）"
cat > emeeek.config.js <<'JS'
export default {
  site: { title: 'E2E', url: 'https://e2e.test' },
  cdn: { enabled: true, provider: 'cloudflare', zoneId: 'z', apiKey: 'oops-in-config' },
};
JS
if node "$EMEEK" build --cwd "$WORK" >/dev/null 2>&1; then
  echo "  ✘ 配置里写 Key 竟然没被拦住"; FAIL=$((FAIL+1))
else
  echo "  ✔ 配置里写 Key 被拦住"; PASS=$((PASS+1))
fi

echo "  ── $PASS 通过，$FAIL 失败"
rm -rf "$WORK"
[ "$FAIL" -eq 0 ]
