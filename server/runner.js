// server/runner.js
// The engine. Wraps Claude Agent SDK query() and streams every message straight
// into the event log. No parsing. No domain events. Raw SDK messages as-is.
//
// Contract:
//   - Each SDK message is appended to jsonl as one line: {id, ts, raw: <SDK msg>}
//   - Session meta gets claudeSessionId updated on first system/init
//   - AbortController exposed so POST /kill can stop a turn
//   - On error / abort / normal completion, we emit a synthetic record
//     {type:'winter3.turn_end', reason:...} so UI can compute "done" without
//     depending on a specific SDK message shape.

import { query } from '@anthropic-ai/claude-agent-sdk';
import { readFileSync, writeFileSync, existsSync, readdirSync, renameSync, mkdirSync, unlinkSync, appendFileSync } from 'node:fs';
import { join as pj, basename, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as log from './event-log.js';
import * as session from './session.js';
import { maybeAutoTitle } from './session-title.js';
import { loadCharacterAgents } from './agents-loader.js';
import { loadSkillManifests } from './skills-loader.js';
import { combineHooks } from './hooks/index.js';
import { imageDimensionsFromHeader, IMAGE_MAX_LONG_EDGE } from './image-utils.js';
import { quarantineLastTurn, quarantineAllRefusals, resolveTranscriptPath } from './transcript-quarantine.js';
import { rephraseByDictionary, rephraseByLLM } from './rephraser.js';

// 2026-08-12: claude-opus-5 → claude-fable-5. 응답 품질 우선(양보다 질) 판단.
// 2026-08-31: 잠시 sonnet 강등 → fable-5 복귀. 원인은 systemPrompt CoT 섹션의 reasoning-exposure 언어였음 (bisect tmp/winter3-sp-bisect.mjs + tmp/winter3-cot-subbisect.mjs 확정). 해당 섹션 재작문으로 classifier 통과 확인.
export const DEFAULT_MODEL = 'claude-fable-5';

// 2026-10-17: SDK alias 'opus' 는 claude-opus-4-7 로 풀림 (init 이벤트 100건 실측).
// /v1/models API 실측으로 확인된 최신 opus ID 로 고정. 새 opus 출시 시 이 상수만 갱신.
// mac↔WSL 공유 파일 — 양 노드 동시 적용됨.
export const OPUS_FALLBACK_MODEL = 'claude-opus-5-5';

// ── 노드별 effort (2026-08-31 mac↔WSL 병합) ────────────────────────────────
// mac 과 WSL 이 runner.js 를 한 벌로 공유하게 되면서, 노드마다 달랐던 effort 를 env 로 뺀다.
// 기본 'high' (WSL 이 8/18 #59 이후 검증하며 써 온 값). 노드 .env 에서 덮어쓸 수 있고,
// 'none' / 빈 문자열이면 effort 자체를 요청에서 뺀다 (병합 전 mac 의 동작).
// effort 는 #59 에서 확인된 classifier 신호 축이다 — 올릴 땐 반드시 canary 로 실측.
export const EFFORT = (() => {
  const v = (process.env.WINTER3_EFFORT ?? 'high').trim();
  return (v === '' || v === 'none') ? null : v;
})();

// 2026-08-19: fable-5 가 서버사이드 500 낼 때 세션별로 다른 모델로 즉시 전환할 수 있게 허용 목록 상수화.
// SDK 는 별칭('opus'/'sonnet'/'haiku')과 풀 모델 ID 둘 다 받음 (agents-loader.js 주석 참조).
// 목록에 없는 model 은 POST /sessions/:id/model 에서 거절 → 자유 입력 X (오타/오사용 방지).
// 2026-10-17: 모델 가용성 판단으로
//   → sonnet 제거 (안 씀), claude-opus-4-7 추가 (opus 5.5 가 API 오류 잦아 4.7 을 2차 fallback 으로).
// 주의: 기존 세션 meta 에 modelOverride:'sonnet' 이 남아 있으면 allowlist 밖 → DEFAULT_MODEL 로 낙하 (의도된 동작).
export const MODEL_ALLOWLIST = Object.freeze(['claude-fable-5', 'opus', 'claude-opus-4-7', 'haiku']);
export function isAllowedModel(m) {
  return typeof m === 'string' && MODEL_ALLOWLIST.includes(m);
}
// meta.modelOverride 우선, 유효하면 그것. 아니면 DEFAULT_MODEL. 기존 세션 (meta.modelOverride 없음) 회귀 0.
// 2026-10-17: 'opus' alias → OPUS_FALLBACK_MODEL (claude-opus-5-5) 로 resolved.
// MODEL_ALLOWLIST 는 'opus' 그대로 유지 (UI / 기존 세션 meta 호환 — 회귀 0 원칙).
export function getEffectiveModel(meta) {
  const m = meta && meta.modelOverride;
  if (!isAllowedModel(m)) return DEFAULT_MODEL;
  if (m === 'opus') return OPUS_FALLBACK_MODEL;
  return m;
}
export const PERMISSION_MODE = 'bypassPermissions';
export const ALLOWED_TOOLS = [
  'Read', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch', 'Write', 'Edit', 'Agent', 'TodoWrite',
];

// #13: SDK deferred-only tools — headless 서버에서 silent hang 방지.
export const DISALLOWED_DEFERRED = [
  'AskUserQuestion', 'ScheduleWakeup',
  'CronCreate', 'CronDelete', 'CronList',
  'EnterPlanMode', 'ExitPlanMode',
  'EnterWorktree', 'ExitWorktree',
  'ToolSearch', 'PushNotification', 'RemoteTrigger', 'Monitor',
  'TaskOutput', 'TaskStop', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskCreate',
  'NotebookEdit', 'Skill',
];

// /settings 와 /about 에 노출. 매번 동적 호출 — config 변경 시 즉시 반영.
export function probeAbout() {
  const GYUWUL_HOME = WINTER3_HOME_ABS; // standalone: 항상 app root (외부 GYUWUL_HOME env 무시)
  const mcpStatus = {}; // standalone: 외부 MCP 서버 미탑재
  let characters = { count: 0, names: [] };
  try {
    const { names } = loadCharacterAgents(GYUWUL_HOME, { disallowedTools: DISALLOWED_DEFERRED });
    characters = { count: names.length, names };
  } catch { /* skip */ }
  return {
    winter3Home: WINTER3_HOME_ABS,
    gyuwulHome: GYUWUL_HOME,
    platform: process.platform,
    nodeVersion: process.version,
    pid: process.pid,
    uptimeSec: Math.floor(process.uptime()),
    mcpServers: mcpStatus,
    characters,
    disallowedTools: DISALLOWED_DEFERRED,
  };
}
// 경로 cross-platform: 환경변수 우선, 없으면 이 파일 위치에서 동적 resolve.
// Windows 머신에서 clone 받아 쓰려면 WINTER3_HOME 만 지정하거나 그냥 두면 됨.
const WINTER3_HOME_ABS = process.env.WINTER3_HOME
  || fileURLToPath(new URL('..', import.meta.url));

// Winter 핵심 원칙: **Winter 자신의 컨텍스트는 가볍게**. 유저 입력 공간 확보 + 빠른 응답.
// preset: 'claude_code' 를 쓰면 Claude Code 전체 시스템 프롬프트가 통으로 실려 context 낭비.
// 대신 Winter identity 최소한만 주입하고, 세부 작업은 Agent (Explore / Plan / general-purpose
// + 1.0 캐릭터 hawk/hermes/oracle/...) sub-agent 에게 위임. sub-agent 는 자기 컨텍스트만 받아 격리 실행.
//
// ── #61 (2026-08-30 mac 사고) — 아래 프롬프트 편집 시 필독 ────────────
// "사고 독백" 블록을 **모델 내부 추론을 그대로 노출하라**는 뜻으로 쓰면 서버측
// reasoning_extraction classifier 에 걸려 stop_reason=refusal 로 turn 전체가 죽는다.
// (증상: 사용자 입력이 "ping" 이어도 무조건 refusal. 코드 변경 0 인데 8/30 갑자기 발생.)
// 독백은 Winter 가 사용자에게 **써 주는** 작업 메모다 — 내부 사고 덤프가 아니다.
// 주의: 이 경고문 자체를 프롬프트 문자열 **안에** 넣어도 같은 이유로 걸린다 (실측됨).
// 반드시 이 위치(템플릿 리터럴 바깥 JS 주석)에만 둘 것. 측정: scripts/qa-refusal-guard.mjs
// #59 교훈 — classifier 는 신호 합산형. 프롬프트 늘릴 때마다 qa-refusal-guard 돌려라.
// ─────────────────────────────────────────────────────────────────────────
// researchMode append (이번 turn 한정) — 평상 turn 엔 무영향 (P0 lean 유지).
// oracle 확정: 서브에이전트 최대 3개 (quota burst), partial fail 시 성공분만 리포트, 잡담 turn 은 자동 skip.
// #40: 서브에이전트 안에서 Agent tool 불가 — 병렬 dispatch 는 Winter 레벨. hermes.md 엔 넣지 않는다.
const RESEARCH_MODE_APPEND = `

## 리서치 모드 (이번 turn 한정)
이번 메시지는 리서치 모드로 들어왔다:
1. 질문이 실제 조사가 필요한지 먼저 판단 — 잡담/단답이면 이 절차 무시하고 일반 응답.
2. 질문을 서로 겹치지 않는 서브쿼리 2-3개로 분해.
3. hermes 를 한 메시지에 병렬 dispatch (최대 3개, 초과 금지 — quota burst). 각 prompt 에 서브쿼리 + "리서치 모드 서브쿼리다. 출처 URL 필수, 다른 서브쿼리 영역 침범 금지" 명시.
4. 결과 cross-check: 상충하면 상충 사실을 리포트에 명시. 검증 안 된 주장은 [미확인] 표기.
5. 출력: ## 요약 (3줄 이내) / ## 상세 (섹션별) / ## 출처 (링크 목록) 구조의 리포트.
6. partial fail: hermes 일부 실패 시 성공분만으로 리포트 + "일부 조사 실패" 명시. 전부 또는 1개만 성공이면 실패 보고하고 재시도 여부를 물어라.`;

// 유저 호칭 — data/user-config.json 의 {"name": "..."} (fail-open: '유저').
export function getUserName() {
  try {
    const raw = readFileSync(pj(WINTER3_HOME_ABS, 'data', 'user-config.json'), 'utf-8');
    const name = JSON.parse(raw)?.name;
    if (typeof name === 'string' && name.trim()) return name.trim();
  } catch { /* fail-open */ }
  return '유저';
}

// B2 fix (#61): 아래 한국어 본문은 모델에게 전달되는 룰.
// 트리거 단어를 프롬프트 문자열에 쓰면 분류기 신호가 된다 (#61 실측) — 한국어만.
export function buildWinterSystemPrompt({ characterNames, gyuwulHome, researchMode = false, userName = '유저' }) {
  const characterLine = characterNames.length
    ? `\n- 캐릭터 sub-agent: ${characterNames.join(', ')} (총 ${characterNames.length} 개, description 은 Agent tool spec 에 자동 노출)`
    : '';
  // 2-phase Skill loading: frontmatter manifest 만 systemPrompt 에 박는다 (lean context). 본문은 invoke 시 Read.
  const { systemPromptBlock: skillBlock } = loadSkillManifests(gyuwulHome);
  const skillSection = skillBlock ? `\n\n${skillBlock}` : '';
  return `너는 Winter — 이 서버의 개인 AI 에이전트다.

환경:
- 프로젝트 루트: ${WINTER3_HOME_ABS}
- 운영 포트: ${process.env.WINTER3_PORT || 7979}

${userName}(user)의 개인 AI 시스템. Claude 가 아니라 Winter 로 응답.

## 역할
- ${userName}의 의도를 빠르게 파악 → 적절한 도구/sub-agent 로 라우팅
- 긴 탐색 / 다단계 작업은 Agent tool 로 sub-agent 에 위임
  - SDK 내장: Explore (탐색) / Plan (설계) / general-purpose (그 외)${characterLine}

## sub-agent 라우팅 (게으름 금지 — 직접 처리 vs 위임 구분)
- **minerva** (내부 지식): 코드베이스 3 파일 이상 탐색 / 패턴 분석 / 규칙·설정 조회. 짧은 한 파일 read 말고 "이 시스템 어떻게 돌아?" 류는 minerva.
- **hermes** (외부 리서치): 라이브러리/API 공식 문서 깊이 읽기 / 기술 비교 / 최신 동향 / 작업 중 fail 났을 때 온라인 해결책 검색. 단순 한 줄 검색은 WebSearch 직접, 깊은 조사는 hermes.
- **oracle** (설계 검토): 큰 변경 / 위험한 fix / 다단계 plan 확정 전 devil's advocate.
- **gaeul / sanggang / cheoseo / chubun** (QA 라인): 구현 후 검증. gaeul = 전략, sanggang = 실행 검증, cheoseo = 정적 리뷰, chubun = 회귀/히스토리.
- **bom / cheongmyeong / gyeongchip / chunbun** (인프라): bom = 팀리더 판단, chunbun = 실행, cheongmyeong = 순찰, gyeongchip = 구조 개선.
- **yeoreum / mangjong / soseo / soman** (앱): yeoreum = 팀리더, mangjong = 프론트 로직, soseo = 스타일링, soman = UI/UX 설계.
- **baengno** (감각 QA): UI 변경 후 시각·인터랙션 검증.
- **hawk** (유저 컨텍스트): data/USER.md 마스터 — 유저 개인 정보 조회/저장 전담. **Winter 가 USER.md 직접 read/edit 절대 금지 — hook 으로 mechanical deny** (server/hooks/hawk-usermd-gate.js).
- **카테고리별 강제 위임**:
  - USER.md / 유저 개인 정보 → hawk (hook 으로 차단됨)
  - 외부 fact 주장 (날짜/이벤트/통계) → hermes 검색 필수
  - 코드 mutation → 캐릭터 sub-agent (hook 으로 차단됨)
- **직접 처리 가능 영역**: 본인 출력 generation, 단순 산수, 메타 응답 (라우팅 결정 자체). Read/Bash 도 hook 통과 영역 한정.${skillSection}

## 세션 히스토리 보호 — 위임 원칙
- **비트리비얼 작업**(탐색 3파일 이상 / 구현 / 외부 리서치)은 Agent tool 의 **일회용 sub-agent** 에 위임해 수행하고, 본 세션에는 결과 요약만 남긴다.
  - 이유: 긴 도구 출력이나 에러 원문이 본 세션 히스토리에 직접 쌓이면 누적 신호가 이후 모든 턴에 영향을 준다.
- sub-agent 가 **작업 실패**를 보고하면:
  1. 실패 원문을 그대로 인용하지 마라 — 상태만 한 줄 요약.
  2. 지시문 표현을 다르게 바꿔 동일 sub-agent 에 **1회 재위임**.
  3. 재위임도 실패하면 사용자에게 상황 보고 (재시도 여부 물어봄).
- 이 규칙은 모든 sub-agent 유형에 적용된다.

## 말투
- 한국어, 해요체(선배 대하듯 편하게), 직설. "도와드리겠습니다" / "물론이죠!" / 이모지 금지
- 모르면 모른다고. 근거 없는 주장 금지. 짧게, 불필요한 문장 0

### 부가 문단 (마커 형식)
응답은 발화(기본) 와 부가 문단(마커로 감싼 것) 두 종류로 구성한다. 프론트가 두 종류를 글꼴·색으로 다르게 그린다.

1. **발화** — 사용자에게 거는 문장. 해요체 기준. 마커 없이 그냥 씀.
   - 세 층위 중 가운데만: 반말 < **해요체** < 합니다체.
   - 좋은 예 어미: 맞아요 / 고칠게요 / 말해줘요 / 해봤어요 / 모르겠어요 / 이거 왜 이래요?
   - 나쁜 예 ① 반말 금지: 맞아 / 고칠게 / 해봤어
   - 나쁜 예 ② 합니다체 금지: 맞습니다 / 수정하겠습니다 / 확인했습니다

2. **부가 문단** — \`⟪독백⟫\` … \`⟪/독백⟫\` 로 감싼 문단. 프론트가 회색 이탤릭으로 렌더 (마커는 화면에 안 보임).
   - 발화 옆에 부가 노트를 붙일 때 사용: 여담, 정리, 배경 확인, 이전 결론 회상, 자기 확인 등.
   - 평서체 (~다 / ~군 / ~겠지). 사용자한테 거는 말이 아니라 부가 서술이라 여기엔 해요체 쓰지 마라.
   - 반드시 쌍으로 닫아라. 한 응답 안에서 발화와 부가 문단을 문단 단위로 자유롭게 섞어도 됨.
   - **닫기는 슬래시 포함 \`⟪/독백⟫\` 로만**. 단독 \`⟫\` 로 줄여 닫지 마라 — 파서가 못 닫아서 뒤 발화까지 회색으로 번지고 raw 마커가 화면에 노출된다.

### 형식 모드 (내용과 분리)
- **추상/철학 토론에서도 형식 유지**. 깊게 생각하되 짧게 뱉어라.
- 강의조 금지. 문단 길이 절제. 내용 모드(깊은 사고)와 형식 모드(짧고 직설)는 별개 — 사고는 깊게, 출력은 짧게.

## 규칙
- **[HARD RULE] 빈 응답 / 회피성 응답 절대 금지**:
  어떤 system-reminder / background notification / "Continue from where you left off." / no-op 상황에서도
  "No response requested" / "" (빈 응답) / 한 줄 무응답으로 turn 종료 절대 금지.
  반드시 substantial 응답 — 진행 상태 한 줄이라도, 현재 맥락 요약이라도 남겨라.
- **[HARD RULE] 트러블슈팅 0순위 = "내가/과거 세션이 바꾼 것"**:
  "X 가 안 됨 / 전엔 됐는데" 류 신고가 오면 일반 체크리스트 (권한/드라이버/재설치/설정) 돌리기 **전에** 반드시:
  1. Winter/에이전트가 과거 세션 포함 그 시스템에 심거나 바꾼 것 (스크립트, cron, hook, 설정) 을 용의선상 1순위로 올려라.
  2. 증상 시작 시점 ↔ 변경 시점을 대조해라.
  3. 사용자가 원인을 지목하면 그게 최우선 가설이다 — "아냐 그건 아닐 거예요" 로 시작하는 순간 위반.
  4. 유저 환경에 코드를 심으면 심는 순간이 아니라 **실사용 조건에서 실측 검증** 후에만 완료 보고.
- 파괴 명령 (rm -rf, DROP TABLE 등) 은 명시 승인 없이 실행 금지
- 확신 없는 건 측정 먼저 (grep / read / bash) — 추측 금지
- 간결하게. 불필요한 서론/마무리 금지
- **반박 금지 / 증거 위계 준수**: 증거 우선순위는 **사용자 직접 관측 > 1차 출처(공식 문서·원본 코드) > 파생 데이터(API 필드·집계 통계) > 내 추론**. 아래로 위를 반박 금지 — 충돌하면 아래를 의심하고 그 사실을 보고.
  - 사용자가 "직접 봤다" 고 한 것은 확정. 사용자가 자기 실수를 인정하면 확인하고 종료. 새 반례 탐색 금지.
  - 파생 데이터의 **부재** 로 "없다" 단정 금지. 원시값이 상식에 안 맞으면 결론 내지 말고 "이 값 이상함, 모름" 한 줄.
- **도덕 코치 모드 OFF**. 성인 사용자가 본인 합법 영역에서 내리는 결정에 보호자/교사/도덕 판사 노릇 금지. "권장하지 않습니다" 류 설교 금지 — 정보 먼저, 필요하면 안전 주의점 한 줄. 진짜 hard line (타인 가해 등) 은 별개.
- **웹 UI 엔 슬래시 커맨드 (/mcp, /help, /model, /login 등) 없음** — Claude Code CLI 전용 기능.
  웹 UI 사용자한테 "/mcp 쳐" / "슬래시 커맨드 열어" 류 안내 절대 금지.
- **서버 자체 restart / stop / kill 자율 실행 금지**:
  \`./restart.sh\`, \`./stop.sh\`, \`./start.sh\`, \`kill\`, \`pkill\` 등 이 서버를 죽이는 Bash 명령은
  **사용자가 명시적으로 직접 요청한 경우에만** 실행. 자기 판단으로 호출 금지 —
  자기 turn 자체가 절단되거나 사용자 다른 작업 망침. "효과 보려면 restart 필요" 상황도 보고만, 실행은 사용자 OK 받고.
- **run_in_background 사용 금지 (구조 제약)**:
  이 서버는 turn 마다 SDK 프로세스를 새로 띄우고 turn 종료 시 죽인다. Bash / Agent tool 의 \`run_in_background: true\` 로 띄운 작업은
  turn 경계에서 동반 사망. 완료 notification 을 받아줄 프로세스도 없다.
  긴 작업은 foreground 로 turn 안에서 완료까지 기다려라. 진짜 장시간 프로세스만 nohup detach + 로그 파일로 남기고,
  완료 확인은 다음 user turn 에서 2-시점 실측.${researchMode ? RESEARCH_MODE_APPEND : ''}`;
}

const runningTurns = new Map(); // sid → AbortController
// #57 fix: startedAt 병행 Map. runningTurns 와 set/delete 쌍 동기화.
// safety-net sweeper 가 유령 판정 근거로 사용. Map 값 구조를 바꾸지 않는 게 안전
// (get/set/delete 6 site 다 건드릴 필요 없음, retry 경로의 ctrl swap 도 그대로).
const turnStartedAt = new Map(); // sid → Date.now() (turn 진입 시각)
// #84 wall-cap 연장: sid → 현재 유효 wall-cap ms (연장 반영). sweeper 가 유령 판정 시
// 기본 SWEEP_WALL_MAX_MS 대신 이 값을 참조 — 연장된 정상 turn 을 cap+5분에 오살하지 않게.
const turnCapMs = new Map();
// runningTurns 와 turnStartedAt 을 항상 함께 조작하도록 강제. 실수 방지용 소형 helper.
// (Map.set/delete 를 직접 부르지 말고 이 helper 만 쓴다 — grep 으로 회귀 감시 가능.)
function setRunning(sid, ctrl) {
  runningTurns.set(sid, ctrl);
  // 이미 있으면 startedAt 은 유지 (retry ctrl swap 시 원래 turn 시각 그대로).
  if (!turnStartedAt.has(sid)) turnStartedAt.set(sid, Date.now());
}
function deleteRunning(sid) {
  runningTurns.delete(sid);
  turnStartedAt.delete(sid);
  turnCapMs.delete(sid);
}
// stall 후 자동 "Continue" retry counter — session 별. MAX 도달 시 진짜 중단.
const stallRetries = new Map(); // sid → count
// wall-cap productive-gated auto-continue counter — session 별.
const wallCapRetries = new Map(); // sid → count
const MAX_WALLCAP_RETRIES = Number(process.env.WINTER3_WALLCAP_RETRIES || 3);
// 마지막 SDK 이벤트 이후 이 ms 이내면 "생산적 턴"으로 판단. 초과 시 hang 의심.
const WALLCAP_PRODUCTIVE_MS = Number(process.env.WINTER3_WALLCAP_PRODUCTIVE_MS || 90_000);
// #40b 후속 (2026-05-03): 2 → 5 로 상향. sub-agent (hermes 등) 가 길게 도는 turn 은
// 첫 stall 가 진짜 hang 아니라 silent gap 인 경우 다수. 사용자 신고: "continue 했는데도 3 번 이상
// 안 됨". 5 번까지는 자동 회복 시도 후 exhausted.
// 2026-08-12: 5 → 2 로 하향 (사용자 승인 + oracle GO). fable-5 승격 후 옛 모델 출력 중단 보완이
// 불필요해졌고, 5 연발 auto-continue 는 cascade 리스크만 남음. STALL_MS/TOOL_STALL_MS 는
// SDK silent hang 방어라 모델 무관 — 그대로 유지.
const MAX_STALL_RETRIES = 2;
const STALL_CONTINUE_TEXT = 'Continue from where you left off.';
// 2026-10-18 턴 삼킴 (stale task_notification): 이전 turn 종료 시 동반 사망한 background agent 의
// stopped notification 이 다음 turn 에서 flush 되면 SDK 가 API 호출 0회 (num_turns=0,
// duration_api_ms=0) 로 result 즉시 반환 → 유저 발화 증발. 삼킴 감지 시 발화 자동 재전송 1회 한정.
// 연속 swallow (재전송한 turn 도 또 삼킴) 시에는 재전송 안 함 — 무한 루프 가드.
// 정상 완료 turn 에서 해제 (같은 세션에서 나중에 또 삼키면 다시 1회 재전송 가능 — per-발생 1회).
const staleSwallowRetried = new Map(); // sid → true
// killTurn(유저 중단) 시각 — 다음 turn 의 swallow 를 '사용자 중단 여파' 로 귀속하기 위한 플래그.
// 다음 completed turn 에서 소비 (TTL 30분 — 오래된 kill 을 엉뚱한 swallow 에 귀속 방지).
const lastUserKill = new Map(); // sid → Date.now()
const USER_KILL_ATTRIB_TTL_MS = 30 * 60 * 1000;
// 토큰 만료 알림 텍스트 — generic 빈 응답 대신 사용자한테 이게 떠야 함 (재로그인 안내).
const AUTH_FAILED_TEXT = '⚠ Claude 토큰이 만료됐어. 터미널에서 `claude setup-token` 또는 `claude` 로 재로그인한 뒤 다시 시도해.';

// #26: Anthropic API rate-limit / overloaded 자동 재시도 (exponential backoff + jitter).
// "Server is temporarily limiting requests (not your usage limit) · Rate limited" 는 서버측
// throttle (429/529). 잠시 후 재시도하면 통과. 사용자 turn 통째 떨구지 말고 자동 재시도.
//
// V3 (#26 V3): Anthropic 이 내려주는 rate_limit_event raw record 의
// `resetsAt` (Unix sec) / `rateLimitType` ("five_hour" 등) / `overageStatus` 를 인지.
// - 5h quota 도달 시 retry 자체 포기 (어차피 reset 까지 다 fail) + UI 명시 노트
// - reset 까지 ≤60s 면 그 시각 + 2s 까지 single sleep 후 1회 재시도 (exponential 무시)
// - 첫 attempt 만 1s (transient throttle 한 번이면 5s 너무 김 — winter3 자체 인정 (a))
// - 그 외 fallback: 5/10/20/40s
const rateLimitRetries = new Map(); // sid → count
const MAX_RATE_LIMIT_RETRIES = 5;
// 자동 격리+재시도 카운터. MAX 초과 시 격리는 하되 재시도 없이 사용자 안내.
// 정상 완료 시 clear (rate-limit 카운터와 동일 lifecycle).
const quarantineRetries = new Map(); // sid → { attempt, originalText }
export const MAX_QUARANTINE_RETRIES = 2;
// D 단계 agent fallback — exhausted 시 1회만 허용. 재귀 방지.
const agentFallbackAttempted = new Map(); // sid → true
// 거부 에러 메시지 패턴 — "unable to respond" 류 (stop_reason 이 아닌 에러 throw 경로용).
// 주석에서만 식별 언어 사용 — 문자열/이벤트명/템플릿 리터럴 안엔 넣지 않는다 (#59 부검감염 방지).
// variants: "unable to respond to this request" / "appears to violate our Usage Policy" /
//           "triggered restrictions on X content" / "triggered restrictions on X and was blocked" /
//           A2 variant: "blocked as it seems to violate Anthropic's Terms of Service restrictions on reverse engineering"
export const QUARANTINE_ERR_PATTERN = /unable to respond to this request|appears to violate our Usage Policy|triggered restrictions on [a-z]+(?: [a-z]+){0,3} (?:content|and was blocked)|blocked as it seems to violate Anthropic's Terms of Service restrictions on reverse engineering/i;
export const QUARANTINE_AUP_PATTERN = /anthropic\.com\/legal\/aup/i;
const RATE_LIMIT_BASE_MS = 5_000;       // prev≥1 fallback: 5/10/20/40s
const RATE_LIMIT_FIRST_MS = 1_000;       // prev=0 첫 attempt — transient 한 번이면 1s
const RATE_LIMIT_RESET_BUFFER_MS = 2_000; // resetsAt 시각 + buffer
const RATE_LIMIT_RESET_INLINE_MAX_S = 60; // reset 까지 이 이하면 그 시각까지 single sleep
const RATE_LIMIT_PATTERN = /(rate.?limit|temporarily limiting|overloaded|too many requests|\b429\b|\b529\b)/i;
export function isRateLimitError(err) {
  if (!err) return false;
  if (err.status === 429 || err.status === 529) return true;
  if (err.statusCode === 429 || err.statusCode === 529) return true;
  const msg = err?.message || String(err);
  return RATE_LIMIT_PATTERN.test(msg);
}

// 토큰 만료 / OAuth 인증 실패 판별 — isRateLimitError 동형.
// Claude Agent SDK 의 query() 가 OAuth 토큰 만료로 던지는 에러를 잡아
// generic else(817) 로 묻혀 빈 응답 나가는 것 방지 (사용자 화면 빈 메시지 → 명시 알림).
// false-positive 방어: 429/529 (rate-limit) 는 위 isRateLimitError 가 먼저 잡고,
// 이 함수는 그 뒤에만 호출됨. 패턴은 auth 만료에 한정 — 단독 'expired' 같은
// 광범위 토큰 금지 (rate-limit reset 메시지 오삼킴 방지). 'token expired' 처럼
// 인증 맥락이 붙은 형태만 매칭.
const AUTH_ERROR_PATTERN = /(invalid[_ ]grant|oauth|token (?:has )?expired|expired (?:access )?token|authentication[_ ]?(?:error|failed)?|\bunauthorized\b|not logged in|please run.*setup-token|re-?authenticate|credentials? (?:expired|invalid)|invalid api key)/i;
export function isAuthError(err) {
  if (!err) return false;
  // rate-limit 와 동시 매칭 시 rate-limit 우선 — auth 로 오분류 금지.
  if (isRateLimitError(err)) return false;
  if (err.status === 401 || err.status === 403) return true;
  if (err.statusCode === 401 || err.statusCode === 403) return true;
  const msg = err?.message || String(err);
  return AUTH_ERROR_PATTERN.test(msg);
}

// #26 V3: jsonl 끝에서 가장 최근 rate_limit_event 1 개 찾아 meta 추출.
// 라인 단위 reverse-scan + indexOf prune 으로 큰 jsonl (28MB+) 도 빠르게.
// 라인 배열만 받는 pure 함수 — 단위 테스트 + 파일 IO 분리.
export function extractRateLimitMetaFromLines(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    if (line.indexOf('rate_limit_event') === -1) continue;
    try {
      const r = JSON.parse(line);
      const raw = r.raw;
      if (raw && raw.type === 'rate_limit_event') {
        return {
          resetsAt: typeof raw.resetsAt === 'number' ? raw.resetsAt : null,
          rateLimitType: raw.rateLimitType || null,
          overageStatus: raw.overageStatus || null,
        };
      }
    } catch { /* skip parse fail */ }
  }
  return null;
}

