// server/session.js
// Minimal session metadata. Stored as data/sessions/<sid>.json.

import { fileURLToPath } from 'node:url';
import { promises as fs, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { forkSession } from '@anthropic-ai/claude-agent-sdk';

const HOME = process.env.WINTER3_HOME || fileURLToPath(new URL('..', import.meta.url));
const SESSIONS_DIR = join(HOME, 'data', 'sessions');
if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true });

function pathFor(sid) {
  return join(SESSIONS_DIR, `${sid}.json`);
}

// Atomic write — tmp 에 쓰고 rename (POSIX atomic). partial write 시 target 보존.
// 17-oracle audit 2026-05-03: 이전 `fs.writeFile` 직접은 동시 dispatch + setClaudeSessionId 가
// 한 sid 에 동시 발생 시 partial write race 가능 (한쪽 write 가 다른 쪽의 절반에 덮어씌움).
// rename atomic 으로 그 race 차단. tmp 명에 pid + Date.now 박아 동시 writer 의 tmp 충돌 방지.
//
// 한계 (다음 turn / Phase 3): setClaudeSessionId 의 read-modify-write race 는 atomic write 만으론
// 못 막음. last-write-wins 가능. per-sid Mutex chaining 필요 (별도 PR).
async function writeFileAtomic(targetPath, content) {
  const tmp = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
  try {
    await fs.writeFile(tmp, content, 'utf8');
    await fs.rename(tmp, targetPath);
  } catch (err) {
    try { await fs.unlink(tmp); } catch {}
    throw err;
  }
}

export async function create(title) {
  const id = randomUUID();
  const meta = {
    id,
    title: title || '새 대화',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    claudeSessionId: null,
  };
  await writeFileAtomic(pathFor(id), JSON.stringify(meta, null, 2));
  return meta;
}

export async function load(sid) {
  if (!existsSync(pathFor(sid))) return null;
  try { return JSON.parse(await fs.readFile(pathFor(sid), 'utf8')); }
  catch { return null; }
}

export async function save(meta) {
  meta.updatedAt = Date.now();
  await writeFileAtomic(pathFor(meta.id), JSON.stringify(meta, null, 2));
  return meta;
}

export async function list() {
  const files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
  const out = [];
  for (const f of files) {
    try {
      const m = JSON.parse(await fs.readFile(join(SESSIONS_DIR, f), 'utf8'));
      out.push(m);
    } catch { /* skip */ }
  }
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return out;
}

// forkAndSwap — 격리 성공 직후 호출. SDK forkSession 으로 clean branch 를 만들고
// session.json 의 claudeSessionId 를 fork ID 로 교체한다.
// 다음 turn 이 fork ID 로 resume → 원본 세션의 trigger 어휘 축적 영향 차단.
// 실패 시 null 반환 (격리 자체는 이미 성공했으므로 fatal 아님).
export async function forkAndSwap(sid, workspacePath) {
  process.stderr.write(`[session] forkAndSwap called sid=${sid} workspacePath=${workspacePath}\n`);
  const meta = await load(sid);
  if (!meta?.claudeSessionId) {
    process.stderr.write(`[session] forkAndSwap skipped sid=${sid}: no claudeSessionId (meta=${JSON.stringify(meta?.id ?? null)})\n`);
    return null;
  }

  process.stderr.write(`[session] forkAndSwap attempting sid=${sid} claudeSessionId=${meta.claudeSessionId}\n`);
  try {
    const result = await forkSession(meta.claudeSessionId, {
      dir: workspacePath,
      title: `${meta.title || 'untitled'} (clean)`,
    });
    const forkedId = result?.sessionId;
    if (!forkedId) {
      process.stderr.write(`[session] forkAndSwap got no sessionId sid=${sid} result=${JSON.stringify(result)}\n`);
      return null;
    }
    // session.json 의 claudeSessionId 를 fork ID 로 교체
    await setClaudeSessionId(sid, forkedId);
    process.stderr.write(`[session] forkAndSwap ok sid=${sid} ${meta.claudeSessionId} → ${forkedId}\n`);
    return forkedId;
  } catch (e) {
    process.stderr.write(`[session] forkAndSwap failed sid=${sid} claudeSessionId=${meta.claudeSessionId}: ${e.message}\n${e.stack}\n`);
    return null;
  }
}

// setClaudeSessionId — persisted so next turn can --resume.
export async function setClaudeSessionId(sid, claudeSessionId) {
  const m = await load(sid);
  if (!m) return null;
  m.claudeSessionId = claudeSessionId;
  return save(m);
}

