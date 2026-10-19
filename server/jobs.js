// server/jobs.js — 백그라운드 job 레지스트리 read-only 관측 + kill
//
// 레지스트리: gyuwul/data/bg-jobs.jsonl (server/ 기준 ../../data)
// v2 줄 형식: {"v":2,"id","pid","label","cmd","cwd","log","started","notified":false}
// v1 호환: v 필드 없거나 v<2 → id/pid/label/log/started/notified 만 있는 구형 줄.
//
// 안전 원칙:
//   - execSync 금지 — log tail 은 fs 로 직접 읽기
//   - 외부로 예외 throw 금지 — 개별 job 실패 시 safe fallback 반환
//   - 모듈 레벨 캐시: 로그 tail (1s TTL per job) + bytes 성장 추적 Map

import { readFileSync, statSync, openSync, closeSync, readSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ── 경로 설정 ──────────────────────────────────────────────────────────────
// server/jobs.js → ../../data/bg-jobs.jsonl = gyuwul/data/bg-jobs.jsonl
const REGISTRY_PATH = fileURLToPath(new URL('../../data/bg-jobs.jsonl', import.meta.url));

// ── 상수 ──────────────────────────────────────────────────────────────────
const TAIL_LINES = 20;
const TAIL_READ_BYTES = 8 * 1024;       // 파일 끝 8KB 읽기
const TAIL_CACHE_TTL_MS = 1000;         // per-job tail 캐시 1s
const STALLED_THRESHOLD_MS = 90 * 1000; // 90초 이상 바이트 무변화 → stalled

// ── 모듈 레벨 캐시 ────────────────────────────────────────────────────────
// tailCache: Map<id, { tail: string[], ts: number }>
const tailCache = new Map();

// growthMap: Map<id, { bytes: number, ts: number }>
// 폴링 호출마다 현재 바이트 수를 이전과 비교해 bytes_per_sec / stalled 계산
const growthMap = new Map();

// ── 헬퍼 ──────────────────────────────────────────────────────────────────

/** 레지스트리 읽기 — 줄별 JSON.parse, 실패 줄 skip */
export function readRegistry() {
  try {
    const raw = readFileSync(REGISTRY_PATH, 'utf8');
    const jobs = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        jobs.push(JSON.parse(trimmed));
      } catch {
        // 파싱 실패 줄 skip
      }
    }
    return jobs;
  } catch {
    return [];
  }
}

/** pid 생존 여부 — ESRCH = 죽음, EPERM = 살아있음(권한 없음), 기타 = 죽음으로 취급 */
export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e.code === 'ESRCH') return false;
    if (e.code === 'EPERM') return true; // 권한 없지만 존재
    return false;
  }
}

/**
 * 로그 파일 끝 8KB 읽어 마지막 N줄 배열 반환.
 * 1s TTL 캐시 적용.
 * execSync 미사용 — fs 직접 읽기.
 */
function readLogTail(logPath, id) {
  const now = Date.now();
  const cached = tailCache.get(id);
  if (cached && (now - cached.ts) < TAIL_CACHE_TTL_MS) {
    return cached.tail;
  }

  let tail = [];
  try {
    const stat = statSync(logPath);
    if (stat.size === 0) {
      tail = [];
    } else {
      const fd = openSync(logPath, 'r');
      try {
        const readSize = Math.min(stat.size, TAIL_READ_BYTES);
        const offset = stat.size - readSize;
        const buf = Buffer.alloc(readSize);
        readSync(fd, buf, 0, readSize, offset);
        const text = buf.toString('utf8');
        // 첫 줄은 잘릴 수 있으므로 제거 (offset > 0 인 경우만)
        const lines = text.split('\n');
        const usableLines = offset > 0 ? lines.slice(1) : lines;
        // 빈 마지막 줄 제거
        if (usableLines.length > 0 && usableLines[usableLines.length - 1] === '') {
          usableLines.pop();
        }
        tail = usableLines.slice(-TAIL_LINES);
      } finally {
        closeSync(fd);
      }
    }
  } catch {
    tail = [];
  }

  tailCache.set(id, { tail, ts: now });
  return tail;
}

