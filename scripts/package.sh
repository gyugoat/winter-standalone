#!/usr/bin/env bash
# package.sh — Winter 배포 zip 생성 (dist/Winter-mac.zip, dist/Winter-windows.zip)
# 패키징 전 필수 파일 존재 검증 + 패키징 후 zip 내용물 개인정보/secret 스캔 내장.
set -euo pipefail
cd "$(dirname "$0")/.."

APP_ROOT="$(pwd)"
DIST="$APP_ROOT/dist"
mkdir -p "$DIST"

# 0) 패키저가 참조하는 파일 실존 검증 (끝까지 안 돌려보고 배포한 사고 방지)
for f in README.md package.json server/index.js web/index.html config/agents/hawk.md \
         dist/README-Winter-설치안내.md install-mac.command install-windows.ps1 start.ps1; do
  [ -e "$f" ] || { echo "ERROR: missing $f"; exit 1; }
done

echo "[package] mac zip 생성 중..."
python3 "$APP_ROOT/scripts/make-zip.py" mac

echo "[package] windows zip 생성 중 (NFC 파일명 + BOM 텍스트)..."
python3 "$APP_ROOT/scripts/make-zip.py" windows

echo "[package] zip 내용물 개인정보/secret 스캔..."
python3 "$APP_ROOT/scripts/scan-zip.py" "$DIST/Winter-mac.zip" "$DIST/Winter-windows.zip"

echo "[package] 완료 — $DIST"
ls -la "$DIST"/Winter-*.zip
