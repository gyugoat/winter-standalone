// server/hooks/bg-job-notify.js
// UserPromptSubmit hook — 다음 턴 시작 시 백그라운드 job 완료/진행 상황을 additionalContext 로 주입.
//
// 레지스트리: data/bg-jobs.jsonl (app root 기준)
// 각 줄 형식 v1: { "id", "pid", "label", "log", "started", "notified" }
// 각 줄 형식 v2: { "v":2, "id", "pid", "label", "cmd", "cwd", "log", "started", "notified" }
//
// 동작 요약:
//   - pid 생존 여부: process.kill(pid, 0) try/catch (ESRCH = 죽음)
//   - 죽었고 notified !== true → 완료 판정. log 마지막 20줄 읽어 주입. notified = true 마킹.
//   - 살아있음 → 진행 중 주입 (경과 시간 + log 마지막 3줄). 마킹 안 함.
//   - notified=true + 죽은 job → 무시.
//   - 완료 후 24시간 지난 줄 → 파일에서 제거.
//
// 안전 원칙: 어떤 예외도 밖으로 throw 금지. 전부 try/catch 로 삼키고 {} 반환.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// hooks/bg-job-notify.js → ../../data/bg-jobs.jsonl = <app root>/data/bg-jobs.jsonl
const REGISTRY_PATH = fileURLToPath(new URL('../../data/bg-jobs.jsonl', import.meta.url));
const NOTIFY_EXPIRE_MS = 24 * 60 * 60 * 1000; // 24시간

// mkdir 기반 락 설정 — flock/wx 의미 충돌 없음, 파일 잔존 없음
const LOCK_PATH = REGISTRY_PATH + '.lock';   // 구 .lock 파일 잔재 정리용
const LOCKD_PATH = REGISTRY_PATH + '.lock.d';
const LOCK_RETRY_INTERVAL_MS = 50;
const LOCK_RETRY_MAX_MS = 2000;

// 구 .lock 파일 잔재 제거 (bgjob.sh 구버전이 남긴 0-byte 파일)
try { fs.rmSync(LOCK_PATH, { force: true }); } catch { /* 무시 */ }

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e.code === 'ESRCH') return false;
    // EPERM = 프로세스 존재하지만 권한 없음 → 살아있음으로 취급
    if (e.code === 'EPERM') return true;
    return false;
  }
}

function elapsedStr(startedIso) {
  try {
    const ms = Date.now() - new Date(startedIso).getTime();
    const secs = Math.floor(ms / 1000);
    if (secs < 60) return `${secs}초`;
    const mins = Math.floor(secs / 60);
    const rem = secs % 60;
    if (mins < 60) return `${mins}분 ${rem}초`;
    const hrs = Math.floor(mins / 60);
    const remMins = mins % 60;
    return `${hrs}시간 ${remMins}분`;
  } catch {
    return '?';
  }
}

function readLogTail(logPath, lines) {
  try {
    if (!logPath || !fs.existsSync(logPath)) return null;
    const stat = fs.statSync(logPath);
    if (stat.size === 0) return null;
    // execSync 대신 fs 직접 읽기 — 8KB tail
    const readSize = Math.min(stat.size, 8 * 1024);
    const offset = stat.size - readSize;
    const buf = Buffer.alloc(readSize);
    const fd = fs.openSync(logPath, 'r');
    try {
      fs.readSync(fd, buf, 0, readSize, offset);
    } finally {
      fs.closeSync(fd);
    }
    const text = buf.toString('utf8');
    const allLines = text.split('\n');
    const usable = offset > 0 ? allLines.slice(1) : allLines;
    if (usable.length > 0 && usable[usable.length - 1] === '') usable.pop();
    return usable.slice(-lines).join('\n') || null;
  } catch {
    return null;
  }
}

/**
 * writeFileSync 전 lock 획득 (mkdir 기반).
 * fs.mkdirSync(LOCKD_PATH) 로 exclusive create — mkdir 는 존재 시 원자적으로 EEXIST.
 * stale 탈취: mtime 10초 초과 시 rmdirSync 후 즉시 재시도.
 * 반환: { acquired: true } | { acquired: false }
 * 획득 실패 → 재기록 skip (주입은 진행 — "어떤 예외도 throw 금지" 원칙 유지).
 */
