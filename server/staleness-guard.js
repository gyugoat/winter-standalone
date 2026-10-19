// server/staleness-guard.js
// SDK hooks (PreToolUse / PostToolUse) 로 file mtime-based staleness 검사.
// omo Hashline edit (LINE#ID hash anchor) 의 mtime 약식 변형.
//
// 짝꿍:
//   - mac shell hooks (Claude Code process tree): scripts/hooks/{read-mtime-tracker,edit-staleness-guard}.sh
//   - 같은 cache 디렉토리 + 같은 key/value 형식 → mac Read 후 winter3 Edit, winter3 Read 후 mac Edit 둘 다 잡힘
//
// 정책:
//   - PostToolUse(Read): file mtime + read 시각을 cache 에 기록
//   - PostToolUse(Edit | Write | MultiEdit): 자기 edit 성공 후 cache 를 새 mtime 으로 갱신
//     (없으면 연속 2번째 Edit 이 자기 mtime bump 에 걸려 무조건 block — 2026-10-18 리뷰 결함 #2)
//   - PreToolUse(Edit | Write): cache 조회 → mtime 변경 감지 시 decision=block (tool result error 로 SDK 가 모델한테 반환)
//   - cache 없음 → 통과 (Write 신규 또는 정책 외 진입)
//   - file 부재 → 통과 (신규 생성)
//
// 설계 노트:
//   - 단일 진입점: 이 파일의 attachStalenessGuardHooks(options) — runner.js queryOptions.hooks 에 spread.
//   - sub-agent context (BaseHookInput.agent_id 존재) 도 같은 SDK 세션이라 hook 발동 동일.

import { statSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve, join as pj } from 'node:path';

// gyuwul home 자동 추론 (winter3/server/staleness-guard.js 의 두 단계 위).
const DEFAULT_GYUWUL_HOME = fileURLToPath(new URL('..', import.meta.url)); // standalone: app root 고정

export const DEFAULT_CACHE_DIR = pj(DEFAULT_GYUWUL_HOME, 'data', 'cache', 'read-mtime');

