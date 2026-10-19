// server/projects.js — 축 4 Projects: scope UUID tag (TaskInfo §4, 부록 A 결정 9-13 확정 2026-10-18)
//
// 모델 (결정 9): project = {id, name, status, ...} 메타만. 세션/job/REA 가 nullable projectId 로
// 가리키고, project 뷰는 조회 시 역인덱스 derive — 저장된 멤버 리스트 없음 (P1 raw=truth).
// 저장 (결정 10): data/projects.json 단일 파일, node-local (gitignore — #83). 상태 파일 0 —
//   lastActivityAt 등 derived 값은 저장하지 않고 매 조회 시 계산.
// status (§4-3(d)): 'active' | 'archived' 2값만. hard delete 없음 (§4-3(f) — dangling 양산 방지 + 파괴 방지).
// dangling (§4-3(e), #34/#35): 존재하지 않는 projectId 를 가리키는 멤버 = stderr warn + 응답에 노출. silent 금지.
//
// 매 조회마다 파일 fresh read (캐시 없음) — project 는 수십 규모 메타뿐이라 비용 무시 가능,
// 대신 projects-ctl.mjs (별 프로세스) 의 쓰기가 서버 재시작/폴링 없이 즉시 반영된다.

import { fileURLToPath } from 'node:url';
import { promises as fs, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as session from './session.js';

const HOME = process.env.WINTER3_HOME || fileURLToPath(new URL('..', import.meta.url));
const PROJECTS_PATH = join(HOME, 'data', 'projects.json');
const SCHEDULE_PATH = join(HOME, 'data', 'schedule.json');
const SCHEDULE_STATE_PATH = join(HOME, 'data', 'schedule-state.json');
const REA_DIR = join(HOME, 'data', 'rea'); // 축 5 자리 예약 — meta.json 의 projectId? (contact 계약 5)

export const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isUuid(v) { return typeof v === 'string' && UUID_V4_RE.test(v); }

const INACTIVITY_BADGE_DAYS = 7; // §4-3(d): active 7일+ 무활동 → "N일 전" 뱃지

// ── 저장소 I/O ─────────────────────────────────────────────────────────────

/**
 * projects.json 로드. 파일 없음 = 빈 문서. parse 실패/shape 불량 = throw —
 * 깨진 파일을 빈 문서로 덮어쓰는 silent 데이터 소실 금지 (schedule-ctl 의 die 패턴과 동형).
 */
export function loadDoc() {
  if (!existsSync(PROJECTS_PATH)) return { version: 1, projects: [] };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(PROJECTS_PATH, 'utf8'));
  } catch (err) {
    throw new Error(`projects.json parse 실패: ${err.message} — 수동 복구 필요 (덮어쓰지 않음)`);
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.projects)) {
    throw new Error('projects.json shape 불량 ({version, projects[]} 아님) — 수동 복구 필요');
  }
  return parsed;
}

// atomic write — session.js writeFileAtomic 과 동일 패턴 (tmp + rename, 동시 writer tmp 충돌 방지).
async function saveDoc(doc) {
  const tmp = `${PROJECTS_PATH}.tmp.${process.pid}.${Date.now()}`;
  try {
    await fs.writeFile(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    await fs.rename(tmp, PROJECTS_PATH);
  } catch (err) {
    try { await fs.unlink(tmp); } catch {}
    throw err;
  }
}

function validateName(name) {
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n) throw Object.assign(new Error('name: 비어있지 않은 문자열 필수'), { statusCode: 400 });
  return n.slice(0, 80);
}

// ── CRUD (hard delete 없음 — archive 만, §4-3(f)) ─────────────────────────

export async function createProject(name) {
  const n = validateName(name);
  const doc = loadDoc();
  const proj = {
    id: randomUUID(),            // uuid v4
    name: n,
    status: 'active',            // 'active' | 'archived' 2값만 (§4-3(d))
    createdAt: Date.now(),
    updatedAt: Date.now(),
    // rootDir / spaceId: 자리만 예약 (§4-3(a)(c) — epitaxy 선예약 수법). 쓰기 전까지 필드 생략.
  };
  doc.projects.push(proj);
  await saveDoc(doc);
  return proj;
}

function findOrThrow(doc, id) {
  if (!isUuid(id)) throw Object.assign(new Error('id: uuid v4 아님'), { statusCode: 400 });
  const proj = doc.projects.find((pr) => pr.id === id);
  if (!proj) throw Object.assign(new Error(`project not found: ${id}`), { statusCode: 404 });
  return proj;
}

export async function renameProject(id, name) {
  const n = validateName(name);
  const doc = loadDoc();
  const proj = findOrThrow(doc, id);
  proj.name = n;
  proj.updatedAt = Date.now();
  await saveDoc(doc);
  return proj;
}

/** archive/unarchive — status 2값 전환. hard delete 는 존재하지 않는다. */
export async function setArchived(id, archived) {
  const doc = loadDoc();
  const proj = findOrThrow(doc, id);
  proj.status = archived ? 'archived' : 'active';
  proj.updatedAt = Date.now();
  await saveDoc(doc);
  return proj;
}

export async function archiveProject(id) { return setArchived(id, true); }

/** 멤버 derive 없는 raw 조회 — 존재 확인용 (세션 할당 시 dangling 생성 차단). 없으면 null. */
export function getProjectRaw(id) {
  if (!isUuid(id)) return null;
  const doc = loadDoc();
  return doc.projects.find((pr) => pr.id === id) || null;
}

