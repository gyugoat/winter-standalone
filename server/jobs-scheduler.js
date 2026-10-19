// server/jobs-scheduler.js — 축 1: scheduled tasks 1급화 (TaskInfo §1, plugins/README.md §3-2)
//
// 선언 소스: data/schedule.json (git 커밋 대상) — 단일 선언처.
// 상태:     data/schedule-state.json (gitignore, 머신 로컬) — 결정 #1 (선언/상태 분리).
//
// 스케줄 포맷 (§1-3(a) B 확정):
//   every:   "30m" | "1h" | ... — interval, epoch-anchor 기반 slot 재계산 (drift-safe)
//   dailyAt: "HH:MM" — 로컬 시각
//   cron:    자리만 예약 — 선언 시 validation 에러 (unimplemented)
//
// kind 4종 (§1-3(b) C 확정 + plugins/README §3-2 표):
//   turn    → HTTP POST localhost:PORT/dispatch   (runner 직접 import 금지 — 단일 진입점)
//   inject  → HTTP POST localhost:PORT/api/inject (LLM 없음)
//   shell   → scripts/bgjob.sh 경유 spawn → bg-jobs.jsonl 레지스트리 (기존 관측 통합)
//   handler → server/plugins/jobs/<handlerName>.js — 플러그인 로더 완성 전까지 unimplemented
//
// 함정 반영:
//   #79: job 당 고정 세션 (sidFile persist) — new_session 은 세션 소실 시 재생성만.
//   #26: 실패/429 시 scheduler 재투입 금지 — runner/서버 내장 retry 에 맡김. 기록만.
//   #31: shell job 의 restart/kill 류 명령 blocklist (spawn 전 자체 검사 — hook 밖 경로).
//   #44: state 쓰기 실패 = stderr + 계속. process.exit 금지.
//   #34/#35: 잘못된 job 선언 = 소리 내고 skip (stderr + state 기록). silent no-op 금지.
//   결정 #2: enabled:false job 은 로드만, 실행 안 함.
//   결정 #3: startup missed-run — dailyAt=catchup 1회 / every=skip (다음 slot 부터).

import { readFileSync, writeFileSync, renameSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

// ── 상수 ──────────────────────────────────────────────────────────────────
const TICK_MS = Number(process.env.WINTER3_SCHED_TICK_MS || 30_000); // QA 용 env override
const DEFAULT_TIMEOUT_MS = 300_000;
const HTTP_TIMEOUT_CAP_MS = 60_000;   // turn/inject HTTP 호출 자체의 cap (dispatch 는 202 즉시 반환)
const MIN_EVERY_MS = 10_000;

const KINDS = new Set(['turn', 'inject', 'shell', 'handler']);
const NODES = new Set(['mac', 'wsl', 'both']);
const ID_RE = /^[a-zA-Z0-9_-]+$/;
const DAILY_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
// 축 4 projectId 형식 (server/projects.js 와 동일 — scheduler 가 projects 모듈을 import 하지 않도록 로컬 상수)
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// shell job blocklist — TaskInfo §1-5 (#31): shell job 은 hook 밖 경로라 자체 검사 필수.
export const SHELL_BLOCKLIST = [
  [/restart\.sh/, 'restart.sh 호출 금지 (#31 self-restart cascade)'],
  [/\bstop\.sh\b/, 'stop.sh 호출 금지 (#31)'],
  [/\b(pkill|killall)\b/, '광역 kill 금지 (#29 pkill -f 광역 매칭)'],
  [/(^|[;&|]\s*)kill\s/, 'kill 직접 호출 금지 (#29)'],
  [/\blaunchctl\b/, 'launchctl 금지 (#37 split-brain)'],
  [/\brm\s+-[a-zA-Z]*(rf|fr)\b/, 'rm -rf 금지 (Core Rules §2)'],
  [/git\s+push\b[^;|&]*--force/, 'git push --force 금지'],
  [/git\s+reset\s+--hard/, 'git reset --hard 금지'],
  [/git\s+clean\s+-[a-zA-Z]*f/, 'git clean -f 금지'],
  [/\bmkfs\b|\bdd\s+if=/, '디스크 파괴 명령 금지'],
];

// ── 모듈 상태 ─────────────────────────────────────────────────────────────
let HOME = null;
let PORT = 7979;
const NODE = process.platform === 'darwin' ? 'mac' : 'wsl';
let timer = null;
let ticking = false;
let lastScheduleMtimeMs = -1;
let jobs = [];                                  // validate 통과분만
let state = { version: 1, runs: {} };

function schedulePath() { return join(HOME, 'data', 'schedule.json'); }
function statePath() { return join(HOME, 'data', 'schedule-state.json'); }

// ── 포맷 파서 / 검증 (schedule-ctl.mjs 가 import 해서 재사용) ─────────────

/** "30m" → ms. 형식 오류 = null. */
export function parseEvery(s) {
  if (typeof s !== 'string') return null;
  const m = s.match(/^(\d+)(s|m|h|d)$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]];
}

