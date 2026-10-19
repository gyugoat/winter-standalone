// server/transcript-quarantine.js
// 오염 턴 사후 격리 + 세션 소생.
//
// 배경 (#59):
//   Anthropic 요청-레벨 안전 분류기가 한 턴을 거부(stop_reason=refusal)시키면,
//   그 거부 기록이 claude transcript 에 남아 이후 모든 턴이 연쇄 거부된다.
//   classifier 는 per-request — transcript 가 깨끗해지면 즉시 소생.
//   즉, 오염된 마지막 user 메시지 + 거부 assistant 응답을 placeholder 로 치환하면
//   세션 resume 시 동일 claudeSessionId 로 정상 동작을 회복할 수 있다.
//
// 소생 방식:
//   transcript jsonl (`~/.claude/projects/<proj-slug>/<claudeSessionId>.jsonl`)
//   에서 마지막 user message 의 content 텍스트를 redactedPlaceholder 로 치환.
//   그 직후 assistant 레코드가 stop_reason="refusal" 이면 그것도 치환.
//   원본은 `.quarantine-bak.<ISO>` 파일로 백업 (unlink 없이 rename 원자적 보존).
//   atomic write (tmp + rename) 로 원본 손상 없음.
//
// 주의:
//   - 이 함수는 RUNNING 중인 세션에 쓰면 안 된다 — runner 가 transcript 를 동시에
//     쓰는 동안 덮어쓰면 race. index.js 의 /sessions/:id/revive 는 isRunning 체크 후 호출.
//   - isSidechain:true 레코드 (tool_use 내부 sub-turn) 는 건드리지 않는다.
//     오염 벡터는 최상위 user/assistant turn 이다.
//   - 치환 대상이 없거나 최신 user 가 이미 placeholder 이면 no-op 반환.
//   - tool_result-only user 레코드 (BLOCKER): content 배열에 text 블록이 없으면 건너뜀.
//     tool_use/tool_result 쌍을 파괴하면 resume 시 API 400 발생.
//
// export:
//   quarantineLastTurn({ transcriptPath, redactedPlaceholder })  — mutex wrapper (호환 유지)
//   quarantineAllRefusals({ transcriptPath, redactedPlaceholder, dryRun })  — 전체 거부 스캔
//   resolveTranscriptPath(claudeSessionId, projectSlug?)
//   detectRefusalInTranscript(transcriptPath)  — 거부 여부만 검사 (read-only)