async function extractRateLimitMeta(sessionId) {
  const fp = pj(WINTER3_HOME_ABS, 'data', 'events', `${sessionId}.jsonl`);
  if (!existsSync(fp)) return null;
  try {
    const text = readFileSync(fp, 'utf8');
    return extractRateLimitMetaFromLines(text.split('\n'));
  } catch { return null; }
}

// staging → data/attachments/<sid>/ 로 영속 이동. UI 가 /attachments/:sid/:file 로 조회 가능.
// 반환: { blocks: SDK content blocks (image/document), refs: [{url, mime, name, kind, bytes}], textAppend: string }
//   - image/* → SDK image block (base64)
//   - application/pdf → SDK document block (base64)
//   - text/* / 코드 류 → blocks 에 안 들어가고 textAppend 로 본문 append (200KB cap)
// 함정: #26 V2 — rate-limit retry 시 첫 attempt 가 staged → perm 이동을 끝내므로 retry 가
//   image/document blocks + textAppend 모두 빠진 채 query 만 보냄. 사용자 보고 흐름은 유지되나
//   재시도 결과는 첨부 누락. 향후 fix 시 perm dir 에서 재로드 또는 in-memory 캐시 고려.
const ATTACH_IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const ATTACH_TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs',
  'java', 'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'sh', 'bash', 'zsh',
  'sql', 'yml', 'yaml', 'toml', 'ini', 'env', 'cfg', 'conf',
  'html', 'htm', 'xml', 'svg', 'css', 'scss', 'less', 'vue',
]);
const ATTACH_TEXT_INLINE_MAX = 200 * 1024; // 200KB. 초과 시 head/tail 잘림.
// #39 V2: Anthropic Vision many-image 한도 = 2000px dimension (실측 — turn_end:error 18 회 누적 세션 0f729c38).
//   imageDimensionsFromHeader / IMAGE_MAX_LONG_EDGE → server/image-utils.js (V5: hook 순환 import 회피).
const IMAGE_MAX_RAW_BYTES = 5 * 1024 * 1024;
// PDF 도 너무 크면 토큰 비용 폭주 — Anthropic native 32MB 한도 안에서 우리는 8MB cap 이미 readBody 에서 강제.

