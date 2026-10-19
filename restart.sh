#!/usr/bin/env bash
# restart.sh — Winter 서버 재시작. 웹 UI 의 /restart 버튼이 이 스크립트를 detach spawn 한다.
set -uo pipefail
cd "$(dirname "$0")"
./stop.sh || true
sleep 1
exec ./start.sh
