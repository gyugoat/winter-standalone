// server/hooks/hawk-usermd-gate.js
// PreToolUse — main thread (Winter) 의 USER.md 직접 read/조회 차단.
//
// 세 layer:
//   1. Read / Grep / Glob tool — 대상 경로(file_path / path / glob / pattern)가 USER.md 매칭 시 deny
//   2. Bash tool — command 안에 read/copy 동사 (cat/head/.../cp/mv/base64/od/xxd/sort/cut/tee/dd/install/rsync)
//      가 USER.md 매칭 시 deny
//      + write redirect `> USER.md` / `>> USER.md` / `tee USER.md` 도 deny (Edit/Write 외 우회 경로 차단)
//   3. Bash 인라인 인터프리터 (node -e / python3 -c / perl -e 류) + USER.md 토큰 동시 등장 시 deny
//
// sub-agent (특히 hawk) → 통과. 다른 sub-agent 도 read 는 OK (cross-validation 위해).
//
// 정책 근거 (#43 / #45):
//   - USER.md = 사용자 개인 정보 마스터. hawk 가 단일 진입점.
//   - Winter 가 USER.md 직접 read 시 system prompt 의 "Recurring Loops" 카탈로그를 cached 답으로 채워
//     fact-drift (예: "결혼식" loop hallucination — #43).
//   - hawk 위임 강제 → hawk 의 cached 답도 risk 있지만 single-layer 보단 안전 (#43 lesson 룰 5).
//
// false positive 방지:
//   - USER.md.bak.* (백업) 은 차단 안 함 — 백업 비교 / cleanup 정상 작업.
//   - winter3 자체 .md (README.md 등) 차단 안 함 — USER.md 정확 매칭만.
//   - Bash 안의 `# USER.md` 같은 주석 / pipe 안의 `echo USER.md` 같은 string literal 은
//     명령어 토큰 검사 후 매칭이라 false positive 있을 수 있음. WINTER3_BYPASS_USERMD_GATE=1 우회.
//
// env 우회: WINTER3_BYPASS_USERMD_GATE=1

import { resolve as pathResolve } from 'node:path';

// USER.md 절대경로 매칭 패턴. winter/data/USER.md 만 정확히 (백업 제외).
// `/data/USER.md` 다음 문자가 없거나 (= 끝) 만 매칭.
const USERMD_PATH_REGEX = /\/data\/USER\.md$/;