// ── 역인덱스 derive (P1 — 조회 시 계산, 저장 X) ───────────────────────────

function readJsonSafe(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/**
 * 멤버 3종 (세션 / schedule job / REA) 스캔 → projectId → members 역인덱스.
 * dangling (멤버가 가리키는 projectId 가 선언에 없음) 은 수집 + stderr — silent 금지 (#34/#35).
 */
async function deriveMembers(knownIds) {
  const byProject = new Map(); // projectId → { sessions:[], jobs:[], rea:[] }
  const dangling = [];
  const bucket = (pid) => {
    if (!byProject.has(pid)) byProject.set(pid, { sessions: [], jobs: [], rea: [] });
    return byProject.get(pid);
  };
  const note = (pid, type, memberId) => {
    if (!knownIds.has(pid)) dangling.push({ type, id: memberId, projectId: pid });
  };

  // 1) 세션 — data/sessions/*.json 의 nullable projectId (TaskInfo §4-3(b) 바인딩 1)
  try {
    for (const s of await session.list()) {
      if (typeof s.projectId !== 'string' || !s.projectId) continue;
      bucket(s.projectId).sessions.push({ id: s.id, title: s.title || '(제목 없음)', updatedAt: s.updatedAt || 0 });
      note(s.projectId, 'session', s.id);
    }
  } catch (err) {
    console.error(`[projects] 세션 스캔 실패 (derive 부분 결과로 계속): ${err.message}`);
  }

  // 2) schedule job — schedule.json 의 projectId? + schedule-state.json 의 lastRun (바인딩 2)
  const sched = readJsonSafe(SCHEDULE_PATH);
  const schedState = readJsonSafe(SCHEDULE_STATE_PATH);
  for (const job of Array.isArray(sched?.jobs) ? sched.jobs : []) {
    if (typeof job?.projectId !== 'string' || !job.projectId) continue;
    const lastRun = schedState?.runs?.[job.id]?.lastRun ?? null;
    bucket(job.projectId).jobs.push({ id: job.id, kind: job.kind, lastRun });
    note(job.projectId, 'job', job.id);
  }

  // 3) REA — data/rea/<hash>/meta.json 의 projectId? (축 5 자리 예약 — 디렉터리 없으면 0건)
  try {
    if (existsSync(REA_DIR)) {
      for (const hash of readdirSync(REA_DIR)) {
        const meta = readJsonSafe(join(REA_DIR, hash, 'meta.json'));
        if (typeof meta?.projectId !== 'string' || !meta.projectId) continue;
        // rea.js meta contract: origName + createdAt (name/ts 필드 없음 — QA 비블로커 fix)
        bucket(meta.projectId).rea.push({ hash, name: meta.origName || hash.slice(0, 12), ts: meta.createdAt || 0 });
        note(meta.projectId, 'rea', hash);
      }
    }
  } catch (err) {
    console.error(`[projects] REA 스캔 실패 (derive 부분 결과로 계속): ${err.message}`);
  }

  for (const d of dangling) {
    console.error(`[projects] dangling projectId: ${d.type}=${d.id} → ${d.projectId} (선언에 없음 — "(deleted project)" 처리)`);
  }
  return { byProject, dangling };
}

/** lastActivityAt = max(소속 세션 updatedAt, job lastRun, REA ts) — 조회 시 derive (§4-3(d)). */
function lastActivityOf(members) {
  let last = 0;
  for (const s of members.sessions) last = Math.max(last, s.updatedAt || 0);
  for (const j of members.jobs) last = Math.max(last, j.lastRun || 0);
  for (const r of members.rea) last = Math.max(last, r.ts || 0);
  return last || null;
}

function decorate(proj, members) {
  const m = members || { sessions: [], jobs: [], rea: [] };
  const lastActivityAt = lastActivityOf(m) || proj.updatedAt || proj.createdAt || null;
  const idleDays = lastActivityAt ? Math.floor((Date.now() - lastActivityAt) / 86_400_000) : null;
  return {
    ...proj,
    lastActivityAt,
    idleDays,
    // §4-3(d): active 7일+ 무활동 → UI 뱃지. 색 단계 없음 — 숫자가 정보.
    inactive: proj.status === 'active' && idleDays !== null && idleDays >= INACTIVITY_BADGE_DAYS,
    counts: { sessions: m.sessions.length, jobs: m.jobs.length, rea: m.rea.length },
  };
}

/** GET /api/projects — 전체 목록 + derived + dangling 노출. */
export async function listProjects() {
  const doc = loadDoc();
  const known = new Set(doc.projects.map((pr) => pr.id));
  const { byProject, dangling } = await deriveMembers(known);
  const projects = doc.projects
    .map((pr) => decorate(pr, byProject.get(pr.id)))
    .sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0));
  return { version: doc.version, projects, dangling };
}

/** GET /api/projects/:id — 상세 (멤버 리스트 포함). 없으면 null. */
export async function getProject(id) {
  const doc = loadDoc();
  if (!isUuid(id)) return null;
  const proj = doc.projects.find((pr) => pr.id === id);
  if (!proj) return null;
  const known = new Set(doc.projects.map((pr) => pr.id));
  const { byProject } = await deriveMembers(known);
  const members = byProject.get(id) || { sessions: [], jobs: [], rea: [] };
  members.sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return { ...decorate(proj, members), members };
}