/**
 * job 1건 검증. 반환 { errors: string[], warnings: string[] } — errors 비면 유효.
 * silent no-op 금지 (#34/#35): 미지 필드는 warning, 치명 오류는 error 로 전부 소리 냄.
 */
export function validateJob(job) {
  const errors = [];
  const warnings = [];
  if (!job || typeof job !== 'object') return { errors: ['job 이 object 가 아님'], warnings };

  if (typeof job.id !== 'string' || !ID_RE.test(job.id)) errors.push('id: [a-zA-Z0-9_-]+ 필수');
  if (job.enabled !== undefined && typeof job.enabled !== 'boolean') errors.push('enabled: boolean 이어야 함');
  if (!NODES.has(job.node)) errors.push('node: "mac"|"wsl"|"both" 필수 (#11/#78 — 머신 구분 없는 job 금지)');

  // 스케줄 필드 — 정확히 1개
  const schedFields = ['every', 'dailyAt', 'cron'].filter((k) => job[k] !== undefined);
  if (schedFields.length !== 1) {
    errors.push('every | dailyAt | cron 중 정확히 1개 필요');
  } else if (job.cron !== undefined) {
    errors.push('cron: 자리만 예약됨 — unimplemented (§1-3(a) 후속 C)');
  } else if (job.every !== undefined) {
    const ms = parseEvery(job.every);
    if (ms === null) errors.push(`every: "30m"/"1h" 형식 아님: ${JSON.stringify(job.every)}`);
    else if (ms < MIN_EVERY_MS) errors.push(`every: 최소 ${MIN_EVERY_MS / 1000}s`);
  } else if (!DAILY_RE.test(job.dailyAt)) {
    errors.push(`dailyAt: "HH:MM" 형식 아님: ${JSON.stringify(job.dailyAt)}`);
  }

  // kind + payload
  if (!KINDS.has(job.kind)) {
    errors.push('kind: "turn"|"inject"|"shell"|"handler" 필수');
  } else {
    const p = job.payload || {};
    if (job.kind === 'turn' && typeof p.text !== 'string') errors.push('turn: payload.text (string) 필수');
    if (job.kind === 'inject') {
      if (typeof p.text !== 'string') errors.push('inject: payload.text (string) 필수');
      if (typeof p.source !== 'string' || !p.source.trim()) errors.push('inject: payload.source (string) 필수');
    }
    if (job.kind === 'shell') {
      if (typeof p.cmd !== 'string' || !p.cmd.trim()) errors.push('shell: payload.cmd (string) 필수');
      else {
        for (const [re, reason] of SHELL_BLOCKLIST) {
          if (re.test(p.cmd)) errors.push(`shell blocklist: ${reason}`);
        }
      }
    }
    if (job.kind === 'handler' && (typeof job.handlerName !== 'string' || !ID_RE.test(job.handlerName))) {
      errors.push('handler: handlerName (kebab-case) 필수 (plugins/README §3-2)');
    }
  }

  if (job.timeoutMs !== undefined) {
    const t = Number(job.timeoutMs);
    if (!Number.isFinite(t) || t < 1_000 || t > 3_600_000) errors.push('timeoutMs: 1000..3600000');
  }
  if (job.session !== undefined) {
    if (typeof job.session !== 'object' || job.session.mode !== 'pinned') {
      errors.push('session: { mode: "pinned", sidFile? } 만 지원 (#79 — 고정 세션이 기본)');
    } else if (job.session.sidFile !== undefined && typeof job.session.sidFile !== 'string') {
      errors.push('session.sidFile: string 이어야 함');
    }
  }
  // 축 4 Projects (TaskInfo §4-3(b) 바인딩 2, contact 계약 5): nullable projectId — 형식 검증만.
  // 존재 확인은 lazy (project 뷰가 조회 시 derive + dangling warn) — scheduler 는 fetch 안 함.
  if (job.projectId !== undefined && job.projectId !== null) {
    if (typeof job.projectId !== 'string' || !UUID_V4_RE.test(job.projectId)) {
      errors.push('projectId: uuid v4 string 또는 null');
    }
  }

  // 미지 필드 warn — typo 탐지 (#34/#35 계열 방어). x- prefix 는 자유 (plugins/README §2).
  const KNOWN = new Set(['id', 'enabled', 'node', 'every', 'dailyAt', 'cron', 'kind', 'payload', 'session', 'timeoutMs', 'handlerName', 'projectId']);
  for (const k of Object.keys(job)) {
    if (!KNOWN.has(k) && !k.startsWith('x-')) warnings.push(`미지 필드 "${k}" — typo?`);
  }
  return { errors, warnings };
}

