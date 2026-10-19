#!/usr/bin/env bash
# install-mac.command — Winter 설치 (macOS). 더블클릭 실행 가능.
set -euo pipefail
cd "$(dirname "$0")"

echo "=============================="
echo " Winter 설치 (macOS)"
echo "=============================="

# ── 1) Node.js >= 20 확인/설치 ────────────────────────────────────────────
need_node=1
if command -v node >/dev/null 2>&1; then
  major="$(node -v | sed 's/^v//' | cut -d. -f1)"
  if [ "$major" -ge 20 ]; then need_node=0; fi
fi
if [ "$need_node" -eq 1 ]; then
  echo "[1/4] Node.js 20+ 가 없습니다 — 설치 시도"
  if command -v brew >/dev/null 2>&1; then
    brew install node
  else
    echo "  Homebrew 가 없습니다. https://nodejs.org/ko/download 에서 Node.js LTS(.pkg) 를 설치한 뒤"
    echo "  이 스크립트를 다시 실행해 주세요."
    exit 1
  fi
else
  echo "[1/4] Node.js OK ($(node -v))"
fi

# ── 2) claude CLI 확인/설치 ──────────────────────────────────────────────
if ! command -v claude >/dev/null 2>&1; then
  echo "[2/4] claude CLI 설치 중..."
  curl -fsSL https://claude.ai/install.sh | bash
  # 설치 직후 PATH 반영
  export PATH="$HOME/.local/bin:$PATH"
  if ! command -v claude >/dev/null 2>&1; then
    echo "  claude CLI 설치 실패 — 터미널에서 수동 설치 후 재실행: curl -fsSL https://claude.ai/install.sh | bash"
    exit 1
  fi
else
  echo "[2/4] claude CLI OK ($(claude --version 2>/dev/null || echo installed))"
fi

# ── 3) npm install ──────────────────────────────────────────────────────
echo "[3/4] Node 패키지 설치 중..."
npm install --omit=dev --silent
echo "[3/4] npm OK"

# ── 4) Claude 인증 ──────────────────────────────────────────────────────
if [ -s "data/.auth-token" ]; then
  echo "[4/4] 인증 토큰 이미 존재 (data/.auth-token)"
else
  echo "[4/4] Claude 계정 인증이 필요합니다. 본인 Claude 구독 계정 (Pro/Max) 이 있어야 합니다."
  echo "  잠시 후 브라우저가 열립니다. 로그인해 주세요."
  set +e
  token_out="$(claude setup-token 2>/dev/null | grep -o 'sk-ant-oat[A-Za-z0-9_-]*' | tail -1)"
  set -e
  if [ -z "$token_out" ]; then
    echo ""
    echo "  자동 캡처에 실패했습니다. 터미널에서 직접 실행해 주세요:"
    echo "    claude setup-token"
    echo "  실행 후 나오는 sk-ant-oat... 토큰을 아래에 붙여넣으세요 (입력 후 Enter):"
    read -r token_out
  fi
  if [ -n "$token_out" ]; then
    mkdir -p data
    printf '%s' "$token_out" > data/.auth-token
    chmod 600 data/.auth-token
    echo "  토큰 저장 완료 (data/.auth-token)"
  else
    echo "  토큰이 입력되지 않았습니다 — 로컬 claude CLI 로그인 상태를 사용합니다."
    echo "  (문제가 생기면 'claude setup-token' 실행 후 토큰을 data/.auth-token 에 저장하세요)"
  fi
fi

# ── 시작 ────────────────────────────────────────────────────────────────
chmod +x start.sh stop.sh 2>/dev/null || true
./start.sh
open "http://localhost:${WINTER3_PORT:-7979}" 2>/dev/null || true
echo ""
echo "설치 완료. 다음부터는 start.sh 만 실행하면 됩니다."