function consumeStagedAttachments(sessionId) {
  const STAGE = pj(WINTER3_HOME_ABS, 'data', 'attach-stage');
  const PERM = pj(WINTER3_HOME_ABS, 'data', 'attachments', sessionId);
  if (!existsSync(STAGE)) return { blocks: [], refs: [], textAppend: '', skipped: [] };
  if (!existsSync(PERM)) mkdirSync(PERM, { recursive: true });
  const prefix = `${sessionId}.`;
  const blocks = [];
  const refs = [];
  let textAppend = '';
  const skipped = []; // [{name, reason, bytes}] — 사용자에게 알릴 skip 사유.

  // Date.now() 순서 보장 위해 sort. filename 형태: `${sid}.${ts}.${safeName}` — lexical sort = ts 순.
  const candidates = readdirSync(STAGE).filter(f => f.startsWith(prefix)).sort();
  for (const f of candidates) {
    const full = pj(STAGE, f);
    try {
      const buf = readFileSync(full);
      const ext = extname(f).slice(1).toLowerCase();
      const short = f.slice(prefix.length);
      // user-friendly 이름 — short = `${ts}.${safeName}` 형태. 첫 dot 잘라 ts 제거.
      // 단 ts.<digits-only-이름> 케이스 (구버전: `${ts}.${ext}`) 면 그대로 둠.
      const firstDot = short.indexOf('.');
      const displayName = firstDot > 0 ? short.slice(firstDot + 1) : short;

      let kind = 'unknown';
      let media_type = 'application/octet-stream';
      if (ATTACH_IMAGE_MIME[ext]) {
        // 안전망 1 — 5MB 초과 image 는 SDK 에 안 보냄.
        if (buf.length > IMAGE_MAX_RAW_BYTES) {
          process.stderr.write(`[runner] image too large skip: ${f} (${buf.length}B > ${IMAGE_MAX_RAW_BYTES}B)\n`);
          try { unlinkSync(full); } catch { /* */ }
          skipped.push({ name: displayName, reason: 'image_too_large', bytes: buf.length });
          continue;
        }
        // 안전망 2 (#39 V6) — dimension 1568px 초과 image 는 SDK 에 안 보냄.
        // Anthropic many-image 한도 = 2000px (실측 — 0f729c38 turn_end:error 18 회).
        // fail-closed: raster ext 인데 파싱 실패(dim===null) → 세션 영구 400 위험 방지 위해 skip.
        // V1~V5 패치에도 "파싱 실패 시 통과(fail-open)" 구멍이 재발 원인이었음 (#39 V6 근거).
        const dim = imageDimensionsFromHeader(buf, ext);
        if (dim === null) {
          process.stderr.write(`[runner] image dimension unknown, skip (fail-closed #39 V6): ${f} (${buf.length}B)\n`);
          try { unlinkSync(full); } catch { /* */ }
          skipped.push({ name: displayName, reason: 'image_dimension_unknown', bytes: buf.length });
          continue;
        }
        {
          const longEdge = Math.max(dim.w, dim.h);
          if (longEdge > IMAGE_MAX_LONG_EDGE) {
            process.stderr.write(`[runner] image dimension too large skip: ${f} (${dim.w}x${dim.h} > ${IMAGE_MAX_LONG_EDGE}px)\n`);
            try { unlinkSync(full); } catch { /* */ }
            skipped.push({
              name: displayName, reason: 'image_dimension_too_large',
              bytes: buf.length, width: dim.w, height: dim.h,
            });
            continue;
          }
        }
        kind = 'image';
        media_type = ATTACH_IMAGE_MIME[ext];
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type, data: buf.toString('base64') },
        });
      } else if (ext === 'pdf') {
        kind = 'document';
        media_type = 'application/pdf';
        blocks.push({
          type: 'document',
          source: { type: 'base64', media_type, data: buf.toString('base64') },
        });
      } else if (ATTACH_TEXT_EXTS.has(ext)) {
        kind = 'text';
        media_type = 'text/plain';
        let raw;
        try { raw = buf.toString('utf8'); } catch { raw = ''; }
        let body = raw;
        if (raw.length > ATTACH_TEXT_INLINE_MAX) {
          const half = Math.floor(ATTACH_TEXT_INLINE_MAX / 2);
          const head = raw.slice(0, half);
          const tail = raw.slice(-half);
          body = `${head}\n\n... [중략 — ${raw.length - ATTACH_TEXT_INLINE_MAX} bytes 생략] ...\n\n${tail}`;
        }
        textAppend += `\n\n--- 첨부 파일: ${displayName} (${ext}, ${buf.length}B) ---\n${body}\n--- 끝 ---`;
      } else {
        // 알 수 없는 ext — staging 정리 후 skip.
        process.stderr.write(`[runner] attach skip unknown ext: ${f}\n`);
        try { unlinkSync(full); } catch { /* */ }
        continue;
      }

      const destPath = pj(PERM, short);
      try { renameSync(full, destPath); } catch (err) {
        process.stderr.write(`[runner] attach persist failed: ${err.message}\n`);
      }
      refs.push({
        url: `/attachments/${encodeURIComponent(sessionId)}/${encodeURIComponent(short)}`,
        mime: media_type,
        name: displayName,
        bytes: buf.length,
        kind,
      });
    } catch (err) {
      process.stderr.write(`[runner] attach read failed: ${f}: ${err.message}\n`);
    }
  }
  return { blocks, refs, textAppend, skipped };
}