// ── due 계산 ──────────────────────────────────────────────────────────────

function lastDailyOccurrence(hh, mm, nowMs) {
  const d = new Date(nowMs);
  d.setHours(hh, mm, 0, 0);
  if (d.getTime() > nowMs) d.setDate(d.getDate() - 1);
  return d.getTime();
}
function nextDailyOccurrence(hh, mm, nowMs) {
  const d = new Date(nowMs);
  d.setHours(hh, mm, 0, 0);
  if (d.getTime() <= nowMs) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/**
 * due 판정. rec = state.runs[job.id] (mutable — every 첫 관측 시 startup-skip 기록).
 * 반환 { due, nextRun }.
 */
function computeDue(job, rec, now) {
  if (job.every !== undefined) {
    const interval = parseEvery(job.every);
    const slot = Math.floor(now / interval) * interval; // epoch-anchored (drift-safe)
    const nextRun = slot + interval;
    if (rec.lastRun == null) {
      // 결정 #3: every 의 startup missed-run = skip — 현재 slot 포기, 다음 slot 부터.
      rec.lastRun = slot;
      rec.lastResult = { ts: now, ok: null, detail: 'startup: missed-run skip (every 정책, 결정 #3)' };
      return { due: false, nextRun };
    }
    // restart 중복 방지 (§1-3(f)): 직전 실행이 interval 절반 이내면 skip
    if (now - rec.lastRun < interval * 0.5) return { due: false, nextRun };
    return { due: rec.lastRun < slot, nextRun };
  }
  if (job.dailyAt !== undefined) {
    const m = job.dailyAt.match(DAILY_RE);
    const hh = Number(m[1]), mm = Number(m[2]);
    const lastOcc = lastDailyOccurrence(hh, mm, now);
    const nextOcc = nextDailyOccurrence(hh, mm, now);
    // 결정 #3: dailyAt 의 startup missed-run = catchup 1회 (lastRun < 마지막 occurrence → due)
    const due = rec.lastRun == null ? true : rec.lastRun < lastOcc;
    return { due, nextRun: nextOcc };
  }
  return { due: false, nextRun: null };
}

// ── state persist ─────────────────────────────────────────────────────────

function loadState() {
  try {
    const parsed = JSON.parse(readFileSync(statePath(), 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.runs && typeof parsed.runs === 'object') return parsed;
    console.error('[scheduler] schedule-state.json shape 불량 — 초기화');
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[scheduler] state 읽기 실패 — 초기화: ${err.message}`);
  }
  return { version: 1, runs: {} };
}

function saveState() {
  // #44: 쓰기 실패해도 process 는 산다 — stderr 만.
  try {
    const p = statePath();
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
    renameSync(tmp, p);
  } catch (err) {
    console.error(`[scheduler] state 쓰기 실패 (계속 동작, #44): ${err.message}`);
  }
}

// ── 고정 세션 (sidFile persist — #79) ─────────────────────────────────────

function sidFilePath(job) {
  const rel = job.session?.sidFile || join('data', 'schedule-sessions', `${job.id}.sid`);
  return isAbsolute(rel) ? rel : join(HOME, rel);
}
function readSid(job) {
  try {
    const sid = readFileSync(sidFilePath(job), 'utf8').trim();
    return sid && ID_RE.test(sid) ? sid : null;
  } catch { return null; }
}
function writeSid(job, sid) {
  try {
    const p = sidFilePath(job);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, sid + '\n');
  } catch (err) {
    console.error(`[scheduler] sidFile 쓰기 실패 job=${job.id}: ${err.message}`);
  }
}

// ── 실행기 — kind 별 3+1 분기 ─────────────────────────────────────────────

async function postJson(path, body, timeoutMs) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Math.min(timeoutMs, HTTP_TIMEOUT_CAP_MS)),
  });
  let data = null;
  try { data = await res.json(); } catch { /* 비 JSON 응답 */ }
  return { status: res.status, data };
}

