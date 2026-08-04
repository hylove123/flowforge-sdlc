#!/usr/bin/env bash
# 创建 GitHub Release v0.2.0 并上传更新资产（一次性脚本）
set -euo pipefail
cd "$(dirname "$0")/.."

GH_TOKEN=$(security find-generic-password \
  -s "IntelliJ Platform GitHub — 697f583a-c914-40dc-b7a8-77e80f880d0b" \
  -a "697f583a-c914-40dc-b7a8-77e80f880d0b" -w)

API="https://api.github.com/repos/hylove123/flowforge-sdlc"
NOTES="Harness Agent 全面升级：交付物回写闭环、门禁确认中心、内置代码智能工具、驳回反思重试、Dashboard 交付驾驶舱、导航收敛"

echo "==> 创建 Release v0.2.0 …"
BODY=$(RELEASE_NOTES="$NOTES" python3 -c "
import json, os
print(json.dumps({
  'tag_name': 'v0.2.0',
  'target_commitish': 'main',
  'name': 'FlowForge v0.2.0',
  'body': os.environ['RELEASE_NOTES'],
  'draft': False,
  'prerelease': False,
}))")
RESP=$(curl -s -X POST -H "Authorization: Bearer $GH_TOKEN" \
  -H "Accept: application/vnd.github+json" "$API/releases" \
  -d "$BODY")

UPLOAD_URL=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('upload_url',''))")
if [ -z "$UPLOAD_URL" ]; then
  echo "创建失败: $RESP" >&2
  exit 1
fi
UPLOAD_URL="${UPLOAD_URL%\{*}"
echo "Release 已创建，upload_url=$UPLOAD_URL"

upload() {
  local file="$1" name="$2" ctype="$3"
  echo "==> 上传 $name ($(du -h "$file" | cut -f1)) …"
  curl -s -X POST -H "Authorization: Bearer $GH_TOKEN" \
    -H "Content-Type: $ctype" \
    --data-binary "@$file" \
    "${UPLOAD_URL}?name=$name" | python3 -c "import json,sys; d=json.load(sys.stdin); print('   ->', d.get('name'), d.get('size'), 'bytes,', d.get('browser_download_url',''))"
}

upload src-tauri/target/release/bundle/macos/FlowForge.app.tar.gz FlowForge.app.tar.gz application/gzip
upload src-tauri/target/release/bundle/dmg/FlowForge_0.2.0_aarch64.dmg FlowForge_0.2.0_aarch64.dmg application/x-apple-diskimage
upload release-out/latest.json latest.json application/json

echo "==> 完成"
