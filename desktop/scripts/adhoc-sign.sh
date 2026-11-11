#!/usr/bin/env bash
# 构建后补 ad-hoc 签名。
#
# 不买 Apple 开发者账号 → electron-builder 的 identity: null 不会签名；
# 但 Apple Silicon 上完全未签名的 arm64 app 会被内核直接拒绝，用户看到的是「已损坏」。
# codesign -s - 是免费的本机临时签名，之后才是正常的「无法验证开发者」。
set -euo pipefail

cd "$(dirname "$0")/.."

APP="$(find release -maxdepth 3 -name '*.app' -type d 2>/dev/null | head -n 1)"
if [ -z "${APP}" ]; then
  echo "找不到构建产物 release/**/*.app" >&2
  exit 1
fi

echo "ad-hoc 签名：${APP}"
codesign --force --deep --sign - "${APP}"
codesign --verify --verbose=2 "${APP}"
echo "✅ 签名完成"
codesign -dv "${APP}" 2>&1 | sed 's/^/  /' || true