function acquireLock() {
  const deadline = Date.now() + LOCK_RETRY_MAX_MS;
  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(LOCKD_PATH);
      return { acquired: true };
    } catch (e) {
      if (e.code !== 'EEXIST') return { acquired: false }; // 예상 외 에러 → 포기
      // stale 탈취: mtime 10초 초과면 소유자 사망으로 간주
      try {
        const st = fs.statSync(LOCKD_PATH);
        if (Date.now() - st.mtimeMs > 10000) {
          fs.rmdirSync(LOCKD_PATH);
          continue; // 즉시 재시도
        }
      } catch { /* statSync/rmdirSync 실패 → 그냥 대기 */ }
      // 동기 sleep: Atomics.wait (worker_threads 없이 사용 가능한 spin 방법)
      try {
        const sa = new Int32Array(new SharedArrayBuffer(4));
        Atomics.wait(sa, 0, 0, LOCK_RETRY_INTERVAL_MS);
      } catch {
        // SharedArrayBuffer 미지원 환경 대비 — busy-loop fallback
        const t = Date.now() + LOCK_RETRY_INTERVAL_MS;
        while (Date.now() < t) { /* spin */ }
      }
    }
  }
  return { acquired: false };
}

function releaseLock() {
  try { fs.rmdirSync(LOCKD_PATH); } catch { /* */ }
}

export function makeBgJobNotify() {
  return async function bgJobNotify(/* input */) {
    try {
      // 레지스트리 없으면 조용히 통과
      if (!fs.existsSync(REGISTRY_PATH)) return {};

      let raw;
      try {
        raw = fs.readFileSync(REGISTRY_PATH, 'utf8');
      } catch {
        return {};
      }

      const lines = raw.split('\n').filter(l => l.trim());
      if (lines.length === 0) return {};

      const jobs = [];
      const unparseable = []; // JSON 파싱 실패 줄은 그대로 보존 (안전)

      for (const line of lines) {
        try {
          const job = JSON.parse(line);
          jobs.push(job);
        } catch {
          unparseable.push(line);
        }
      }

      const now = Date.now();
      const completedMsgs = [];
      const runningMsgs = [];
      const updatedJobs = [];

      for (const job of jobs) {
        try {
          const pid = Number(job.pid);
          const alive = isPidAlive(pid);

          if (!alive) {
            // 완료된 job
            const startedMs = job.started ? new Date(job.started).getTime() : null;
            const ageMs = startedMs ? now - startedMs : null;

            // 24시간 초과 → 파일에서 제거 (updatedJobs 에 넣지 않음)
            if (ageMs !== null && ageMs > NOTIFY_EXPIRE_MS) {
              continue;
            }

            // notified=true 이면 무시 (중복 통보 방지), 단 파일은 유지
            if (job.notified === true) {
              updatedJobs.push({ ...job });
              continue;
            }

            // 완료 판정 + 주입 대상
            const elapsed = job.started ? elapsedStr(job.started) : '?';
            const tail = readLogTail(job.log, 20);
            let msg = `✅ "${job.label || '(unnamed)'}" (pid ${pid}) 완료 — ${elapsed} 소요`;
            if (job.log) msg += `\n   log: ${job.log}`;
            if (tail) msg += `\n${tail.split('\n').map(l => `   ${l}`).join('\n')}`;
            msg += `\n   → 이 결과를 사용자에게 보고할 것. 사용자가 물어보지 않았어도 먼저 언급하라.`;
            completedMsgs.push(msg);

            // notified 마킹
            updatedJobs.push({ ...job, notified: true });
          } else {
            // 진행 중
            const elapsed = job.started ? elapsedStr(job.started) : '?';
            const tail = readLogTail(job.log, 3);
            let msg = `⏳ "${job.label || '(unnamed)'}" (pid ${pid}) 아직 진행 중 — ${elapsed} 경과`;
            if (tail) msg += `\n${tail.split('\n').map(l => `   ${l}`).join('\n')}`;
            runningMsgs.push(msg);

            updatedJobs.push({ ...job });
          }
        } catch {
          // 개별 job 처리 실패 → 원본 보존, 무시
          updatedJobs.push({ ...job });
        }
      }

      // 파일 재기록 (notified 마킹 반영 + 만료 제거) — lock 획득 후 진행
      if (completedMsgs.length > 0) {
        const { acquired } = acquireLock();
        if (acquired) {
          try {
            const newContent = [...updatedJobs.map(j => JSON.stringify(j)), ...unparseable]
              .filter(Boolean)
              .join('\n');
            fs.writeFileSync(REGISTRY_PATH, newContent ? newContent + '\n' : '', 'utf8');
          } catch {
            // 파일 쓰기 실패 → 무시 (주입은 그래도 진행)
          } finally {
            releaseLock();
          }
        }
        // 락 획득 실패 → 재기록 skip, 주입은 진행 (기존 "어떤 예외도 throw 금지" 원칙)
      }

      // 주입할 내용 없으면 빈 통과
      if (completedMsgs.length === 0 && runningMsgs.length === 0) return {};

      const parts = ['[백그라운드 작업 알림]'];
      if (completedMsgs.length > 0) parts.push(...completedMsgs);
      if (runningMsgs.length > 0) parts.push(...runningMsgs);

      const text = parts.join('\n\n');

      return {
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: text,
        },
      };
    } catch {
      // 최외곽 안전망 — 어떤 예외도 밖으로 던지지 않음
      return {};
    }
  };
}