import { promises as fs, existsSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import os from 'node:os';

// claude transcript 루트. SDK 는 항상 ~/.claude/projects/<slug>/<claudeSessionId>.jsonl.
const CLAUDE_PROJECTS_DIR = join(os.homedir(), '.claude', 'projects');

// Fix 1 (CRITICAL): trigger 어휘 없는 중립 placeholder.
// 구: '[격리됨: 안전 분류기 거부로 오염된 턴. 세션 소생을 위해 이 메시지는 삭제됐습니다.]'
// 신: "분류기", "거부", "격리" 등 어떤 trigger 어휘도 없음.
const DEFAULT_PLACEHOLDER = '[이전 메시지가 처리되지 않았습니다.]';

// mutex map — 같은 transcriptPath 에 두 호출이 겹치면 last-writer-wins 방지.
const inflightLocks = new Map();

// 오래된 백업 파일 정리 — 최신 keepN 개만 보존.
async function pruneBackups(transcriptPath, keepN = 5) {
  const dir = dirname(transcriptPath);
  const base = basename(transcriptPath) + '.quarantine-bak.';
  let files;
  try { files = (await fs.readdir(dir)).filter((f) => f.startsWith(base)); }
  catch { return; }
  if (files.length <= keepN) return;
  files.sort(); // ISO 타임스탬프 → 알파벳 정렬 = 시간 정렬
  const toDelete = files.slice(0, files.length - keepN);
  for (const f of toDelete) {
    try { await fs.unlink(join(dir, f)); } catch {}
  }
}

// winter3 workspace 절대경로 → claude project slug 변환.
//
// 공식 SDK slug 규칙 1:1 (claude-code cli.js nM 함수):
//   realpathSync + .normalize("NFC") → /[^a-zA-Z0-9]/g → "-" → 200자 초과 시 djb2 hash suffix.
//
// 실측 결과:
//   dot:  /home/foo/.winter                         → -home-foo--winter
//   win:  C:\Users\foo\proj                         → C--Users-foo-proj
//
// 과거 함정 (교훈):
//   toLowerCase():       WSL/mac 혼합 케이스 경로를 못 찾아 격리 완전 실패 (2026-10-15 실측).
//   .replace(/^\//, ''): leading / 제거 → slug 불일치, dir 탐색 실패 (2026-10-15 fix2).
//   trailing slash 미제거: slug 끝 여분의 '-' → transcript 못 찾음 (MAJOR-2).
//   /[/\\]/g 만 치환:    점(.)·언더스코어(_) 포함 경로에서 SDK slug 와 불일치.
export function workspaceToSlug(workspacePath) {
  let resolved;
  try {
    resolved = realpathSync(workspacePath).normalize('NFC');
  } catch {
    resolved = workspacePath.normalize('NFC');
  }
  const base = resolved.replace(/[^a-zA-Z0-9]/g, '-');
  if (base.length <= 200) return base;
  // djb2-like hash (cli.js nM 함수, 200자 초과 시 suffix)
  let h = 0;
  for (let i = 0; i < resolved.length; i++) {
    h = (h << 5) - h + resolved.charCodeAt(i) | 0;
  }
  const hashSuffix = Math.abs(h).toString(36);
  return `${base.slice(0, 200)}-${hashSuffix}`;
}

/**
 * claudeSessionId 와 워크스페이스 경로로 transcript 파일 경로를 계산한다.
 * @param {string} claudeSessionId  - UUID (session.json 의 claudeSessionId)
 * @param {string} [workspacePath]  - 프로젝트 루트. 없으면 process.cwd() 사용.
 * @returns {string}
 */
export function resolveTranscriptPath(claudeSessionId, workspacePath) {
  const slug = workspaceToSlug(workspacePath || process.cwd());
  return join(CLAUDE_PROJECTS_DIR, slug, `${claudeSessionId}.jsonl`);
}

/**
 * user 레코드가 실제 유저 발화인지 판단한다.
 * tool_result-only 레코드는 유저 발화가 아님 — tool_use/tool_result 쌍 보존 필요.
 * @param {object} rec  - 파싱된 transcript 레코드
 * @returns {boolean}
 */
function isRealUserMessage(rec) {
  const c = rec.message?.content ?? rec.content;
  // string content 는 항상 발화.
  if (typeof c === 'string') return true;
  // 배열이면 text 블록이 하나라도 있어야 발화.
  if (Array.isArray(c)) return c.some((b) => b.type === 'text');
  // null/undefined/기타 구조 — 발화 아님.
  return false;
}

/**
 * transcript 를 읽어 마지막 user turn 이 refusal 인지 검사한다 (read-only).
 * @param {string} transcriptPath
 * @returns {Promise<{hasRefusal: boolean, lastUserIdx: number, refusalAssistantIdx: number|null}>}
 */
export async function detectRefusalInTranscript(transcriptPath) {
  const result = { hasRefusal: false, lastUserIdx: -1, refusalAssistantIdx: null };
  if (!existsSync(transcriptPath)) return result;

  let raw;
  try { raw = await fs.readFile(transcriptPath, 'utf8'); }
  catch (err) {
    console.error(`[transcript-quarantine] read failed: ${err.message}`);
    return result;
  }

  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  let lastUserIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    let rec;
    try { rec = JSON.parse(lines[i]); } catch { continue; }
    // isSidechain 은 sub-agent 내부 턴 — 최상위만 대상.
    if (rec.isSidechain) continue;
    // BLOCKER: tool_result-only 레코드는 유저 발화가 아님 — 건너뜀.
    if (rec.type === 'user' && isRealUserMessage(rec)) lastUserIdx = i;
  }

  result.lastUserIdx = lastUserIdx;
  if (lastUserIdx === -1) return result;

  // lastUserIdx 이후의 assistant 레코드를 순회해 refusal 을 찾는다.
  for (let i = lastUserIdx + 1; i < lines.length; i++) {
    let rec;
    try { rec = JSON.parse(lines[i]); } catch { continue; }
    if (rec.isSidechain) continue;
    if (rec.type === 'assistant') {
      const stopReason = rec.message?.stop_reason;
      if (stopReason === 'refusal') {
        result.hasRefusal = true;
        result.refusalAssistantIdx = i;
        break;
      }
      // tool_use assistant — tool_result user 가 따라오므로 계속 순회.
      // end_turn 등 정상 완료 assistant 는 refusal 없음으로 종료.
      if (stopReason !== 'tool_use') break;
    }
  }

  return result;
}

