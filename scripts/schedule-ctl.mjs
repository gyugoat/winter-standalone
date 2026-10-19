#!/usr/bin/env node
// scripts/schedule-ctl.mjs — data/schedule.json 조작 CLI (축 1, TaskInfo §1-3(e))
//
// SDK deferred tool (CronCreate/ScheduleWakeup) 대체 — deferred unblock 은 #2 (silent hang) 로 금지.
// Winter 는 이 CLI 를 Bash 로 호출. 서버는 schedule.json mtime 폴링(30s)으로 reload — 재시작 불필요.
//
// 사용:
//   node scripts/schedule-ctl.mjs list
//   node scripts/schedule-ctl.mjs add <job.json> [--enabled]   # default: enabled:false 강제 (결정 #2)
//   node scripts/schedule-ctl.mjs enable <id>
//   node scripts/schedule-ctl.mjs disable <id>
//   node scripts/schedule-ctl.mjs remove <id>
//   node scripts/schedule-ctl.mjs status
//
// 결정 #2: 자가 생성 job 은 enabled:false 로 들어간다. --enabled 는 사람(사용자) 수동 전용 —
// Winter 가 add 할 땐 플래그 없이 호출하고, 활성화는 사용자 `enable <id>` 로.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateJob } from '../server/jobs-scheduler.js';

const HOME = fileURLToPath(new URL('..', import.meta.url)); // winter3/
const SCHEDULE_PATH = join(HOME, 'data', 'schedule.json');
const STATE_PATH = join(HOME, 'data', 'schedule-state.json');

function die(msg) {
  console.error(`schedule-ctl: ${msg}`);
  process.exit(1);
}

function loadSchedule() {
  if (!existsSync(SCHEDULE_PATH)) return { version: 1, jobs: [] };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(SCHEDULE_PATH, 'utf8'));
  } catch (err) {
    die(`schedule.json parse 실패: ${err.message} — 수동 복구 필요 (덮어쓰지 않음)`);
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.jobs)) {
    die('schedule.json shape 불량 ({version, jobs[]} 아님) — 수동 복구 필요');
  }
  return parsed;
}

function saveSchedule(doc) {
  // atomic write — 쓰다 죽어도 선언 파일은 온전
  mkdirSync(dirname(SCHEDULE_PATH), { recursive: true });
  const tmp = `${SCHEDULE_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n');
  renameSync(tmp, SCHEDULE_PATH);
}

function loadState() {
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    if (parsed?.runs && typeof parsed.runs === 'object') return parsed;
  } catch { /* 없거나 깨짐 — 빈 상태로 */ }
  return { version: 1, runs: {} };
}

function schedDesc(job) {
  if (job.every !== undefined) return `every ${job.every}`;
  if (job.dailyAt !== undefined) return `dailyAt ${job.dailyAt}`;
  if (job.cron !== undefined) return `cron ${job.cron} (unimplemented)`;
  return '(없음)';
}

function fmtTs(ms) {
  if (ms == null) return '-';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ── 명령 ──────────────────────────────────────────────────────────────────

function cmdList() {
  const doc = loadSchedule();
  if (!doc.jobs.length) { console.log('jobs: (없음)'); return; }
  for (const j of doc.jobs) {
    const en = j.enabled === false ? 'disabled' : 'enabled ';
    console.log(`${en}  ${String(j.id).padEnd(24)} node=${String(j.node).padEnd(4)} kind=${String(j.kind).padEnd(7)} ${schedDesc(j)}`);
  }
}

function cmdAdd(file, flags) {
  if (!file) die('add: job JSON 파일 경로 필요');
  const fp = resolve(process.cwd(), file);
  let input;
  try {
    input = JSON.parse(readFileSync(fp, 'utf8'));
  } catch (err) {
    die(`입력 파일 읽기/parse 실패 (${fp}): ${err.message}`);
  }
  // 단일 job object 또는 {jobs:[...]} 둘 다 수용
  const incoming = Array.isArray(input?.jobs) ? input.jobs : [input];
  if (!incoming.length) die('add: job 이 없음');

  const doc = loadSchedule();
  const ids = new Set(doc.jobs.map((j) => j.id));
  const forceEnabled = flags.includes('--enabled');

  for (const job of incoming) {
    // 결정 #2: enabled:false 강제. --enabled (사람 수동) 시에만 true.
    job.enabled = forceEnabled ? true : false;
    const { errors, warnings } = validateJob(job);
    for (const w of warnings) console.error(`warn job=${job?.id}: ${w}`);
    if (errors.length) die(`job=${job?.id || '?'} 검증 실패:\n  - ${errors.join('\n  - ')}`);
    if (ids.has(job.id)) die(`job=${job.id} 이미 존재 — remove 후 add 하거나 다른 id 사용`);
    ids.add(job.id);
    doc.jobs.push(job);
    console.log(`added: ${job.id} (${schedDesc(job)}, kind=${job.kind}, enabled=${job.enabled})`);
    if (!job.enabled) console.log(`  → 활성화는 사람이: node scripts/schedule-ctl.mjs enable ${job.id} (결정 #2)`);
    if (job.dailyAt !== undefined) console.log('  → 주의: enable 시점에 오늘 dailyAt 시각이 이미 지났으면 catchup 1회 즉시 실행 (결정 #3)');
  }
  saveSchedule(doc);
}

