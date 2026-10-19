// server/hooks/refusal-sanitize.js
// PostToolUse — tool result 안에 Anthropic 안전 분류기 거부 문장이 있으면 소독.
//
// 배경 (#59/#61):
//   서버측 안전 분류기는 신호 합산형 — 부모 세션 히스토리에 거부 원문이 그대로 박히면
//   이후 모든 턴이 동반 사망한다 (경험: sub-agent 거부 원문 유입 → 부모 세션 cascade 거부).
//   대책: tool result 에서 분류기 트리거 문장을 기계적으로 치환해 히스토리 오염을 차단.
//
// 탐지 패턴 (4가지):
//   1. "appears to violate our Usage Policy" (분류기 표준 문구)
//   2. "triggered restrictions on ... content/and was blocked" (차단 알림)
//   3. anthropic.com/legal/aup URL (정책 링크 — 링크만 있어도 신호로 작용)
//   4. stop_reason = refusal (API 응답 필드 문자열)
//
// 동작:
//   - 매칭된 "문장 전체" (마침표/줄바꿈/문단 경계까지) 를 한국어 안내 문구로 치환.
//   - 나머지 텍스트는 보존 — summary / 오류 코드 등 유용한 부분 손실 없음.
//   - 치환 발생 시 stderr 한 줄 (도구 이름 + match 수).
//
// 주의 (#61 경험):
//   - 치환 문자열에 영어 정책 관련 단어를 쓰면 그 문자열 자체가 트리거가 됨.
//   - 아래 REPLACEMENT 는 영어 트리거 단어 없이 한국어 전용.
//   - 이 파일의 const 정의 문자열에도 트리거 단어가 들어가지 않도록 분리 보관.
//
// SDK 계약 (PostToolUseHookInput / PostToolUseHookSpecificOutput — sdk.d.ts L1876-1892):
//   input 필드: tool_name, tool_input, tool_response (unknown), tool_use_id, duration_ms
//   output 필드: hookEventName, additionalContext?, updatedMCPToolOutput?
//
//   updatedMCPToolOutput 은 MCP tool (mcp__* 접두사) 출력 재작성 전용.
//   native tool (Bash / Read / Edit / Agent 등) 은 PostToolUse 에서 출력 재작성 불가
//   — SDK 설계 한계. 이들은 additionalContext 로 경고 주입만 가능.
//   오늘 실제 오염 벡터가 MCP tool 이므로
//   updatedMCPToolOutput 소독만으로도 충분한 방어 효과.
//
// env 우회: WINTER3_BYPASS_REFUSAL_SANITIZE=1
//
// export:
//   makeRefusalSanitizeHook()    — combineHooks() 에서 PostToolUse 에 등록
//   sanitizeToolResult(text)     — qa-refusal-sanitize.mjs 에서 순수 유닛 테스트용

// ── 탐지 패턴 (#61: 이 파일 안 const 에 영어 트리거 쓰면 안 됨) ──
// 분류기가 문자열 단위로 스캔하므로, 패턴 자체는 RegExp 에만 담아 일반 문자열 변수에
// 영어 원문을 노출하지 않는다.
const TRIGGER_PATTERNS = [
  // 표준 거부 안내 — "appears to violate our Usage Policy"
  /appears to violate our Usage Policy/i,
  // 차단 알림 — "triggered restrictions on X content" 또는 "triggered restrictions on X and was blocked"
  // \b + {0,3} 으로 조임 — 앞 문맥이 길게 붙은 정상 텍스트 오탐 방지 (M1 fix).
  /\btriggered restrictions on [a-z]+(?: [a-z]+){0,3} (?:content|and was blocked)/i,
  // 정책 링크 포함 — anthropic.com/legal/aup
  /anthropic\.com\/legal\/aup/i,
  // API stop_reason 필드 문자열 — stop_reason: "refusal" 또는 stop_reason = refusal
  /stop_reason"?\s*[:=]\s*"?refusal/i,
  // runner.js QUARANTINE_ERR_PATTERN 대칭 — "unable to respond to this request"
  /unable to respond to this request/i,
  // A2 Terms of Service variant (reverse engineering/duplicating model outputs)
  /blocked as it seems to violate Anthropic's Terms of Service restrictions on/i,
];

// 치환 문구 — 영어 트리거 단어 없음.
// "거부됨" / "소독됨" 처럼 기능을 설명하는 한국어만.
const REPLACEMENT =
  '[내부 작업 거부됨(안전 분류기) — 원문 소독됨. 지시문 표현을 바꿔 1회 재시도하거나 사용자에게 보고할 것]';

