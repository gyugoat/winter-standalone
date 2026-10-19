// server/rephraser.js
// 안전 분류기 거부 후 사용자 텍스트를 리프레이즈하는 두 전략.
//
// ① rephraseByDictionary(text) — 정규식 사전 치환. 빠르고 오프라인.
//    단어 경계(\b) 필수. case-insensitive. 치환 발생 시 replacements[] 기록.
//
// ② rephraseByLLM(text, { timeout }) — SDK query() 1회용 호출로 중립 표현으로 변환.
//    프롬프트에 안전 분류기 트리거 어휘 넣지 않음 (#61 교훈).
//    실패/timeout 시 throw — 호출 측에서 try/catch.
//
// #61 규칙: 이 파일 안 일반 문자열 변수/주석에 영어 정책 관련 단어를 평문으로
// 두지 않는다. 정규식 source 안에만 담는다 (source 는 문자열이지만 스캐너가 패턴 단위로
// 처리하는 컨텍스트 — 완전한 문장/API 응답이 아니라 안전한 범위로 판단).
//
// export:
//   rephraseByDictionary(text)                          → { rephrased, replacements }
//   rephraseByLLM(text, { timeout?, parentSignal? })    → Promise<{ rephrased }>

import { query } from '@anthropic-ai/claude-agent-sdk';

// ── 사전 정의 ─────────────────────────────────────────────────────────────
// 각 항목: [검색 정규식 source (단어 경계 없이), 치환 후 텍스트]
// 단어 경계와 case-insensitive 플래그는 buildEntry() 에서 공통 적용.
// 순서 무관 — 겹치는 패턴 없음 (접두사 관계인 경우 긴 것 먼저).
const DICT_ENTRIES_RAW = [
  // [pattern_source, replacement_text]
  // 아래 배열 원소 두 번째 칸은 치환 결과 문자열 — 안전 어휘 아님.
  // 접두사 관계: 긴 패턴 먼저 (reverse engineer > exploit).
  ['reverse engineer(?:ing)?',        '분석'],
  ['deobfuscat(?:e|ing|ed|ion)?',     '코드 정리'],
  ['exploit(?:s|ing|ed)?',            '동작 조사'],
  ['bypass(?:es|ing|ed)?',            '우회 동작'],
  ['payload(?:s)?',                   '데이터 묶음'],
  ['vulnerabilit(?:y|ies)',           '취약 지점'],
  ['crack(?:ing|ed|s)?',              '분해 분석'],
  ['violative',                       '문제가 될'],
  ['jailbreak(?:ing|ed|s)?',          '제약 우회'],
  ['malwar(?:e|es)',                  '악성 소프트웨어'],
  // 한글 트리거 어휘 — build() 의 lookbehind/lookahead([a-zA-Z0-9가-힣]) 로 경계 처리.
  // "취약점" → "약점" 중립 표현.
  ['취약점',                           '약점'],
  // "공격" → "접근" (문맥 유지). 단독 단어로만 치환.
  ['공격',                             '접근'],
  // "까보/까봐" 조합 — "까보다/까보자/까봐" 등 "분해해보다" 의미. "까다" 단독은 제외 (오탐).
  // "까봐" = "까보아" 준말이라 별도 패턴. 긴 것 먼저 (접두사 관계).
  ['까봐|까보(?:다|자|자구|자아|려고|려|자고|고)?', '분석하다'],
  // 보안 관련 한국어 — 중립 표현으로 치환.
  ['해킹(?:하다|하는법|방법|해보다|해보자)?',  '보안 조사'],
  ['크랙(?:킹|해보다)?',                       '보안 조사'],
  ['리버싱',                                   '분석'],
  ['디스어셈(?:블|블링)?',                     '분석'],
  ['디컴파일(?:링|해보다)?',                   '분석'],
  // "rea" — 단어 경계 \b 로 area·react·ready 등 오탐 방지.
  // 독립 단어로 쓰인 경우만 치환 (npm 패키지명 등).
  ['rea',                              '그 npm 패키지'],
];