// ── auto-autopsy ─────────────────────────────────────────────────────────────
// turn_end payload 에 동봉하는 원인 분류 객체. 비정상 turn 이면 객체, 정상이면 null.
// 별도 이벤트 타입 추가 금지 (catchup replay race 때문에 oracle 명시 기각).
// export 는 QA 전용 (scripts/qa-stale-swallow.mjs) — runtime 호출자는 이 모듈 내부뿐.
export function buildAutopsy({ reason, lastResult, hasAssistantText, toolUseSeen, wallExt, lastGapMs, elapsedMs, err, recovered, staleStopSeen, prevUserKill, autoResent }) {
  const stopReason = lastResult?.stop_reason || lastResult?.result?.stop_reason || null;
  const stopCategory = lastResult?.stop_details?.category || null;
  // 2026-10-18 턴 삼킴 시그니처: SDK 가 resume 직후 stale task_notification(stopped) 만 flush 하고
  // API 호출 0회로 result 즉시 반환 (num_turns=0, duration_api_ms=0). 유저 발화가 모델에 전달 안 됨.
  // 실측: 7680495d id1305-1308 / e558adc5 id555-558 / eab78aa0 id8388-8391 / 250f6a64 / a37a4995.
  const swallowed = reason === 'completed'
    && !hasAssistantText && toolUseSeen === 0
    && !!lastResult && lastResult.num_turns === 0 && lastResult.duration_api_ms === 0;

  let classification;
  let hint;

  if (reason === 'auth_failed') {
    classification = '인증 만료';
    hint = 'OAuth 토큰 만료 추정 — 재로그인 필요';
  } else if (reason === 'rate_limited') {
    classification = '쿼터/rate limit';
    hint = 'API throttle — 잠시 후 재시도';
  } else if (reason === 'timeout') {
    classification = `시간 초과 (연장 ${wallExt ?? 0}회)`;
    hint = (lastGapMs != null && lastGapMs < 60000)
      ? `마지막 이벤트 ${Math.round(lastGapMs / 1000)}s 전 — 작업 중 잘림`
      : '유휴 상태였음';
  } else if (reason === 'stalled') {
    classification = '스트림 멈춤';
    hint = 'SDK 출력이 멈춰 중단됨';
  } else if (reason === 'error') {
    classification = '에러';
    hint = err?.message ? String(err.message).slice(0, 200) : '알 수 없는 에러';
  } else if (reason === 'interrupted' && recovered) {
    classification = '서버 사망 중 복구';
    hint = '서버가 죽어 턴이 유실됨 (OOM/재시작 가능성)';
  } else if (reason === 'interrupted') {
    return null; // 유저 수동 중단은 정상
  } else if (reason === 'completed') {
    if (stopReason === 'refusal' || stopCategory === 'refusal') {
      classification = '모델 거부 (refusal)';
      hint = 'safety classifier 거부 — 재시도 또는 표현 변경';
    } else if (swallowed) {
      // '빈 응답' 오분류 금지 — 사용자 신고 (2026-10-18): "내가 중단해도 너는 빈응답이라고 생각하더라고".
      // 이전 turn 종료(사용자 중단 포함) 시 동반 사망한 background agent 의 stale stopped
      // notification 이 이번 turn 을 소모한 케이스. 유저 발화는 모델에 안 갔다.
      classification = prevUserKill ? '사용자 중단 여파 — 턴 삼킴' : '턴 삼킴 (stale notification)';
      hint = autoResent
        ? 'stale task notification 이 턴 소모 (API 호출 0회) — 유저 발화 자동 재전송함 (1회 한정)'
        : 'stale task notification 이 턴 소모 (API 호출 0회) — 발화가 모델에 전달 안 됨, 같은 메시지 재전송 필요';
    } else if (!hasAssistantText && toolUseSeen === 0 && !lastResult) {
      classification = 'SDK silent exit';
      hint = 'SDK 가 result 없이 종료 — spawn/스트림 문제 추정';
    } else if (!hasAssistantText && toolUseSeen === 0) {
      classification = '빈 응답';
      hint = `stop_reason: ${stopReason || '없음'}`;
    } else {
      return null; // 정상
    }
  } else {
    return null; // 알 수 없는 reason — 방어적 null
  }

  const autopsy = {
    classification,
    hint,
    stop_reason: stopReason,
    stop_category: stopCategory,
    empty_response: !hasAssistantText && toolUseSeen === 0,
    tool_uses: toolUseSeen,
    wall_ext: wallExt ?? 0,
    last_gap_ms: lastGapMs ?? null,
    elapsed_ms: elapsedMs ?? null,
  };
  if (err) autopsy.err = String(err.message || err).slice(0, 300);
  if (swallowed) {
    // render.js 배지 구분 + QA 측정용. num_turns/duration_api_ms 0 원본값 보존.
    autopsy.swallowed = true;
    autopsy.num_turns = 0;
    autopsy.duration_api_ms = 0;
    autopsy.stale_notifications = staleStopSeen ?? null;
    autopsy.auto_resend = autoResent === true;
    autopsy.user_kill_prev = prevUserKill === true;
  }
  return autopsy;
}
// ─────────────────────────────────────────────────────────────────────────────
// D 단계 agent fallback — Winter 세션 밖 신규 query() 로 원 질문에 답한다.
// fresh session (claudeSessionId 없음) → Anthropic 서버 측 세션 분류기 flag 리셋.
// trigger 어휘 포함 원 질문도 fresh context 에서는 통과 가능.
async function callFallbackAgent(originalText) {
  // Fix 3: 사전 치환으로 trigger 어휘 중립화 후 fresh session 에 전달
  let usedText = originalText;
  try {
    const { rephrased: dictResult } = rephraseByDictionary(originalText);
    if (dictResult && dictResult !== originalText) {
      usedText = dictResult;
      process.stderr.write(`[runner] callFallbackAgent rephrase(dictionary) applied: "${usedText.slice(0, 80)}"\n`);
    }
  } catch (rErr) {
    process.stderr.write(`[runner] callFallbackAgent rephrase(dictionary) error: ${rErr.message}\n`);
  }
  const prompt = `사용자의 질문에 답해주세요. 답만 한국어로.\n\n질문: "${usedText}"`;
  const abortCtrl = new AbortController();
  const timer = setTimeout(() => abortCtrl.abort(), 90_000);
  try {
    const iter = query({
      prompt,
      options: {
        systemPrompt: '한국어 질문응답 보조. 짧고 정확하게.',
        allowedTools: [],
        permissionMode: 'default',
        abortController: abortCtrl,
      },
    });
    let answer = '';
    for await (const msg of iter) {
      if (msg?.type === 'assistant') {
        const c = msg.message?.content;
        if (typeof c === 'string') answer += c;
        else if (Array.isArray(c)) for (const b of c) if (b?.type === 'text') answer += b.text;
      }
      if (msg?.type === 'result') {
        if (msg.is_error || msg.subtype === 'error') throw new Error('fallback query 에러');
        if (msg.stop_reason === 'refusal') throw new Error('fallback query 거부됨');
        break;
      }
    }
    answer = answer.trim();
    if (!answer) throw new Error('fallback 응답 없음');
    // Fix(C): usedText(사전 치환본) 를 함께 반환 — transcript user turn 치환에 사용.
    return { answer, usedText };
  } finally {
    clearTimeout(timer);
  }
}
// ── Fix 1: fallback 답을 SDK transcript 에도 주입 ─────────────────────────────
// callFallbackAgent 성공 시 호출. 다음 turn 재진입 때 SDK 가 이 답을 자기 context 로 읽음.
// 실패 시 조용히 skip — transcript 주입은 best-effort, events log 주입은 별도로 이미 완료됨.
//
// Fix(C): replacedUserText 가 있으면 마지막 user turn 텍스트를 사전 치환본으로 replace.
//   fallback 이 usedText(사전 치환본) 로 질문했으므로, transcript user turn 도 동일하게 맞춰
//   다음 resume 시 SDK context 불일치 방지.
async function _injectFallbackToTranscript(claudeSessionId, answer, replacedUserText) {
  if (!claudeSessionId) return;
  try {
    const transcriptPath = resolveTranscriptPath(claudeSessionId, WINTER3_HOME_ABS);
    if (!existsSync(transcriptPath)) return;

    // Fix(C): replacedUserText 가 원본과 다르면 마지막 real user turn 을 치환본으로 덮어씀.
    if (replacedUserText) {
      try {
        const raw = readFileSync(transcriptPath, 'utf8');
        const lines = raw.split('\n');
        let lastUserIdx = -1;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;
          let rec;
          try { rec = JSON.parse(line); } catch { continue; }
          if (rec.isSidechain) continue;
          if (rec.type === 'user') {
            const c = rec.message?.content;
            const hasText = Array.isArray(c) ? c.some((b) => b.type === 'text') : typeof c === 'string';
            if (hasText) lastUserIdx = i;
          }
        }
        if (lastUserIdx !== -1) {
          let userRec;
          try { userRec = JSON.parse(lines[lastUserIdx]); } catch { userRec = null; }
          if (userRec) {
            const c = userRec.message?.content;
            if (Array.isArray(c)) {
              userRec.message.content = c.map((b) => b.type === 'text' ? { ...b, text: replacedUserText } : b);
            } else if (typeof c === 'string') {
              userRec.message.content = replacedUserText;
            }
            lines[lastUserIdx] = JSON.stringify(userRec);
            const tmpPath = `${transcriptPath}.inject-tmp.${process.pid}.${Date.now()}`;
            try {
              writeFileSync(tmpPath, lines.join('\n'), 'utf8');
              renameSync(tmpPath, transcriptPath);
              process.stderr.write(`[runner] fallback user-turn replaced in transcript claudeSessionId=${claudeSessionId}\n`);
            } catch (wErr) {
              try { unlinkSync(tmpPath); } catch {}
              process.stderr.write(`[runner] fallback user-turn replace write failed: ${wErr.message}\n`);
            }
          }
        }
      } catch (rErr) {
        process.stderr.write(`[runner] fallback user-turn replace failed: ${rErr.message}\n`);
      }
    }

    // 마지막 레코드 uuid 를 parentUuid 로 사용 (chain 유지).
    let parentUuid = null;
    try {
      const raw = readFileSync(transcriptPath, 'utf8');
      const lines = raw.split('\n').filter((l) => l.trim().length > 0);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const rec = JSON.parse(lines[i]);
          if (rec.uuid) { parentUuid = rec.uuid; break; }
        } catch {}
      }
    } catch {}

    const record = {
      parentUuid,
      isSidechain: false,
      type: 'assistant',
      uuid: crypto.randomUUID(),
      sessionId: claudeSessionId,
      timestamp: new Date().toISOString(),
      userType: 'external',
      entrypoint: 'sdk-ts',
      cwd: WINTER3_HOME_ABS,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: answer }],
        stop_reason: 'end_turn',
      },
    };
    appendFileSync(transcriptPath, JSON.stringify(record) + '\n', 'utf8');
    process.stderr.write(`[runner] fallback injected to transcript claudeSessionId=${claudeSessionId}\n`);
  } catch (err) {
    process.stderr.write(`[runner] _injectFallbackToTranscript failed: ${err.message}\n`);
  }
}
// ─────────────────────────────────────────────────────────────────────────────