// setLastActualModel — 매 turn 의 system/init 이벤트에서 Anthropic 이 실제로 서빙한 모델 문자열 저장.
// 별칭(opus/sonnet 등) → 실제 버전(claude-opus-4-7 등) 추적용.
export async function setLastActualModel(sid, actualModel) {
  const m = await load(sid);
  if (!m) return null;
  m.lastActualModel = String(actualModel);
  return save(m);
}

// setModelOverride — 세션별 model override 설정 (fable-5 500 등 대비).
// 유효성 검증은 호출 측 (index.js) 에서 runner.isAllowedModel 로 함. null 이면 override 제거 → DEFAULT_MODEL 로 복귀.
// 원칙 P1 준수: raw 는 그대로, 스킨만 얹음 — 기존 세션 (modelOverride 없음) 회귀 0.
export async function setModelOverride(sid, modelOrNull) {
  const m = await load(sid);
  if (!m) return null;
  if (modelOrNull === null || modelOrNull === undefined || modelOrNull === '') {
    delete m.modelOverride;
  } else {
    m.modelOverride = String(modelOrNull);
  }
  return save(m);
}

// setProjectId — 축 4 Projects (TaskInfo §4-3(b) 바인딩 1): 세션 메타의 nullable projectId 할당/해제.
// null/''/undefined → 필드 제거 (기존 세션은 필드 자체가 없음 — migration 금지, 무변경 원칙).
// projectId 존재 검증은 호출 측 (index.js — dangling 신규 생성 차단). 멤버당 project ≤ 1 (결정 12).
export async function setProjectId(sid, projectIdOrNull) {
  const m = await load(sid);
  if (!m) return null;
  if (projectIdOrNull === null || projectIdOrNull === undefined || projectIdOrNull === '') {
    delete m.projectId;
  } else {
    m.projectId = String(projectIdOrNull);
  }
  return save(m);
}

// rename — title 변경.
// 수동(PATCH endpoint)이든 LLM 자동(session-title.maybeAutoTitle)이든 호출되면
// titleAuto=false 로 확정 → 이후 자동제목 생성이 다시 덮어쓰지 않는다.
export async function rename(sid, newTitle, _opts = {}) {
  const m = await load(sid);
  if (!m) return null;
  m.title = String(newTitle || '').slice(0, 120) || '(제목 없음)';
  m.titleAuto = false;
  return save(m);
}

// 아카이브 디렉토리 + 요약 생성 — remove / restore 에서 공용.
const nodeFs = await import('node:fs');
const nodePath = await import('node:path');
const HOME_FOR_ARCHIVE = process.env.WINTER3_HOME || fileURLToPath(new URL('..', import.meta.url));
const EVT_DIR = nodePath.join(HOME_FOR_ARCHIVE, 'data', 'events');
const ARCHIVE_DIR = nodePath.join(EVT_DIR, 'archived');

function ensureArchive() {
  if (!nodeFs.existsSync(ARCHIVE_DIR)) nodeFs.mkdirSync(ARCHIVE_DIR, { recursive: true });
}