// turn — 단일 진입점 POST /dispatch. sid 는 고정 (sidFile), 세션 meta 는 dispatch 가 자동 생성.
// 결과 = dispatch 수락 여부(202)만 — 턴 완료는 비동기 (runner 소관). 실패 시 재투입 금지 (#26).
async function runTurn(job, timeoutMs) {
  let sid = readSid(job);
  if (!sid) {
    sid = `sched-${job.id}-${Date.now().toString(36)}`;
    writeSid(job, sid);
  }
  const { status, data } = await postJson('/dispatch', { sessionId: sid, userText: job.payload.text }, timeoutMs);
  if (status === 202) return { ok: true, detail: `dispatch accepted sid=${sid}` };
  return { ok: false, detail: `dispatch ${status}: ${data?.error || '?'} (재투입 안 함 — #26)` };
}

// inject — #79 fix 의 inject_winter3() 패턴 일반화: 저장된 sid 우선, 404(세션 소실) 시에만 new_session 재생성.
async function runInject(job, timeoutMs) {
  const { text, source } = job.payload;
  let sid = readSid(job);
  if (sid) {
    const { status, data } = await postJson('/api/inject', { text, source, session_id: sid }, timeoutMs);
    if (status === 200) return { ok: true, detail: `injected sid=${sid}` };
    if (status !== 404) return { ok: false, detail: `inject ${status}: ${data?.error || '?'}` };
    // 404 = 고정 세션 삭제됨 → 아래에서 재생성
  }
  const { status, data } = await postJson('/api/inject', { text, source, new_session: true }, timeoutMs);
  if (status === 200 && data?.session_id) {
    writeSid(job, data.session_id);
    return { ok: true, detail: `injected (세션 재생성) sid=${data.session_id}` };
  }
  return { ok: false, detail: `inject(new_session) ${status}: ${data?.error || '?'}` };
}

// shell — bgjob.sh 경유로 bg-jobs.jsonl 레지스트리에 등록 (관측 통합, 새 체계 안 만듦).
// blocklist 는 validate 에서 1차, 여기서 2차 (defense-in-depth — reload 로 들어온 선언 대비).
async function runShell(job) {
  const cmd = job.payload.cmd;
  for (const [re, reason] of SHELL_BLOCKLIST) {
    if (re.test(cmd)) return { ok: false, detail: `blocklist 거부: ${reason}` };
  }
  const label = job.payload.label || `sched:${job.id}`;
  const bgjob = join(HOME, 'scripts', 'bgjob.sh');
  try {
    const { stdout } = await execFileP('bash', [bgjob, label, cmd], { cwd: HOME, timeout: 15_000 });
    return { ok: true, detail: (stdout || '').trim().slice(0, 300) || 'bgjob spawned' };
  } catch (err) {
    return { ok: false, detail: `bgjob spawn 실패: ${err.message}` };
  }
}

async function runJob(job) {
  const t0 = Date.now();
  const timeoutMs = job.timeoutMs || DEFAULT_TIMEOUT_MS;
  let result;
  try {
    if (job.kind === 'turn') result = await runTurn(job, timeoutMs);
    else if (job.kind === 'inject') result = await runInject(job, timeoutMs);
    else if (job.kind === 'shell') result = await runShell(job);
    else if (job.kind === 'handler') result = { ok: false, detail: 'kind:handler unimplemented — plugins 로더 미완 (plugins/README.md §3-2)' };
    else result = { ok: false, detail: `unknown kind: ${job.kind}` };
  } catch (err) {
    result = { ok: false, detail: String(err?.message || err) };
  }
  result.durationMs = Date.now() - t0;
  return result;
}

// ── 로드 / tick ───────────────────────────────────────────────────────────

function loadSchedule(reason) {
  let raw;
  try {
    raw = readFileSync(schedulePath(), 'utf8');
  } catch (err) {
    console.error(`[scheduler] schedule.json 읽기 실패 (${reason}) — 이전 설정 유지: ${err.message}`);
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`[scheduler] schedule.json parse 실패 (${reason}) — 이전 설정 유지: ${err.message}`);
    return;
  }
  const list = Array.isArray(parsed?.jobs) ? parsed.jobs : [];
  const valid = [];
  const seen = new Set();
  for (const job of list) {
    const { errors, warnings } = validateJob(job);
    const id = typeof job?.id === 'string' ? job.id : '(no-id)';
    for (const w of warnings) console.error(`[scheduler] warn job=${id}: ${w}`);
    if (seen.has(id)) errors.push('중복 id');
    if (errors.length) {
      // #34/#35: silent skip 금지 — stderr + state 양쪽 기록
      console.error(`[scheduler] invalid job=${id} — skip: ${errors.join('; ')}`);
      if (id !== '(no-id)') {
        state.runs[id] = { ...(state.runs[id] || {}), lastResult: { ts: Date.now(), ok: false, detail: `config invalid: ${errors.join('; ')}` } };
      }
      continue;
    }
    seen.add(id);
    valid.push(job);
  }
  jobs = valid;
  saveState();
  console.log(`[scheduler] schedule.json 로드 (${reason}): ${valid.length}/${list.length} job 유효, node=${NODE}`);
}