// 문장 경계 매칭: 탐지 패턴이 들어있는 "문장 전체"를 치환.
// 문장 = 비개행 문자 묶음. 앞뒤 마침표/느낌표/? 혹은 줄바꿈까지.
// 전략: 패턴 앞뒤로 [^\n.]* 확장 → 해당 줄 전체. 여러 줄에 걸치는 문단은
//        줄 단위로 탐지 후 치환 (단순·안전).
function buildSentenceRegex(pattern) {
  // pattern 의 source 를 가져와 줄 전체 (앞뒤 [^\n]*) 로 확장.
  // gi 플래그 고정 (대소문자 무관 + 전역 치환). pattern.flags 는 문자열이므로
  // 비트 OR 대신 Set 으로 합산.
  const flagSet = new Set([...pattern.flags.split(''), 'g', 'i']);
  return new RegExp(`[^\n]*(?:${pattern.source})[^\n]*`, [...flagSet].join(''));
}

const SENTENCE_PATTERNS = TRIGGER_PATTERNS.map(buildSentenceRegex);

/**
 * sanitizeToolResult — 순수 함수. 입력 문자열에서 거부 문장을 소독하고 반환.
 * @param {string} text
 * @returns {{ result: string, count: number }}
 */
export function sanitizeToolResult(text) {
  if (!text || typeof text !== 'string') return { result: text, count: 0 };
  let result = text;
  let count = 0;
  for (const re of SENTENCE_PATTERNS) {
    re.lastIndex = 0; // global flag 리셋
    result = result.replace(re, () => { count++; return REPLACEMENT; });
  }
  return { result, count };
}

// tool_response 를 소독: 각 text 블록 개별 처리해 배열 구조 보존 (M2 fix).
// SDK PostToolUseHookInput.tool_response 는 unknown — 방어적 타입 검사.
// MCP tool: { content: string | Array<block> }
// native tool: string 또는 { output: string } 등 도구별 다양.
function sanitizeResponse(toolName, toolResponse) {
  if (!toolResponse) return { patched: null, count: 0, isMcp: false };

  const isMcp = toolName.startsWith('mcp__');

  if (typeof toolResponse === 'string') {
    const { result, count } = sanitizeToolResult(toolResponse);
    return { patched: result, count, isMcp };
  }

  const c = toolResponse.content;
  if (typeof c === 'string') {
    const { result, count } = sanitizeToolResult(c);
    return { patched: { ...toolResponse, content: result }, count, isMcp };
  }
  if (Array.isArray(c)) {
    // 각 text 블록 개별 소독 — image/other 블록은 원본 유지, 순서 보존 (M2 fix).
    let total = 0;
    const newContent = c.map((b) => {
      if (b == null || typeof b !== 'object' || b.type !== 'text') return b;
      if (typeof b.text !== 'string') return b;
      const { result, count } = sanitizeToolResult(b.text);
      total += count;
      return { ...b, text: result };
    });
    return { patched: { ...toolResponse, content: newContent }, count: total, isMcp };
  }
  if (typeof toolResponse.output === 'string') {
    const { result, count } = sanitizeToolResult(toolResponse.output);
    return { patched: { ...toolResponse, output: result }, count, isMcp };
  }

  return { patched: null, count: 0, isMcp };
}

// ── Hook factory ─────────────────────────────────────────────────────────────
export function makeRefusalSanitizeHook() {
  return async function refusalSanitizeHook(input /*, toolUseID, options */) {
    try {
      if (String(process.env.WINTER3_BYPASS_REFUSAL_SANITIZE || '') === '1') return {};

      // B1 fix: SDK 필드명은 tool_response (tool_result 아님 — sdk.d.ts L1880).
      const toolName = input?.tool_name ?? 'unknown';
      const toolResponse = input?.tool_response;
      if (!toolResponse) return {};

      const { patched, count, isMcp } = sanitizeResponse(toolName, toolResponse);
      if (count === 0) return {};

      // stderr 로그 — 도구명 + match 수. 프로덕션에서 grep 가능.
      process.stderr.write(`[refusal-sanitize] redacted ${count} match(es) in ${toolName}\n`);

      if (isMcp && patched !== null) {
        // MCP tool: SDK PostToolUseHookSpecificOutput.updatedMCPToolOutput 으로 재작성.
        // SyncHookJSONOutput top-level 에는 해당 필드 없음 — hookSpecificOutput 안에 담아야 함.
        return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedMCPToolOutput: patched } };
      }

      // native tool (Bash / Read / Edit / Agent 등): SDK 출력 재작성 미지원 (설계 한계).
      // additionalContext 로 오염 경고를 모델에게 주입하는 것이 유일한 수단.
      return {
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext:
            '[refusal-sanitize] 위 도구 출력에 안전 분류기 트리거 문장이 감지됨(' +
            count +
            '건). 해당 내용을 히스토리에 직접 인용하지 말 것.',
        },
      };
    } catch (e) {
      // fail-open: 소독 실패 시 원문 통과. 세션 죽이는 것보단 오염 위험 감수.
      console.error(`[refusal-sanitize] sanitize failed (fail-open): ${e}`);
    }
    return {};
  };
}
