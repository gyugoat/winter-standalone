// server/hooks/events-necropsy-gate.js
// PreToolUse — data/events/*.jsonl 및 claude transcript ~/.claude/projects/**/*.jsonl 의
// 원문 read 를 차단. "부검 감염" (#59 제 2 함정) 방지.
//
// 이유:
//   raw jsonl 에는 모델 output / thinking delta / tool_result content 가 들어있고,
//   그걸 라이브 세션이 Read/cat 하면 그 내용이 컨텍스트로 유입 → Anthropic AUP classifier
//   ("duplicating model outputs") 가 그 세션도 죽인다 (실측: mac 19a24f09 + sub-agent 2).
//
// 정책:
//   - PreToolUse(Read): file_path 가 events/transcript 패턴 매칭 시 deny.
//   - PreToolUse(Bash): command 에 events/transcript 경로 + 위험 reader (cat|head|tail|
//     less|more|nl|sed|awk|xxd|od|python.*open|node.*readFile 등) 결합 시 deny.
//   - 허용:
//       * `scripts/necropsy.mjs ...` 포함 명령어 (공식 안전 부검 도구)
//       * `grep -c` / `grep -o` (카운트 / 특정 토큰만 뽑기 — content 대량 유입 없음)
//       * `wc` (라인/바이트 카운트만)
//       * `ls` / `stat` / `file` (메타만)
//       * `rm` / `mv` / `cp` (cleanup / 이동)
//   - sub-agent (agent_id 있음) → 통과. 위임 후 sub-agent 격리 컨텍스트에선 판정을
//     서브에 맡긴다. (부검용 sub-agent 는 necropsy.mjs 를 쓰거나 필요 시 위험 감수.)
//
// env 우회: WINTER3_BYPASS_NECROPSY_GATE=1 (emergency 용)

import { resolve as pathResolve } from 'node:path';

// 위험 파일 경로 매칭.
// 1) winter3 raw events jsonl:  .../data/events/<uuid>.jsonl
// 2) claude transcript jsonl:   .../.claude/projects/.../*.jsonl
const EVENTS_PATH_REGEX = /\/data\/events\/[^/]+\.jsonl$/;
const TRANSCRIPT_PATH_REGEX = /\/\.claude\/projects\/[^/]+\/[^/]+\.jsonl$/;

