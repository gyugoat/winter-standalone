// server/hooks/index.js
// 단일 진입점 — runner.js 의 queryOptions.hooks 에 박힐 hook 카탈로그를 모은다.
//
// 정책 / ordering (#45):
//   - mechanical deny (winter-never-edits / hawk-usermd-gate) 가 staleness-guard 보다 **먼저** 실행.
//     SDK 가 첫 deny 에서 후속 hook skip + 즉시 tool deny 반환 → unnecessary mtime check 회피.
//   - 같은 matcher 안의 hooks[] 배열 순서가 실행 순서. 첫 hook 이 decision='block' 반환 시 후속 skip.
//
// matcher 별 분배:
//   PreToolUse(Edit|Write|MultiEdit):
//     [winter-never-edits, qa-gate-marker-forge-deny, staleness-guard]
//   PreToolUse(Read):
//     [hawk-usermd-gate (Read variant), image-dimension-gate]
//   PreToolUse(Bash):
//     [hawk-usermd-gate (Bash variant), qa-gate-forge-deny, qa-ship-gate]
//   PostToolUse(Read):
//     [staleness-guard mtime tracker]
//
// 추가 hook 시: 카테고리별 강제 위임 룰 (#43 lesson 룰 6개) 의 mechanical enforcement.
//   - 1주차: USER.md / Edit·Write 차단 (이 파일)
//   - 2주차: hookify.js plugin loader 도입 (#45 후속, winter-opencode 의 588 line ref)

import {
  stalenessGuardHooks,
  makeReadMtimeTracker,
  makeWriteMtimeTracker,
  makeEditStalenessGuard,
  DEFAULT_CACHE_DIR,
} from '../staleness-guard.js';
import { makeWinterNeverEditsHook, makeWinterNeverEditsBashGate } from './winter-never-edits.js';
import { makeHawkUserMdReadGate, makeHawkUserMdBashGate } from './hawk-usermd-gate.js';
import {
  makeQaDirtyRecorder,
  makeQaDirtyBashRecorder,
  makeQaVerifiedRecorder,
  makeQaShipGate,
  makeQaForgeDenyBash,
  makeQaMarkerForgeDeny,
  makeQaUnverifiedReminder,
  DEFAULT_STATE_DIR as QA_DEFAULT_STATE_DIR,
} from './qa-ship-gate.js';
import { makeBgJobNotify } from './bg-job-notify.js';
import { makeLessonToolMarker, makeLessonPromptHook } from './lesson-trigger.js';
import { makeImageDimensionGate } from './image-dimension-gate.js';
import { makeEventsNecropsyReadGate, makeEventsNecropsyBashGate } from './events-necropsy-gate.js';
import { makeRefusalSanitizeHook } from './refusal-sanitize.js';

// ── QA ship-gate 안전 원칙 (server/hooks/qa-ship-gate.js 헤더 참조) ──
//   - PostToolUse hook 들(qa-dirty-recorder / qa-dirty-bash-recorder / qa-verified-recorder)은
//     절대 block 하지 않는다 — 오직 마커(data/cache/qa-gate/state.json) "기록" 전용. 항상 {} 반환.
//   - block 은 오직 PreToolUse(Bash) 의 ship 명령(restart.sh / git commit)에서만(qa-ship-gate).
//     + state.json 수동 위조 차단(qa-gate-forge-deny-bash / qa-gate-marker-forge-deny).
//   - env 우회: WINTER3_BYPASS_QA_GATE=1.