function buildSummaryMarkdown(sid, meta, jsonlText) {
  const lines = jsonlText.split('\n').filter((l) => l.length > 0);
  let firstTs = null, lastTs = null;
  const userPrompts = [];
  const toolCounts = {};
  let totalCost = 0, totalDurationMs = 0, turnsCompleted = 0, turnsInterrupted = 0;

  for (const line of lines) {
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    if (!firstTs) firstTs = rec.ts;
    lastTs = rec.ts;
    const raw = rec.raw || {};
    if (raw.type === 'winter3.user_prompt' && typeof raw.text === 'string') {
      userPrompts.push(raw.text);
    } else if (raw.type === 'assistant' && raw.message?.content) {
      for (const c of raw.message.content) {
        if (c?.type === 'tool_use' && c.name) {
          toolCounts[c.name] = (toolCounts[c.name] || 0) + 1;
        }
      }
    } else if (raw.type === 'result') {
      // 0.3.277+ 누적 semantics 기준: result.total_cost_usd 는 세션 누적값이므로 max 로 취함.
      // 구 세션 (pre-upgrade per-turn 레코드) 은 과소 표시될 수 있음 — 표시용이라 수용.
      if (typeof raw.total_cost_usd === 'number') totalCost = Math.max(totalCost, raw.total_cost_usd);
      if (typeof raw.duration_ms === 'number') totalDurationMs += raw.duration_ms;
    } else if (raw.type === 'winter3.turn_end') {
      if (raw.reason === 'completed') turnsCompleted++;
      else if (raw.reason === 'interrupted') turnsInterrupted++;
    }
  }

  const dur = (d) => d > 60_000 ? `${(d/60_000).toFixed(1)}분` : `${(d/1000).toFixed(1)}초`;
  const toolList = Object.entries(toolCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([n, c]) => `- ${n}: ${c} 회`).join('\n');

  return `# 세션 요약 — ${meta?.title || sid.slice(0, 8)}

- **ID**: \`${sid}\`
- **생성**: ${meta?.createdAt ? new Date(meta.createdAt).toLocaleString('ko-KR') : '?'}
- **활성 구간**: ${firstTs || '?'} → ${lastTs || '?'}
- **턴**: ${turnsCompleted} 완료${turnsInterrupted ? ` / ${turnsInterrupted} 중단` : ''}
- **총 비용**: $${totalCost.toFixed(4)}
- **총 LLM 시간**: ${dur(totalDurationMs)}
- **도구 사용**:
${toolList || '  (없음)'}

## 유저 프롬프트 (${userPrompts.length} 개)

${userPrompts.map((p, i) => `${i + 1}. ${p.replace(/\n/g, ' ').slice(0, 200)}`).join('\n') || '(없음)'}

---
_자동 생성 — ${new Date().toISOString()}. 원본 jsonl 은 같은 디렉토리의 \`${sid}.events.*.jsonl\` 로 아카이브._
`;
}

// remove — meta + jsonl 아카이브 + 요약 markdown 생성.
export async function remove(sid) {
  ensureArchive();
  const metaPath = pathFor(sid);
  const evtPath = nodePath.join(EVT_DIR, `${sid}.jsonl`);
  const ts = Date.now();

  // 요약 먼저 (파일 이동 전)
  let summaryWritten = false;
  try {
    const meta = await load(sid);
    const jsonlText = nodeFs.existsSync(evtPath) ? nodeFs.readFileSync(evtPath, 'utf8') : '';
    const md = buildSummaryMarkdown(sid, meta, jsonlText);
    nodeFs.writeFileSync(nodePath.join(ARCHIVE_DIR, `${sid}.summary.${ts}.md`), md, 'utf8');
    summaryWritten = true;
  } catch (err) {
    process.stderr.write(`[session.remove] summary failed: ${err.message}\n`);
  }

  // 파일 이동
  try { if (nodeFs.existsSync(metaPath)) nodeFs.renameSync(metaPath, nodePath.join(ARCHIVE_DIR, `${sid}.meta.${ts}.json`)); } catch {}
  try { if (nodeFs.existsSync(evtPath)) nodeFs.renameSync(evtPath, nodePath.join(ARCHIVE_DIR, `${sid}.events.${ts}.jsonl`)); } catch {}

  return { archived: true, sid, ts, summaryWritten };
}

// restore — 가장 최근 archived 파일을 original 위치로 되돌림. undo 지원.
export async function restore(sid) {
  ensureArchive();
  const entries = nodeFs.readdirSync(ARCHIVE_DIR);
  // <sid>.events.<ts>.jsonl 중 ts 가장 큰 것 찾기
  let bestTs = -1;
  for (const name of entries) {
    const m = name.match(new RegExp(`^${sid}\\.events\\.(\\d+)\\.jsonl$`));
    if (m) { const t = Number(m[1]); if (t > bestTs) bestTs = t; }
  }
  if (bestTs < 0) return { restored: false, reason: 'no archive found' };
  const metaFrom = nodePath.join(ARCHIVE_DIR, `${sid}.meta.${bestTs}.json`);
  const evtFrom = nodePath.join(ARCHIVE_DIR, `${sid}.events.${bestTs}.jsonl`);
  const metaTo = pathFor(sid);
  const evtTo = nodePath.join(EVT_DIR, `${sid}.jsonl`);
  try { if (nodeFs.existsSync(metaFrom)) nodeFs.renameSync(metaFrom, metaTo); } catch (err) { return { restored: false, reason: err.message }; }
  try { if (nodeFs.existsSync(evtFrom)) nodeFs.renameSync(evtFrom, evtTo); } catch (err) { return { restored: false, reason: err.message }; }
  // summary 도 삭제 (원본 살아있으니까 무의미)
  try { nodeFs.unlinkSync(nodePath.join(ARCHIVE_DIR, `${sid}.summary.${bestTs}.md`)); } catch {}
  return { restored: true, sid, ts: bestTs };
}