// Bash command 안에서 USER.md 토큰 + 위험 동사 매칭.
// 위험 동사: read (cat|head|tail|less|more|nl|wc) + grep (grep|sed|awk)
//          + copy/encode 우회 (cp|mv|base64|od|xxd|sort|cut|tee|dd|install|rsync|strings|rev|paste|fold|uniq)
//          + write redirect (> / >>)
// 완벽 봉쇄 아님 — "싸게 막을 수 있는 구멍" 수준 best-effort. 새 우회 발견 시 verb 추가.
const DANGER_VERBS = /(?:^|[\s|&;`(])(cat|head|tail|grep|sed|awk|less|more|nl|wc|cp|mv|base64|od|xxd|sort|cut|tee|dd|install|rsync|strings|rev|paste|fold|uniq)\s/;
const WRITE_REDIRECT = /(?:^|[\s|&;])>>?\s*[^\s|&;]*\/?USER\.md(?:\s|$|[|&;])/;
// 인라인 인터프리터 (node -e / python3 -c / perl -pe / ruby -e / php -r / deno eval 류).
// USERMD_TOKEN 과 동시 매칭 시만 deny — 인터프리터 단독 사용은 통과 (과차단 방지).
const INLINE_INTERP = /(?:^|[\s|&;`(])(?:node|nodejs|bun|deno|python[0-9.]*|perl|ruby|php)(?:\s+\S+)*?\s-{1,2}(?:e|c|r|p|pe|ne|eval|exec|print)(?=\s|$|['"])|(?:^|[\s|&;`(])deno\s+eval\b/;
// command 안에 USER.md 토큰 (백업 .bak.* 은 별도 패턴으로 제외)
const USERMD_TOKEN = /(?:^|[\s/=])USER\.md(?!\.bak)(?:\s|$|[|&;<>"'\\)])/;
// Grep/Glob 용 — path 인자가 USER.md 파일 자체를 가리키는 경우 (상대경로 포함, .bak 은 $ 앵커로 자연 제외)
const USERMD_LOOSE_PATH = /(?:^|\/)USER\.md$/;
// Grep 의 glob 인자 / Glob 의 pattern 인자 문자열 안 USER.md (예: "**/USER.md")
const USERMD_GLOB_PATTERN = /USER\.md(?!\.bak)/;

function extractFilePath(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null;
  const fp = toolInput.file_path || toolInput.path;
  if (!fp || typeof fp !== 'string') return null;
  if (!fp.startsWith('/')) return null;
  return pathResolve(fp);
}

function denyResult(reason) {
  return {
    decision: 'block',
    reason,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

// Read / Grep / Glob tool variant — 대상 경로가 USER.md 매칭 시 deny.
//   Read: file_path 정확 매칭 (절대경로).
//   Grep: path 가 USER.md 파일 자체이거나 glob 인자가 USER.md 를 겨냥 (디렉토리 grep 은 과차단 방지 위해 통과).
//   Glob: pattern / path 가 USER.md 를 겨냥.
// index.js 의 matcher 가 'Read|Grep|Glob' 이어야 Grep/Glob 분기가 발동.
export function makeHawkUserMdReadGate() {
  return async function hawkUserMdReadGate(input /*, toolUseID, options */) {
    try {
      const tn = input?.tool_name;
      if (tn !== 'Read' && tn !== 'Grep' && tn !== 'Glob') return {};
      if (String(process.env.WINTER3_BYPASS_USERMD_GATE || '') === '1') return {};
      if (input.agent_id) return {}; // sub-agent (hawk 포함) → 통과

      if (tn === 'Read') {
        const absPath = extractFilePath(input.tool_input);
        if (!absPath) return {};
        if (USERMD_PATH_REGEX.test(absPath)) {
          return denyResult(
            `BLOCKED: Winter (main thread) cannot Read ${absPath} directly. Delegate to hawk: "USER.md 의 X 섹션 읽어와" via Agent tool. Bypass: WINTER3_BYPASS_USERMD_GATE=1.`
          );
        }
        return {};
      }

      // Grep / Glob — path 가 USER.md 파일 자체이거나, glob/pattern 이 USER.md 를 겨냥하면 deny.
      const ti = input.tool_input || {};
      const p = typeof ti.path === 'string' ? ti.path : '';
      const g = typeof ti.glob === 'string' ? ti.glob : '';
      const pat = (tn === 'Glob' && typeof ti.pattern === 'string') ? ti.pattern : '';
      if ((p && USERMD_LOOSE_PATH.test(p)) || (g && USERMD_GLOB_PATTERN.test(g)) || (pat && USERMD_GLOB_PATTERN.test(pat))) {
        return denyResult(
          `BLOCKED: Winter (main thread) cannot ${tn} USER.md directly. Delegate to hawk via Agent tool. Bypass: WINTER3_BYPASS_USERMD_GATE=1.`
        );
      }
    } catch { /* fail-open */ }
    return {};
  };
}

// Bash tool variant — command 안에서 USER.md 우회 검사 (cat/grep/redirect 등).
export function makeHawkUserMdBashGate() {
  return async function hawkUserMdBashGate(input /*, toolUseID, options */) {
    try {
      if (input?.tool_name !== 'Bash') return {};
      if (String(process.env.WINTER3_BYPASS_USERMD_GATE || '') === '1') return {};
      if (input.agent_id) return {};

      const cmd = input?.tool_input?.command;
      if (!cmd || typeof cmd !== 'string') return {};

      // 1) write redirect 우선 검사 — `> USER.md` 또는 `>> USER.md`
      if (WRITE_REDIRECT.test(cmd)) {
        return denyResult(
          `BLOCKED: Winter (main thread) cannot write to USER.md via Bash redirect. Delegate to hawk for USER.md mutation. Bypass: WINTER3_BYPASS_USERMD_GATE=1.`
        );
      }

      // 2) read/copy 동사 + USER.md 토큰 동시 매칭
      if (USERMD_TOKEN.test(cmd) && DANGER_VERBS.test(cmd)) {
        return denyResult(
          `BLOCKED: Winter (main thread) cannot read/copy USER.md via Bash (cat/head/tail/grep/sed/awk/cp/mv/base64/od/xxd/sort/cut/tee/dd/install/rsync ...). Delegate to hawk via Agent tool. Bypass: WINTER3_BYPASS_USERMD_GATE=1.`
        );
      }

      // 3) 인라인 인터프리터 (node -e / python3 -c / perl -e ...) + USER.md 토큰 동시 매칭
      if (USERMD_TOKEN.test(cmd) && INLINE_INTERP.test(cmd)) {
        return denyResult(
          `BLOCKED: Winter (main thread) cannot access USER.md via inline interpreter (node -e / python3 -c / perl -e ...). Delegate to hawk via Agent tool. Bypass: WINTER3_BYPASS_USERMD_GATE=1.`
        );
      }
    } catch { /* fail-open */ }
    return {};
  };
}
