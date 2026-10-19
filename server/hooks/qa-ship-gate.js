// server/hooks/qa-ship-gate.js
// QA ship-gate — 구현 sub-agent 가 코드 바꾼 뒤 QA(gaeul/sanggang/cheoseo/chubun/baengno)
// 검증 없이 "완료"로 ship(restart.sh / git commit) 되는 걸 기계적으로 차단.
//
// 배경 (#43 architectural lesson — Dispatch Bypass Single-Layer Hallucination):
//   - winter3 architecture = Winter dispatch → sub-agent 수행 → 결과 return → Winter 검토 → 보고.
//     두 layer(수행자/검토자) 분리가 cached-completion hallucination 방지의 structural defense.
//   - winter-never-edits.js 가 Winter 직접 코딩을 막듯, 이 hook 은 "QA 안 거친 코드의 배포/커밋"을 막는다.
//     self-review → cross-review 강제의 mechanical enforcement.
//
// ★ 안전 원칙 (절대 위반 금지) ★
//   - PostToolUse hook 은 절대 block 하지 않는다 — 오직 마커 파일 "기록"만 한다(반환 항상 {}).
//     PostToolUse 에서 block 하면 일반 대화/작업이 깨질 수 있음. 기록 전용.
//   - block 은 오직 PreToolUse(Bash) 의 ship 명령(restart.sh / git commit)에서만.
//     그 외 Bash/Edit/Read 는 절대 안 막음 → Winter 가 벽돌(brick) 안 됨.
//   - 마커 위조 차단 deny 는 PreToolUse(Bash) / PreToolUse(Edit|Write) 에서 state.json 직접 write 만 막음.
//   - 모든 hook 은 try/catch fail-open. hook 자체 fail 로 turn 망치지 마라.
//   - env 우회: WINTER3_BYPASS_QA_GATE=1 → 게이트 전체 무력화.
//
// hook 카탈로그:
//   hook1 qa-dirty-recorder        PostToolUse(Edit|Write|MultiEdit) — CODE_PATH 변경 시 dirty 기록 (block X)
//   hook2 qa-dirty-bash-recorder   PostToolUse(Bash)                 — sed -i / tee / redirect 우회 dirty 기록 (block X)
//   hook3 qa-verified-recorder     PostToolUse(Agent)                — QA sub-agent verdict 기록 (block X)
//   hook4 qa-ship-gate             PreToolUse(Bash)                  — ship 명령만 검사, 유일한 block
//   hook5a qa-gate-forge-deny-bash PreToolUse(Bash)                  — state.json 수동 write deny
//   hook5b qa-gate-marker-forge-deny PreToolUse(Edit|Write|MultiEdit) — state.json Edit/Write deny

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve as pathResolve, join as pj, relative as pathRelative } from 'node:path';

// ── 경로 추론 ──────────────────────────────────────────────────────────────
// standalone: home = app root (server/hooks/ 의 두 단계 위).
const DEFAULT_GYUWUL_HOME = fileURLToPath(new URL('../..', import.meta.url)); // standalone: app root 고정
// winter3 root — server/hooks/ 의 두 단계 위. dirtyFiles 상대경로 기준 + CODE_PATH 판정 기준.
const WINTER3_HOME = fileURLToPath(new URL('../..', import.meta.url));

export const DEFAULT_STATE_DIR = pj(DEFAULT_GYUWUL_HOME, 'data', 'cache', 'qa-gate');
const STATE_FILE = 'state.json';

// QA sub-agent 화이트리스트 — verified 기록을 신뢰하는 검토자.
export const QA_AGENTS = new Set(['gaeul', 'sanggang', 'cheoseo', 'chubun', 'baengno']);

// ── 공통 헬퍼 ──────────────────────────────────────────────────────────────

function bypassed() {
  return String(process.env.WINTER3_BYPASS_QA_GATE || '') === '1';
}

function statePath(stateDir) {
  return pj(stateDir, STATE_FILE);
}

