#!/usr/bin/env bash
# scripts/bgjob.sh — 백그라운드 job 래퍼
# Winter 가 백그라운드 job 을 띄울 때 사용. 레지스트리 자동 등록.
#
# 사용: bgjob.sh "레이블" "실행할 명령"
#
# 동작:
#   1. setsid 로 명령을 세션 분리해 띄우고 로그를 /tmp/bgjob-<id>.log 로 리다이렉트
#   2. data/bg-jobs.jsonl 에 한 줄 append (mkdir 기반 락으로 원자적 쓰기)
#   3. pid 와 로그 경로를 stdout 출력
#
# v2 스키마: {"v":2,"id","pid","label","cmd","cwd","log","started","notified":false}
# 락: REGISTRY.lock.d 디렉토리 — mkdir 원자성으로 flock/wx 의미 충돌 없음

set -euo pipefail

# REGISTRY: app root/data
REGISTRY="$(cd "$(dirname "$0")/.." && pwd)/data/bg-jobs.jsonl"

if [[ $# -lt 2 ]]; then
  echo "사용: $0 \"레이블\" \"실행할 명령\"" >&2
  exit 1
fi

LABEL="$1"
CMD="$2"

# 타임스탬프 기반 id
ID="bgjob_$(date +%Y%m%d_%H%M%S)_$$"
LOG="/tmp/${ID}.log"
STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# setsid 로 세션 분리 spawn — nohup 미사용 (setsid 와 중복, nohup.out 오염 방지)
# < /dev/null : stdin 닫기, > "$LOG" 2>&1 : stdout/stderr 로그 리다이렉트
setsid bash -c "$CMD" > "$LOG" 2>&1 < /dev/null &
PID=$!

# REGISTRY 디렉토리 없으면 생성 (첫 실행 시 안전)
mkdir -p "$(dirname "$REGISTRY")"

# JSON escape 를 python3 로 안전하게 생성 (따옴표/한글/공백/특수문자 안전)
JSON_LINE="$(python3 -c "
import json, sys
v = {
    'v': 2,
    'id': sys.argv[1],
    'pid': int(sys.argv[2]),
    'label': sys.argv[3],
    'cmd': sys.argv[4],
    'cwd': sys.argv[5],
    'log': sys.argv[6],
    'started': sys.argv[7],
    'notified': False,
}
print(json.dumps(v, ensure_ascii=False))
" "$ID" "$PID" "$LABEL" "$CMD" "$PWD" "$LOG" "$STARTED")"

# mkdir 기반 락으로 원자적 append — flock 과 달리 파일 잔존 없음
LOCKD="${REGISTRY}.lock.d"

acquire() {
  local waited=0
  while ! mkdir "$LOCKD" 2>/dev/null; do
    # stale 탈취: 10초 이상 묵은 락은 소유자 사망으로 간주
    lock_mtime="$(stat -c %Y "$LOCKD" 2>/dev/null || stat -f %m "$LOCKD" 2>/dev/null || true)"
    if [[ -z "$lock_mtime" ]]; then
      continue   # lock.d 가 체크 사이에 사라짐 — 다음 루프에서 mkdir 재시도
    fi
    if (( $(date +%s) - lock_mtime > 10 )); then
      rmdir "$LOCKD" 2>/dev/null && continue
    fi
    sleep 0.05; waited=$((waited+1))
    [[ $waited -gt 40 ]] && return 1   # 2초 포기
  done
  return 0
}

# 비정상 종료 시 락 해제 보장
trap 'rmdir "$LOCKD" 2>/dev/null; trap - EXIT' EXIT INT TERM

if acquire; then
  printf '%s\n' "$JSON_LINE" >> "$REGISTRY"
  rmdir "$LOCKD" 2>/dev/null
  trap - EXIT INT TERM
else
  # 락 획득 실패해도 append 는 진행 (등록 유실이 더 나쁨 — 락은 best-effort)
  printf '%s\n' "$JSON_LINE" >> "$REGISTRY"
  trap - EXIT INT TERM
fi

echo "bgjob registered: id=$ID pid=$PID label=\"$LABEL\" log=$LOG"