// shell hook 과 동일한 key 변환: 절대경로의 모든 '/' → '_'.
// mac hook (`sed 's|/|_|g'`) 과 1:1 호환.
export function fileKey(absPath) {
  return absPath.replace(/\//g, '_');
}

// 안전하게 file_path 추출 — Read/Edit/Write tool_input 모두 file_path 키 사용.
// MultiEdit 도 file_path. NotebookEdit / Glob / 기타는 file_path 없으면 null 반환.
function extractFilePath(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null;
  const fp = toolInput.file_path || toolInput.path;
  if (!fp || typeof fp !== 'string') return null;
  // 절대경로만 — 상대경로는 cwd 의존이라 cache key 불일치 위험. SDK 는 항상 절대경로 권장.
  if (!fp.startsWith('/')) return null;
  return pathResolve(fp);
}

function safeMtime(absPath) {
  try {
    return Math.floor(statSync(absPath).mtimeMs / 1000);
  } catch { return null; }
}

function ensureDir(p) {
  try { mkdirSync(p, { recursive: true }); } catch { /* race ok */ }
}

// PostToolUse for Read — mtime + 시각 cache 기록.
// SDK hook spec: 반환 객체 무관하게 통과 (block 의미는 PreToolUse 만 유효).
// 단순 best-effort. cache write 실패해도 turn 진행.
export function makeReadMtimeTracker({ cacheDir = DEFAULT_CACHE_DIR } = {}) {
  return async function readMtimeTracker(input /*, toolUseID, options */) {
    try {
      if (input?.tool_name !== 'Read') return {};
      const absPath = extractFilePath(input.tool_input);
      if (!absPath) return {};
      const mtime = safeMtime(absPath);
      if (mtime === null) return {}; // file 없으면 skip (Read 가 fail 했어도 무시)
      const readTime = Math.floor(Date.now() / 1000);
      ensureDir(cacheDir);
      writeFileSync(pj(cacheDir, fileKey(absPath)), `${mtime}:${readTime}`);
    } catch { /* best-effort */ }
    return {};
  };
}

// PostToolUse for Edit / Write / MultiEdit — 자기 edit 후 cache 를 새 mtime 으로 갱신.
// 결함 fix (2026-10-18 리뷰 #2): Read 만 cache 갱신하면 자기 Edit 성공 → mtime bump → cache 는 구버전
//   → 같은 파일의 연속 2번째 Edit 이 무조건 "Re-read the file" block (과차단).
// Edit 실패 시(old_string 불일치 등) mtime 불변 → 같은 값 재기록으로 무해.
// 외부 process 가 Edit 직후~이 hook 실행 사이에 끼어드는 race 는 이론상 존재하나 best-effort 범위.
export function makeWriteMtimeTracker({ cacheDir = DEFAULT_CACHE_DIR } = {}) {
  return async function writeMtimeTracker(input /*, toolUseID, options */) {
    try {
      const tn = input?.tool_name;
      if (tn !== 'Edit' && tn !== 'Write' && tn !== 'MultiEdit') return {};
      const absPath = extractFilePath(input.tool_input);
      if (!absPath) return {};
      const mtime = safeMtime(absPath);
      if (mtime === null) return {}; // file 없음 (Edit fail 등) → skip
      const writeTime = Math.floor(Date.now() / 1000);
      ensureDir(cacheDir);
      writeFileSync(pj(cacheDir, fileKey(absPath)), `${mtime}:${writeTime}`);
    } catch { /* best-effort */ }
    return {};
  };
}

// PreToolUse for Edit / Write — cache 조회 → mtime 변경 감지 시 block.
// SDK SyncHookJSONOutput 의 decision='block' + reason 이 tool result error 로 모델에 반환.
// 모델이 그 error 를 보고 자연스럽게 Read 재호출하도록 유도하는 message.
//
// MultiEdit 도 같은 file_path 키라 함께 보호.
// Write 신규 file (cache 없음 + file 부재) → 통과. file 존재하지만 cache 없음 → 통과
//   (다른 process / 첫 Write 가능성 — 정책 외 진입).
export function makeEditStalenessGuard({ cacheDir = DEFAULT_CACHE_DIR } = {}) {
  return async function editStalenessGuard(input /*, toolUseID, options */) {
    try {
      const tn = input?.tool_name;
      if (tn !== 'Edit' && tn !== 'Write' && tn !== 'MultiEdit') return {};
      const absPath = extractFilePath(input.tool_input);
      if (!absPath) return {};
      const cachePath = pj(cacheDir, fileKey(absPath));
      if (!existsSync(cachePath)) return {}; // cache 없음 → Write 신규 또는 정책 외
      const currentMtime = safeMtime(absPath);
      if (currentMtime === null) return {}; // file 부재 (Write 신규) → 통과
      const record = readFileSync(cachePath, 'utf8').trim();
      const lastMtime = Number((record.split(':')[0] || '0').trim());
      if (!Number.isFinite(lastMtime) || lastMtime <= 0) return {};
      if (currentMtime > lastMtime) {
        const reason = `BLOCKED: ${absPath} was modified after last Read (mtime ${lastMtime} -> ${currentMtime}). Re-read the file before editing to avoid line drift.`;
        return {
          decision: 'block',
          reason,
          // PreToolUseHookSpecificOutput.permissionDecision 도 deny 로 박아 SDK 가 명확히 거부 분기.
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
          },
        };
      }
    } catch { /* best-effort — guard 자체 fail 로 turn 망치지 마 */ }
    return {};
  };
}

// runner.js queryOptions.hooks 에 그대로 spread 가능한 형식.
// HookCallbackMatcher 의 matcher 는 tool_name regex. SDK 가 매 tool_use 마다 매칭 후 hooks 실행.
//
// 사용:
//   import { stalenessGuardHooks } from './staleness-guard.js';
//   queryOptions.hooks = { ...stalenessGuardHooks() };
export function stalenessGuardHooks({ cacheDir = DEFAULT_CACHE_DIR } = {}) {
  return {
    PreToolUse: [{
      matcher: 'Edit|Write|MultiEdit',
      hooks: [makeEditStalenessGuard({ cacheDir })],
    }],
    PostToolUse: [{
      matcher: 'Read',
      hooks: [makeReadMtimeTracker({ cacheDir })],
    }, {
      matcher: 'Edit|Write|MultiEdit',
      hooks: [makeWriteMtimeTracker({ cacheDir })],
    }],
  };
}
