#!/usr/bin/env bash
# start.sh — Winter 서버 시작 (mac / linux)
set -euo pipefail
cd "$(dirname "$0")"

PORT="${WINTER3_PORT:-7979}"

# 인증 토큰: data/.auth-token 있으면 주입 (server/index.js 도 자체 주입하지만 이중 안전망)
if [ -f "data/.auth-token" ] && [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  CLAUDE_CODE_OAUTH_TOKEN="$(cat data/.auth-token)"
  export CLAUDE_CODE_OAUTH_TOKEN
fi

# 이미 떠 있으면 안내 후 종료 (--max-time 으로 non-HTTP 리스너에 걸려 hang 방지)
if curl -sf --max-time 2 "http://localhost:${PORT}/health" >/dev/null 2>&1; then
  echo "[winter] 이미 실행 중 — http://localhost:${PORT}"
  exit 0
fi

# 포트 점유 체크 — winter health 가 아닌데 포트가 쓰이면 다른 프로세스가 점유 중
port_in_use=0
if command -v lsof >/dev/null 2>&1; then
  if lsof -iTCP:"${PORT}" -sTCP:LISTEN -t >/dev/null 2>&1; then port_in_use=1; fi
elif command -v ss >/dev/null 2>&1; then
  if ss -ltn "sport = :${PORT}" 2>/dev/null | tail -n +2 | grep -q .; then port_in_use=1; fi
elif command -v netstat >/dev/null 2>&1; then
  if netstat -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${PORT}\$"; then port_in_use=1; fi
fi
if [ "$port_in_use" -eq 1 ]; then
  echo "[winter] 포트 ${PORT} 가 다른 프로세스에 점유 중이에요."
  echo "         다른 포트로 바꾸려면: WINTER3_PORT=8080 ./start.sh"
  exit 1
fi

mkdir -p data/logs
echo "[winter] 서버 시작 — http://localhost:${PORT}"
WINTER3_PORT="$PORT" nohup node server/index.js >> data/logs/server.log 2>&1 &

# health 대기 (최대 15초)
for _ in $(seq 1 30); do
  if curl -sf "http://localhost:${PORT}/health" >/dev/null 2>&1; then
    echo "[winter] 준비 완료 — 브라우저에서 http://localhost:${PORT} 를 여세요"
    exit 0
  fi
  sleep 0.5
done
echo "[winter] 경고: health 확인 실패 — data/logs/server.log 를 확인하세요"
exit 1