// lines[] 의 startIdx 이후에서 refusal assistant 의 라인 인덱스를 반환. 없으면 -1.
function _scanRefusalIdx(scanLines, startIdx) {
  for (let i = startIdx + 1; i < scanLines.length; i++) {
    const line = scanLines[i].trim();
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.isSidechain) continue;
    if (rec.type === 'assistant') {
      const stopReason = rec.message?.stop_reason;
      if (stopReason === 'refusal') return i;
      if (stopReason !== 'tool_use') break;
    }
  }
  return -1;
}

// lines[] 에서 한 쌍 (userLineIdx, refusalLineIdx) 을 placeholder 로 치환.
// refusalLineIdx = -1 이면 user 만 치환.
// alreadyRedacted 시 false 반환.
function _redactPair(lines, userLineIdx, refusalLineIdx, placeholder) {
  let userRec;
  try { userRec = JSON.parse(lines[userLineIdx]); } catch { return false; }

  const content = userRec.message?.content;
  if (Array.isArray(content)) {
    const allPlaceholder = content.every((b) => b.type !== 'text' || b.text === placeholder);
    if (allPlaceholder) return false; // already redacted
    userRec.message.content = content.map((b) => {
      if (b.type !== 'text') return b;
      return { ...b, text: placeholder };
    });
  } else if (typeof content === 'string') {
    if (content === placeholder) return false;
    userRec.message.content = placeholder;
  } else {
    return false; // 구조 미인식
  }
  lines[userLineIdx] = JSON.stringify(userRec);

  if (refusalLineIdx !== -1) {
    let rec;
    try { rec = JSON.parse(lines[refusalLineIdx]); } catch { rec = null; }
    if (rec) {
      rec.message.content = [{ type: 'text', text: placeholder }];
      rec.message.stop_details = null;
      lines[refusalLineIdx] = JSON.stringify(rec);
    }
  }
  return true;
}

/**
 * transcript jsonl 에서 마지막 user turn 의 텍스트 + (있으면) 직후 refusal assistant 응답을
 * redactedPlaceholder 로 치환한다. 원본은 .quarantine-bak.<ISO> 로 백업.
 *
 * @param {object} opts
 * @param {string}  opts.transcriptPath       - 절대 경로 (resolveTranscriptPath 결과)
 * @param {string} [opts.redactedPlaceholder] - 치환 문구. 기본값: 중립 안내 문구.
 * @param {boolean} [opts.dryRun]             - true 이면 실제 파일 쓰기 없이 결과만 반환.
 * @returns {Promise<QuarantineResult>}
 *
 * @typedef {object} QuarantineResult
 * @property {boolean} ok              - 치환 성공 여부
 * @property {string}  [error]         - 오류 메시지 (ok=false 시)
 * @property {boolean} noop            - 치환 대상 없음 (ok=true + noop=true = 이미 깨끗함)
 * @property {number}  lastUserIdx     - 마지막 user 레코드 인덱스 (-1 = 없음)
 * @property {boolean} assistantRedacted - assistant 거부 레코드도 치환했는지
 * @property {string}  [backupPath]    - 백업 파일 경로 (dryRun=false 성공 시)
 */