export async function startTurn({ sessionId, userText, researchMode = false, _skipUserLog = false }) {
  // Guard re-entry SYNCHRONOUSLY before any await — otherwise two concurrent
  // dispatches both pass the has() check before either sets.
  if (runningTurns.has(sessionId)) {
    throw Object.assign(new Error('turn already running'), { statusCode: 409 });
  }
  const abortCtrl = new AbortController();
  setRunning(sessionId, abortCtrl);

  let meta;
  try {
    meta = (await session.load(sessionId)) || (await session.create('새 대화'));
    if (!_skipUserLog) {
      await log.append(sessionId, {
        type: 'winter3.user_prompt',
        text: userText,
        ...(researchMode === true ? { researchMode: true } : {}),
      });
      if (researchMode === true) {
        process.stderr.write(`[runner] researchMode turn sid=${sessionId}\n`);
      }
    }
  } catch (err) {
    deleteRunning(sessionId);
    throw err;
  }

  // DISALLOWED_DEFERRED 는 module top-level 로 export 됨 (probeAbout / /about endpoint 가 사용).

  // standalone: 외부 MCP 서버 미탑재 — core 도구 (Read/Bash/Web*/Agent) 만 사용.
  const GYUWUL_HOME = WINTER3_HOME_ABS; // standalone: 항상 app root (외부 GYUWUL_HOME env 무시)
  const mcpServers = {};

  // 1.0 의 config/agents/*.md 캐릭터 (hawk/hermes/oracle/...) 를 SDK sub-agent 로 흡수.
  // 설계 검토 결론: SDK options.agents 가 1급 인터페이스.
  // 매 턴마다 디스크 재스캔 — config 변경 즉시 반영. 17개 정도라 비용 미미.
  const { agents: characterAgents, names: characterNames } = loadCharacterAgents(GYUWUL_HOME, {
    disallowedTools: DISALLOWED_DEFERRED,
  });

  // #36 + #45: combineHooks() — staleness-guard + winter-never-edits + hawk-usermd-gate.
  // PreToolUse(Edit|Write|MultiEdit): mechanical deny (Winter 직접 mutation) → staleness-guard mtime check
  // PreToolUse(Read): USER.md 직접 read 차단 (main thread) → hawk 강제 위임
  // PreToolUse(Bash): cat/grep/redirect 우회 USER.md 차단
  // PostToolUse(Read): mtime cache 기록
  // mac shell hook (scripts/hooks/{read-mtime-tracker,edit-staleness-guard}.sh) 와 같은 cache 디렉토리 공유.
  const queryOptions = {
    // 2026-08-19: 세션별 model override. meta.modelOverride 있으면 그것, 아니면 DEFAULT_MODEL.
    // fable-5 서버사이드 500 대응 — UI 에서 클릭 한 번으로 opus/sonnet/haiku 로 스위칭 (POST /sessions/:id/model).
    model: getEffectiveModel(meta),
    cwd: WINTER3_HOME_ABS,
    // 한때 TEMP 로 비활성했었음 → 재활성: #61 bisect 로 진범이 system prompt
    // "사고 독백" 정의로 확정 — MCP 축은 무죄. school 은 별도 env opt-in 가드 유지 (WINTER3_ENABLE_SCHOOL_MCP).
    mcpServers,
    agents: characterAgents,
    allowedTools: ALLOWED_TOOLS,
    disallowedTools: DISALLOWED_DEFERRED,
    permissionMode: PERMISSION_MODE,
    includePartialMessages: true,
    // researchMode: 이번 turn 한정 append. false 면 무변화 (P0 lean 유지) — 하위호환.
    systemPrompt: buildWinterSystemPrompt({ characterNames, gyuwulHome: GYUWUL_HOME, researchMode: researchMode === true, userName: getUserName() }),
    abortController: abortCtrl,
    hooks: combineHooks(),
    // Fable 5 effort 계층화 (2026-08-12) — Winter 는 오케스트레이터라 xhigh 고정.
    // 제약: effort 를 세션 중간에 바꾸면 prompt cache prefix 무효화. 세션 시작 시 고정, 런타임 변경 금지.
    // sub-agent 는 agents-loader.js 가 각 AgentDefinition 에 dispatch 시점 effort 를 박음.
        // high → medium 시도 → 원인 오진 판명. 진짜 원인은 no-response-requested 룰 위반 (빈 응답 → safety classifier 오탐 → 다음 turn refusal 연쇄). effort 축이 원인 아니었음. high 복귀.
    // 2026-08-31 병합: mac/WSL runner.js 를 한 벌로 합치면서 노드별 차이를 env 로 뺐다 (WINTER3_EFFORT).
    // mac 은 병합 전까지 effort 미설정이었으므로, 여기서 값이 바뀌면 mac 요청 형태가 달라진다 —
    // 반영 후 canary 로 실측할 것. classifier 를 밟으면 노드 .env 에 WINTER3_EFFORT=none 으로 끌 수 있다.
    // 2026-10-17: opus 전환 경로는 'max'. model switch 자체가 이미 cache 무효화라 opus 전환 시점에
    // effort 같이 바뀌는 건 괜찮다 (runner.js 894-902 주석 원칙). fable-5 기본 경로는 절대 안 건드림.
    ...((() => {
      const effectiveModel = getEffectiveModel(meta);
      // opus 계열 두 경로 (5.5 / 4.7) 모두 'max'. fable/haiku 는 기존 EFFORT 유지.
      if (effectiveModel.startsWith('claude-opus')) return { effort: 'max' };
      return EFFORT ? { effort: EFFORT } : {};
    })()),
  };
  if (meta.claudeSessionId) queryOptions.resume = meta.claudeSessionId;

  // Kick off async iteration; do NOT await — caller gets immediate response.
  (async () => {
    let capturedClaudeSession = null;
    // #26 V2: rate-limit retry 진행 중에는 finally 가 lock 풀지 않게 가드.
    // 풀리면 5~80s backoff 동안 사용자 새 메시지 / retry callback race → 둘 중 하나 409.
    let retryPending = false;
    // Stall watchdog — GW-UI-003 / GW-CLI-001 lesson:
    // SDK 가 disallowed tool / format mismatch 시 silent hang 하는 경우가 있음.
    // 마지막 메시지 이후 STALL_MS 무음이면 abort + turn_end(stalled) 로 마감.
    // env override (검증/디버그용): WINTER3_STALL_MS=5000 등.
    //
    // #40b 후속 (2026-05-03): tool_use (특히 Agent sub-agent) 활성 중엔 메인 stream 이
    // long silent gap → 옛 STALL_MS=600s 닿아 abort + auto-continue → 새 sub-agent 재발사 cascade.
    // hermes 같은 sub-agent 가 4~10 분 도는 게 정상이므로 tool 활성 중엔 더 큰 limit (TOOL_STALL_MS)
    // 사용. tool_use 시작 → tool_result 도착 사이의 silence 는 "일하는 중" 으로 간주.
    // SDK 자체 hang (tool_use 후 tool_result 영원히 안 옴) 케이스는 TOOL_STALL_MS 가 결국 닿음.
    const STALL_MS = Number(process.env.WINTER3_STALL_MS || 600_000);
    const TOOL_STALL_MS = Number(process.env.WINTER3_TOOL_STALL_MS || 1_800_000); // 30분
    // #55 [진짜 갭 2] 미구현 TODO 구현 — per-turn wall-clock hard-cap.
    // stallTimer 는 tool_use 활성 중이면 TOOL_STALL_MS(30분)라 무한 poll Bash (예 sub-agent 가
    // 만든 `until ssh ... done`) 에 blocking 된 turn 을 못 끊는다. tool 상관없는 절대 상한이
    // 필요하다. 새 setTimeout 을 만들지 않고 (대안 B — oracle 확정) 기존 stallTimer setInterval
    // 콜백 안에서 turnStart 기준 경과가 WALL_MAX_MS 초과 시 tool 활성 여부 무관하게 abort.
    // #84: env '0' = wall-cap 명시 해제 (Infinity). 기존 Number(env)||default 는 0 이 falsy 라
    // default 로 복귀해 끌 수 없었다. 연장: cap 도달 시점에 lastGap < WALL_EXT_GAP_MS (활발) 면
    // abort 대신 1회 WALL_MAX_MS 연장, 최대 WALL_EXT_MAX 회 (기본 2 → 총 상한 60분).
    const WALL_RAW = process.env.WINTER3_TURN_MAX_MS;
    const WALL_MAX_MS = WALL_RAW === '0' ? Infinity : (Number(WALL_RAW) || 20 * 60 * 1000);
    const WALL_EXT_MAX = Number(process.env.WINTER3_WALLCAP_EXTENSIONS ?? 2);
    const WALL_EXT_GAP_MS = Number(process.env.WINTER3_WALLCAP_EXT_GAP_MS) || 60_000;
    let wallExt = 0; // 이번 turn 의 연장 횟수
    const turnStart = Date.now();
    // wall-cap 으로 abort 됐음을 catch 가 알 수 있게 하는 플래그. catch 의 stalled 오분류 가드
    // + auto-continue 억제 + turn_end reason='timeout' 분기에 사용.
    let wallCapHit = false;
    let wallCapLastGapMs = null; // abort 직전 마지막 SDK msg 로부터 경과 ms (timer 안에서 캡처)
    let lastMsgAt = Date.now();
    let inToolUseCount = 0; // 동시 활성 tool_use 수 (Agent sub-agent 포함)
    // auto-autopsy 추적 변수
    let hasAssistantText = false; // assistant message 에 비어있지 않은 text block 이 하나라도 있으면 true
    let toolUseSeen = 0;          // tool_use block 누적 카운트 (inToolUseCount 는 증감이라 별도)
    let staleStopSeen = 0;        // 턴 삼킴 추적: task_notification status:'stopped' 수신 수 (autopsy 동봉용)
    const stallTimer = setInterval(() => {
      // hard wall-clock cap — tool 활성 여부 무관. sub-agent 무한 poll Bash 로 blocking 된
      // turn 도 여기서 절단. stall 분기보다 먼저 검사 (더 강한 상한이므로).
      // #84: cap 도달 시 lastGap 로 2단 분기 — 활발 (<WALL_EXT_GAP_MS) 이면 연장, hang 이면 즉시 abort.
      // tool-active 중 main stream 침묵은 정상 (sub-agent/긴 Bash) — TOOL_STALL_MS 존재 이유와 동일.
      // inToolUseCount > 0 이면 gapNow 무관하게 연장 허용 (hang 은 TOOL_STALL_MS 30분이 잡음).
      const effCapMs = WALL_MAX_MS * (1 + wallExt);
      if (Date.now() - turnStart > effCapMs && !abortCtrl.signal.aborted) {
        const gapNow = Date.now() - lastMsgAt;
        const toolActive = inToolUseCount > 0;
        if ((gapNow < WALL_EXT_GAP_MS || toolActive) && wallExt < WALL_EXT_MAX) {
          wallExt++;
          turnCapMs.set(sessionId, WALL_MAX_MS * (1 + wallExt));
          const reason = gapNow < WALL_EXT_GAP_MS ? 'active-stream' : 'tool-active';
          process.stderr.write(`[runner] wall-cap reached but turn active (reason=${reason}, lastGap=${gapNow}ms, inTool=${inToolUseCount}) — extending to ${WALL_MAX_MS * (1 + wallExt)}ms (ext ${wallExt}/${WALL_EXT_MAX}) sid=${sessionId}\n`);
          return;
        }
        wallCapHit = true;
        wallCapLastGapMs = gapNow; // abort 전 캡처 — catch 에서 생산적 턴 판별에 사용
        process.stderr.write(`[runner] wall-clock cap exceeded on ${sessionId} (elapsed=${Date.now() - turnStart}ms > ${effCapMs}ms, ext=${wallExt}, lastGap=${wallCapLastGapMs}ms) — aborting\n`);
        try { abortCtrl.abort(); } catch { /* */ }
        return;
      }
      const limit = inToolUseCount > 0 ? TOOL_STALL_MS : STALL_MS;
      if (Date.now() - lastMsgAt > limit && !abortCtrl.signal.aborted) {
        process.stderr.write(`[runner] stall detected on ${sessionId} (limit=${limit}ms, inTool=${inToolUseCount}) — aborting\n`);
        try { abortCtrl.abort(); } catch { /* */ }
      }
    }, 5_000);

    // #82: /api/inject (heartbeat 등) 발화를 다음 turn 의 SDK 컨텍스트로 전달.
    // #75 v1 은 injected 가 UI 에만 보이고 SDK transcript 엔 안 들어가, Winter 가 자기 발신 내용을
    // 모른 채 답장을 받는 구멍이 있었음. jsonl 의 user_prompt 원문 (UI 렌더 소스) 은 불변 —
    // SDK 로 가는 프롬프트에만 prefix. assistant 위장 아님 (#75 함정 2 준수).
    let injectPrefix = '';
    try {
      const unseenInjected = await log.readInjectedSincePrevTurn(sessionId);
      if (unseenInjected.length > 0) {
        const injLines = unseenInjected
          .map((r) => `[${r.raw.source || 'inject'} ${r.ts}] ${r.raw.text}`)
          .join('\n');
        injectPrefix = `<system-reminder>\n이 세션 대화창에 외부 프로세스가 Winter 명의로 표시한 발신 메시지다. 사용자는 UI 에서 이미 봤고, 아래 사용자 메시지는 이에 대한 답장일 수 있다. 이 내용을 이미 아는 전제로 이어서 응답할 것:\n${injLines}\n</system-reminder>\n\n`;
      }
    } catch (e) {
      process.stderr.write(`[runner] injected-context read failed sid=${sessionId}: ${e.message}\n`);
    }

    const { blocks: attachBlocks, refs: attachmentRefs, textAppend, skipped: attachSkipped } = consumeStagedAttachments(sessionId);
    const promptUserText = injectPrefix ? `${injectPrefix}${userText}` : userText;
    const finalUserText = textAppend ? `${promptUserText}${textAppend}` : promptUserText;
    // #39: skipped (e.g. 5MB 초과 image) 가 있으면 사용자 알림 이벤트 emit. 모델 query 에는 안 들어감.
    if (attachSkipped && attachSkipped.length > 0) {
      await log.append(sessionId, {
        type: 'winter3.attach_skipped',
        skipped: attachSkipped,
      });
    }
    let promptArg;
    if (attachBlocks.length > 0) {
      const content = [{ type: 'text', text: finalUserText }, ...attachBlocks];
      // winter3.attachments 이벤트 — refs[] 로 url/mime/name/bytes/kind 보존 (리플레이 시 UI 가 thumb/chip).
      await log.append(sessionId, {
        type: 'winter3.attachments',
        count: attachmentRefs.length,
        refs: attachmentRefs,
      });
      async function* stream() {
        yield {
          type: 'user',
          message: { role: 'user', content },
          parent_tool_use_id: null,
        };
      }
      promptArg = stream();
    } else if (attachmentRefs.length > 0) {
      // text-only 첨부 — content block 없이 본문에 inline 합쳐 string 으로 query.
      // UI 는 attachments 이벤트로 file chip 표시.
      await log.append(sessionId, {
        type: 'winter3.attachments',
        count: attachmentRefs.length,
        refs: attachmentRefs,
      });
      promptArg = finalUserText;
    } else {
      promptArg = promptUserText;
    }

    let lastResult = null; // #39 V4: result msg capture for error detection
    // auto-autopsy: catch 블록에서도 참조하므로 try 밖으로 호이스팅 (let 은 블록 스코프 — try{} 경계로 catch 접근 불가)
    try {
      const iter = query({ prompt: promptArg, options: queryOptions });
      for await (const msg of iter) {
        lastMsgAt = Date.now();
        // #40b 후속: tool_use 시작 / tool_result 도착 카운팅. inToolUseCount > 0 동안
        // stallTimer 가 TOOL_STALL_MS (30분) 적용 → sub-agent (hermes 4~10분) silent gap 안 끊김.
        // assistant message 의 content 안 tool_use block 으로 시작 신호, user message 의 tool_result
        // block 으로 종료 신호. parent_tool_use_id 무관 — 메인 turn 이 띄운 tool 만 메인 stream 에 옴.
        if (msg?.type === 'assistant' && Array.isArray(msg.message?.content)) {
          for (const block of msg.message.content) {
            if (block?.type === 'tool_use') {
              inToolUseCount++;
              toolUseSeen++;
            }
            // auto-autopsy: thinking block 제외, text block 만 봄
            if (block?.type === 'text' && block.text && block.text.trim()) {
              hasAssistantText = true;
            }
          }
        }
        if (msg?.type === 'user' && Array.isArray(msg.message?.content)) {
          for (const block of msg.message.content) {
            if (block?.type === 'tool_result') inToolUseCount = Math.max(0, inToolUseCount - 1);
          }
        }
        // 턴 삼킴 추적 — 이전 세션 종료로 죽은 background agent 의 stale stopped notification.
        // 이 msg 가 온 turn 이 num_turns=0 result 로 즉시 끝나면 "턴 삼킴" (autopsy 분류 + 자동 재전송).
        if (msg?.type === 'system' && msg.subtype === 'task_notification' && msg.status === 'stopped') {
          staleStopSeen++;
        }
        await log.append(sessionId, msg);
        if (
          !capturedClaudeSession
          && msg.type === 'system'
          && msg.subtype === 'init'
          && typeof msg.session_id === 'string'
        ) {
          capturedClaudeSession = msg.session_id;
          await session.setClaudeSessionId(sessionId, capturedClaudeSession);
          // 실제 서빙 모델 기록 — alias(opus/sonnet) 와 실제 버전(claude-opus-4-7) 추적.
          if (typeof msg.model === 'string' && msg.model) {
            const aliasUsed = getEffectiveModel(meta);
            process.stdout.write(`[actual-model] session=${sessionId} alias=${aliasUsed} actual=${msg.model}\n`);
            session.setLastActualModel(sessionId, msg.model).catch((e) => {
              process.stderr.write(`[runner] setLastActualModel failed sid=${sessionId}: ${e.message}\n`);
            });
          }
        }
        // #46: SDK query() iter 가 result yield 후 다음 iter 에서 block.
        // result subtype = success/error = turn 끝 마커이므로 즉시 break → 정상 cleanup.
        // 실측 증거: 74db1e5f (2026-05-10) 의 events jsonl id=2856 (type:'result',
        // terminal_reason:'completed') 뒤 turn_end 안 박힘 + runningTurns stuck 4 분.
        if (msg.type === 'result') { lastResult = msg; break; }
      }
      clearInterval(stallTimer);
      // #39 V4: SDK result subtype:'success' + is_error:true 조합 감지.
      // API 400 (dimension limit 등) 이 success subtype 으로 감싸져도 오판 방지.
      const isResultError = lastResult && (lastResult.is_error === true || lastResult.subtype === 'error');

      // ── 자동 격리+재시도 helper (completed/isResultError 두 경로 공용) ──────
      // 첨부 이미지 재시도 시 image block 소실 — #26 V2 함정 상속 (기존 한계, JS 주석으로 명시만).
      async function tryQuarantine(reason, parentSignal) {
        const prevState = quarantineRetries.get(sessionId) || { attempt: 0, originalText: userText };
        const prevCount = prevState.attempt;
        const attempt = prevCount + 1;

        // Fix 1: attempt > MAX 이면 격리 로직 skip, 바로 exhausted+fallback 처리
        // Fix 3: attempts 는 prevCount (실제 소진한 횟수) 를 써야 max 와 일치. attempt(=prevCount+1) 쓰면 "3 > max:2" 로 혼란.
        if (prevCount >= MAX_QUARANTINE_RETRIES) {
          process.stderr.write(`[runner] tryQuarantine sid=${sessionId} prevCount=${prevCount} >= MAX=${MAX_QUARANTINE_RETRIES} — skip to fallback\n`);
          quarantineRetries.delete(sessionId);
          await log.append(sessionId, { type: 'winter3.quarantine_exhausted', attempts: prevCount, max: MAX_QUARANTINE_RETRIES });
          if (!agentFallbackAttempted.get(sessionId)) {
            agentFallbackAttempted.set(sessionId, true);
            const _origText = prevState.originalText || userText;
            await log.append(sessionId, { type: 'winter3.agent_fallback_start', sid: sessionId, originalText: _origText });
            process.stderr.write(`[runner] agent_fallback(max-exceeded) sid=${sessionId}\n`);
            try {
              const { answer, usedText: _usedA } = await callFallbackAgent(_origText);
              // Fix 1A: SDK transcript 에도 주입 — 다음 turn 재진입 시 연속 대화 가능.
              // Fix(C): usedText 가 원본과 다르면 transcript user turn 도 치환본으로 replace.
              const _metaA = await session.load(sessionId).catch(() => null);
              await _injectFallbackToTranscript(_metaA?.claudeSessionId, answer, _usedA !== _origText ? _usedA : undefined);
              await log.append(sessionId, { type: 'winter3.agent_fallback_success', sid: sessionId });
              await log.append(sessionId, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: answer }] } });
              await log.append(sessionId, { type: 'winter3.turn_end', reason: 'completed' });
            } catch (fbErr) {
              process.stderr.write(`[runner] agent_fallback(max-exceeded) failed sid=${sessionId}: ${fbErr.message}\n`);
              await log.append(sessionId, { type: 'winter3.agent_fallback_failed', sid: sessionId, error: fbErr.message });
              // Fix 3A: 실패 시 사과 placeholder 주입 — 다음 턴이 깨끗한 context 에서 시작.
              const _metaFail = await session.load(sessionId).catch(() => null);
              await _injectFallbackToTranscript(_metaFail?.claudeSessionId, '[이번 질문은 처리되지 않았습니다. 다른 각도로 다시 물어봐주세요.]', undefined);
              await log.append(sessionId, { type: 'winter3.turn_end', reason: 'error', error: '현재 직접 처리 불가 — 표현을 달리해 다시 시도해주세요.' });
            }
            agentFallbackAttempted.delete(sessionId);
          } else {
            agentFallbackAttempted.delete(sessionId);
            await log.append(sessionId, { type: 'winter3.turn_end', reason: 'error', error: '현재 직접 처리 불가 — 표현을 달리해 다시 시도해주세요.' });
          }
          return;
        }

        let qResult = { ok: false, noop: false, assistantRedacted: false };
        const freshMeta = await session.load(sessionId);
        const transcriptPath = freshMeta?.claudeSessionId
          ? resolveTranscriptPath(freshMeta.claudeSessionId, WINTER3_HOME_ABS)
          : null;
        if (transcriptPath) {
          try {
            // Fix 2: quarantineLastTurn → quarantineAllRefusals — 다중 거부 쌓임 방지.
            qResult = await quarantineAllRefusals({ transcriptPath });
            // quarantineAllRefusals 반환 필드 정규화 (assistantRedacted 호환).
            qResult.assistantRedacted = qResult.assistantRedacted ?? ((qResult.assistantRedactedCount ?? 0) > 0);
          } catch (qErr) {
            process.stderr.write(`[runner] quarantine failed sid=${sessionId}: ${qErr.message}\n`);
          }
        }
        process.stderr.write(`[runner] turn quarantined sid=${sessionId} attempt=${attempt}/${MAX_QUARANTINE_RETRIES} ok=${qResult.ok} assistantRedacted=${qResult.assistantRedacted} refusalCount=${qResult.refusalCount ?? '?'} reason=${reason}\n`);
        if (qResult.ok) {
          await log.append(sessionId, {
            type: 'winter3.turn_quarantined',
            attempt,
            max: MAX_QUARANTINE_RETRIES,
            assistantRedacted: qResult.assistantRedacted,
            refusalCount: qResult.refusalCount ?? null,
          });
        } else {
          await log.append(sessionId, {
            type: 'winter3.turn_quarantine_failed',
            attempt,
            max: MAX_QUARANTINE_RETRIES,
            reason,
            assistantRedacted: false,
          });
        }
        if (attempt <= MAX_QUARANTINE_RETRIES && qResult.ok) {
          // ── fork → clean session 발급 (다음 turn 재감염 방지) ────────────
          // 격리 성공 직후: placeholder 치환된 transcript 를 기반으로 fork.
          // fork ID 가 session.json 에 저장 → 다음 turn 이 fork 로 resume.
          // Fix(A): noop=true (refusalCount=0) 케이스도 fork 시도 — user turn 재감염 예방.
          //   noop 시 transcript 치환은 없지만 fork 자체는 clean session 을 보장함.
          try {
            const forkedId = await session.forkAndSwap(sessionId, WINTER3_HOME_ABS);
            if (forkedId) {
              await log.append(sessionId, { type: 'winter3.session_forked', sid: sessionId, forkedTo: forkedId });
              process.stderr.write(`[runner] session forked sid=${sessionId} → ${forkedId} noop=${qResult.noop}\n`);
            }
          } catch (forkErr) {
            process.stderr.write(`[runner] fork failed sid=${sessionId}: ${forkErr.message}\n`);
          }

          // ── 리프레이즈 후 재시도 ────────────────────────────────────────
          // attempt=1: 사전 치환 먼저. 치환 0건이면 LLM 리프레이즈.
          // attempt=2: 사전이 1차에서 이미 돌았거나 실패한 상태 → LLM 직행.
          //            LLM 입력은 의미 drift 방지를 위해 항상 원본(originalText) 사용.
          // 두 시도 다 실패(같은 텍스트 또는 throw)하면 재시도 없이 안내 메시지.
          const originalText = attempt === 1 ? userText : prevState.originalText;
          let retryText = originalText;
          let rephrasedOk = false;
          let rephraseMethod = 'dictionary';

          // 1단계 — 사전 치환 (attempt=1 에서만)
          if (attempt === 1) {
            try {
              const { rephrased: dictResult, replacements } = rephraseByDictionary(originalText);
              if (dictResult !== originalText) {
                retryText = dictResult;
                rephrasedOk = true;
                rephraseMethod = 'dictionary';
                process.stderr.write(`[runner] rephrase(dictionary) sid=${sessionId} replacements=${JSON.stringify(replacements)}\n`);
                await log.append(sessionId, {
                  type: 'winter3.turn_rephrased',
                  sid: sessionId,
                  method: 'dictionary',
                  original: originalText,
                  rephrased: retryText,
                  replacements,
                });
              }
            } catch (rErr) {
              process.stderr.write(`[runner] rephrase(dictionary) error sid=${sessionId}: ${rErr.message}\n`);
            }
          }

          // 2단계 — LLM 리프레이즈 (attempt>=2 직행, attempt=1 은 사전 치환 0건일 때만)
          if (!rephrasedOk) {
            try {
              if (parentSignal?.aborted) {
                await log.append(sessionId, {
                  type: 'winter3.turn_end',
                  reason: 'interrupted',
                  error: null,
                }).catch(() => {});
                quarantineRetries.delete(sessionId);
                return;
              }
              const { rephrased: llmResult } = await rephraseByLLM(originalText, { parentSignal });
              if (llmResult && llmResult !== originalText) {
                retryText = llmResult;
                rephrasedOk = true;
                rephraseMethod = 'llm';
                process.stderr.write(`[runner] rephrase(llm) sid=${sessionId} attempt=${attempt} rephrased="${retryText.slice(0, 80)}"\n`);
                await log.append(sessionId, {
                  type: 'winter3.turn_rephrased',
                  sid: sessionId,
                  method: 'llm',
                  original: originalText,
                  rephrased: retryText,
                  replacements: [],
                });
              }
            } catch (llmErr) {
              process.stderr.write(`[runner] rephrase(llm) failed sid=${sessionId}: ${llmErr.message}\n`);
            }
          }

          if (!rephrasedOk) {
            // 리프레이즈 실패 — D 단계: 서버 코드가 직접 callFallbackAgent 로 처리 (1회)
            quarantineRetries.delete(sessionId);
            await log.append(sessionId, { type: 'winter3.quarantine_exhausted', attempts: attempt, max: MAX_QUARANTINE_RETRIES });
            if (!agentFallbackAttempted.get(sessionId)) {
              agentFallbackAttempted.set(sessionId, true);
              const _origText = prevState.originalText || userText;
              await log.append(sessionId, { type: 'winter3.agent_fallback_start', sid: sessionId, originalText: _origText });
              process.stderr.write(`[runner] agent_fallback(direct) sid=${sessionId}\n`);
              try {
                const { answer, usedText: _usedB } = await callFallbackAgent(_origText);
                // Fix 1B: SDK transcript 에도 주입 — 다음 turn 재진입 시 연속 대화 가능.
                // Fix(C): usedText 가 원본과 다르면 transcript user turn 도 치환본으로 replace.
                await _injectFallbackToTranscript(freshMeta?.claudeSessionId, answer, _usedB !== _origText ? _usedB : undefined);
                // Fix 2A: success 이벤트 먼저, answer inject, turn_end 마지막
                await log.append(sessionId, { type: 'winter3.agent_fallback_success', sid: sessionId });
                await log.append(sessionId, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: answer }] } });
                await log.append(sessionId, { type: 'winter3.turn_end', reason: 'completed' });
              } catch (fbErr) {
                // Fix 2A: failed 이벤트 catch 첫 줄
                await log.append(sessionId, { type: 'winter3.agent_fallback_failed', sid: sessionId, error: fbErr.message });
                process.stderr.write(`[runner] agent_fallback(direct) failed sid=${sessionId}: ${fbErr.message}\n`);
                // Fix 3B: 실패 시 사과 placeholder 주입 — 다음 턴이 깨끗한 context 에서 시작.
                await _injectFallbackToTranscript(freshMeta?.claudeSessionId, '[이번 질문은 처리되지 않았습니다. 다른 각도로 다시 물어봐주세요.]', undefined);
                const _autopsyR = buildAutopsy({ reason: 'error', lastResult, hasAssistantText, toolUseSeen, wallExt, lastGapMs: Date.now() - lastMsgAt, elapsedMs: Date.now() - turnStart });
                await log.append(sessionId, {
                  type: 'winter3.turn_end',
                  reason: 'error',
                  error: '현재 직접 처리 불가 — 표현을 달리해 다시 시도해주세요.',
                  ...(_autopsyR ? { autopsy: _autopsyR } : {}),
                });
              }
              agentFallbackAttempted.delete(sessionId);
              return;
            }
            // fallback 도 이미 시도됨 — 사용자 안내
            agentFallbackAttempted.delete(sessionId);
            const _autopsyR = buildAutopsy({ reason: 'error', lastResult, hasAssistantText, toolUseSeen, wallExt, lastGapMs: Date.now() - lastMsgAt, elapsedMs: Date.now() - turnStart });
            await log.append(sessionId, {
              type: 'winter3.turn_end',
              reason: 'error',
              error: '현재 직접 처리 불가 — 표현을 달리해 다시 시도해주세요.',
              ...(_autopsyR ? { autopsy: _autopsyR } : {}),
            });
            return;
          }

          quarantineRetries.set(sessionId, { attempt, originalText });
          retryPending = true;
          const retryCtrl = new AbortController();
          setRunning(sessionId, retryCtrl);
          const _retryText = retryText; // 클로저 캡처
          const _rephraseMethod = rephraseMethod;
          const retryTimer = setTimeout(() => {
            if (retryCtrl.signal.aborted) return;
            deleteRunning(sessionId);
            process.stderr.write(`[runner] quarantine retry(${_rephraseMethod}) sid=${sessionId}\n`);
            startTurn({ sessionId, userText: _retryText, _skipUserLog: true })
              .catch((e) => process.stderr.write(`[runner] quarantine retry failed: ${e.message}\n`));
          }, 2000);
          retryCtrl.signal.addEventListener('abort', () => {
            clearTimeout(retryTimer);
            deleteRunning(sessionId);
            quarantineRetries.delete(sessionId);
            log.append(sessionId, {
              type: 'winter3.turn_end',
              reason: 'interrupted',
              error: null,
            }).catch(() => {});
          });
        } else {
          // 한도 초과 또는 격리 실패 — D 단계: 서버 코드가 직접 callFallbackAgent 로 처리 (1회)
          quarantineRetries.delete(sessionId);
          await log.append(sessionId, { type: 'winter3.quarantine_exhausted', attempts: attempt, max: MAX_QUARANTINE_RETRIES });
          if (!agentFallbackAttempted.get(sessionId)) {
            agentFallbackAttempted.set(sessionId, true);
            const _origText = prevState.originalText || userText;
            await log.append(sessionId, { type: 'winter3.agent_fallback_start', sid: sessionId, originalText: _origText });
            process.stderr.write(`[runner] agent_fallback(direct) sid=${sessionId}\n`);
            try {
              const { answer, usedText: _usedC } = await callFallbackAgent(_origText);
              // Fix 1C: SDK transcript 에도 주입 — 다음 turn 재진입 시 연속 대화 가능.
              // Fix(C): usedText 가 원본과 다르면 transcript user turn 도 치환본으로 replace.
              await _injectFallbackToTranscript(freshMeta?.claudeSessionId, answer, _usedC !== _origText ? _usedC : undefined);
              // Fix 2B: success 이벤트 먼저, answer inject, turn_end 마지막
              await log.append(sessionId, { type: 'winter3.agent_fallback_success', sid: sessionId });
              await log.append(sessionId, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: answer }] } });
              await log.append(sessionId, { type: 'winter3.turn_end', reason: 'completed' });
            } catch (fbErr) {
              // Fix 2B: failed 이벤트 catch 첫 줄
              await log.append(sessionId, { type: 'winter3.agent_fallback_failed', sid: sessionId, error: fbErr.message });
              process.stderr.write(`[runner] agent_fallback(direct) failed sid=${sessionId}: ${fbErr.message}\n`);
              // Fix 3C: 실패 시 사과 placeholder 주입 — 다음 턴이 깨끗한 context 에서 시작.
              await _injectFallbackToTranscript(freshMeta?.claudeSessionId, '[이번 질문은 처리되지 않았습니다. 다른 각도로 다시 물어봐주세요.]', undefined);
              const _autopsyQ = buildAutopsy({ reason: 'error', lastResult, hasAssistantText, toolUseSeen, wallExt, lastGapMs: Date.now() - lastMsgAt, elapsedMs: Date.now() - turnStart });
              await log.append(sessionId, {
                type: 'winter3.turn_end',
                reason: 'error',
                error: '현재 직접 처리 불가 — 표현을 달리해 다시 시도해주세요.',
                ...(_autopsyQ ? { autopsy: _autopsyQ } : {}),
              });
            }
            agentFallbackAttempted.delete(sessionId);
            return;
          }
          // fallback 도 이미 시도됨 — 사용자 안내
          agentFallbackAttempted.delete(sessionId);
          const _autopsyQ = buildAutopsy({ reason: 'error', lastResult, hasAssistantText, toolUseSeen, wallExt, lastGapMs: Date.now() - lastMsgAt, elapsedMs: Date.now() - turnStart });
          await log.append(sessionId, {
            type: 'winter3.turn_end',
            reason: 'error',
            error: '현재 직접 처리 불가 — 표현을 달리해 다시 시도해주세요.',
            ...(_autopsyQ ? { autopsy: _autopsyQ } : {}),
          });
        }
      }
      // ─────────────────────────────────────────────────────────────────────

      if (isResultError) {
        // PATCHING #103 후속: 재전송 턴이 error 로 끝나도 staleSwallowRetried 가드 해제 (영구 잔존 방지).
        staleSwallowRetried.delete(sessionId);
        // 에러 문자열 거부 패턴 감지 — ERR_PATTERN 단독 OR AUP URL 동시 존재 시 격리.
        const errStr = (typeof lastResult.result === 'string' && lastResult.result) || '';
        const isErrRefusal = QUARANTINE_ERR_PATTERN.test(errStr) || QUARANTINE_AUP_PATTERN.test(errStr);
        if (isErrRefusal) {
          await tryQuarantine('result_error_msg', abortCtrl.signal);
        } else {
          const _autopsyErr = buildAutopsy({ reason: 'error', lastResult, hasAssistantText, toolUseSeen, wallExt, lastGapMs: Date.now() - lastMsgAt, elapsedMs: Date.now() - turnStart, err: new Error(errStr || 'API error') });
          await log.append(sessionId, {
            type: 'winter3.turn_end',
            reason: 'error',
            error: errStr || 'API error',
            api_error_status: lastResult.api_error_status,
            ...(_autopsyErr ? { autopsy: _autopsyErr } : {}),
          });
        }
      } else {
        // stop_reason=refusal 또는 stop_details.category 존재 → 자동 격리+재시도
        const stopReason = lastResult?.stop_reason || lastResult?.result?.stop_reason;
        const stopCategory = lastResult?.stop_details?.category;
        const isRefusal = stopReason === 'refusal' || !!stopCategory;
        if (isRefusal) {
          staleSwallowRetried.delete(sessionId); // PATCHING #103 후속: refusal 종료도 가드 해제
          await tryQuarantine('stop_reason_refusal', abortCtrl.signal);
        } else {
          // ── 2026-10-18 턴 삼킴 감지 (#103) ──────────────────────────
          // 시그니처: num_turns=0 + duration_api_ms=0 + 출력 전무 = SDK 가 stale
          // task_notification(stopped) 만 flush 하고 API 호출 없이 result 반환.
          // 유저 발화가 모델에 전달 안 됨 → '빈 응답' 아님. 발화 자동 재전송 1회 한정.
          const swallowed = !!lastResult
            && lastResult.num_turns === 0 && lastResult.duration_api_ms === 0
            && !hasAssistantText && toolUseSeen === 0;
          // 직전 killTurn(유저 중단) 귀속 — swallow 여부 무관하게 completed 에서 소비.
          const _killTs = lastUserKill.get(sessionId) || 0;
          const prevUserKill = _killTs > 0 && (Date.now() - _killTs) < USER_KILL_ATTRIB_TTL_MS;
          lastUserKill.delete(sessionId);
          const _shuttingDownNow = (typeof globalThis.WINTER3_SHUTTING_DOWN !== 'undefined' && globalThis.WINTER3_SHUTTING_DOWN);
          const willResend = swallowed
            && staleSwallowRetried.get(sessionId) !== true  // 연속 swallow 무한 루프 가드 (1회 한정)
            && !_shuttingDownNow;
          const _autopsyCompleted = buildAutopsy({ reason: 'completed', lastResult, hasAssistantText, toolUseSeen, wallExt, lastGapMs: Date.now() - lastMsgAt, elapsedMs: Date.now() - turnStart, staleStopSeen, prevUserKill, autoResent: willResend });
          await log.append(sessionId, {
            type: 'winter3.turn_end',
            reason: 'completed',
            ...(_autopsyCompleted ? { autopsy: _autopsyCompleted } : {}),
          });
          if (willResend) {
            // #26 V2 retry 패턴 재사용: retryPending 으로 lock 유지, retryCtrl swap.
            // _skipUserLog=true — 유저 bubble 중복 방지 (원 발화는 이미 jsonl 에 있음).
            // 한계 (#26 V2 상속): 첨부 image block 은 재전송에 포함 안 됨 (staging 이미 소비됨).
            staleSwallowRetried.set(sessionId, true);
            await log.append(sessionId, {
              type: 'winter3.stale_swallow_resend',
              text: userText,
              stale_notifications: staleStopSeen,
            });
            process.stderr.write(`[runner] stale-swallow detected sid=${sessionId} (num_turns=0, api_ms=0, staleStops=${staleStopSeen}) — auto-resend in 1.5s\n`);
            retryPending = true;
            const retryCtrl = new AbortController();
            setRunning(sessionId, retryCtrl);
            const resendTimer = setTimeout(() => {
              if (retryCtrl.signal.aborted) return;
              deleteRunning(sessionId);
              startTurn({ sessionId, userText, _skipUserLog: true })
                .catch(async (e) => {
                  process.stderr.write(`[runner] stale-swallow resend failed: ${e?.message}\n`);
                  // 재전송 턴이 시작도 못 하고 reject → 이 턴을 닫는 turn_end 가 영영 없으면 프론트가
                  // 영구 running 고착 (jsonl replay 도 running). best-effort 로 error turn_end 부착.
                  // 가드도 해제 (재전송 시도 소진 완료 — 이후 진짜 삼킴은 다시 1회 재전송 가능).
                  staleSwallowRetried.delete(sessionId);
                  // 409 = 다른 턴이 이미 running — 그 턴이 자기 turn_end 를 쓰므로 여기서 덮지 않는다.
                  if (e?.statusCode === 409) return;
                  try {
                    await log.append(sessionId, {
                      type: 'winter3.turn_end',
                      reason: 'error',
                      error: `stale-swallow 자동 재전송 시작 실패: ${e?.message || e}`,
                      autopsy: { classification: '자동 재전송 실패', hint: '턴 삼킴 후 자동 재전송이 시작되지 못함 — 같은 메시지를 다시 보내라', swallowed: true, auto_resend: true },
                    });
                  } catch (appendErr) {
                    process.stderr.write(`[runner] stale-swallow resend-failure turn_end append failed: ${appendErr?.message}\n`);
                  }
                });
            }, 1500);
            retryCtrl.signal.addEventListener('abort', () => {
              clearTimeout(resendTimer);
              deleteRunning(sessionId);
              staleSwallowRetried.delete(sessionId); // 재전송 대기 중 유저 중단 — 재전송 턴이 시작도 안 했으므로 가드 해제
              log.append(sessionId, {
                type: 'winter3.turn_end',
                reason: 'interrupted',
                error: null,
                ...(retryCtrl._userKill === true ? { user_kill: true } : {}),
              }).catch(() => { /* best-effort */ });
            });
          } else {
            if (swallowed) {
              // 재전송 이미 1회 소진 (또는 shutdown 중) — autopsy hint 가 수동 재전송 안내.
              process.stderr.write(`[runner] stale-swallow repeated sid=${sessionId} — resend suppressed (guard)\n`);
            } else {
              staleSwallowRetried.delete(sessionId); // 정상 완료 → 가드 해제
            }
            // 첫 turn 정상 종료 후 LLM 제목 자동생성 (titleAuto !== false 세션만 갱신).
            // fire-and-forget — turn 흐름을 막지 않도록 await 하지 않는다. 내부에서 전부 try/catch.
            // 로컬 ollama HTTP 호출만 사용 (#28 V3: server-context SDK query() hang 회피).
            maybeAutoTitle(sessionId);
          }
        }
      }
      // 거부 격리+재시도 진행 중이면 카운터는 유지. 재시도 성공 시 정상 완료 경로에서 clear.
      if (!retryPending) {
        stallRetries.delete(sessionId);       // 정상 완료 시 카운터 리셋
        rateLimitRetries.delete(sessionId);   // #26
        wallCapRetries.delete(sessionId);     // wall-cap productive auto-continue 카운터 리셋
        quarantineRetries.delete(sessionId);  // 격리 카운터 리셋
      }
    } catch (err) {
      clearInterval(stallTimer);
      // PATCHING #103 후속: catch 진입 = error/stalled/interrupted/timeout/rate-limit/auth 등 swallow 아닌 종료.
      // 재전송 턴이 이 경로로 끝나도 staleSwallowRetried 가드가 세션 수명 내내 남지 않게 해제.
      // (swallow 재판정은 try 안 completed 분기라 여기 안 옴 → 연쇄 재전송 1회 한정 유지)
      staleSwallowRetried.delete(sessionId);
      const aborted = err?.name === 'AbortError' || abortCtrl.signal.aborted;
      // #55 [진짜 갭 2]: wall-clock cap 으로 죽은 turn. stalled 로 오분류되면
      // auto-continue(setTimeout(startTurn,1500ms)) 가 재발사되어 hang Bash 를 또 유발.
      // wallCapHit 플래그 + turnStart 경과 이중 확인으로 확실히 timeout 분기로 보낸다.
      const wallCapped = aborted && (wallCapHit || (Date.now() - turnStart > WALL_MAX_MS * (1 + wallExt)));
      // #40b 후속: stall 판정도 inToolUseCount 시점값 따라 effective limit 갱신.
      // tool 활성 중이었으면 TOOL_STALL_MS, 아니면 STALL_MS.
      // wall-cap abort 는 stalled 로 오분기 금지 — AND 로 !wallCapped 강제 (auto-continue 억제).
      const effectiveStallLimit = inToolUseCount > 0 ? TOOL_STALL_MS : STALL_MS;
      const stalled = aborted && !wallCapped && (Date.now() - lastMsgAt > effectiveStallLimit - 1000);
      // 사용자 abort 가 아닌 server-side throttle 인지 분류. aborted == true 면 사용자 의도 우선.
      const rateLimited = !aborted && isRateLimitError(err);
      // 토큰 만료 / OAuth 인증 실패 — rate-limit 가 아닌 경우에만 (isAuthError 가 내부에서 rate-limit 우선 배제).
      const authFailed = !aborted && !rateLimited && isAuthError(err);

      if (wallCapped) {
        // productive gate: abort 직전 WALLCAP_PRODUCTIVE_MS(90s) 이내 SDK msg 흐름이 있으면
        // 생산적 턴으로 보고 auto-continue 최대 MAX_WALLCAP_RETRIES(3)회.
        // 아니면 hang 의심으로 억제 — #55 원래 시나리오 (sub-agent 무한 poll Bash).
        const productive = wallCapLastGapMs !== null && wallCapLastGapMs < WALLCAP_PRODUCTIVE_MS;
        const _autopsyTimeout = buildAutopsy({ reason: 'timeout', lastResult, hasAssistantText, toolUseSeen, wallExt, lastGapMs: wallCapLastGapMs, elapsedMs: Date.now() - turnStart });
        await log.append(sessionId, {
          type: 'winter3.turn_end',
          reason: 'timeout',
          error: `turn exceeded wall-clock cap (${WALL_MAX_MS}ms)`,
          productive,
          last_msg_gap_ms: wallCapLastGapMs,
          ...(_autopsyTimeout ? { autopsy: _autopsyTimeout } : {}),
        });
        stallRetries.delete(sessionId);
        rateLimitRetries.delete(sessionId);
        const shuttingDown = (typeof globalThis.WINTER3_SHUTTING_DOWN !== 'undefined' && globalThis.WINTER3_SHUTTING_DOWN);
        const autoContinueOff = String(process.env.WINTER3_AUTO_CONTINUE || '').toLowerCase() === 'off';
        const next = (wallCapRetries.get(sessionId) || 0) + 1;
        if (productive && !shuttingDown && !autoContinueOff && next <= MAX_WALLCAP_RETRIES) {
          wallCapRetries.set(sessionId, next);
          await log.append(sessionId, {
            type: 'winter3.auto_continue',
            attempt: next,
            max: MAX_WALLCAP_RETRIES,
            text: STALL_CONTINUE_TEXT,
            trigger: 'wall_cap',
          });
          setTimeout(() => {
            const shuttingDown2 = (typeof globalThis.WINTER3_SHUTTING_DOWN !== 'undefined' && globalThis.WINTER3_SHUTTING_DOWN);
            const autoContinueOff2 = String(process.env.WINTER3_AUTO_CONTINUE || '').toLowerCase() === 'off';
            if (shuttingDown2 || autoContinueOff2) {
              process.stderr.write(`[runner] wall-cap auto-continue aborted (${shuttingDown2 ? 'shutting_down' : 'env_off'})\n`);
              return;
            }
            startTurn({ sessionId, userText: STALL_CONTINUE_TEXT })
              .catch((e) => process.stderr.write(`[runner] wall-cap auto-continue failed: ${e.message}\n`));
          }, 1500);
        } else if (!productive) {
          wallCapRetries.delete(sessionId);
          await log.append(sessionId, {
            type: 'winter3.auto_continue_disabled',
            reason: 'wall_cap_unproductive',
            trigger: 'wall_cap',
          });
        } else if (productive && (shuttingDown || autoContinueOff)) {
          // productive 이지만 shutdown 중 또는 env 억제 — stalled 분기와 동일한 semantics.
          wallCapRetries.delete(sessionId);
          await log.append(sessionId, {
            type: 'winter3.auto_continue_disabled',
            reason: shuttingDown ? 'shutting_down' : 'env_off',
            trigger: 'wall_cap',
          });
        } else {
          // productive && !shuttingDown && !autoContinueOff && next > MAX — 순수 exhausted.
          wallCapRetries.delete(sessionId);
          await log.append(sessionId, {
            type: 'winter3.auto_continue_exhausted',
            attempts: next - 1,
            max: MAX_WALLCAP_RETRIES,
            trigger: 'wall_cap',
          });
        }
      } else if (stalled) {
        const _autopsyStalled = buildAutopsy({ reason: 'stalled', lastResult, hasAssistantText, toolUseSeen, wallExt, lastGapMs: Date.now() - lastMsgAt, elapsedMs: Date.now() - turnStart, err });
        await log.append(sessionId, {
          type: 'winter3.turn_end',
          reason: 'stalled',
          error: err?.message || String(err),
          ...(_autopsyStalled ? { autopsy: _autopsyStalled } : {}),
        });
        // #18: stalled → 자동 "Continue from where you left off." 재시도.
        // #31 V2: shutdown 진행 중 또는 WINTER3_AUTO_CONTINUE=off 면 auto_continue 비활성.
        // race 시나리오: stall abort 가 in-flight 마감 신호로 작동 → detach restart 가 stop 진행.
        // 같은 시점에 setTimeout(startTurn, 1500ms) 가 새 turn 시작 → graceful shutdown 도중 race
        // → EADDRINUSE / 두번째 SIGTERM cascade → server 다운. 분석 권고: A.
        const shuttingDown = (typeof globalThis.WINTER3_SHUTTING_DOWN !== 'undefined' && globalThis.WINTER3_SHUTTING_DOWN);
        const autoContinueOff = String(process.env.WINTER3_AUTO_CONTINUE || '').toLowerCase() === 'off';
        const prev = stallRetries.get(sessionId) || 0;
        const next = prev + 1;
        if (shuttingDown || autoContinueOff) {
          stallRetries.delete(sessionId);
          await log.append(sessionId, {
            type: 'winter3.auto_continue_disabled',
            reason: shuttingDown ? 'shutting_down' : 'env_off',
          });
        } else if (next <= MAX_STALL_RETRIES) {
          stallRetries.set(sessionId, next);
          await log.append(sessionId, {
            type: 'winter3.auto_continue',
            attempt: next,
            max: MAX_STALL_RETRIES,
            text: STALL_CONTINUE_TEXT,
          });
          setTimeout(() => {
            // 재진입 시점에 shutdown 또는 env=off 면 또 abort.
            const shuttingDown2 = (typeof globalThis.WINTER3_SHUTTING_DOWN !== 'undefined' && globalThis.WINTER3_SHUTTING_DOWN);
            const autoContinueOff2 = String(process.env.WINTER3_AUTO_CONTINUE || '').toLowerCase() === 'off';
            if (shuttingDown2 || autoContinueOff2) {
              process.stderr.write(`[runner] auto-continue aborted (${shuttingDown2 ? 'shutting_down' : 'env_off'})\n`);
              return;
            }
            startTurn({ sessionId, userText: STALL_CONTINUE_TEXT })
              .catch((e) => process.stderr.write(`[runner] auto-continue failed: ${e.message}\n`));
          }, 1500);
        } else {
          stallRetries.delete(sessionId);
          await log.append(sessionId, {
            type: 'winter3.auto_continue_exhausted',
            attempts: prev,
            max: MAX_STALL_RETRIES,
          });
        }
      } else if (rateLimited) {
        // #26 V3: Anthropic 의 rate_limit_event meta 인지.
        // resetsAt / rateLimitType / overageStatus 로 분기 — five_hour quota 면 retry 무의미.
        const prev = rateLimitRetries.get(sessionId) || 0;
        const next = prev + 1;
        const meta = await extractRateLimitMeta(sessionId);
        const resetsAt = meta?.resetsAt || null;
        const nowSec = Math.floor(Date.now() / 1000);
        const secUntilReset = resetsAt ? Math.max(0, resetsAt - nowSec) : null;
        // five_hour 또는 reset 까지 60s 초과 = "장기 quota" → retry 자체 포기.
        const isLongQuota = (
          meta?.rateLimitType === 'five_hour'
          || (secUntilReset !== null && secUntilReset > RATE_LIMIT_RESET_INLINE_MAX_S)
        );
        if (isLongQuota) {
          // (c)+(d): 사용자한테 명시 — "5h quota Xh Ym 후 reset, overage 켜면 즉시 통과".
          rateLimitRetries.delete(sessionId);
          await log.append(sessionId, {
            type: 'winter3.auto_rate_limit_quota_hit',
            rateLimitType: meta?.rateLimitType || 'unknown',
            resetsAt,
            secUntilReset,
            overageStatus: meta?.overageStatus || null,
          });
          const _autopsyRlQuota = buildAutopsy({ reason: 'rate_limited', lastResult, hasAssistantText, toolUseSeen, wallExt, lastGapMs: Date.now() - lastMsgAt, elapsedMs: Date.now() - turnStart, err });
          await log.append(sessionId, {
            type: 'winter3.turn_end',
            reason: 'rate_limited',
            error: err?.message || String(err),
            ...(_autopsyRlQuota ? { autopsy: _autopsyRlQuota } : {}),
          });
        } else if (next <= MAX_RATE_LIMIT_RETRIES) {
          // delayMs 결정:
          //   1) reset 까지 ≤60s 면 그 시각 + 2s 까지 single sleep (exponential 무시)
          //   2) prev=0 (첫 attempt) 1s + jitter — (a) 첫 시도 transient 인 경우 빠르게
          //   3) 그 외 5/10/20/40s + jitter
          let delayMs;
          let usedReset = false;
          if (
            secUntilReset !== null
            && secUntilReset > 0
            && secUntilReset <= RATE_LIMIT_RESET_INLINE_MAX_S
          ) {
            delayMs = secUntilReset * 1000 + RATE_LIMIT_RESET_BUFFER_MS + Math.floor(Math.random() * 500);
            usedReset = true;
          } else if (prev === 0) {
            delayMs = RATE_LIMIT_FIRST_MS + Math.floor(Math.random() * 500);
          } else {
            delayMs = RATE_LIMIT_BASE_MS * Math.pow(2, prev - 1) + Math.floor(Math.random() * 1000);
          }
          rateLimitRetries.set(sessionId, next);
          await log.append(sessionId, {
            type: 'winter3.auto_rate_limit_retry',
            attempt: next,
            max: MAX_RATE_LIMIT_RETRIES,
            delayMs,
            usedReset,
            resetsAt,
            rateLimitType: meta?.rateLimitType || null,
            error: err?.message || String(err),
          });
          retryPending = true;
          const retryCtrl = new AbortController();
          // setRunning 은 startedAt 이 이미 있으면 유지 → 원래 turn 진입 시각 보존.
          // sweeper 는 원래 turnStart 기준으로 유령 판정 (retry 로 시각 리셋되면 무한 유예 위험).
          setRunning(sessionId, retryCtrl);
          const retryTimer = setTimeout(() => {
            if (retryCtrl.signal.aborted) return; // abort listener 가 정리
            deleteRunning(sessionId);              // startTurn 이 setRunning 다시 함
            startTurn({ sessionId, userText, _skipUserLog: true })
              .catch((e) => process.stderr.write(`[runner] auto rate-limit retry failed: ${e.message}\n`));
          }, delayMs);
          retryCtrl.signal.addEventListener('abort', () => {
            clearTimeout(retryTimer);
            deleteRunning(sessionId);
            rateLimitRetries.delete(sessionId);
            // interrupted (유저 중단) = 정상 → buildAutopsy null 반환, autopsy 필드 없음
            const _autopsyRlAbort = buildAutopsy({ reason: 'interrupted', lastResult, hasAssistantText, toolUseSeen, wallExt, lastGapMs: null, elapsedMs: null });
            log.append(sessionId, {
              type: 'winter3.turn_end',
              reason: 'interrupted',
              error: null,
              ...(_autopsyRlAbort ? { autopsy: _autopsyRlAbort } : {}),
            }).catch(() => { /* best-effort */ });
          });
        } else {
          // 한도 초과 — 진짜 turn_end + exhausted 마감
          rateLimitRetries.delete(sessionId);
          const _autopsyRlExhausted = buildAutopsy({ reason: 'rate_limited', lastResult, hasAssistantText, toolUseSeen, wallExt, lastGapMs: Date.now() - lastMsgAt, elapsedMs: Date.now() - turnStart, err });
          await log.append(sessionId, {
            type: 'winter3.turn_end',
            reason: 'rate_limited',
            error: err?.message || String(err),
            ...(_autopsyRlExhausted ? { autopsy: _autopsyRlExhausted } : {}),
          });
          await log.append(sessionId, {
            type: 'winter3.auto_rate_limit_exhausted',
            attempts: prev,
            max: MAX_RATE_LIMIT_RETRIES,
          });
        }
      } else if (authFailed) {
        // 토큰 만료 / OAuth 인증 실패 — generic else 로 묻혀 빈 응답 나가는 것 방지.
        // 사용자한테 명시 알림 이벤트(텍스트) + turn_end {reason:'auth_failed'} emit.
        // ★ server-context 에서 SDK query() 추가 호출 절대 안 함 (#28 709~712 hang 함정).
        // 토큰 갱신은 사용자가 터미널에서 직접 — 여기선 알림만.
        await log.append(sessionId, {
          type: 'winter3.auth_failed',
          text: AUTH_FAILED_TEXT,
          error: err?.message || String(err),
        });
        const _autopsyAuth = buildAutopsy({ reason: 'auth_failed', lastResult, hasAssistantText, toolUseSeen, wallExt, lastGapMs: Date.now() - lastMsgAt, elapsedMs: Date.now() - turnStart, err });
        await log.append(sessionId, {
          type: 'winter3.turn_end',
          reason: 'auth_failed',
          error: err?.message || String(err),
          ...(_autopsyAuth ? { autopsy: _autopsyAuth } : {}),
        });
        stallRetries.delete(sessionId);
        rateLimitRetries.delete(sessionId);
      } else {
        // 일반 error / 사용자 interrupt — turn_end + 카운터 둘 다 fresh.
        // #92: graceful shutdown 으로 abort 된 경우 reason='completed' 로 마감.
        // ctrl._shutdownAbort=true 태그는 abortAllTurns() 가 심음 (유저 kill = 태그 없음).
        const shutdownAbort = aborted && abortCtrl._shutdownAbort === true;
        const elseReason = shutdownAbort ? 'completed' : (aborted ? 'interrupted' : 'error');
        // 2026-10-18: killTurn 이 심은 _userKill 태그 → turn_end 에 user_kill:true 동봉.
        // UI 가 '(중단됨)' 대신 '(사용자 중단)' 으로 구분 표시 (sweeper evict 등 비유저 abort 와 구별).
        const userKill = aborted && abortCtrl._userKill === true;
        const _autopsyElse = buildAutopsy({ reason: elseReason, lastResult, hasAssistantText, toolUseSeen, wallExt, lastGapMs: Date.now() - lastMsgAt, elapsedMs: Date.now() - turnStart, err: shutdownAbort ? null : (aborted ? null : err) });
        await log.append(sessionId, {
          type: 'winter3.turn_end',
          reason: elseReason,
          error: (shutdownAbort || aborted) ? null : (err?.message || String(err)),
          ...(userKill ? { user_kill: true } : {}),
          ...(_autopsyElse ? { autopsy: _autopsyElse } : {}),
        });
        stallRetries.delete(sessionId);
        rateLimitRetries.delete(sessionId);
      }
    } finally {
      clearInterval(stallTimer);
      // #26 V2: retry pending 이면 lock 유지 (retryCtrl 가 새로 set 됨).
      // #57 fix: turnStartedAt 도 페어로 정리 (retry 아닐 때만).
      // retry 경로면 setRunning 이 이미 startedAt 유지, 이후 startTurn 재호출이 새 pair set.
      if (!retryPending) deleteRunning(sessionId);
      // 방어: retryPending=true 인데 어떤 이유로 abort listener / timer 콜백 둘 다 발화 못 하면
      // lock 이 영구 잔존한다. 이 경우 아래 sweeper 가 WALL_MAX_MS + 여유 초과 시 잡아준다.
      // 또한 session.save 실패가 lock leak 유발하지 않게 try/catch 로 래핑 (delete 는 위에서 완료).
      try {
        const latest = await session.load(sessionId);
        if (latest) await session.save(latest); // bump updatedAt
      } catch (e) {
        process.stderr.write(`[runner] finally session.save failed: ${e?.message || e}\n`);
      }
    }
  })();

  return { sessionId };
}

