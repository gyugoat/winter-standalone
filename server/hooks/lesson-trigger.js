// server/hooks/lesson-trigger.js
// lesson-trigger — data/lesson-triggers.json 의 트리거 조건 매칭 시 lesson 텍스트를
// additionalContext 로 Winter 에 주입. 과거 함정/교훈이 관련 상황에서 자동 노출된다.
//
// 트리거 종류:
//   a. { "type":"tool", "tool":"Bash", "inputPattern":"<regex>" }
//      PreToolUse 에서 input JSON 문자열에 regex 매치 → 마킹만 (프로세스 Set)
//      → 다음 UserPromptSubmit 에서 마킹된 lesson 을 additionalContext 로 주입.
//      (PostToolUse additionalContext 지원이 이 SDK 버전에서 미확인이라 bg-job-notify
//       와 동일한 "다음 턴 주입" 지연 방식을 사용한다 — fail-safe 우선.)
//   b. { "type":"prompt", "keywords":["렉","느려"] }
//      UserPromptSubmit 의 prompt 에 키워드 포함 시 즉시 additionalContext 주입.
//
// 세션당 같은 lesson 1회만 주입 — 프로세스 스코프 Set (commit-policy-gate 패턴).
// 서버 재시작 시 리셋 (의도된 설계).
//
// fail-open 절대 원칙: json 파싱 실패/파일 없음/regex 에러 등 어떤 경우에도
// throw 금지. try/catch 로 감싸고 조용히 skip. 이 hook 이 죽어도 Winter 는 정상 동작.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join as pj, dirname } from 'node:path';

// winter3 루트 상대 경로로 resolve (bg-job-notify 방식: 절대경로 직접 참조).
// WINTER3_HOME 환경변수 우선, 없으면 이 파일 위치에서 3단계 상위:
//   server/hooks/lesson-trigger.js → server/hooks/ → server/ → winter3/
const WINTER3_HOME = process.env.WINTER3_HOME
  || dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const TRIGGERS_PATH = pj(WINTER3_HOME, 'data', 'lesson-triggers.json');

// 세션당 주입 dedup — key = lesson id.
// 프로세스 스코프 (commit-policy-gate 동일 패턴).
const injectedLessons = new Set();

// 도구 트리거에서 마킹된 lesson id → 다음 UserPromptSubmit 에서 주입.
// Set 이라 중복 없음.
const pendingToolLessons = new Set();

// 트리거 목록 캐시 — 매 hook 호출마다 파일 re-read 는 낭비.
// 단 파일 변경 시 서버 재시작으로 반영 (의도된 설계 — hot-reload 복잡도 제거).
let _triggersCache = null;

function loadTriggers() {
  if (_triggersCache !== null) return _triggersCache;
  try {
    if (!fs.existsSync(TRIGGERS_PATH)) {
      _triggersCache = [];
      return _triggersCache;
    }
    const raw = fs.readFileSync(TRIGGERS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    _triggersCache = Array.isArray(parsed.triggers) ? parsed.triggers : [];
  } catch {
    // json 파싱 실패 — 조용히 빈 배열. hook 자체는 살아있음.
    _triggersCache = [];
  }
  return _triggersCache;
}

function buildInjectionText(trigger) {
  try {
    const parts = [`[lesson:${trigger.id}]`];
    if (trigger.lesson) parts.push(trigger.lesson);
    if (Array.isArray(trigger.refs) && trigger.refs.length > 0) {
      parts.push(`refs: ${trigger.refs.join(', ')}`);
    }
    return parts.join('\n');
  } catch {
    return `[lesson:${trigger.id}]`;
  }
}

// ── hook1: PreToolUse — tool 트리거 매칭 시 pending 마킹 (block 금지, 항상 {}) ──────
export function makeLessonToolMarker() {
  return async function lessonToolMarker(input) {
    try {
      const toolName = input?.tool_name;
      if (!toolName) return {};

      const triggers = loadTriggers();
      if (triggers.length === 0) return {};

      // tool_input 전체를 JSON 문자열로 직렬화해서 regex 매칭.
      let inputStr;
      try {
        inputStr = JSON.stringify(input?.tool_input ?? {});
      } catch {
        return {};
      }

      for (const trigger of triggers) {
        try {
          if (!trigger.enabled) continue;
          if (trigger.type !== 'tool') continue;
          if (trigger.tool && trigger.tool !== toolName) continue;
          if (injectedLessons.has(trigger.id)) continue; // 이미 주입됨

          if (trigger.inputPattern) {
            let re;
            try {
              re = new RegExp(trigger.inputPattern);
            } catch {
              // regex 에러 — 이 트리거만 skip, 다른 건 계속.
              continue;
            }
            if (!re.test(inputStr)) continue;
          }

          // 매칭 — pending 마킹.
          pendingToolLessons.add(trigger.id);
          try {
            process.stderr.write(`[lesson-trigger] tool trigger 매칭: id=${trigger.id}\n`);
          } catch { /* noop */ }
        } catch {
          // 개별 트리거 처리 실패 → 무시.
        }
      }
    } catch { /* fail-open */ }
    return {};
  };
}

// ── hook2: UserPromptSubmit — prompt 트리거 매칭 + pending tool lesson 주입 ────────
export function makeLessonPromptHook() {
  return async function lessonPromptHook(input) {
    try {
      const triggers = loadTriggers();
      const toInject = []; // 이번 턴에 주입할 lesson id 목록.

      // (a) pending tool lesson 소비.
      for (const id of pendingToolLessons) {
        if (!injectedLessons.has(id)) {
          toInject.push(id);
        }
      }
      pendingToolLessons.clear();

      // (b) prompt keyword 트리거.
      const prompt = (typeof input?.prompt === 'string') ? input.prompt : '';
      if (prompt && triggers.length > 0) {
        for (const trigger of triggers) {
          try {
            if (!trigger.enabled) continue;
            if (trigger.type !== 'prompt') continue;
            if (injectedLessons.has(trigger.id)) continue;
            if (toInject.includes(trigger.id)) continue;

            if (Array.isArray(trigger.keywords) && trigger.keywords.length > 0) {
              const lower = prompt.toLowerCase();
              const matched = trigger.keywords.some(kw =>
                typeof kw === 'string' && lower.includes(kw.toLowerCase())
              );
              if (!matched) continue;
            }

            toInject.push(trigger.id);
            try {
              process.stderr.write(`[lesson-trigger] prompt trigger 매칭: id=${trigger.id}\n`);
            } catch { /* noop */ }
          } catch {
            // 개별 트리거 처리 실패 → 무시.
          }
        }
      }

      if (toInject.length === 0) return {};

      // 주입 텍스트 조립.
      const triggerMap = new Map(triggers.map(t => [t.id, t]));
      const parts = ['[lesson-trigger 자동 주입]'];
      for (const id of toInject) {
        const trigger = triggerMap.get(id);
        if (!trigger) continue;
        try {
          parts.push(buildInjectionText(trigger));
          injectedLessons.add(id); // 주입 확정 후 dedup 마킹.
        } catch { /* skip */ }
      }

      if (parts.length <= 1) return {};

      const text = parts.join('\n\n');

      return {
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: text,
        },
      };
    } catch {
      // 최외곽 안전망.
      return {};
    }
  };
}