function setEnabled(id, value) {
  if (!id) die(`${value ? 'enable' : 'disable'}: job id 필요`);
  const doc = loadSchedule();
  const job = doc.jobs.find((j) => j.id === id);
  if (!job) die(`job not found: ${id}`);
  job.enabled = value;
  saveSchedule(doc);
  console.log(`${id}: enabled=${value}`);
}

function cmdRemove(id) {
  if (!id) die('remove: job id 필요');
  const doc = loadSchedule();
  const before = doc.jobs.length;
  doc.jobs = doc.jobs.filter((j) => j.id !== id);
  if (doc.jobs.length === before) die(`job not found: ${id}`);
  saveSchedule(doc);
  console.log(`removed: ${id}`);
}

function cmdStatus() {
  const doc = loadSchedule();
  const st = loadState();
  if (!doc.jobs.length) { console.log('jobs: (없음)'); return; }
  for (const j of doc.jobs) {
    const rec = st.runs[j.id] || {};
    const r = rec.lastResult;
    const resStr = r
      ? `ok=${r.ok}${r.durationMs != null ? ` ${r.durationMs}ms` : ''} — ${String(r.detail || '').slice(0, 120)}`
      : '(기록 없음)';
    console.log(`${j.id} [${j.enabled === false ? 'disabled' : 'enabled'}] node=${j.node} kind=${j.kind} ${schedDesc(j)}`);
    console.log(`  lastRun=${fmtTs(rec.lastRun)}  nextRun=${fmtTs(rec.nextRun)}`);
    console.log(`  lastResult: ${resStr}`);
  }
  // 선언에 없는데 state 에 남은 잔재도 표시 (silent 금지)
  const declared = new Set(doc.jobs.map((j) => j.id));
  for (const id of Object.keys(st.runs)) {
    if (!declared.has(id)) console.log(`(orphan state) ${id} — 선언에 없음, lastRun=${fmtTs(st.runs[id].lastRun)}`);
  }
}

// ── entry ─────────────────────────────────────────────────────────────────

const [cmd, ...rest] = process.argv.slice(2);
const args = rest.filter((a) => !a.startsWith('--'));
const flags = rest.filter((a) => a.startsWith('--'));

switch (cmd) {
  case 'list': cmdList(); break;
  case 'add': cmdAdd(args[0], flags); break;
  case 'enable': setEnabled(args[0], true); break;
  case 'disable': setEnabled(args[0], false); break;
  case 'remove': cmdRemove(args[0]); break;
  case 'status': cmdStatus(); break;
  default:
    console.error('사용: schedule-ctl.mjs <list|add <file> [--enabled]|enable <id>|disable <id>|remove <id>|status>');
    process.exit(1);
}