function ensureDir(p) {
  try { mkdirSync(p, { recursive: true }); } catch { /* race ok */ }
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

// state.json 읽기 — 없거나 깨지면 빈 객체.
function readState(stateDir) {
  try {
    const fp = statePath(stateDir);
    if (!existsSync(fp)) return {};
    const raw = readFileSync(fp, 'utf8').trim();
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch { return {}; }
}

// 원자적 write — temp + rename. 디렉토리 자동 생성.
function writeState(stateDir, state) {
  try {
    ensureDir(stateDir);
    const fp = statePath(stateDir);
    const tmp = `${fp}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, fp);
  } catch { /* best-effort — 기록 실패해도 turn 진행 */ }
}

// tool_input 에서 file_path 추출 (staleness-guard / winter-never-edits 동일 패턴).
function extractFilePath(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null;
  const fp = toolInput.file_path || toolInput.path;
  if (!fp || typeof fp !== 'string') return null;
  if (!fp.startsWith('/')) return null;
  return pathResolve(fp);
}

// CODE_PATH 판정 — gyuwul repo 내부의 코드 파일.
//
// 판정 기준 (DEFAULT_GYUWUL_HOME 상대):
//   포함: 확장자 .js/.mjs/.cjs/.css/.html/.py/.sh
//         또는 winter3/server|web|scripts 하위
//   제외: 경로 어느 세그먼트든 data/, node_modules/ 포함
//         또는 *.md (문서)
//         또는 gyuwul repo 외부 (시스템 파일 등)
//
// 이전 구현 제한: WINTER3_HOME 상대 기준 → winter3 외부 코드(games/, tools/ 등)가 누락.
// 변경: DEFAULT_GYUWUL_HOME 기준으로 확장 — 같은 repo 내 모든 코드 파일 커버.
const CODE_EXT_REGEX = /\.(?:js|mjs|cjs|css|html|py|sh)$/i;
// 경로 세그먼트 중 하나라도 data, node_modules, logs, tmp, scratch, .git 이면 제외.
const EXCLUDE_SEGMENT_RE = /(?:^|\/)(data|node_modules|logs|tmp|scratch|\.git)(?:\/|$)/;
function isCodePath(absPath) {
  if (!absPath) return false;
  // gyuwul repo 외부면 무시.
  const rel = pathRelative(DEFAULT_GYUWUL_HOME, absPath);
  if (!rel || rel.startsWith('..')) return false;
  // 제외 세그먼트 우선.
  if (EXCLUDE_SEGMENT_RE.test(rel)) return false;
  if (/\.md$/i.test(rel)) return false;
  // winter3/server|web|scripts 하위 또는 코드 확장자.
  const underWinter3CodeDir = /^winter3\/(?:server|web|scripts)\//.test(rel);
  if (underWinter3CodeDir) return true;
  if (CODE_EXT_REGEX.test(rel)) return true;
  return false;
}

// gyuwul root 기준 상대경로 — dirtyFiles 저장용 (어느 영역인지 보이게).
function toGyuwulRel(absPath) {
  const rel = pathRelative(DEFAULT_GYUWUL_HOME, absPath);
  return rel && !rel.startsWith('..') ? rel : absPath;
}

// dirty 기록 — dirtyTs/dirtyFiles/dirtyBy 갱신. verified 필드는 건드리지 않음.
function recordDirty(stateDir, absPath, by) {
  const state = readState(stateDir);
  state.dirtyTs = nowSec();
  state.dirtyBy = by;
  const rel = toGyuwulRel(absPath);
  const files = Array.isArray(state.dirtyFiles) ? state.dirtyFiles : [];
  if (!files.includes(rel)) files.push(rel);
  // 중복 제거 + 최대 20개 (최근 것 유지).
  state.dirtyFiles = [...new Set(files)].slice(-20);
  writeState(stateDir, state);
}

// PreToolUse deny 결과 — winter-never-edits / hawk-usermd-gate 와 동일 형식.
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

// tool_response 방어적 문자열화 — 문자열이거나 {content:[{text}]} 형태일 수 있음.
function stringifyToolResponse(resp) {
  try {
    if (resp == null) return '';
    if (typeof resp === 'string') return resp;
    if (Array.isArray(resp)) {
      return resp.map((x) => stringifyToolResponse(x)).join('\n');
    }
    if (typeof resp === 'object') {
      // {content:[{text}]} 형태 우선.
      if (Array.isArray(resp.content)) {
        const joined = resp.content
          .map((c) => (c && typeof c === 'object' && typeof c.text === 'string' ? c.text : ''))
          .filter(Boolean)
          .join('\n');
        if (joined) return joined;
      }
      if (typeof resp.text === 'string') return resp.text;
      return JSON.stringify(resp);
    }
    return String(resp);
  } catch { return ''; }
}

// verdict 파싱 — FAIL 신호 감지 + 짧은 발췌 추출.
//
// 우선순위:
//   1. VERDICT/판정 명시 선언 줄이 있으면 그것만으로 결정 (PASS/FAIL).
//      - PARTIAL / 조건부 PASS 같은 애매 표현은 FAIL 로 처리 (안전 우선).
//        이유: "조건부 통과"는 실제로 조건을 충족했는지 알 수 없어 gate 통과시키면 위험.
//        명시적 VERDICT: PASS 만 확실히 통과.
//   2. 명시 선언 없을 때만 휴리스틱 fallback:
//      - [FAIL] 태그
//      - 숫자 앞 word boundary 강제 (?<![A-Za-z0-9_]) + N FAIL, N>0
//        (\b 는 "S2 FAIL" 의 "2" 앞에서 word boundary 로 인식돼 오탐 — lookbehind 사용)
//
// PARTIAL 처리 근거:
//   QA 보고서에서 "Result: PARTIAL" 은 "일부 케이스가 실패했거나 재현 불가"를 뜻하는 경우가 많다.
//   gate 의 목적(검증 안 된 코드 차단)을 생각하면 false negative(놓침)가 false positive(오차단)보다
//   훨씬 위험하다. VERDICT: PASS 로 명시 선언한 것만 통과시킨다.

// VERDICT 명시 선언 줄 인식 규칙.
//
// 설계 원칙:
//   - "첫 번째 매치" 가 아닌 "모든 선언 수집 + 하나라도 FAIL → 차단" 방식.
//     이유: QA 보고서 헤더에 "[QA VERDICT] PASS" 가 오고 맨 마지막 줄에 "VERDICT: FAIL"
//     이 오는 케이스에서 첫 매치를 취하면 통과누락(false-negative)이 발생한다.
//     반면 any-FAIL 방식은 "헤더 PASS + 마지막 FAIL" 케이스를 자연히 차단한다.
//   - 판정 선언 문법만 인식: [VERDICT]/[QA VERDICT] 또는 VERDICT: 뒤에 PASS/FAIL/PARTIAL.
//     줄 앞에 공백/마크다운 마커(#, *, >, -) 만 허용. 임의 텍스트 앞 금지.
//     이유: "이 케이스는 VERDICT: FAIL → 차단 확인" 같은 서술 줄을 선언으로 오인 방지.
//   - 판정 선언이 하나도 없으면 → fallback 휴리스틱 적용.
//   - 선언이 있는데 모두 판별 불가(PASS/FAIL/PARTIAL 없음)이면 → fallback 적용.
//   - 자기참조 보고서 (본문 서술에 "VERDICT: FAIL" 문자열이 있고 최종이 PASS):
//     Option A 로 줄 앞을 좁히면 서술 줄은 걸러지므로 최종 VERDICT: PASS 만 잡혀 통과된다.
//     이 트레이드오프(서술과 선언 구분)를 받아들인다 — 잘못된 false-negative 보다 낫다.
const VERDICT_DECL_RE = /^[\s#*>-]*(?:\[(?:QA\s+)?VERDICT\]|VERDICT\s*:)\s*(?:PASS|FAIL|PARTIAL)[^\n]*/gim;

// 명시 선언 줄 하나에서 PASS/FAIL 판별.
function parseExplicitVerdict(line) {
  const upper = line.toUpperCase();
  const hasPartial = /\bPARTIAL\b/.test(upper);
  const hasFail = /\bFAIL\b/.test(upper);
  const hasPass = /\bPASS\b/.test(upper);
  if (hasPartial) return 'fail';   // PARTIAL = 안전 우선 FAIL
  if (hasFail) return 'fail';
  if (hasPass) return 'pass';
  return null; // 판별 불가
}

function parseVerdict(text) {
  const t = String(text || '');

  // 모든 판정 선언 줄 수집.
  const declMatches = [...t.matchAll(VERDICT_DECL_RE)];

  // 짧은 발췌 — 선언 줄 중 마지막 것 우선, 없으면 카운트 줄.
  let verdict = '';
  if (declMatches.length > 0) {
    verdict = declMatches[declMatches.length - 1][0].trim().slice(0, 120);
  } else {
    // 숫자 앞 lookbehind 적용한 카운트 줄 — 오탐 방지용
    const countLine = t.match(/(?<![A-Za-z0-9_])\d+\s*PASS[^\n]{0,80}|(?<![A-Za-z0-9_])\d+\s*FAIL[^\n]{0,80}/i);
    if (countLine) verdict = countLine[0].trim().slice(0, 120);
  }

  // ── 1순위: 명시적 VERDICT 선언 — any-FAIL 방식 ──────────────────────
  // 선언 줄이 하나라도 있으면:
  //   - 하나라도 FAIL/PARTIAL 이면 → 차단 (안전 우선).
  //   - 모두 PASS 이면 → 통과.
  //   - 전부 판별 불가이면 → fallback 으로 내려감.
  if (declMatches.length > 0) {
    const verdicts = declMatches.map((m) => parseExplicitVerdict(m[0]));
    const hasAnyFail = verdicts.some((v) => v === 'fail');
    const hasAnyPass = verdicts.some((v) => v === 'pass');
    const hasAnyKnown = hasAnyFail || hasAnyPass;

    if (hasAnyKnown) {
      // 하나라도 fail 이면 차단. 모두 pass 여야 통과.
      const passed = !hasAnyFail;
      return { passed, verdict };
    }
    // 전부 판별 불가 → fallback
  }

  // ── 2순위 fallback: 휴리스틱 ────────────────────────────────────────
  let passed = true;

  if (/\[FAIL\]/i.test(t)) passed = false;

  // 숫자 앞 lookbehind — "S2 FAIL" 의 "2" 같은 식별자 내 숫자 오탐 방지.
  // \b 는 \w-\W 경계라 숫자 뒤 공백("S2 FAIL"에서 "2 F")를 boundary로 보지 않음 → lookbehind 필요.
  const failCountMatch = t.match(/(?<![A-Za-z0-9_])(\d+)\s*FAIL/i);
  if (failCountMatch && Number(failCountMatch[1]) > 0) passed = false;

  if (/\bVERDICT\b[^\n]*\bFAIL\b/i.test(t)) passed = false;

  return { passed, verdict };
}

// ── CODE_PATH 우회 write 토큰 매칭 (hook2 용) ───────────────────────────────
// write 동사 + CODE_PATH 토큰 동시 매칭. false positive 줄이려 best-effort.
// CODE_PATH 토큰: server/ web/ scripts/ 경로 prefix 또는 .js/.mjs/.cjs/.css/.html/.py/.sh 파일.
// isCodePath 의 CODE_EXT_REGEX 와 확장자 목록 동기화.
const CODE_TOKEN = '(?:[^\\s|&;<>"\'`]*(?:server|web|scripts)\\/[^\\s|&;<>"\'`]*|[^\\s|&;<>"\'`]+\\.(?:js|mjs|cjs|css|html|py|sh))';
// `>`/`>>` redirect 뒤 CODE_PATH.
const BASH_WRITE_REDIRECT = new RegExp(`>>?\\s*${CODE_TOKEN}`, 'i');
// `tee ` 뒤 CODE_PATH (옵션 플래그 허용).
const BASH_TEE = new RegExp(`\\btee\\b(?:\\s+-\\S+)*\\s+${CODE_TOKEN}`, 'i');
// `sed -i` / `sed --in-place` 가 CODE_PATH 인자.
const BASH_SED_INPLACE = new RegExp(`\\bsed\\b[^\\n]*(?:-i|--in-place)\\b[^\\n]*${CODE_TOKEN}`, 'i');

function bashWritesCodePath(cmd) {
  if (!cmd || typeof cmd !== 'string') return false;
  return BASH_WRITE_REDIRECT.test(cmd) || BASH_TEE.test(cmd) || BASH_SED_INPLACE.test(cmd);
}

// ── ship 명령 매칭 (hook4 용) ───────────────────────────────────────────────
// restart.sh "실행" 또는 git commit.
//
// 2026-10-09 오탐 fix: 구 정규식 /(^|[\s&;|])\.?\/?restart\.sh\b/ 은 구분자에 일반
// 공백(\s)이 포함돼 "명령 인자 속 경로"에도 매칭 — `git log -- ... restart.sh` 같은
// 읽기 전용 진단 명령까지 BLOCKED. 명령 위치(세그먼트 첫 토큰, 또는 interpreter
// 호출의 첫 스크립트 인자)에서만 매칭하도록 토큰 검사로 교체.
//
// restart.sh 토큰 — 경로 prefix 허용 (./restart.sh, /abs/path/restart.sh).
const RESTART_TOKEN_RE = /^(?:[^\s|&;<>"'`]*\/)?restart\.sh$/;
// interpreter 경유 실행 (bash restart.sh / sh ./restart.sh / source 류).
const SHIP_INTERPRETERS = new Set(['bash', 'sh', 'zsh', 'source', '.']);
// 투명 wrapper — 실제 명령을 뒤 토큰으로 넘기는 prefix (nohup ./restart.sh 등).
// 중첩 가능 (nohup env FOO=1 bash ./restart.sh) — 루프로 전부 소비.
const SHIP_WRAPPERS = new Set(['nohup', 'exec', 'env', 'eval', 'command', 'time', 'sudo']);
const SHIP_GIT_COMMIT = /(^|[\s&;|])git\s+commit\b/;

// restart.sh 가 "명령으로 실행"되는지 — 세그먼트(&&, ||, ;, |, &, 줄바꿈 분리)별로
// 첫 토큰(env VAR= / wrapper prefix 제외)이 restart.sh 이거나, interpreter + 첫
// 스크립트 인자가 restart.sh 일 때만 true. 인자 속 경로(cat/grep/git log -- 등)는 false.
// 토큰 양끝 괄호류 strip — `(cd x && ./restart.sh)` 의 `./restart.sh)` 대응.
function isRestartInvocation(cmd) {
  const segments = String(cmd).split(/&&|\|\||[;|&\n]/);
  for (const seg of segments) {
    const tokens = seg
      .trim()
      .split(/\s+/)
      .map((t) => t.replace(/^[({]+|[)}]+$/g, ''))
      .filter(Boolean);
    let i = 0;
    // env 할당 prefix (FOO=1 bash restart.sh) + 투명 wrapper(+플래그) 건너뜀.
    while (i < tokens.length) {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) { i += 1; continue; }
      if (SHIP_WRAPPERS.has(tokens[i])) {
        i += 1;
        while (i < tokens.length && tokens[i].startsWith('-')) i += 1;
        continue;
      }
      break;
    }
    if (i >= tokens.length) continue;
    if (RESTART_TOKEN_RE.test(tokens[i])) return true;
    if (SHIP_INTERPRETERS.has(tokens[i])) {
      // interpreter 플래그(-x 등) 건너뛰고 첫 비플래그 인자만 검사.
      for (let j = i + 1; j < tokens.length; j += 1) {
        if (tokens[j].startsWith('-')) continue;
        if (RESTART_TOKEN_RE.test(tokens[j])) return true;
        break; // 첫 스크립트 인자가 restart.sh 아니면 이 세그먼트 종료.
      }
    }
  }
  return false;
}

function isShipCommand(cmd) {
  if (!cmd || typeof cmd !== 'string') return false;
  return isRestartInvocation(cmd) || SHIP_GIT_COMMIT.test(cmd);
}

// ── 마커 위조 매칭 (hook5 용) ───────────────────────────────────────────────
// command 안에서 state.json 경로 + write 동사(touch/>/>>/tee/sed -i).
const STATE_JSON_TOKEN = /qa-gate\/state\.json/;
const FORGE_WRITE_VERB = /(?:\btouch\b|>>?|\btee\b|\bsed\b[^\n]*(?:-i|--in-place)\b)/;
function bashForgesState(cmd) {
  if (!cmd || typeof cmd !== 'string') return false;
  if (!STATE_JSON_TOKEN.test(cmd)) return false;
  return FORGE_WRITE_VERB.test(cmd);
}

// ════════════════════════════════════════════════════════════════════════════
// hook1 — dirty 기록: PostToolUse(Edit|Write|MultiEdit). block 금지, 항상 {}.
// ════════════════════════════════════════════════════════════════════════════
export function makeQaDirtyRecorder({ stateDir = DEFAULT_STATE_DIR } = {}) {
  return async function qaDirtyRecorder(input /*, toolUseID, options */) {
    try {
      const tn = input?.tool_name;
      if (tn !== 'Edit' && tn !== 'Write' && tn !== 'MultiEdit') return {};
      // agent_id 있을 때만 — Winter main 직접 Edit 은 winter-never-edits 가 이미 차단.
      if (!input.agent_id) return {};
      const absPath = extractFilePath(input.tool_input);
      if (!absPath) return {};
      if (!isCodePath(absPath)) return {};
      recordDirty(stateDir, absPath, 'Edit');
    } catch { /* fail-open — 기록 전용 hook */ }
    return {};
  };
}

// ════════════════════════════════════════════════════════════════════════════
// hook2 — dirty 기록 (우회 봉합): PostToolUse(Bash). block 금지, 항상 {}.
//   sub-agent 가 Edit 안 쓰고 sed -i / tee / redirect 로 코드 파일 쓰면 hook1 미발동 → 여기서 잡음.
// ════════════════════════════════════════════════════════════════════════════
export function makeQaDirtyBashRecorder({ stateDir = DEFAULT_STATE_DIR } = {}) {
  return async function qaDirtyBashRecorder(input /*, toolUseID, options */) {
    try {
      if (input?.tool_name !== 'Bash') return {};
      if (!input.agent_id) return {};
      const cmd = input?.tool_input?.command;
      if (!bashWritesCodePath(cmd)) return {};
      // 우회 write 감지 — 대표 경로 하나를 dirty 로 기록 (정확한 파일명 추출은 best-effort).
      recordDirty(stateDir, pj(WINTER3_HOME, '(bash-write)'), 'Bash');
    } catch { /* fail-open — 기록 전용 hook */ }
    return {};
  };
}

// ════════════════════════════════════════════════════════════════════════════
// hook3 — verified 기록: PostToolUse(Agent). block 금지, 항상 {}.
//   QA sub-agent verdict 를 기록. PostToolUse(Agent) 발화 여부는 런타임 불확실 →
//   발화 시 stderr 한 줄 로그로 e2e 확인 가능하게 한다.
// ════════════════════════════════════════════════════════════════════════════
export function makeQaVerifiedRecorder({ stateDir = DEFAULT_STATE_DIR } = {}) {
  return async function qaVerifiedRecorder(input /*, toolUseID, options */) {
    try {
      if (input?.tool_name !== 'Agent') return {};
      const subagent = input?.tool_input?.subagent_type;
      if (!subagent || !QA_AGENTS.has(subagent)) return {};

      const text = stringifyToolResponse(input?.tool_response);
      const { passed, verdict } = parseVerdict(text);

      const state = readState(stateDir);
      state.verifiedTs = nowSec();
      state.verifiedPassed = passed;
      state.verdict = verdict || (passed ? 'PASS (no explicit verdict)' : 'FAIL');
      state.verifiedBy = subagent;
      writeState(stateDir, state);

      // e2e 확인용 stderr 로그.
      try { process.stderr.write(`[qa-gate] verified recorded by ${subagent} (passed=${passed})\n`); } catch { /* noop */ }
    } catch { /* fail-open — 기록 전용 hook */ }
    return {};
  };
}

// ════════════════════════════════════════════════════════════════════════════
// hook4 — ship-gate (유일한 block): PreToolUse(Bash).
//   ship 명령(restart.sh / git commit)일 때만 검사. 그 외 Bash 는 즉시 통과.
// ════════════════════════════════════════════════════════════════════════════
export function makeQaShipGate({ stateDir = DEFAULT_STATE_DIR } = {}) {
  return async function qaShipGate(input /*, toolUseID, options */) {
    try {
      if (input?.tool_name !== 'Bash') return {};
      if (bypassed()) return {};
      const cmd = input?.tool_input?.command;
      if (!isShipCommand(cmd)) return {}; // ship 명령 아니면 절대 안 막음.

      const state = readState(stateDir);
      const dirtyTs = Number(state.dirtyTs || 0);
      const verifiedTs = Number(state.verifiedTs || 0);

      // state 없음 / dirty 없음 → 통과 (아직 변경 없음 또는 첫 실행).
      if (!dirtyTs || dirtyTs <= 0) return {};

      const files = Array.isArray(state.dirtyFiles) ? state.dirtyFiles.join(', ') : '';
      const lastVerdict = state.verdict ? String(state.verdict) : '(none)';
      const fixHint = `QA 통과(gaeul/sanggang/cheoseo/chubun/baengno) 후 재시도, 또는 WINTER3_BYPASS_QA_GATE=1.`;

      // 조건 1: 코드 변경 후 QA 미실행 (dirty 가 verified 보다 최신).
      if (dirtyTs > verifiedTs) {
        const reason = `BLOCKED: 코드 변경 후 QA 미실행 — ship 차단. 변경 파일: [${files}]. 마지막 verdict: ${lastVerdict}. ${fixHint}`;
        return denyResult(reason);
      }

      // 조건 2: QA 가 FAIL 판정 (verified 가 dirty 이후인데 passed=false).
      if (verifiedTs >= dirtyTs && state.verifiedPassed === false) {
        const reason = `BLOCKED: QA 가 FAIL 판정 — ship 차단. 검토자: ${state.verifiedBy || '?'}, verdict: ${lastVerdict}. 변경 파일: [${files}]. ${fixHint}`;
        return denyResult(reason);
      }

      // dirty 후 verified(passed) → 통과.
    } catch { /* fail-open — gate 자체 fail 로 ship turn 망치지 마 */ }
    return {};
  };
}

// ════════════════════════════════════════════════════════════════════════════
// hook5a — 마커 위조 차단 (Bash): PreToolUse(Bash).
//   state.json 을 touch / redirect / tee / sed -i 로 직접 쓰는 시도 deny.
// ════════════════════════════════════════════════════════════════════════════
export function makeQaForgeDenyBash() {
  return async function qaForgeDenyBash(input /*, toolUseID, options */) {
    try {
      if (input?.tool_name !== 'Bash') return {};
      if (bypassed()) return {};
      const cmd = input?.tool_input?.command;
      if (!bashForgesState(cmd)) return {};
      const reason = `BLOCKED: qa-gate state.json 은 hook 만 기록한다. touch/redirect/tee/sed -i 로 직접 위조 금지. QA 는 실제 sub-agent(gaeul/sanggang/cheoseo/chubun/baengno) 위임으로 검증해라. Bypass: WINTER3_BYPASS_QA_GATE=1.`;
      return denyResult(reason);
    } catch { /* fail-open */ }
    return {};
  };
}

// ════════════════════════════════════════════════════════════════════════════
// hook5b — 마커 위조 차단 (Edit|Write|MultiEdit): PreToolUse.
//   file_path 가 qa-gate/state.json 이면 deny.
// ════════════════════════════════════════════════════════════════════════════
export function makeQaMarkerForgeDeny() {
  return async function qaMarkerForgeDeny(input /*, toolUseID, options */) {
    try {
      const tn = input?.tool_name;
      if (tn !== 'Edit' && tn !== 'Write' && tn !== 'MultiEdit') return {};
      if (bypassed()) return {};
      const absPath = extractFilePath(input.tool_input);
      if (!absPath) return {};
      if (!STATE_JSON_TOKEN.test(absPath.replace(/\\/g, '/'))) return {};
      const reason = `BLOCKED: qa-gate state.json 은 hook 만 기록한다. Edit/Write 로 직접 위조 금지. QA 는 실제 sub-agent 위임으로 검증해라. Bypass: WINTER3_BYPASS_QA_GATE=1.`;
      return denyResult(reason);
    } catch { /* fail-open */ }
    return {};
  };
}

// ════════════════════════════════════════════════════════════════════════════
// hook6 — 미검증 reminder 주입: UserPromptSubmit.
//   dirty > verified 상태이면 매 turn additionalContext 로 짧은 리마인더 주입.
//   절대 block 금지. try/catch fail-open. bypassed() 존중.
//   같은 dirtyTs 에 대해 최대 2회까지만 주입, 그 뒤 침묵 (lesson-trigger 의 injectedLessons 패턴).
// ════════════════════════════════════════════════════════════════════════════

// 프로세스 스코프 카운터 — { dirtyTs(number): count(number) }.
// 같은 dirtyTs 에 대해 2회 주입 후 침묵.
const _reminderCountByTs = new Map();
const REMINDER_MAX_PER_DIRTY = 2;

export function makeQaUnverifiedReminder({ stateDir = DEFAULT_STATE_DIR } = {}) {
  return async function qaUnverifiedReminder(/* input */) {
    try {
      if (bypassed()) return {};
      const state = readState(stateDir);
      const dirtyTs = Number(state.dirtyTs || 0);
      const verifiedTs = Number(state.verifiedTs || 0);

      // dirty 없음 또는 verified 가 최신 → 리마인더 불필요.
      if (!dirtyTs || dirtyTs <= 0) return {};
      if (verifiedTs >= dirtyTs) return {};

      // 같은 dirtyTs 에 대한 주입 횟수 체크.
      const count = _reminderCountByTs.get(dirtyTs) || 0;
      if (count >= REMINDER_MAX_PER_DIRTY) return {}; // 2회 초과 → 침묵.

      _reminderCountByTs.set(dirtyTs, count + 1);

      const files = Array.isArray(state.dirtyFiles) ? state.dirtyFiles : [];
      const fileList = files.length > 0 ? files.join(', ') : '(알 수 없음)';
      const text = `[qa-gate] 미검증 코드 변경 있음 — 파일: [${fileList}]. 완료 보고 전에 QA sub-agent (gaeul/sanggang/cheoseo/chubun/baengno) 검증 태워라.`;

      return {
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: text,
        },
      };
    } catch { /* fail-open */ }
    return {};
  };
}

// 테스트 / 외부 재사용을 위한 내부 헬퍼 export.
export const __internals = {
  isCodePath,
  bashWritesCodePath,
  isShipCommand,
  bashForgesState,
  parseVerdict,
  stringifyToolResponse,
  readState,
  writeState,
  DEFAULT_GYUWUL_HOME,
  WINTER3_HOME,
  _reminderCountByTs,
};
