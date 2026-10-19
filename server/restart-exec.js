// server/restart-exec.js — POST /restart 의 spawn 스케줄러 (index.js 가 라우팅).
// 웹 UI 재시작 버튼이 LLM 안 거치고 서버에 직접 요청 → 여기서 restart.sh 를 detach spawn.
// drain / graceful TERM→KILL / health wait 은 전부 restart.sh 내장 (#29 V4/V5, #37)
// — 이 모듈은 spawn 만 하고 절대 그 로직을 재구현하지 않는다 (단일 진입점 유지).
//
// spawn 되는 restart.sh 는 server process 의 env (WINTER3_OWNER_PID) 를 상속하므로
// in_winter3_child() detect → 스스로 setsid detach → in-flight turn drain 후 재기동.
// 따라서 이 요청의 HTTP 응답은 정상적으로 나간다.

import { spawn } from 'node:child_process';
import { join } from 'node:path';

// 중복 클릭 가드 — 마지막 spawn 후 15초 내 재요청은 no-op (dedup:true).
export const RESTART_DEDUP_MS = 15_000;
let _lastSpawnAt = 0;

/**
 * restart.sh 를 detach spawn 한다.
 * @param {object} opts
 * @param {string} opts.home - winter3 루트 (index.js 의 HOME 상수 재사용, 하드코딩 금지)
 * @param {Function} [opts.spawnFn] - 테스트 주입용 (기본 node:child_process spawn)
 * @param {number} [opts.nowMs] - 테스트 주입용 현재 시각
 * @returns {{scheduled: true, dedup: boolean}} — spawn 실패 시 throw
 */
export function scheduleRestart({ home, spawnFn = spawn, nowMs = Date.now() }) {
  if (nowMs - _lastSpawnAt < RESTART_DEDUP_MS) {
    return { scheduled: true, dedup: true };
  }
  _lastSpawnAt = nowMs;
  try {
    const isWin = process.platform === 'win32';
    const child = isWin
      ? spawnFn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(home, 'restart.ps1')], {
          cwd: home, detached: true, stdio: 'ignore',
        })
      : spawnFn(join(home, 'restart.sh'), [], {
          cwd: home, detached: true, stdio: 'ignore',
        });
    if (child && typeof child.unref === 'function') child.unref();
  } catch (err) {
    _lastSpawnAt = 0; // spawn 실패 시 가드 해제 — 즉시 재시도 허용
    throw err;
  }
  return { scheduled: true, dedup: false };
}

// 테스트 전용 — dedup 상태 초기화.
export function _resetForTest() { _lastSpawnAt = 0; }
