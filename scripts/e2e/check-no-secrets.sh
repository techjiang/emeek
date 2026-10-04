#!/usr/bin/env bash
# 负向验证：扫描产物，确认没有任何 CDN 凭据 leaked 进去。
#
# 这条和 UI 上的「不显示 Key」不同：它检查的是**磁盘上的字节**。
# 一个 Key 出现在 dist/ 里，就算界面上打了码，推到 CDN 就等于公开。
set -uo pipefail

TARGET="${1:-dist}"

# 常见凭据形态 + 环境变量名，两者都扫。
PATTERNS=(
  'CF_API_KEY[=:]'
  'CF_ZONE_ID[=:]'
  'ALIYUN_ACCESS_KEY_(ID|SECRET)[=:]'
  'TENCENT_SECRET_(ID|KEY)[=:]'
  'EMEEEK_CDN_API_KEY[=:]'
  'Authorization: Bearer '
)

FOUND=0
for pattern in "${PATTERNS[@]}"; do
  # acceleration.json 里允许出现字段名（那是配置说明），但不允许出现值。
  hits=$(grep -rIlE "$pattern[^\"'[:space:]]{8,}" "$TARGET" 2>/dev/null || true)
  if [ -n "$hits" ]; then
    echo "  ✘ 产物中发现疑似凭据（模式 $pattern）："
    echo "$hits" | sed 's/^/      /'
    FOUND=1
  fi
done

if [ "$FOUND" -eq 0 ]; then
  echo "  ✔ 产物中未发现 CDN 凭据"
else
  echo "  ── 凭据泄露，部署会把它推到 CDN 上"
  exit 1
fi