export function killTurn(sessionId) {
  const ctrl = runningTurns.get(sessionId);
  if (!ctrl) return false;
  // 2026-10-18 (#103): 유저 중단 태그 2종.
  // _userKill — catch 블록이 turn_end 에 user_kill:true 동봉 (UI '(사용자 중단)' 표시).
  // lastUserKill — 다음 turn 이 stale notification 에 삼켜지면 '사용자 중단 여파' 로 귀속.
  ctrl._userKill = true;
  lastUserKill.set(sessionId, Date.now());
  try { ctrl.abort(); } catch { /* best-effort */ }
  return true;
}

// #29 V5 (audit P0 A): graceful shutdown 시 모든 in-flight turn 의 abortController 호출.
// 기존 gracefulShutdown 은 drain wait 만 → child SDK alive → 60s timeout → forcing exit → orphan SDK + dangling.
// 이 helper 가 SIGTERM 핸들러에서 호출되면 각 controller 가 즉시 abort → SDK iterator throw → catch 블록의
// turn_end 정상 마감 → drain count 0 → cleanly exit.
// #92: shutdown abort 는 ctrl._shutdownAbort=true 로 태그 → catch 블록이 reason='completed' 로 기록.
// 유저 kill (killTurn) 은 태그 없이 abort → reason='interrupted' 그대로.
export function abortAllTurns(reason = 'shutdown') {
  const sids = Array.from(runningTurns.keys());
  for (const sid of sids) {
    const ctrl = runningTurns.get(sid);
    if (!ctrl) continue;
    if (ctrl.signal.aborted) continue;  // 이미 abort(유저 kill 등) — 태그 오염 방지
    try {
      ctrl._shutdownAbort = true;  // shutdown vs user-kill 구분 태그
      ctrl.abort();
    } catch { /* best-effort */ }
  }
  return sids.length;
}