// runner.js queryOptions.hooks 에 그대로 spread 가능한 형식.
// HookCallbackMatcher 의 matcher 는 tool_name regex. SDK 가 매 tool_use 마다 매칭 후 hooks[] 순차 실행.
export function combineHooks({ cacheDir = DEFAULT_CACHE_DIR, qaStateDir = QA_DEFAULT_STATE_DIR } = {}) {
  return {
    UserPromptSubmit: [
      {
        // 다음 턴 시작 시 백그라운드 job 완료/진행 상황을 additionalContext 로 주입.
        // 레지스트리: data/bg-jobs.jsonl (없으면 조용히 통과).
        // + lesson-trigger: tool 트리거 pending 소비 + prompt keyword 트리거 매칭.
        // + qa-unverified-reminder: dirty > verified 상태일 때 미검증 리마인더 주입 (block 금지, 같은 dirtyTs 2회 후 침묵).
        matcher: '*',
        hooks: [makeBgJobNotify(), makeLessonPromptHook(), makeQaUnverifiedReminder({ stateDir: qaStateDir })],
      },
    ],
    PreToolUse: [
      {
        // Edit/Write/MultiEdit — mechanical deny 먼저, mtime check 뒤.
        //   winter-never-edits(main thread 차단) → qa-gate-marker-forge-deny(state.json 위조 차단) → staleness-guard.
        matcher: 'Edit|Write|MultiEdit',
        hooks: [
          makeWinterNeverEditsHook(),
          makeQaMarkerForgeDeny(),
          makeEditStalenessGuard({ cacheDir }),
        ],
      },
      {
        // Read|Grep|Glob — USER.md 직접 read/검색 차단 (main thread) → 이미지 dimension 초과 차단 (전 agent).
        //   hawk-usermd-gate (mechanical deny 먼저) → image-dimension-gate (1568px cap).
        //   Grep/Glob 추가 (2026-10-18 리뷰 #1c) — image/necropsy gate 는 내부 tool_name==='Read' 체크라 영향 없음.
        matcher: 'Read|Grep|Glob',
        hooks: [makeHawkUserMdReadGate(), makeImageDimensionGate(), makeEventsNecropsyReadGate()],
      },
      {
        // Bash — USER.md 우회 차단 → Bash write 우회 차단 → state.json 위조 차단 → ship-gate(유일한 ship block)
        //   mechanical-deny-first: forge-deny 가 ship-gate 보다 먼저. ship-gate 가 최종 검문.
        matcher: 'Bash',
        hooks: [
          makeHawkUserMdBashGate(),
          makeWinterNeverEditsBashGate(), // sed -i / tee / redirect 가 소스 파일 타격 시 deny (2026-10-18 리뷰 #3)
          makeEventsNecropsyBashGate(),
          makeQaForgeDenyBash(),
          makeQaShipGate({ stateDir: qaStateDir }),
          makeLessonToolMarker(), // lesson-trigger tool 매칭 마킹 (block 금지, 항상 {}).
        ],
      },
    ],
    PostToolUse: [
      {
        // Read 후 mtime 기록 — staleness-guard 의 cache.
        matcher: 'Read',
        hooks: [makeReadMtimeTracker({ cacheDir })],
      },
      {
        // Edit/Write/MultiEdit 후: ① staleness cache 를 새 mtime 으로 갱신 (연속 Edit 과차단 방지,
        //   2026-10-18 리뷰 #2) ② CODE_PATH 변경 dirty 기록 (block X — 둘 다 기록 전용).
        matcher: 'Edit|Write|MultiEdit',
        hooks: [makeWriteMtimeTracker({ cacheDir }), makeQaDirtyRecorder({ stateDir: qaStateDir })],
      },
      {
        // Bash 후 sed -i / tee / redirect 우회 코드 write dirty 기록 (block X — 기록 전용).
        matcher: 'Bash',
        hooks: [makeQaDirtyBashRecorder({ stateDir: qaStateDir })],
      },
      {
        // Agent(QA sub-agent) 후 verdict 기록 (block X — 기록 전용).
        matcher: 'Agent',
        hooks: [makeQaVerifiedRecorder({ stateDir: qaStateDir })],
      },
      {
        // 모든 tool result 소독 — 안전 분류기 거부 원문이 부모 히스토리에 박히는 것 차단.
        // Agent / Bash / 기타 모든 tool 커버.
        // block 아님 — 매칭 문장만 한국어 안내 문구로 치환, 나머지 보존.
        // (#59/#61: 거부 원문 유입 → 부모 세션 cascade 거부 방지)
        matcher: '.*',
        hooks: [makeRefusalSanitizeHook()],
      },
    ],
  };
}

// 하위 호환 — 기존 stalenessGuardHooks() caller 보존 (직접 호출 코드 있을 시).
export { stalenessGuardHooks };
