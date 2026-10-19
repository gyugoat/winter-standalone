#!/usr/bin/env bash
# stop.sh — Winter 서버 종료 (mac / linux). 포트 점유 PID 를 정확히 잡아 graceful TERM → KILL.
set -uo pipefail
cd "$(dirname "$0")"
PORT="${WINTER3_PORT:-7979}"

PIDS="$(lsof -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true)"
if [ -z "$PIDS" ]; then
  echo "[winter] 포트 $PORT 에 실행 중인 서버 없음"
  exit 0
fi
for PID in $PIDS; do
  kill "$PID" 2>/dev/null || true
done
# graceful 대기 (최대 8초) 후 남으면 KILL
REMAIN=""
for _ in $(seq 1 16); do
  REMAIN="$(lsof -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true)"
  [ -z "$REMAIN" ] && { echo "[winter] 종료 완료 (PID: $PIDS)"; exit 0; }
  sleep 0.5
done
for PID in $REMAIN; do
  kill -9 "$PID" 2>/dev/null || true
done
echo "[winter] 강제 종료 (PID: $REMAIN)"