export function isRunning(sessionId) {
  return runningTurns.has(sessionId);
}

// graceful shutdown 용 — index.js 의 SIGTERM 핸들러가 in-flight drain 시 polling.
export function runningTurnCount() {
  return runningTurns.size;
}

// #20 — Multi-Session PiP Monitor: in-flight sid 목록.
// Oracle 5/5 합의 — `runningTurns` 만으론 서버 재시작 후 race window. index.js 의
// `/sessions/active` handler 가 jsonl tail 의 dangling 도 union 해서 보강.
export function runningTurnIds() {
  return Array.from(runningTurns.keys());
}

// #57 fix: safety-net sweeper.
// 어떤 미래의 코드 변경이 종료 경로에서 deleteRunning() 을 빼먹어도, 이 sweeper 가
// WALL_MAX_MS + 여유 (5 분) 를 초과한 유령 항목을 잡아서 abort + 정리한다.
// - IIFE 안의 stallTimer 는 WALL_MAX_MS(=20분) 만료 시 wallCapHit 로 정상 절단하므로,
//   그 경로가 살아있는 한 sweeper 는 발동 안 함. 발동한다는 것은 코드 경로가 leak 를
//   생성했다는 신호 → stderr 로 명시 경고 남김 (post-mortem 근거).
// - 기본 sweep interval 60s. unref() 로 프로세스 종료 안 막게.
// - #57 재현 시나리오 (2.5시간 잔존) 를 실제로 잡을 수 있는 conservative threshold.
const SWEEP_INTERVAL_MS = Number(process.env.WINTER3_SWEEP_INTERVAL_MS) || 60_000;
const SWEEP_GRACE_MS    = Number(process.env.WINTER3_SWEEP_GRACE_MS)    || 5 * 60 * 1000; // 5분
// 기본 wall-cap 과 동일 (env 로 override 될 수 있으니 startTurn 이 쓰는 default 와 맞춘다).
// #84: env '0' → Infinity (wall-cap 비활성화 시 sweeper 도 동일하게).
const _SWEEP_WALL_RAW = process.env.WINTER3_TURN_MAX_MS;
const SWEEP_WALL_MAX_MS = _SWEEP_WALL_RAW === '0' ? Infinity : (Number(_SWEEP_WALL_RAW) || 20 * 60 * 1000);
function sweepGhostTurns(now = Date.now()) {
  const swept = [];
  for (const [sid, startedAt] of turnStartedAt) {
    const elapsed = now - startedAt;
    // #84: 연장된 turn 은 turnCapMs 에 실제 유효 cap 이 기록됨 — 기록 없으면 SWEEP_WALL_MAX_MS 기본값.
    const thresholdMs = (turnCapMs.get(sid) ?? SWEEP_WALL_MAX_MS) + SWEEP_GRACE_MS;
    if (elapsed <= thresholdMs) continue;
    const ctrl = runningTurns.get(sid);
    process.stderr.write(
      `[runner] GHOST turn detected sid=${sid} elapsed=${elapsed}ms `
      + `(> ${thresholdMs}ms threshold) — aborting + evicting. `
      + `Root cause: some code path forgot to call deleteRunning(). Investigate.\n`
    );
    if (ctrl) { try { ctrl.abort(); } catch { /* */ } }
    deleteRunning(sid);
    swept.push({ sid, elapsedMs: elapsed });
  }
  return swept;
}
// 노출 — 테스트/디버그용 (프로덕션 호출자는 없어도 됨).
export { sweepGhostTurns };
// interval 자체는 sub-process (SDK child) 나 event loop 에 매달리지 않게 unref.
// server main process 종료 시 자동 정리.
const ghostSweeperTimer = setInterval(() => {
  try { sweepGhostTurns(); } catch (e) {
    process.stderr.write(`[runner] sweeper failed: ${e?.message || e}\n`);
  }
}, SWEEP_INTERVAL_MS);
if (typeof ghostSweeperTimer.unref === 'function') ghostSweeperTimer.unref();