/**
 * 로그 바이트 수 조회 + 성장 추적.
 * growthMap 과 비교해 bytes_per_sec + stalled 계산.
 * 반환: { log_bytes, bytes_per_sec, stalled }
 */
function trackGrowth(logPath, id, alive) {
  let log_bytes = 0;
  try {
    const stat = statSync(logPath);
    log_bytes = stat.size;
  } catch {
    log_bytes = 0;
  }

  const now = Date.now();
  const prev = growthMap.get(id);

  let bytes_per_sec = 0;
  let stalled = false;

  if (prev) {
    const dtMs = now - prev.ts;
    const dBytes = log_bytes - prev.bytes;
    bytes_per_sec = dtMs > 0 ? Math.round((dBytes / dtMs) * 1000) : 0;
    if (bytes_per_sec < 0) bytes_per_sec = 0; // 파일 truncate 방어

    // alive && 90초 이상 바이트 무변화 → stalled
    if (alive && dBytes === 0 && dtMs >= STALLED_THRESHOLD_MS) {
      stalled = true;
    }
  }

  // 바이트가 바뀐 경우만 growthMap 갱신 (마지막 변화 시점 보존 → stalled 정확도)
  if (!prev || log_bytes !== prev.bytes) {
    growthMap.set(id, { bytes: log_bytes, ts: now });
  }

  return { log_bytes, bytes_per_sec, stalled };
}

// ── 공개 API ──────────────────────────────────────────────────────────────

/**
 * listJobs() — 레지스트리의 모든 job 상태 반환.
 * 반환 job 객체:
 *   { id, label, started, elapsed_ms, alive, stalled, log_path, log_bytes, bytes_per_sec, tail }
 */
export function listJobs() {
  const jobs = readRegistry();
  const now = Date.now();
  const result = [];

  for (const job of jobs) {
    try {
      const id = String(job.id || '');
      const pid = Number(job.pid);
      const label = String(job.label || '(unnamed)');
      const started = job.started || null;
      const logPath = job.log || null;

      const alive = isPidAlive(pid);
      const elapsed_ms = started ? now - new Date(started).getTime() : null;

      let log_bytes = 0, bytes_per_sec = 0, stalled = false, tail = [];

      if (logPath) {
        const growth = trackGrowth(logPath, id, alive);
        log_bytes = growth.log_bytes;
        bytes_per_sec = growth.bytes_per_sec;
        stalled = growth.stalled;
        tail = readLogTail(logPath, id);
      }

      result.push({
        id,
        pid,
        label,
        started,
        elapsed_ms,
        alive,
        stalled,
        log_path: logPath,
        log_bytes,
        bytes_per_sec,
        tail,
      });
    } catch {
      // 개별 job 처리 실패 → 해당 job skip
    }
  }

  return result;
}

/**
 * killJob(id) — 레지스트리에서 id 찾아 SIGTERM 전송.
 * setsid spawn 이라 pgid == pid → process.kill(-pid) 로 프로세스 그룹 전체 kill.
 * ESRCH/EPERM 시 pid 직접 fallback.
 * 반환: { ok: true } | { ok: false, error: string }
 */
export function killJob(id) {
  const jobs = readRegistry();
  const job = jobs.find(j => String(j.id) === String(id));

  if (!job) {
    return { ok: false, error: `job not found: ${id}` };
  }

  const pid = Number(job.pid);
  if (!pid || isNaN(pid)) {
    return { ok: false, error: `invalid pid for job: ${id}` };
  }

  if (!isPidAlive(pid)) {
    return { ok: false, error: `process already dead: pid=${pid}` };
  }

  // setsid spawn → pgid == pid → 그룹 전체 SIGTERM
  try {
    process.kill(-pid, 'SIGTERM');
    return { ok: true };
  } catch (e) {
    if (e.code === 'ESRCH' || e.code === 'EPERM') {
      // pgid 실패 → pid 직접 fallback
      try {
        process.kill(pid, 'SIGTERM');
        return { ok: true };
      } catch (e2) {
        return { ok: false, error: `kill failed: ${e2.message}` };
      }
    }
    return { ok: false, error: `kill failed: ${e.message}` };
  }
}