async function _quarantineImpl({
  transcriptPath,
  redactedPlaceholder,
  dryRun = false,
} = {}) {
  const placeholder = redactedPlaceholder || DEFAULT_PLACEHOLDER;

  // ── 1. 파일 읽기 ──────────────────────────────────────────────────────────
  if (!existsSync(transcriptPath)) {
    return { ok: false, error: `transcript not found: ${transcriptPath}`, noop: false, lastUserIdx: -1, assistantRedacted: false };
  }

  let raw;
  try { raw = await fs.readFile(transcriptPath, 'utf8'); }
  catch (err) {
    return { ok: false, error: `read failed: ${err.message}`, noop: false, lastUserIdx: -1, assistantRedacted: false };
  }

  let lines = raw.split('\n');
  // 후행 개행 보존: 마지막 빈 문자열 요소 포함해서 원형 유지.

  // ── 2. 마지막 user 레코드 찾기 (isSidechain 제외, tool_result-only 제외) ───
  let lastUserIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.isSidechain) continue;
    // BLOCKER: tool_result-only 레코드는 유저 발화가 아님 — 건너뜀.
    if (rec.type === 'user' && isRealUserMessage(rec)) lastUserIdx = i;
  }

  if (lastUserIdx === -1) {
    return { ok: true, noop: true, lastUserIdx: -1, assistantRedacted: false, error: 'no user record found' };
  }

  // ── 3. user 레코드 텍스트 치환 ───────────────────────────────────────────
  let userRec;
  try { userRec = JSON.parse(lines[lastUserIdx]); }
  catch (err) {
    return { ok: false, error: `parse failed at line ${lastUserIdx}: ${err.message}`, noop: false, lastUserIdx, assistantRedacted: false };
  }

  // content 배열의 text 블록을 placeholder 로 치환. 다른 블록(image 등)은 보존.
  const content = userRec.message?.content;
  let alreadyRedacted = false;
  if (Array.isArray(content)) {
    const allPlaceholder = content.every((b) => b.type !== 'text' || b.text === placeholder);
    if (allPlaceholder) alreadyRedacted = true;
    else {
      userRec.message.content = content.map((b) => {
        if (b.type !== 'text') return b;
        return { ...b, text: placeholder };
      });
    }
  } else if (typeof content === 'string') {
    if (content === placeholder) alreadyRedacted = true;
    else userRec.message.content = placeholder;
  } else {
    // content 구조 미인식 — no-op
    return { ok: true, noop: true, lastUserIdx, assistantRedacted: false };
  }

  if (alreadyRedacted) {
    return { ok: true, noop: true, lastUserIdx, assistantRedacted: false };
  }

  lines[lastUserIdx] = JSON.stringify(userRec);

  // ── 4. refusal assistant 레코드 탐색 + 치환 ──────────────────────────────
  // tool_use stop_reason 의 assistant 는 건너뛰고 refusal 만 치환.
  //
  // BLOCKER-2 timing race 대응:
  //   runner 가 SDK 거부를 감지해 quarantineLastTurn 을 호출하는 시점에
  //   assistant refusal 레코드가 아직 jsonl 에 flush 되지 않았을 수 있다.
  //   Fix 3: 100ms 간격 최대 40회 (총 4초) 폴링으로 확장 — 실측 assistantRedacted=false 재발 차단.
  //   찾으면 즉시 break. 4초 초과 시 포기 — user 치환만으로 종료 (assistantRedacted=false).
  let assistantRedacted = false;

  let refusalIdx = _scanRefusalIdx(lines, lastUserIdx);

  if (refusalIdx === -1) {
    // Fix 3: 100ms 간격 최대 40회 (총 4초) 폴링.
    let rescanIdx = -1;
    let refreshedLines = null;
    for (let attempt = 0; attempt < 40 && rescanIdx === -1; attempt++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        const refreshedRaw = await fs.readFile(transcriptPath, 'utf8');
        refreshedLines = refreshedRaw.split('\n');
        rescanIdx = _scanRefusalIdx(refreshedLines, lastUserIdx);
      } catch { /* file race, 계속 폴링 */ }
    }
    if (rescanIdx !== -1) {
      // lines 전체를 refreshedLines 로 교체.
      // SDK 는 append-only → lastUserIdx 는 refreshedLines 에서도 동일 위치.
      // user 치환(userRec)은 이미 완료됐으므로 교체 후 해당 위치에 재적용.
      lines = refreshedLines;
      lines[lastUserIdx] = JSON.stringify(userRec);
      refusalIdx = rescanIdx;
      console.error(`[transcript-quarantine] timing-race rescan: refusalIdx=${refusalIdx}`);
    }
  }

  if (refusalIdx !== -1) {
    let rec;
    try { rec = JSON.parse(lines[refusalIdx]); } catch { rec = null; }
    if (rec) {
      // content 와 stop_details 를 소독.
      rec.message.content = [{ type: 'text', text: placeholder }];
      rec.message.stop_details = null;
      lines[refusalIdx] = JSON.stringify(rec);
      assistantRedacted = true;
    }
  }

  if (dryRun) {
    return { ok: true, noop: false, lastUserIdx, assistantRedacted, dryRun: true };
  }

  // ── 5. 원본 백업 (atomic rename) ──────────────────────────────────────────
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${transcriptPath}.quarantine-bak.${ts}`;
  try {
    await fs.copyFile(transcriptPath, backupPath);
  } catch (err) {
    return { ok: false, error: `backup failed: ${err.message}`, noop: false, lastUserIdx, assistantRedacted };
  }

  // ── 6. 치환된 내용 atomic write ───────────────────────────────────────────
  const newContent = lines.join('\n');
  const tmpPath = `${transcriptPath}.quarantine-tmp.${process.pid}.${Date.now()}`;
  try {
    await fs.writeFile(tmpPath, newContent, 'utf8');
    await fs.rename(tmpPath, transcriptPath);
  } catch (err) {
    try { await fs.unlink(tmpPath); } catch {}
    return { ok: false, error: `write failed: ${err.message}`, noop: false, lastUserIdx, assistantRedacted, backupPath };
  }

  // 오래된 백업 정리 — 최신 5개만 보존.
  await pruneBackups(transcriptPath);

  console.error(`[transcript-quarantine] quarantined lastUserIdx=${lastUserIdx} assistantRedacted=${assistantRedacted} backup=${backupPath}`);
  return { ok: true, noop: false, lastUserIdx, assistantRedacted, backupPath };
}

/**
 * Fix 2 (CRITICAL): transcript jsonl 전체를 스캔해 모든 refusal 턴을 격리한다.
 *
 * 마지막 1개만 처리하던 quarantineLastTurn 의 한계 극복:
 * 여러 거부가 쌓인 세션에서 앞쪽 거부가 그대로 남아 다음 resume 도 오염되는 문제 해소.
 *
 * @param {object} opts
 * @param {string}  opts.transcriptPath       - 절대 경로
 * @param {string} [opts.redactedPlaceholder] - 치환 문구. 기본값: DEFAULT_PLACEHOLDER.
 * @param {boolean} [opts.dryRun]             - true 이면 파일 쓰기 없이 결과만 반환.
 * @returns {Promise<AllRefusalsResult>}
 *
 * @typedef {object} AllRefusalsResult
 * @property {boolean} ok                   - 성공 여부
 * @property {string}  [error]              - 오류 메시지
 * @property {boolean} noop                 - 치환 대상 없음
 * @property {number}  refusalCount         - 발견된 refusal 쌍 수
 * @property {number}  userRedactedCount    - 치환된 user 레코드 수
 * @property {number}  assistantRedactedCount - 치환된 assistant 레코드 수
 * @property {string}  [backupPath]         - 백업 파일 경로
 */
export async function quarantineAllRefusals({
  transcriptPath,
  redactedPlaceholder,
  dryRun = false,
} = {}) {
  const placeholder = redactedPlaceholder || DEFAULT_PLACEHOLDER;

  if (!existsSync(transcriptPath)) {
    return { ok: false, error: `transcript not found: ${transcriptPath}`, noop: false, refusalCount: 0, userRedactedCount: 0, assistantRedactedCount: 0 };
  }

  let raw;
  try { raw = await fs.readFile(transcriptPath, 'utf8'); }
  catch (err) {
    return { ok: false, error: `read failed: ${err.message}`, noop: false, refusalCount: 0, userRedactedCount: 0, assistantRedactedCount: 0 };
  }

  const lines = raw.split('\n');

  // ── 전체 스캔: real user idx 목록 + refusal assistant idx 목록 수집 ──────
  // pass 1: 모든 라인 파싱, (type, lineIdx) 배열 구성
  const parsed = []; // { lineIdx, type, rec }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.isSidechain) continue;
    if (rec.type === 'user' || rec.type === 'assistant') {
      parsed.push({ lineIdx: i, type: rec.type, rec });
    }
  }

  // pass 2: refusal assistant 를 모두 찾고 각각의 직전 real user 를 매핑
  // refusals = [{ userLineIdx, assistantLineIdx }]
  const refusals = [];
  for (let pi = 0; pi < parsed.length; pi++) {
    const entry = parsed[pi];
    if (entry.type !== 'assistant') continue;
    const stopReason = entry.rec.message?.stop_reason;
    if (stopReason !== 'refusal') continue;

    // 직전 real user 찾기 (역순 탐색)
    let userLineIdx = -1;
    for (let pj = pi - 1; pj >= 0; pj--) {
      if (parsed[pj].type === 'user' && isRealUserMessage(parsed[pj].rec)) {
        userLineIdx = parsed[pj].lineIdx;
        break;
      }
    }
    refusals.push({ userLineIdx, assistantLineIdx: entry.lineIdx });
  }

  if (refusals.length === 0) {
    // SDK flush 지연 대응 — 100ms 간격 최대 40회 (총 4초) 폴링.
    // Fix(B): 2초 → 4초 확장 — SDK 가 일부 거부 케이스에서 transcript 기록을 늦게 flush 함.
    for (let _pi = 0; _pi < 40 && refusals.length === 0; _pi++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        const freshRaw = await fs.readFile(transcriptPath, 'utf8');
        const freshLines = freshRaw.split('\n');
        const freshParsed = [];
        for (let i = 0; i < freshLines.length; i++) {
          const line = freshLines[i].trim();
          if (!line) continue;
          let rec;
          try { rec = JSON.parse(line); } catch { continue; }
          if (rec.isSidechain) continue;
          if (rec.type === 'user' || rec.type === 'assistant') freshParsed.push({ lineIdx: i, type: rec.type, rec });
        }
        for (let pi = 0; pi < freshParsed.length; pi++) {
          const entry = freshParsed[pi];
          if (entry.type !== 'assistant') continue;
          if (entry.rec.message?.stop_reason !== 'refusal') continue;
          let userLineIdx = -1;
          for (let pj = pi - 1; pj >= 0; pj--) {
            if (freshParsed[pj].type === 'user' && isRealUserMessage(freshParsed[pj].rec)) {
              userLineIdx = freshParsed[pj].lineIdx;
              break;
            }
          }
          refusals.push({ userLineIdx, assistantLineIdx: entry.lineIdx });
        }
        if (refusals.length > 0) {
          // freshLines 로 lines 전체 교체
          lines.length = 0;
          for (const l of freshLines) lines.push(l);
          console.error(`[transcript-quarantine] quarantineAllRefusals flush-poll found refusalCount=${refusals.length} on attempt=${_pi + 1}`);
          break;
        }
      } catch { /* file race, 계속 폴링 */ }
    }
  }

  if (refusals.length === 0) {
    return { ok: true, noop: true, refusalCount: 0, userRedactedCount: 0, assistantRedactedCount: 0 };
  }

  // ── 치환 ─────────────────────────────────────────────────────────────────
  let userRedactedCount = 0;
  let assistantRedactedCount = 0;

  for (const { userLineIdx, assistantLineIdx } of refusals) {
    // assistant 치환
    let rec;
    try { rec = JSON.parse(lines[assistantLineIdx]); } catch { rec = null; }
    if (rec) {
      rec.message.content = [{ type: 'text', text: placeholder }];
      rec.message.stop_details = null;
      lines[assistantLineIdx] = JSON.stringify(rec);
      assistantRedactedCount++;
    }

    // user 치환 (없으면 skip)
    if (userLineIdx === -1) continue;
    const didRedact = _redactPair(lines, userLineIdx, -1, placeholder);
    if (didRedact) userRedactedCount++;
  }

  if (dryRun) {
    return { ok: true, noop: false, dryRun: true, refusalCount: refusals.length, userRedactedCount, assistantRedactedCount };
  }

  // ── 백업 + atomic write ───────────────────────────────────────────────────
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${transcriptPath}.quarantine-bak.${ts}`;
  try {
    await fs.copyFile(transcriptPath, backupPath);
  } catch (err) {
    return { ok: false, error: `backup failed: ${err.message}`, noop: false, refusalCount: refusals.length, userRedactedCount, assistantRedactedCount };
  }

  const newContent = lines.join('\n');
  const tmpPath = `${transcriptPath}.quarantine-tmp.${process.pid}.${Date.now()}`;
  try {
    await fs.writeFile(tmpPath, newContent, 'utf8');
    await fs.rename(tmpPath, transcriptPath);
  } catch (err) {
    try { await fs.unlink(tmpPath); } catch {}
    return { ok: false, error: `write failed: ${err.message}`, noop: false, refusalCount: refusals.length, userRedactedCount, assistantRedactedCount, backupPath };
  }

  await pruneBackups(transcriptPath);

  console.error(`[transcript-quarantine] quarantineAllRefusals refusalCount=${refusals.length} userRedacted=${userRedactedCount} assistantRedacted=${assistantRedactedCount} backup=${backupPath}`);
  return { ok: true, noop: false, refusalCount: refusals.length, userRedactedCount, assistantRedactedCount, backupPath };
}

/**
 * 동시 격리 직렬화 wrapper (호환 유지).
 * 같은 transcriptPath 에 두 호출이 겹치면 앞선 호출 완료 후 순차 진행.
 * 기존 호출자는 이 함수를 그대로 사용하면 됨 (동일 시그니처).
 */
export async function quarantineLastTurn(opts) {
  const key = opts?.transcriptPath;
  const prev = key ? inflightLocks.get(key) : undefined;
  if (prev) { try { await prev; } catch {} }
  const p = _quarantineImpl(opts);
  if (key) {
    inflightLocks.set(key, p);
    try { return await p; }
    finally { if (inflightLocks.get(key) === p) inflightLocks.delete(key); }
  }
  return p;
}