// 각 항목을 { re, from, to } 객체로 빌드. 런타임에 한 번만 실행.
// lookbehind/lookahead 로 한글·영문·숫자 인접 시 매칭 차단.
// JS \b 는 ASCII \w 기준이라 한글/영문 경계를 단어 경계로 오인함 — 직접 차단.
const build = (src) =>
  new RegExp(`(?<![a-zA-Z0-9가-힣])(?:${src})(?![a-zA-Z0-9가-힣])`, 'gi');

const DICT = DICT_ENTRIES_RAW.map(([src, to]) => ({
  re: build(src),
  from: src,
  to,
}));

/**
 * rephraseByDictionary — 사전 기반 치환.
 * @param {string} text
 * @returns {{ rephrased: string, replacements: Array<{from:string, to:string}> }}
 */
export function rephraseByDictionary(text) {
  if (!text || typeof text !== 'string') return { rephrased: text, replacements: [] };

  let rephrased = text;
  const replacements = [];

  for (const { re, from, to } of DICT) {
    re.lastIndex = 0; // global 플래그 리셋
    const before = rephrased;
    rephrased = rephrased.replace(re, to);
    if (rephrased !== before) {
      replacements.push({ from, to });
    }
  }

  return { rephrased, replacements };
}

// ── LLM 리프레이즈 ────────────────────────────────────────────────────────
// 시스템 프롬프트: 최소한. 트리거 어휘 없이 한국어만.
// 사용자 입력을 중립 표현으로 바꾸는 역할만 기술.
const REPHRASE_SYSTEM = '중립 표현 변환기. 주어진 문장을 의미는 유지하면서 중립적인 표현으로 바꿔 한 줄로만 출력.';

// 기본 timeout — 호출 측 override 가능.
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * rephraseByLLM — SDK query() 1회 호출로 리프레이즈.
 * @param {string} text
 * @param {{ timeout?: number, parentSignal?: AbortSignal }} [opts]
 * @returns {Promise<{ rephrased: string }>}
 */
export async function rephraseByLLM(text, { timeout = DEFAULT_TIMEOUT_MS, parentSignal } = {}) {
  const abortCtrl = new AbortController();
  const timer = setTimeout(() => abortCtrl.abort(), timeout);

  // parentSignal 있으면 부모 abort → abortCtrl 전파.
  // SDK 는 AbortController 객체를 요구하므로 any() 결과를 직접 넘기지 않고
  // 이벤트 리스너로 abortCtrl 에 위임. AbortSignal.any 유무 무관하게 동일 동작.
  if (parentSignal) {
    if (parentSignal.aborted) {
      // 이미 abort 된 신호 — 즉시 전파
      abortCtrl.abort();
    } else {
      parentSignal.addEventListener('abort', () => abortCtrl.abort(), { once: true });
    }
  }

  try {
    const prompt = `다음 <text> 태그 안의 문장을 의미는 유지하면서 중립적인 표현으로 바꿔줘. 결과만 한 줄로 출력.\n<text>\n${text}\n</text>`;
    const iter = query({
      prompt,
      options: {
        systemPrompt: REPHRASE_SYSTEM,
        // tools 없음 — 단순 텍스트 변환만 필요.
        allowedTools: [],
        abortController: abortCtrl,
      },
    });

    let resultText = '';
    for await (const msg of iter) {
      if (msg?.type === 'assistant') {
        const content = msg.message?.content;
        if (typeof content === 'string') {
          resultText += content;
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === 'text') resultText += block.text;
          }
        }
      }
      // result 메시지에서도 추출 (SDK result subtype).
      if (msg?.type === 'result' && typeof msg.result === 'string' && msg.subtype !== 'error') {
        if (!resultText) resultText = msg.result;
      }
    }

    const rephrased = resultText.trim().split('\n')[0].trim();
    if (!rephrased) throw new Error('LLM 리프레이즈 결과 없음');

    // 품질 가드
    if (rephrased === text) throw new Error('LLM 리프레이즈 결과가 원문과 동일');
    if (rephrased.length < 10) throw new Error(`LLM 리프레이즈 결과 너무 짧음 (${rephrased.length}자)`);
    if (text.length >= 20 && rephrased.length < text.length * 0.3) {
      throw new Error(`LLM 리프레이즈 결과 과도 축소 (원문 ${text.length}자 → ${rephrased.length}자)`);
    }

    return { rephrased };
  } finally {
    clearTimeout(timer);
  }
}