function maybeReload() {
  // §1-3(e): 서버는 schedule.json mtime 폴링으로 reload — schedule-ctl 수정이 재시작 없이 반영.
  let mtimeMs;
  try { mtimeMs = statSync(schedulePath()).mtimeMs; }
  catch { return; } // 파일 없음 — 기존 설정 유지 (초기 로드에서 이미 소리 냄)
  if (mtimeMs !== lastScheduleMtimeMs) {
    lastScheduleMtimeMs = mtimeMs;
    loadSchedule('mtime 변경');
  }
}

async function tick() {
  if (ticking) return; // 직렬 보장 — 이전 tick 의 job 이 길어도 중첩 실행 없음
  ticking = true;
  try {
    maybeReload();
    const now = Date.now();
    for (const job of jobs) {
      try {
        if (job.enabled === false) continue;                       // 결정 #2: 로드만, 실행 안 함
        if (job.node !== 'both' && job.node !== NODE) continue;    // 머신 필터
        const rec = state.runs[job.id] || (state.runs[job.id] = {});
        const { due, nextRun } = computeDue(job, rec, now);
        rec.nextRun = nextRun;
        if (!due) continue;
        // 실행 직전 lastRun persist — 실행 중 crash 해도 재기동 시 중복 실행 방지 (#26 과 동일 정신)
        rec.lastRun = Date.now();
        saveState();
        console.log(`[scheduler] run job=${job.id} kind=${job.kind}`);
        const result = await runJob(job);                          // 직렬 (동시 1 job)
        rec.lastResult = { ts: Date.now(), ok: result.ok, durationMs: result.durationMs, detail: result.detail };
        const after = computeDue(job, rec, Date.now());
        rec.nextRun = after.nextRun;
        saveState();
        const logFn = result.ok ? console.log : console.error;
        logFn(`[scheduler] done job=${job.id} ok=${result.ok} ${result.durationMs}ms — ${result.detail}`);
      } catch (err) {
        // 개별 job 실패가 루프를 못 죽임 — 기록 후 다음 job (#44)
        console.error(`[scheduler] job=${job?.id} 실행 루프 에러: ${err.message}`);
        if (job?.id) {
          state.runs[job.id] = { ...(state.runs[job.id] || {}), lastResult: { ts: Date.now(), ok: false, detail: `scheduler 내부 에러: ${err.message}` } };
          saveState();
        }
      }
    }
  } catch (err) {
    console.error(`[scheduler] tick 에러: ${err.message}`);
  } finally {
    ticking = false;
  }
}

// ── 공개 API ──────────────────────────────────────────────────────────────

/**
 * index.js boot 에서 1회 호출. throw 해도 호출측 try/catch 로 서버는 산다.
 * timer 는 unref — scheduler 가 process 종료를 막지 않음.
 */
export function initScheduler({ home, port }) {
  if (timer) return { jobs: jobs.length, already: true };
  HOME = home;
  PORT = port;
  state = loadState();
  try { lastScheduleMtimeMs = statSync(schedulePath()).mtimeMs; } catch { lastScheduleMtimeMs = -1; }
  loadSchedule('startup');
  timer = setInterval(tick, TICK_MS);
  timer.unref();
  // 기동 3s 후 첫 tick — dailyAt catchup (결정 #3) 이 다음 30s tick 을 안 기다리게.
  const first = setTimeout(tick, 3_000);
  first.unref();
  console.log(`[scheduler] init node=${NODE} tick=${TICK_MS}ms jobs=${jobs.length}`);
  return { jobs: jobs.length };
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** GET /schedule 패널 (TaskInfo §1-4 step 3, 후속) 용 스냅샷. */
export function getSchedulerStatus() {
  return {
    node: NODE,
    tickMs: TICK_MS,
    jobs: jobs.map((j) => ({
      id: j.id,
      enabled: j.enabled !== false,
      node: j.node,
      kind: j.kind,
      schedule: j.every !== undefined ? { every: j.every } : { dailyAt: j.dailyAt },
      ...(state.runs[j.id] || {}),
    })),
  };
}
