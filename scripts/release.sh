#!/usr/bin/env bash
# ================================================================
#  release.sh — FlowForge 发版脚本（GitHub Releases 自动更新）
#
#  用法：
#    ./scripts/release.sh 0.2.0                 # 构建并生成发版产物
#    ./scripts/release.sh 0.2.0 "修复了xxx"      # 附带更新说明
#
#  产出（target/release/bundle/macos/ 与 release-out/）：
#    - FlowForge.app.tar.gz        更新包（上传到 Release assets）
#    - FlowForge_x.y.z_aarch64.dmg 安装包（上传到 Release assets）
#    - release-out/latest.json     更新清单（上传到 Release assets，文件名必须为 latest.json）
#
#  上传后（仓库需为 public）：
#    旧版本用户启动应用 → 静默检查 GitHub latest.json → 发现新版本 →
#    下载 tar.gz → 公钥验签 → 安装并重启
# ================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:?用法: ./scripts/release.sh <版本号> [更新说明]}"
NOTES="${2:-FlowForge v${VERSION}}"

# 1. 更新 tauri.conf.json 版本号（updater 用 semver 比较，必须大于已发布版本）
CONF=src-tauri/tauri.conf.json
python3 - "$CONF" "$VERSION" <<'EOF'
import json, sys
path, ver = sys.argv[1], sys.argv[2]
conf = json.load(open(path))
conf['version'] = ver
json.dump(conf, open(path, 'w'), ensure_ascii=False, indent=2)
print(f'version → {ver}')
EOF

# 2. 签名密钥（.env 中的本地密钥文件）
[ -f src-tauri/keys/flowforge.key ] || { echo "缺少签名密钥 src-tauri/keys/flowforge.key"; exit 1; }
export TAURI_SIGNING_PRIVATE_KEY="$(cat src-tauri/keys/flowforge.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-flowforge-local-dev}"
export PATH="$HOME/.cargo/bin:$PATH"

# 3. 构建（自动签名更新包）
echo "==> tauri build v${VERSION} …"
npm run tauri:build

BUNDLE=src-tauri/target/release/bundle/macos
DMG=$(ls src-tauri/target/release/bundle/dmg/FlowForge_*.dmg | head -1)
SIG="$(cat "${BUNDLE}/FlowForge.app.tar.gz.sig")"

# 4. 生成 latest.json（与 tauri.conf.json 的 endpoint 对应）
mkdir -p release-out
python3 - "$VERSION" "$NOTES" "$SIG" <<'EOF'
import json, sys, datetime
ver, notes, sig = sys.argv[1], sys.argv[2], sys.argv[3]
base = 'https://github.com/hylove123/flowforge-sdlc/releases/latest/download'
manifest = {
  'version': ver,
  'notes': notes,
  'pub_date': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
  'platforms': {
    'darwin-aarch64': {
      'signature': sig,
      'url': f'{base}/FlowForge.app.tar.gz',
    },
  },
}
open('release-out/latest.json', 'w').write(json.dumps(manifest, ensure_ascii=False, indent=2))
print('release-out/latest.json 已生成')
EOF

echo ""
echo "================================================================"
echo " 发版产物就绪，请到 GitHub 创建 Release（tag v${VERSION}）并上传："
echo "   1. ${BUNDLE}/FlowForge.app.tar.gz"
echo "   2. ${DMG}"
echo "   3. release-out/latest.json   ← 资产名必须为 latest.json"
echo "================================================================"
