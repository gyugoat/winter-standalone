#!/usr/bin/env node
// scripts/rea-ctl.mjs — 축 5 REA CLI (TaskInfo §5-3(h), 결정 14 — 입구 A).
// schedule-ctl / projects-ctl 와 동형: Winter 가 Bash 로 호출 (MCP/deferred tool 기각 #27/#2).
//
// 사용:
//   node scripts/rea-ctl.mjs add <path> [--depth quick|deep] [--project <uuid>]
//   node scripts/rea-ctl.mjs list [--project <uuid>]
//   node scripts/rea-ctl.mjs show <hash>
//   node scripts/rea-ctl.mjs retry <hash> [--depth deep]
//   node scripts/rea-ctl.mjs clear-trash
//
// remove/delete 커맨드 없음 — 삭제는 서버 DELETE /api/rea/:hash (.trash 이동) 만. 파괴 방지.

import {
  analyze, listRea, getRea, retryLLM, clearTrash, isSha256, CACHE_ROOT,
} from '../server/rea.js';

function die(msg) {
  console.error(`rea-ctl: ${msg}`);
  process.exit(1);
}

function fmtTs(ms) {
  if (ms == null) return '-';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// --flag 파싱 (positional 과 분리)
const rawArgs = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === '--depth') { flags.depth = rawArgs[++i]; continue; }
  if (rawArgs[i] === '--project') { flags.project = rawArgs[++i]; continue; }
  if (rawArgs[i].startsWith('--')) die(`알 수 없는 플래그: ${rawArgs[i]}`);
  pos.push(rawArgs[i]);
}
const [cmd, ...args] = pos;
if (flags.depth && !['quick', 'deep'].includes(flags.depth)) die('--depth 는 quick|deep');

async function cmdAdd(path) {
  if (!path) die('add: <path> 필요');
  const meta = await analyze(path, { depth: flags.depth, projectId: flags.project || null });
  if (meta.cacheHit) console.log(`cache hit — unpack/mechanical 재실행 0 (§5-2 metric)`);
  console.log(`hash:    ${meta.hash}`);
  console.log(`format:  ${meta.format}${meta.subformat ? ` (${meta.subformat})` : ''}  size: ${meta.size}B  status: ${meta.status}`);
  if (meta.extMismatch) console.log(`warn:    확장자-magic 불일치 — magic 우선 적용`);
  if (meta.requires) console.log(`requires: ${meta.requires} (이 노드 unpack skip)`);
  for (const w of meta.warnings || []) console.log(`warn:    ${w}`);
  console.log(`meta:    data/rea/${meta.hash}/`);
  console.log(`cache:   ${CACHE_ROOT}/${meta.hash}/`);
}

function cmdList() {
  const items = listRea(flags.project || null);
  if (!items.length) { console.log('rea: (없음)'); return; }
  for (const m of items) {
    const proj = m.projectId ? `  proj=${m.projectId.slice(0, 8)}` : '';
    console.log(`${m.hash.slice(0, 12)}  ${(m.status || '?').padEnd(11)} ${(m.format || '?').padEnd(6)} ${String(m.size).padStart(10)}B  ${fmtTs(m.lastAccess)}  ${m.origName}${proj}`);
  }
}

function cmdShow(hash) {
  if (!isSha256(hash)) {
    // short hash 허용 — 전체 목록에서 prefix 매칭
    const matches = listRea().filter((m) => m.hash.startsWith(hash || ''));
    if (matches.length !== 1) die(`show: sha256 (또는 유일 prefix) 필요 — 매칭 ${matches.length}건`);
    hash = matches[0].hash;
  }
  const d = getRea(hash, { withContent: true });
  if (!d) die(`분석 이력 없음: ${hash}`);
  console.log(JSON.stringify({ ...d, result: undefined, mechanical: undefined }, null, 2));
  console.log('\n── result.md ──');
  console.log(d.result || '(없음)');
  console.log('── tree (앞부분) ──');
  console.log((d.mechanical?.tree || '(없음)').split('\n').slice(0, 40).join('\n'));
}

async function cmdRetry(hash) {
  if (!hash) die('retry: <hash> 필요');
  const { meta, llm } = await retryLLM(hash, flags.depth || 'quick');
  console.log(`retry: ${meta.hash.slice(0, 12)} depth=${meta.depth} → ${llm.todo ? 'LLM placeholder (미통합)' : 'done'}`);
  if (llm.reason) console.log(`note:  ${llm.reason}`);
}

async function cmdClearTrash() {
  const removed = await clearTrash();
  console.log(`clear-trash: ${removed.length}건 실삭제`);
  for (const p of removed) console.log(`  ${p}`);
}

try {
  switch (cmd) {
    case 'add': await cmdAdd(args[0]); break;
    case 'list': cmdList(); break;
    case 'show': cmdShow(args[0]); break;
    case 'retry': await cmdRetry(args[0]); break;
    case 'clear-trash': await cmdClearTrash(); break;
    case 'remove':
    case 'delete':
    case 'rm':
      die('삭제 커맨드 없음 — DELETE /api/rea/:hash (.trash 이동) 만 가능. 파괴 방지 (결정 16).');
      break;
    default:
      console.error('사용: rea-ctl.mjs <add <path> [--depth quick|deep] [--project <uuid>] | list [--project <uuid>] | show <hash> | retry <hash> [--depth deep] | clear-trash>');
      process.exit(1);
  }
} catch (err) {
  die(err.message);
}
