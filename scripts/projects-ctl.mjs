#!/usr/bin/env node
// scripts/projects-ctl.mjs — data/projects.json 조작 CLI (축 4, TaskInfo §4-3(f))
//
// schedule-ctl.mjs 와 동형 — Winter 가 Bash 로 호출 (MCP/deferred tool 기각: #27/#2).
// 서버는 projects.json 을 매 조회 fresh read — 재시작/폴링 없이 즉시 반영.
//
// 사용:
//   node scripts/projects-ctl.mjs list
//   node scripts/projects-ctl.mjs add <name>
//   node scripts/projects-ctl.mjs rename <id> <newName>
//   node scripts/projects-ctl.mjs archive <id>
//   node scripts/projects-ctl.mjs unarchive <id>
//
// hard delete 커맨드는 없다 (§4-3(f) 확정) — remove/delete 입력 시 archive 안내만.

import {
  loadDoc, createProject, renameProject, setArchived, listProjects,
} from '../server/projects.js';

function die(msg) {
  console.error(`projects-ctl: ${msg}`);
  process.exit(1);
}

function fmtTs(ms) {
  if (ms == null) return '-';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function cmdList() {
  const { projects, dangling } = await listProjects();
  if (!projects.length) { console.log('projects: (없음)'); return; }
  for (const pr of projects) {
    const st = pr.status === 'archived' ? 'archived' : 'active  ';
    const idle = pr.inactive ? `  [${pr.idleDays}일 전]` : '';
    console.log(`${st}  ${pr.id}  ${pr.name}`);
    console.log(`          created=${fmtTs(pr.createdAt)}  lastActivity=${fmtTs(pr.lastActivityAt)}  멤버: 세션 ${pr.counts.sessions} / job ${pr.counts.jobs} / rea ${pr.counts.rea}${idle}`);
  }
  // dangling 참조 가시화 — silent 금지 (#34/#35)
  for (const d of dangling || []) {
    console.log(`(dangling) ${d.type}=${d.id} → projectId=${d.projectId} (선언에 없음)`);
  }
}

async function cmdAdd(name) {
  if (!name) die('add: 프로젝트 이름 필요');
  const proj = await createProject(name);
  console.log(`added: ${proj.id}  ${proj.name}`);
}

async function cmdRename(id, newName) {
  if (!id || !newName) die('rename: <id> <newName> 필요');
  const proj = await renameProject(id, newName);
  console.log(`renamed: ${proj.id}  → ${proj.name}`);
}

async function cmdArchive(id, archived) {
  if (!id) die(`${archived ? 'archive' : 'unarchive'}: project id 필요`);
  const proj = await setArchived(id, archived);
  console.log(`${proj.id}  status=${proj.status}`);
}

const [cmd, ...args] = process.argv.slice(2).filter((a) => !a.startsWith('--'));

try {
  switch (cmd) {
    case 'list': await cmdList(); break;
    case 'add': await cmdAdd(args.join(' ').trim()); break;
    case 'rename': await cmdRename(args[0], args.slice(1).join(' ').trim()); break;
    case 'archive': await cmdArchive(args[0], true); break;
    case 'unarchive': await cmdArchive(args[0], false); break;
    case 'remove':
    case 'delete':
      die('hard delete 없음 (TaskInfo §4-3(f) — dangling 방지 + 파괴 방지). archive <id> 를 사용해라.');
      break;
    default:
      // loadDoc 은 여기선 미사용이지만 import 는 파일 무결성 조기 검출용 — parse 실패 시 명시 에러.
      void loadDoc;
      console.error('사용: projects-ctl.mjs <list|add <name>|rename <id> <newName>|archive <id>|unarchive <id>>');
      process.exit(1);
  }
} catch (err) {
  die(err.message);
}
