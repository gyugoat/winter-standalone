// server/hooks/winter-never-edits.js
// PreToolUse(Edit | Write | MultiEdit) — main thread (Winter) 의 직접 file mutation 차단.
//
// 배경 (#44 / #45):
//   - #43 architectural lesson: dispatch bypass single-layer hallucination.
//     Winter 가 sub-agent 위임 skip + 본인 직접 수행 + 본인 self-check 시 single-layer 로 collapse.
//   - system prompt 만으론 모순 회피 안 됨 (L117 "hawk 전담" + 이전 L118 "단순 작업 직접" 양립).
//   - winter-opencode `winter-never-edits.sh` (Edit/Write DEFAULT-DENY) 패턴을 SDK hook 으로 import.
//
// 정책:
//   - BaseHookInput.agent_id 존재 = sub-agent → 통과 (17 캐릭터 + Explore/Plan/general-purpose)
//   - agent_id 부재 = main thread (Winter) → ALLOWED_PATHS_REGEX 매칭 시만 통과, 그 외 deny
//   - WINTER3_BYPASS_WINTER_EDITS=1 → 전체 우회 (emergency / 1주차 마이그레이션 / 디버그용)
//
// false positive 방지:
//   - data/USER.md.bak.* 은 hawk 가 만든 백업 — Winter 가 비교 / cleanup OK
//   - data/sessions/ 는 session.js 가 atomic write 하는 영역인데, runner 외부 manual repair 가능성 보존
//   - scripts/qa-* 는 회귀 테스트 — Winter 본인이 자기 코드 검증 시 박을 수 있음
//
// 추가 path (필요 시): bom 판단으로 신중하게. USER.md 본체는 절대 ALLOWED 안 됨 (hawk-usermd-gate 가 별도 차단).
//
// 커버리지 한계 (2026-10-18 리뷰 결함 #3 — 의도된 범위):
//   - Bash 우회는 makeWinterNeverEditsBashGate 가 "명백한" 패턴만 차단:
//     sed -i / tee / > >> redirect 가 소스성 확장자(.js/.css/.md/.json/.sh 등) 파일을 타격하는 경우.
//   - 미커버 (전면 Bash 파싱 = 과차단 위험이라 의도적으로 제외):
//     * NotebookEdit tool
//     * cp/mv/dd 로 파일 덮어쓰기, python -c open(...,'w'), ed/ex/vi 스크립트, truncate, patch 등
//     * 확장자 없는 파일 / .log .txt 등 비소스 파일 (운영 plumbing 과 구분 불가)
//   - 이 한계는 best-effort 기조 — 완전 봉쇄가 아니라 "무심코 직접 수정" 사고 방지가 목적.

import { resolve as pathResolve } from 'node:path';

// 화이트리스트 — Winter (main) 가 직접 Edit/Write 가능한 path regex.
// 새 path 추가 시: 사유 + 검증을 문서로 남긴 후에만 박는다.
export const ALLOWED_PATHS_REGEX = [
  /\/data\/USER\.md\.bak\.[0-9_]+$/,
  /\/data\/sessions\//,
  /\/winter3\/scripts\/qa-/,
];

function extractFilePath(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null;
  const fp = toolInput.file_path || toolInput.path;
  if (!fp || typeof fp !== 'string') return null;
  if (!fp.startsWith('/')) return null;
  return pathResolve(fp);
}

function isAllowedPath(absPath) {
  return ALLOWED_PATHS_REGEX.some((re) => re.test(absPath));
}

export function makeWinterNeverEditsHook() {
  return async function winterNeverEditsHook(input /*, toolUseID, options */) {
    try {
      const tn = input?.tool_name;
      if (tn !== 'Edit' && tn !== 'Write' && tn !== 'MultiEdit') return {};

      // env 우회 — emergency / 마이그레이션 시.
      if (String(process.env.WINTER3_BYPASS_WINTER_EDITS || '') === '1') return {};

      // sub-agent (agent_id 있음) → 통과. main thread (agent_id 없음) 만 deny 대상.
      if (input.agent_id) return {};

      const absPath = extractFilePath(input.tool_input);
      // 경로 추출 실패 시 통과 (다른 hook 이 별도 처리할 수 있음 — staleness-guard 등)
      if (!absPath) return {};

      if (isAllowedPath(absPath)) return {};

      const reason = `BLOCKED: Winter (main thread) cannot Edit/Write ${absPath} directly. Delegate to a sub-agent (hawk for USER.md, 17 character agents for code mutation). ALLOWED paths: ${ALLOWED_PATHS_REGEX.map(r => r.source).join(', ')}. Bypass: WINTER3_BYPASS_WINTER_EDITS=1.`;
      return {
        decision: 'block',
        reason,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      };
    } catch {
      // hook 자체 fail 로 turn 망치지 마 — fail-open (best-effort 차단).
      return {};
    }
  };
}