// Bash 안에서 파일 경로 토큰 매칭 — 인용 여부 관계 없이.
// events 는 절대/상대 상관없이 `data/events/xxx.jsonl` 형태 인식.
const BASH_EVENTS_TOKEN = /(?:^|[\s"'`(<>|&;=])(?:[\w./~-]*\/)?data\/events\/[^\s"'`)<>|&;]+\.jsonl(?:\s|$|["'`)<>|&;])/;
const BASH_TRANSCRIPT_TOKEN = /(?:^|[\s"'`(<>|&;=])(?:[\w./~-]*\/)?\.claude\/projects\/[^\s]+\.jsonl(?:\s|$|["'`)<>|&;])/;

// 위험 reader — content 를 stdout 으로 대량 방출하는 명령.
// 안전 reader (grep -c, grep -o, wc, ls, stat, file, rm, mv, cp) 는 아래 SAFE_READER 로 우선 체크.
const DANGER_READER = /(?:^|[\s|&;`(])(cat|head|tail|less|more|nl|sed|awk|xxd|od|tac|rev|column|fold|jq|yq)\s/;
// python / node 등 언어 호출로 파일 읽는 우회
const DANGER_LANG = /(?:^|[\s|&;`(])(python[23]?|node|deno|bun|ruby|perl|php)\s+(?:-[cSeRf]|-\w*\s+|--?\S*\s+)*(?:.*?(?:open|readFile|readFileSync|read_text|readLines|readlines|slurp|readAsText|readAllText))/;
// grep 은 -o / -c 는 안전, plain grep 은 content 유입. 안전 flag 있는지 별도 판단.
const DANGER_GREP_PLAIN = /(?:^|[\s|&;`(])grep\s+(?!(?:-[a-zA-Z]*[oclq]|--(?:count|only-matching|files-with-matches|files-without-match|quiet)))/;

// necropsy.mjs 는 언제나 허용. 이 토큰이 command 안에 있으면 통과.
const NECROPSY_ALLOW = /(?:scripts\/necropsy\.mjs|necropsy\.mjs)(?:\s|$|["'`)<>|&;])/;

function extractFilePath(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null;
  const fp = toolInput.file_path || toolInput.path;
  if (!fp || typeof fp !== 'string') return null;
  if (!fp.startsWith('/') && !fp.startsWith('~')) return null;
  try { return pathResolve(fp.replace(/^~/, process.env.HOME || '~')); }
  catch { return fp; }
}

const DENY_MSG_READ = (path) =>
  `BLOCKED: ${path} 는 raw events/transcript — 모델 출력/thinking delta 포함. 이걸 Read 하면 컨텍스트 유입으로 classifier 감염 (#59 부검 감염 사고, mac 세션 2 + sub-agent 1 사망). 대신 \`node scripts/necropsy.mjs --session <id> --stats\` 로 구조만 추출하라. Bypass: WINTER3_BYPASS_NECROPSY_GATE=1.`;

const DENY_MSG_BASH = (which) =>
  `BLOCKED: raw ${which} jsonl 은 모델 출력 포함 — cat/tail 등으로 읽으면 classifier 감염 (#59). scripts/necropsy.mjs 로 구조만 추출하거나, grep -c / grep -o / wc / ls / rm 같은 메타 명령만 사용. Bypass: WINTER3_BYPASS_NECROPSY_GATE=1.`;

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

// ─── Read variant ───────────────────────────────────────────────────────────
export function makeEventsNecropsyReadGate() {
  return async function eventsNecropsyReadGate(input /*, toolUseID, options */) {
    try {
      if (input?.tool_name !== 'Read') return {};
      if (String(process.env.WINTER3_BYPASS_NECROPSY_GATE || '') === '1') return {};
      if (input.agent_id) return {}; // sub-agent → 통과

      const absPath = extractFilePath(input.tool_input);
      if (!absPath) return {};

      if (EVENTS_PATH_REGEX.test(absPath) || TRANSCRIPT_PATH_REGEX.test(absPath)) {
        return denyResult(DENY_MSG_READ(absPath));
      }
    } catch { /* fail-open */ }
    return {};
  };
}

// ─── Bash variant ───────────────────────────────────────────────────────────
export function makeEventsNecropsyBashGate() {
  return async function eventsNecropsyBashGate(input /*, toolUseID, options */) {
    try {
      if (input?.tool_name !== 'Bash') return {};
      if (String(process.env.WINTER3_BYPASS_NECROPSY_GATE || '') === '1') return {};
      if (input.agent_id) return {};

      const cmd = input?.tool_input?.command;
      if (!cmd || typeof cmd !== 'string') return {};

      const hasEvents = BASH_EVENTS_TOKEN.test(cmd);
      const hasTranscript = BASH_TRANSCRIPT_TOKEN.test(cmd);
      if (!hasEvents && !hasTranscript) return {};

      // 공식 안전 도구 → 무조건 허용.
      if (NECROPSY_ALLOW.test(cmd)) return {};

      // 위험 reader 조합 판정.
      const danger =
        DANGER_READER.test(cmd) ||
        DANGER_LANG.test(cmd) ||
        DANGER_GREP_PLAIN.test(cmd);
      if (danger) {
        return denyResult(DENY_MSG_BASH(hasTranscript ? 'transcript' : 'events'));
      }
      // 안전 명령 (grep -c, wc, ls, rm, mv, cp, stat, file 등) → 통과.
    } catch { /* fail-open */ }
    return {};
  };
}