// ── Bash 우회 write 차단 (명백한 패턴만 — 헤더의 "커버리지 한계" 참조) ──
//
// 차단 조건 (전부 동시 성립해야 deny):
//   1. main thread (agent_id 없음) + bypass env 꺼짐
//   2. command 에 sed -i / tee <file> / > >> redirect 존재
//   3. 그 target 이 소스성 확장자 (.js/.mjs/.cjs/.ts/.jsx/.tsx/.css/.html/.md/.json/.jsonl/.sh/.py/.yml/.yaml)
//   4. target 이 /tmp /dev /proc /var/tmp 가 아니고 ALLOWED_PATHS_REGEX 에도 안 걸림
// → `echo x > /tmp/foo.js`, `cmd > out.log`, `2>/dev/null` 등 운영 plumbing 은 통과 (과차단 방지).

const SED_INPLACE = /(?:^|[\s|&;`(])sed\s+(?:[^|&;]*\s)?-[a-zA-Z]*i\b|(?:^|[\s|&;`(])sed\s+--in-place\b/;
const PROTECTED_EXT = /\.(?:js|mjs|cjs|ts|jsx|tsx|css|html|md|json|jsonl|sh|py|yml|yaml)$/i;
const SKIP_TARGET = /^(?:\/dev\/|\/tmp\/|\/var\/tmp\/|\/proc\/)/;
// redirect target: `>` 또는 `>>` 뒤의 word. `2>&1` 은 target 이 `&1` 이라 클래스에서 탈락.
const REDIRECT_TARGET = /(?:^|[^<>])>{1,2}\s*([^\s|&;<>]+)/g;
// tee target(s): `tee [-a] <file>` — 첫 non-flag 인자만 (복수 파일은 첫 개만 봐도 deny 충분).
const TEE_TARGET = /(?:^|[\s|&;`(])tee\s+(?:-[a-zA-Z]+\s+)*([^\s|&;<>]+)/g;
// sed -i 가 있을 때 command 안의 소스성 path 토큰.
const PATHISH_TOKEN = /[^\s"'`|&;<>]+\.(?:js|mjs|cjs|ts|jsx|tsx|css|html|md|json|jsonl|sh|py|yml|yaml)\b/gi;

function isBlockedBashWriteTarget(raw) {
  if (!raw) return false;
  const t = raw.replace(/^["']+|["']+$/g, '');
  if (!t || SKIP_TARGET.test(t)) return false;
  if (!PROTECTED_EXT.test(t)) return false;
  // allowlist: 절대/상대 둘 다 검사 (상대경로는 앞에 '/' 붙여 재검사).
  const abs = t.startsWith('/') ? t : '/' + t;
  if (ALLOWED_PATHS_REGEX.some((re) => re.test(abs) || re.test(t))) return false;
  // scripts/qa-* 상대경로 형태도 허용 (ALLOWED 의 /winter3/scripts/qa- 와 동치 의도).
  if (/(?:^|\/)scripts\/qa-/.test(t)) return false;
  return true;
}

export function makeWinterNeverEditsBashGate() {
  return async function winterNeverEditsBashGate(input /*, toolUseID, options */) {
    try {
      if (input?.tool_name !== 'Bash') return {};
      if (String(process.env.WINTER3_BYPASS_WINTER_EDITS || '') === '1') return {};
      if (input.agent_id) return {}; // sub-agent → 통과

      const cmd = input?.tool_input?.command;
      if (!cmd || typeof cmd !== 'string') return {};

      const hits = [];
      for (const m of cmd.matchAll(REDIRECT_TARGET)) {
        if (isBlockedBashWriteTarget(m[1])) hits.push(`redirect → ${m[1]}`);
      }
      for (const m of cmd.matchAll(TEE_TARGET)) {
        if (isBlockedBashWriteTarget(m[1])) hits.push(`tee → ${m[1]}`);
      }
      if (SED_INPLACE.test(cmd)) {
        for (const m of cmd.matchAll(PATHISH_TOKEN)) {
          if (isBlockedBashWriteTarget(m[0])) hits.push(`sed -i → ${m[0]}`);
        }
      }
      if (hits.length === 0) return {};

      const reason = `BLOCKED: Winter (main thread) cannot write files via Bash (${hits.join(', ')}). Delegate to a sub-agent, or use allowed paths (${ALLOWED_PATHS_REGEX.map((r) => r.source).join(', ')}). Bypass: WINTER3_BYPASS_WINTER_EDITS=1.`;
      return {
        decision: 'block',
        reason,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      };
    } catch {
      return {}; // fail-open
    }
  };
}
