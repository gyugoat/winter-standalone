// web/js/render.js — derives UI state from raw SDK records. Client-side only.
// Bug in here? Refresh the page, re-derive. Never corrupts persistence.

import { playChime } from './chime.js';
import {
  createSoliloquyParser,
  wrapSoliloquyForMarkdown,
  stripSoliloquyMarkers,
} from './soliloquy.js';
import { buildToolDiffDOM } from './tool-diff.js';
// 인증 카드의 [계정 연결] 버튼 → 설정 패널 열기. settings.js 는 render.js 를
// import 하지 않으므로 순환 없음 (settings.js deps: chime.js, snow.js).
import { openSettings } from './settings.js';

let messagesEl, runningIndicator, runningTimerEl, killBtn, sendBtn;

const state = {
  running: false,
  runStartAt: null,
  currentAssistantBubble: null,
  currentMessageId: null,
  tools: new Map(),
  timerIntervalId: null,
  seenIds: new Set(),
  lastId: -1,
  thinkingEl: null,
  thinkingTimerId: null,
  thinkingWordIdx: 0,
  lastUserBubble: null,   // attachments 이벤트가 뒤따라올 때 붙일 타겟
  // (a) live turn 중 현재 실행 중인 tool 추적 (하위 호환 유지 — turn_end clear 에 사용).
  // Map<toolUseId, { name, summary }> — 완료(tool_result) 또는 turn_end 시 삭제.
  activeTools: new Map(),
  // tool-line 생성 시각 — 소요시간 계산용. Map<toolUseId, DOMHighResTimeStamp>.
  // reset() 시 clear. messagesEl.innerHTML='' 이 DOM 을 지우므로 별도 DOM 참조 보관 불필요.
  toolLineStartAt: new Map(),
  // A2 (2026-08-12): result 이벤트의 usage/cost 누적 — 세션 전환 시 reset() 이 clear.
  //   lastCtxTokens = 마지막 turn 의 input + cache_read + cache_creation (컨텍스트 총량)
  //   lastCacheHit  = 마지막 turn 의 cache_read / (input + cache_read + cache_creation) (0~1)
  //   sessionCost   = 세션 누적 USD (result.total_cost_usd 합산)
  //   sessionCtxMax = 세션 중 관측된 최대 컨텍스트 크기 (context growth 가시화)
  lastCtxTokens: 0,
  lastCacheHit: 0,
  sessionCost: 0,
  sessionCtxMax: 0,
  // A5 (2026-08-12): 사용자가 위로 스크롤한 상태에서 새 델타 도착 시 카운트.
  //   scroll-to-bottom 버튼에 뱃지로 노출 → 클릭 시 바닥 이동 + 리셋.
  unreadDeltaCount: 0,
  // A6: live 스트리밍 중 실시간 출력 토큰 카운터.
  //   공식 CLI 동일 방식: content_block_delta chars/4 추정 누적 + message_delta 실측 정정.
  //   liveOutputTokens = 표시값 = livePrevMsgOutput(완료 메시지 실측 합) + floor(liveMsgEst).
  //   livePrevMsgOutput = 완료된 assistant 메시지들의 output 토큰 합 (tool-use 루프 다중 메시지 대응).
  //   liveMsgEst = 현재 스트리밍 중인 메시지의 추정 토큰 (float, message_delta 실측 수신 시 폐기).
  //   liveActive = 현재 스트리밍 진행 중 여부 (pill live 세그먼트 표시 게이트).
  //   _liveRafPending = rAF 예약 중 여부 (DOM 갱신 throttle).
  liveOutputTokens: 0,
  livePrevMsgOutput: 0,
  liveMsgEst: 0,
  liveActive: false,
};

// scroll-to-bottom 버튼 캐시 (bindUI 에서 저장). 자주 접근하는데 매번 getElementById 하면 낭비.
let _scrollBtnEl = null;

// A6: live 인디케이터 DOM 갱신 throttle — rAF 예약 중일 때 중복 requestAnimationFrame 방지.
let _liveRafPending = false;

// A6: rAF throttle 로 live 인디케이터 렌더 예약 (이미 예약된 프레임이 있으면 생략).
// A6-v2 (2026-10-17 사용자): 렌더 타깃 변경 — 헤더 ctx-pill 이 아니라 turn 배지 자리 (메시지 하단).
function scheduleLiveRender() {
  if (_liveRafPending) return;
  _liveRafPending = true;
  requestAnimationFrame(() => {
    _liveRafPending = false;
    updateLiveIndicator();
  });
}

// A6-v2: 스트리밍 live 인디케이터 — thinking-row 가 떠 있는 동안(첫 텍스트 전 / 생각 중)은
// 그 row 에 "↑Nk" 세그먼트만 덧붙이고, thinking-row 가 사라진 뒤(텍스트/도구 스트리밍 중)엔
// turn 배지 자리(메시지 목록 맨 아래)에 "turn: 3.2s · ↑1.4k" live 배지를 띄운다.
// result 시점에 updateCtxFromResult 가 liveActive=false → 여기서 배지 제거,
// 직후 mkResultSummary 가 기존 최종 "turn: 11.5s" 배지를 그대로 그린다 (교체).
let _liveBadgeEl = null;

function removeLiveBadge() {
  if (_liveBadgeEl) { try { _liveBadgeEl.remove(); } catch {} _liveBadgeEl = null; }
}

// thinking-row 뒤에 ↑Nk span 부착/갱신/제거. txt='' 면 제거.
function setThinkingLiveTokens(txt) {
  if (!state.thinkingEl || !state.thinkingEl.isConnected) return;
  let span = state.thinkingEl.querySelector('.thinking-live');
  if (!txt) { if (span) span.remove(); return; }
  if (!span) {
    span = document.createElement('span');
    span.className = 'thinking-live';
    state.thinkingEl.appendChild(span);
  }
  if (span.textContent !== txt) span.textContent = txt;
}

function updateLiveIndicator() {
  if (!state.liveActive || !messagesEl) {
    removeLiveBadge();
    setThinkingLiveTokens('');
    return;
  }
  const tok = state.liveOutputTokens > 0 ? `↑${fmtTokens(state.liveOutputTokens)}` : '';
  // thinking-row 가 살아있으면 (응답 텍스트 시작 전) 그 row 의 타이머 옆에 토큰만.
  if (state.thinkingEl && state.thinkingEl.isConnected) {
    removeLiveBadge();
    setThinkingLiveTokens(tok);
    return;
  }
  // thinking-row 소멸 후 — turn 배지 자리에 live 배지.
  const elapsed = state.runStartAt ? `${((Date.now() - state.runStartAt) / 1000).toFixed(1)}s` : '';
  if (!_liveBadgeEl || !_liveBadgeEl.isConnected) {
    const el = document.createElement('div');
    el.className = 'rate-limit turn-summary turn-summary--live';
    messagesEl.appendChild(el);
    _liveBadgeEl = el;
  }
  _liveBadgeEl.textContent = `turn: ${elapsed}${tok ? ` · ${tok}` : ''}`;
  // 스트리밍 중 새 버블/카드가 뒤에 붙으면 배지를 다시 맨 아래로 (appendChild = move).
  if (messagesEl.lastElementChild !== _liveBadgeEl) messagesEl.appendChild(_liveBadgeEl);
}

// A6: content_block_delta 1건의 추정 토큰 누적 — 공식 CLI 동일 방식 (chars/4 추정 + message_delta 실측 정정).
// text_delta/input_json_delta/thinking_delta = 문자수 ÷ 4,
// thinking_delta 는 서버가 estimated_tokens 를 주면 그 값 우선,
// signature_delta = 문자수 × 0.75 를 chars 로 간주 (÷4).
function accumulateLiveEstimate(d) {
  let chars = 0;
  if (d.type === 'text_delta' && typeof d.text === 'string') {
    chars = d.text.length;
  } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
    chars = d.partial_json.length;
  } else if (d.type === 'thinking_delta') {
    const est = Number(d.estimated_tokens);
    if (Number.isFinite(est) && est > 0) {
      state.liveMsgEst += est;
      state.liveOutputTokens = state.livePrevMsgOutput + Math.floor(state.liveMsgEst);
      scheduleLiveRender();
      return;
    }
    if (typeof d.thinking === 'string') chars = d.thinking.length;
  } else if (d.type === 'signature_delta' && typeof d.signature === 'string') {
    chars = d.signature.length * 0.75;
  }
  if (chars <= 0) return;
  state.liveMsgEst += chars / 4;
  state.liveOutputTokens = state.livePrevMsgOutput + Math.floor(state.liveMsgEst);
  scheduleLiveRender();
}

// A2 pill DOM 참조 — chat-header 안 chat-title 옆(chat-meta 앞) 에 삽입.
// chat-header 오른쪽 끝에 두면 activity-view (position:fixed right:0 width:420px) 가 열려있을 때
// 그 뒤로 가려짐 (기존 layout 규칙 — chat area 우측 여백 = activity 영역). 그래서 chat-meta 앞에 둠.
let _ctxPillEl = null;
function ensureCtxPill() {
  if (_ctxPillEl && _ctxPillEl.isConnected) return _ctxPillEl;
  const header = document.getElementById('chat-header');
  if (!header) return null;
  const pill = document.createElement('span');
  pill.id = 'ctx-pill';
  pill.className = 'ctx-pill hidden';
  // 초기값은 hidden. 첫 result 이벤트 오면 값 채우고 removeClass('hidden').
  const chatMetaEl = document.getElementById('chat-meta');
  if (chatMetaEl && chatMetaEl.parentNode === header) header.insertBefore(pill, chatMetaEl);
  else header.appendChild(pill);
  _ctxPillEl = pill;
  return pill;
}

// 토큰수 → 사람이 보는 단위 (k/M). 정수 tokens.
function fmtTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}
function fmtCost(usd) {
  if (!Number.isFinite(usd) || usd <= 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

// pill 렌더 — state.lastCtx/lastCacheHit/sessionCost 기반. hidden 해제.
// A6-v2: live ↑Nk 세그먼트는 pill 에서 제거 — turn 배지 자리로 이동 (updateLiveIndicator).
function renderCtxPill() {
  const pill = ensureCtxPill();
  if (!pill) return;
  const ctx = fmtTokens(state.lastCtxTokens);
  const cache = state.lastCacheHit > 0 ? `${Math.round(state.lastCacheHit * 100)}%` : '0%';
  const cost = fmtCost(state.sessionCost);
  // 형식: "ctx 84k · cache 92% · $0.31"
  // 세그먼트별 span 구조 유지 — @media 에서 .cp-cache/.cp-cost 숨김 (모바일은 ctx 만, style.css).
  // 조립 문자열 시그니처 — 동일하면 DOM 갱신 skip (불필요한 reflow 방지).
  const sig = `ctx ${ctx} · cache ${cache} · ${cost}`;
  if (pill.dataset.sig === sig && !pill.classList.contains('hidden')) return;
  pill.dataset.sig = sig;
  // 값은 전부 fmtTokens/fmtCost/Math.round 산출 (숫자 유래) — innerHTML 안전.
  pill.innerHTML = `<span class="cp-ctx">ctx ${ctx}</span>`
    + `<span class="cp-sep cp-sep-cache"> · </span><span class="cp-cache">cache ${cache}</span>`
    + `<span class="cp-sep cp-sep-cost"> · </span><span class="cp-cost">${cost}</span>`;
  // 툴팁으로 상세 정보 노출 (마지막 턴 컨텍스트 + 세션 최대)
  pill.title = [
    `마지막 턴 컨텍스트: ${state.lastCtxTokens.toLocaleString()} tokens`,
    `cache hit: ${(state.lastCacheHit * 100).toFixed(1)}%`,
    `세션 누적 비용: $${state.sessionCost.toFixed(4)}`,
    `세션 최대 컨텍스트: ${state.sessionCtxMax.toLocaleString()} tokens`,
  ].join('\n');
  pill.classList.remove('hidden');
}

// result 이벤트의 usage 파싱 → state 누적 → pill 갱신.
// SDK: usage.input_tokens / cache_read_input_tokens / cache_creation_input_tokens 는 정수 or 없음.
// 없으면 0 처리. total_cost_usd 는 turn 단위 비용.
function updateCtxFromResult(raw) {
  const u = raw?.usage;
  if (u) {
    const inp = Number(u.input_tokens) || 0;
    const cr  = Number(u.cache_read_input_tokens) || 0;
    const cc  = Number(u.cache_creation_input_tokens) || 0;
    const ctx = inp + cr + cc;
    if (ctx > 0) {
      state.lastCtxTokens = ctx;
      state.lastCacheHit = cr / ctx;
      if (ctx > state.sessionCtxMax) state.sessionCtxMax = ctx;
    }
  }
  const cost = Number(raw?.total_cost_usd);
  // SDK 0.3.277+ cumulative semantics: total_cost_usd 는 세션 누적값.
  // += 로 합산하면 이중 계상 발생 → Math.max 로 단조 증가만 보장.
  if (Number.isFinite(cost) && cost > 0) state.sessionCost = Math.max(state.sessionCost, cost);
  // A6: turn 종료 — live 카운터 reset. rAF 취소는 불가(id 미보관)이나 pending 플래그만 내리면
  // 다음 rAF 콜백이 liveActive=false 를 보고 인디케이터를 제거만 하므로 무해.
  state.liveActive = false;
  state.liveOutputTokens = 0;
  state.livePrevMsgOutput = 0;
  state.liveMsgEst = 0;
  _liveRafPending = false;
  // A6-v2: live 배지 즉시 제거 — 직후 mkResultSummary 가 최종 "turn: 11.5s" 배지로 교체.
  updateLiveIndicator();
  renderCtxPill();
}

// consume() 진입 시 캡처되는 현재 record 의 ts. mkBubble 가 timestamp 표기에 사용.
// stream_event / handleStreamEvent 처럼 mkBubble 호출 경로가 rec 객체를 직접 안 받는 경우 쓰임.
let _lastRecTs = null;

// ─── 페이지네이션 상태 ────────────────────────────────────────────────────────
// winter3.catchup_info 수신 시 세팅. loadMoreHistory() 가 소비/갱신.
// 세션 전환 시 reset() 으로 전부 clear.
const _pag = {
  sid: null,               // 요청 당시 sid (cross-session 오염 가드)
  oldestTurnIndex: null,   // 다음 beforeTurn 인자
  remainingTurns: 0,
  loading: false,          // 중복 클릭 가드
};
// messagesEl 안 첫 자식으로 삽입되는 버튼 엘리먼트.
// updateEmptyState() 가 .load-more-btn 을 제외하고 카운트해 empty-state 충돌 방지.
let _loadMoreBtnEl = null;

// 독백 마커 파서는 web/js/soliloquy.js 로 분리 (DOM 무관 순수 로직 + Node 단위 테스트 공유).

// 현재 화면이 보고 있는 session id. app.js setCurrentSession 가 setViewSid 호출.
// startTimer/stopTimer 가 sid 인자와 비교 — 다른 세션 event 면 sendBtn / runningIndicator
// 등 viewport-bound UI 토글 skip. cross-session SSE 잔존이 신규 페이지의 send 버튼을
// .hidden 으로 만드는 회귀 (qa-character-agent step 6 timeout root cause Layer 3) 방어.
let _viewSid = null;
export function setViewSid(sid) { _viewSid = sid; }
export function getViewSid() { return _viewSid; }

// 이중 에러 표시 방지 — result 핸들러가 mkError 찍은 텍스트를 임시 저장.
// turn_end:error 핸들러가 동일 텍스트를 또 표시하려 할 때 skip. 다음 turn 시작 전 null 리셋.
let _lastResultErrText = null;

// rec.ts (ISO string) → "HH:MM" 표시용. 잘못된 값이면 null 반환.
function fmtTimeShort(ts) {
  if (!ts) return null;
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
}
function fmtTimeFull(ts) {
  if (!ts) return null;
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('ko-KR');
}

// bubble 옆 (sibling) 에 timestamp 노드 부착. 이미 있으면 갱신.
// bubble 의 *내부* 가 아닌 *형제* 로 두는 이유: user bubble 은 background+border 가 있어
// 시각이 박스 안에 갇혀 보임. sibling 으로 빼면 박스 밖 자유 위치 + markdown re-render 의
// `bubble.innerHTML = ''` 영향 0 (보존 로직 불필요).
function attachTimestamp(bubble, ts) {
  if (!bubble || !ts) return;
  const short = fmtTimeShort(ts);
  if (!short) return;
  // 직후 sibling 이 .bubble-time 이면 그것 갱신, 아니면 새로 만들어 끼워 넣음.
  let timeEl = bubble.nextElementSibling;
  if (!timeEl || !timeEl.classList || !timeEl.classList.contains('bubble-time')) {
    timeEl = document.createElement('div');
    timeEl.className = 'bubble-time';
    if (bubble.classList.contains('user')) timeEl.classList.add('for-user');
    else if (bubble.classList.contains('assistant')) timeEl.classList.add('for-assistant');
    else if (bubble.classList.contains('error')) timeEl.classList.add('for-error');
    if (bubble.parentNode) bubble.parentNode.insertBefore(timeEl, bubble.nextSibling);
  }
  timeEl.textContent = short;
  timeEl.title = fmtTimeFull(ts) || short;
  timeEl.dataset.ts = ts;
}

// 클립보드 복사 — secure context(HTTPS/localhost)면 navigator.clipboard,
// insecure context(LAN IP+http)면 navigator.clipboard 가 undefined 이므로
// clipboard.js 검증 방식의 execCommand fallback 사용.
// 주의: top:-9999px/opacity:0 은 execCommand('copy') false 반환을 유발 → 쓰지 말 것.
async function copyTextToClipboard(text) {
  // 1순위: secure context 의 async clipboard API
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // 2순위: 레거시 execCommand (clipboard.js fakeElem 패턴)
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.contain = 'strict';
  ta.style.position = 'absolute';
  ta.style.left = '-9999px';                         // 가로만 off-screen (세로 스크롤 점프 방지)
  const yPos = window.pageYOffset || document.documentElement.scrollTop || 0;
  ta.style.top = `${yPos}px`;                        // 현재 스크롤 위치 — focus 시 스크롤 안 튐
  ta.style.fontSize = '12pt';                        // iOS zoom 방지
  ta.style.border = '0';
  ta.style.padding = '0';
  ta.style.margin = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  ta.setSelectionRange(0, ta.value.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch (_) {
    ok = false;
  } finally {
    document.body.removeChild(ta);
  }
  if (ok) return;
  // 3순위: execCommand 도 false → 일부 브라우저는 insecure 에서도 권한 있으면 async API 동작
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    await navigator.clipboard.writeText(text);       // 실패하면 throw 전파 → 호출부 '복사 실패'
    return;
  }
  throw new Error('copy failed: execCommand=false and no async clipboard');
}

// bubble 우상단 hover 시 표시되는 copy 버튼. user/assistant 둘 다 대상 (error 는 제외).
// SVG clipboard 아이콘. 클릭 시 navigator.clipboard.writeText(bubble.textContent) + 0.9s "복사됨" feedback.
// UI-INVENTORY.md L270 의 "있으면 좋겠다" spec 구현.
function attachCopyButton(bubble) {
  if (!bubble) return;
  if (bubble.classList.contains('error')) return;
  // 중복 부착 방지 — 이미 .copy-btn 자식이 있으면 skip.
  if (bubble.querySelector(':scope > .copy-btn')) return;
  const btn = document.createElement('button');
  btn.className = 'copy-btn';
  btn.type = 'button';
  btn.title = '복사';
  btn.setAttribute('aria-label', '메시지 복사');
  // SVG clipboard outline (현재 색 inherit 으로 currentColor)
  btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    // bubble 내 .copy-btn 자체 텍스트 제외하고 가져옴 — innerText 가 hidden/visibility 처리되지만
    // copy-btn 의 svg 는 보이는 상태라 같이 들어갈 수 있음. 안전하게 clone 후 .copy-btn 제거.
    const clone = bubble.cloneNode(true);
    clone.querySelectorAll('.copy-btn').forEach((n) => n.remove());
    const text = (clone.innerText || clone.textContent || '').trim();
    try {
      await copyTextToClipboard(text);
      btn.classList.add('copied');
      btn.title = '복사됨';
      setTimeout(() => { btn.classList.remove('copied'); btn.title = '복사'; }, 900);
    } catch {
      btn.classList.add('failed');
      btn.title = '복사 실패';
      setTimeout(() => { btn.classList.remove('failed'); btn.title = '복사'; }, 1500);
    }
  });
  bubble.appendChild(btn);
}

// A1 (2026-08-12): highlight.js 적용 — attachCodeCopyButtons 와 같은 후단 (markdown 재렌더 시점)에서.
// hljs 는 index.html 에서 로컬 vendor 로 로드 (오프라인 OK). 로드 실패해도 UI 안 깨지게 typeof 가드.
// soliloquy 는 marked 렌더 이전 wrapSoliloquyForMarkdown 에서 <span class="soliloquy"> 로 이미 치환됐고
// 그 span 은 code block 밖에서 이뤄지므로 hljs 가 code block 내부만 건드리는 한 충돌 없음.
// 독백 안에 코드블록이 있는 경우 — <span class="soliloquy"><pre><code>...</code></pre></span> 형태.
// span 안 pre 도 querySelectorAll('pre') 로 잡히고 hljs.highlightElement 는 정상 동작 (span 부모 무관).
function highlightCodeBlocks(container) {
  if (!container) return;
  if (typeof window.hljs === 'undefined') return;   // vendor 로드 실패 — silently skip.
  const codes = container.querySelectorAll('pre > code');
  codes.forEach((code) => {
    // 중복 하이라이트 방지 — hljs 는 이미 처리한 element 에 data-highlighted="yes" 마킹.
    if (code.dataset.highlighted === 'yes') return;
    // 언어 힌트 — marked 는 fenced ```lang 을 <code class="language-lang"> 로 낸다. hljs 는 그걸 인식.
    try { window.hljs.highlightElement(code); }
    catch (e) { /* 언어 미지원 / 파싱 실패 — 원문 유지 */ }
  });
}

// 코드 블록 (`<pre>`) 우상단 copy 버튼. markdown 렌더 후 호출.
// 코드 본문 (보통 `<pre><code>...</code></pre>`) 만 복사 — pre 직속 텍스트 우선, 없으면 pre.textContent.
function attachCodeCopyButtons(container) {
  if (!container) return;
  const pres = container.querySelectorAll('pre');
  pres.forEach((pre) => {
    if (pre.querySelector(':scope > .code-copy-btn')) return; // 이미 박힘
    pre.classList.add('has-copy');
    const btn = document.createElement('button');
    btn.className = 'code-copy-btn';
    btn.type = 'button';
    btn.title = '코드 복사';
    btn.setAttribute('aria-label', '코드 블록 복사');
    btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const code = pre.querySelector('code');
      const text = (code ? code.innerText : pre.innerText) || pre.textContent || '';
      try {
        await copyTextToClipboard(text);
        btn.classList.add('copied');
        btn.title = '복사됨';
        setTimeout(() => { btn.classList.remove('copied'); btn.title = '코드 복사'; }, 900);
      } catch {
        btn.classList.add('failed');
        btn.title = '복사 실패';
        setTimeout(() => { btn.classList.remove('failed'); btn.title = '코드 복사'; }, 1500);
      }
    });
    pre.appendChild(btn);
  });
}

// 이미지 풀스크린 프리뷰 — 클릭 시 모달.
function openImagePreview(url, name) {
  let modal = document.getElementById('image-preview-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'image-preview-modal';
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });
    document.body.appendChild(modal);
  }
  modal.innerHTML = '';
  const img = document.createElement('img');
  img.src = url;
  img.alt = name || '';
  img.addEventListener('click', (e) => { e.stopPropagation(); /* 이미지 자체 클릭엔 닫지 않음 */ });
  modal.appendChild(img);
  const close = document.createElement('button');
  close.className = 'image-preview-close';
  close.textContent = '✕';
  close.title = '닫기 (Esc)';
  close.addEventListener('click', () => modal.classList.add('hidden'));
  modal.appendChild(close);
  modal.classList.remove('hidden');
  // Esc 로 닫기
  const onEsc = (e) => {
    if (e.key === 'Escape') { modal.classList.add('hidden'); window.removeEventListener('keydown', onEsc); }
  };
  window.addEventListener('keydown', onEsc);
}
// 외부에서 쓸 수 있게 export (app.js staging thumb 클릭도 이거 사용)
if (typeof window !== 'undefined') window.__winter3_openImagePreview = openImagePreview;

// 빛나는 diamond 인디케이터. winter v2 / Claude CLI "thinking" 느낌.
const THINKING_WORDS = [
  'Thinking', 'Pondering', 'Analyzing', 'Brewing', 'Processing',
  'Reasoning', 'Synthesizing', 'Searching', 'Computing', 'Crafting',
];

function mkThinkingRow() {
  if (state.thinkingEl && state.thinkingEl.isConnected) return state.thinkingEl;
  const row = document.createElement('div');
  row.className = 'thinking-row';
  const dia = document.createElement('span'); dia.className = 'thinking-diamond';
  const txt = document.createElement('span'); txt.className = 'thinking-text';
  txt.textContent = THINKING_WORDS[0];
  // .thinking-tool 힌트 span 은 tool-line 으로 대체 — 생성하지 않음.
  const timer = document.createElement('span'); timer.className = 'thinking-timer';
  timer.textContent = '0.0s';
  row.appendChild(dia); row.appendChild(txt); row.appendChild(timer);
  messagesEl.appendChild(row);
  state.thinkingEl = row;
  scrollToBottom();

  // 2.2초마다 단어 로테이션
  state.thinkingWordIdx = 0;
  clearInterval(state.thinkingTimerId);
  state.thinkingTimerId = setInterval(() => {
    if (!state.thinkingEl || !state.thinkingEl.isConnected) return;
    state.thinkingWordIdx = (state.thinkingWordIdx + 1) % THINKING_WORDS.length;
    state.thinkingEl.querySelector('.thinking-text').textContent = THINKING_WORDS[state.thinkingWordIdx];
  }, 2200);
  return row;
}

function removeThinkingRow() {
  if (state.thinkingEl) {
    try { state.thinkingEl.remove(); } catch {}
    state.thinkingEl = null;
  }
  if (state.thinkingTimerId) { clearInterval(state.thinkingTimerId); state.thinkingTimerId = null; }
}

function updateThinkingTimer() {
  if (!state.thinkingEl || !state.runStartAt) return;
  const t = state.thinkingEl.querySelector('.thinking-timer');
  if (!t) return;
  const elapsed = (Date.now() - state.runStartAt) / 1000;
  t.textContent = `${elapsed.toFixed(1)}s`;
}

// ── tool 요약 + tool-line DOM ──────────────────────────────────────────────
// toolSummaryFromNameInput: input 확정 시점(snapshot)에서 호출. mkToolLine 이 재사용.

function toolSummaryFromNameInput(name, input) {
  try {
    if (!input || typeof input !== 'object') return name;
    if (name === 'Bash') {
      if (typeof input.description === 'string' && input.description.trim())
        return `Bash — ${input.description.trim().slice(0, 60)}`;
      if (typeof input.command === 'string')
        return `Bash — ${input.command.trim().slice(0, 60)}`;
    }
    if (name === 'Edit' || name === 'Write' || name === 'Read' || name === 'NotebookRead' || name === 'NotebookEdit') {
      if (typeof input.file_path === 'string') {
        const parts = input.file_path.replace(/\\/g, '/').split('/').filter(Boolean);
        const seg = parts.slice(-2).join('/');
        return `${name} — ${seg || input.file_path}`;
      }
    }
    if (name === 'MultiEdit') {
      if (typeof input.file_path === 'string') {
        const parts = input.file_path.replace(/\\/g, '/').split('/').filter(Boolean);
        const seg = parts.slice(-2).join('/');
        return `Edit — ${seg || input.file_path}`;
      }
    }
    if (name === 'Agent' || name === 'Task') {
      const sub = input.subagent_type || 'agent';
      const desc = typeof input.description === 'string' ? input.description.slice(0, 40) : '';
      return `Agent — ${sub}${desc ? ': ' + desc : ''}`;
    }
    if (name === 'Grep') {
      if (typeof input.pattern === 'string')
        return `Grep — ${input.pattern.slice(0, 60)}`;
    }
    if (name === 'Glob') {
      if (typeof input.pattern === 'string')
        return `Glob — ${input.pattern.slice(0, 60)}`;
    }
    if (name === 'WebSearch' || name === 'WebFetch') {
      const q = input.query || input.url || '';
      if (q) return `${name} — ${String(q).slice(0, 60)}`;
    }
    return name;
  } catch { return name; }
}

// thinking-tool 힌트는 tool-line 으로 대체. 호출부 제거 없이 no-op 으로 유지.
function updateThinkingToolHint() { /* no-op — replaced by tool-line */ }

// ── openToolDetail 주입 (app.js 가 boot 시 activity.js 의 openToolDetailById 를 연결) ──
// circular dependency 방지: render.js 는 activity.js 를 import 안 하고, 함수 참조만 받음.
let _toolDetailFn = null;
export function setToolDetailHandler(fn) { _toolDetailFn = fn; }

// ── tool-group: 연속 tool-line 들을 헤더+바디 컨테이너로 묶기 ─────────────────
//
// DOM 구조:
//   .tool-group[data-expanded="false"]
//     .tg-header                          (항상 보임, 클릭으로 toggle)
//       .tg-icon                          (⟳ 실행 중 / ✓ 완료 / ✗ 실패)
//       .tg-label                         (실행 중: 최신 tool 요약 / 완료: "작업 N건")
//       .tg-count                         ((N) 표시)
//     .tg-body                            (tool-line 목록, 기본 접힘)
//       .tool-line ...
//
// 함수:
//   _mkToolGroupEl()          — 그룹 DOM 생성 (container append 없음)
//   ensureToolGroup(container) — container 의 lastElementChild 가 .tool-group 이면
//                                 재사용, 아니면 새 그룹 만들어 append 후 반환.
//   updateGroupHeader(group)  — 바디 내 line 들을 스캔해 헤더 갱신.
//   finalizeGroup(group)      — 실행 완료 시 최종 헤더 갱신 (✓/✗ 전환).

function _mkToolGroupEl() {
  const group = document.createElement('div');
  group.className = 'tool-group';
  group.dataset.expanded = 'false';   // 기본 접힘

  const header = document.createElement('div');
  header.className = 'tg-header';

  const icon = document.createElement('span');
  icon.className = 'tg-icon';
  icon.textContent = '⟳';

  const label = document.createElement('span');
  label.className = 'tg-label';

  const count = document.createElement('span');
  count.className = 'tg-count';

  header.appendChild(icon);
  header.appendChild(label);
  header.appendChild(count);

  const body = document.createElement('div');
  body.className = 'tg-body';

  group.appendChild(header);
  group.appendChild(body);

  // 헤더 클릭 → expand/collapse toggle
  header.addEventListener('click', () => {
    const expanded = group.dataset.expanded === 'true';
    group.dataset.expanded = expanded ? 'false' : 'true';
  });

  return group;
}

// container (messagesEl 또는 DocumentFragment) 에서 마지막 .tool-group 을 반환하거나 새로 생성.
// frag 경로는 container 가 DocumentFragment 이므로 lastChild 기준 탐색 (querySelector 미지원).
function ensureToolGroup(container) {
  let last;
  if (container.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
    // frag: childNodes 역순으로 tool-group 찾기
    const nodes = container.childNodes;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (n.nodeType === Node.ELEMENT_NODE && n.classList.contains('tool-group')) {
        last = n;
        break;
      }
    }
  } else {
    // messagesEl: lastElementChild
    const lc = container.lastElementChild;
    if (lc && lc.classList.contains('tool-group')) last = lc;
  }
  if (last) return last;

  const group = _mkToolGroupEl();
  container.appendChild(group);
  return group;
}

// 그룹 헤더를 body 안 tool-line 들의 현재 상태에 맞게 갱신.
function updateGroupHeader(group) {
  const body = group.querySelector('.tg-body');
  if (!body) return;
  const lines = body.querySelectorAll('.tool-line');
  const total = lines.length;
  const icon = group.querySelector('.tg-icon');
  const label = group.querySelector('.tg-label');
  const count = group.querySelector('.tg-count');
  if (!icon || !label || !count) return;

  // spinner 가 남아있으면 실행 중
  const spinners = body.querySelectorAll('.tl-spinner');
  const running = spinners.length > 0;

  if (running) {
    // 가장 마지막 tool-line 의 .tl-summary 텍스트 노출
    let latestSummary = '';
    const allLines = [...lines];
    for (let i = allLines.length - 1; i >= 0; i--) {
      const s = allLines[i].querySelector('.tl-summary');
      if (s && s.textContent) { latestSummary = s.textContent; break; }
    }
    icon.textContent = '⟳';
    icon.className = 'tg-icon tg-icon-running';
    label.textContent = latestSummary || '실행 중';
    count.textContent = total > 1 ? `(${total})` : '';
  } else {
    // 완료 — 오류 수 집계
    const errCount = body.querySelectorAll('.tl-err').length;
    icon.textContent = errCount > 0 ? '✗' : '✓';
    icon.className = errCount > 0 ? 'tg-icon tg-icon-err' : 'tg-icon tg-icon-done';
    if (errCount > 0) {
      label.textContent = `작업 ${total}건 (${errCount} 실패)`;
    } else {
      label.textContent = `작업 ${total}건`;
    }
    count.textContent = '';
  }
}

// ── tool-line: 채팅 흐름에 tool 호출 하나당 영구 한 줄 ────────────────────
//
// mkToolLine(id, name, summary, catchup)
//   id      — tool_use id (dedup 키, dataset.toolUseId)
//   name    — tool 이름 (Bash / Edit / …)
//   summary — toolSummaryFromNameInput 결과 (input 확정 후 호출)
//   catchup — true 면 스피너 애니메이션 억제 (replay 경로)
//
// DOM 구조:
//   .tool-line[data-tool-use-id]
//     .tl-spinner          (회전 또는 정적 dot)
//     .tl-summary          (monospace 요약 텍스트)
//     .tl-elapsed          (완료 후 소요시간 / aborted)
//
// 완료/aborted 처리: finalizeToolLine(id, isError, label)
//   .tl-spinner → .tl-done(✓) or .tl-err(✗)
//   .tl-elapsed 에 소요시간 또는 "aborted"

// DocumentFragment 는 querySelector 미지원 — 하위 트리에서 data-tool-use-id 탐색.
// tool-group > tg-body > tool-line 구조도 커버.
function _fragFindToolLine(frag, id) {
  function search(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    if (node.dataset && node.dataset.toolUseId === id) return node;
    for (const child of node.childNodes) {
      const found = search(child);
      if (found) return found;
    }
    return null;
  }
  for (const child of frag.childNodes) {
    const found = search(child);
    if (found) return found;
  }
  return null;
}

// tool-line 엘리먼트 생성만 담당 (container 에 append 안 함).
// renderHistoryRecords 의 fragment 경로에서 재사용.
function _mkToolLineEl(id, name, summary, catchup) {
  const line = document.createElement('div');
  line.className = 'tool-line';
  line.dataset.toolUseId = id;

  const spinner = document.createElement('span');
  spinner.className = catchup ? 'tl-spinner tl-catchup' : 'tl-spinner';

  const sumEl = document.createElement('span');
  sumEl.className = 'tl-summary';
  sumEl.textContent = summary || name || 'tool';  // textContent — XSS 방지

  const elapsed = document.createElement('span');
  elapsed.className = 'tl-elapsed';

  line.appendChild(spinner);
  line.appendChild(sumEl);
  line.appendChild(elapsed);

  // B: 클릭 → activity 모달 (openToolDetailById 주입 경로)
  line.addEventListener('click', (e) => {
    e.stopPropagation(); // tg-header toggle 이벤트 차단
    if (_toolDetailFn) _toolDetailFn(id);
  });

  return line;
}

function mkToolLine(id, name, summary, catchup) {
  if (!messagesEl) return;
  // dedup — 같은 id 의 라인이 이미 존재하면 skip (SSE 재연결 replay 대비).
  if (messagesEl.querySelector(`.tool-line[data-tool-use-id="${CSS.escape(id)}"]`)) return;

  const line = _mkToolLineEl(id, name, summary, catchup);

  // tool-group: messagesEl 의 마지막 child 가 .tool-group 이면 재사용, 아니면 새 그룹 생성.
  const group = ensureToolGroup(messagesEl);
  group.querySelector('.tg-body').appendChild(line);
  updateGroupHeader(group);

  // 생성 시각 기록 — finalizeToolLine 에서 소요시간 계산.
  // catchup(SSE replay) 시에는 덮어쓰지 않음 — 라이브 때 찍힌 startAt 보존.
  if (!catchup) state.toolLineStartAt.set(id, Date.now());

  if (!catchup) scrollToBottom();
}

// tool_result 도착 또는 turn_end 비정상 시 호출.
// isError: true → ✗ 빨강 / false → ✓ 초록.
// elapsedLabel: 이미 계산된 문자열(예: "1.2s") — 없으면 toolLineStartAt 에서 계산.
function finalizeToolLine(id, isError, elapsedLabel) {
  if (!messagesEl) return;
  const line = messagesEl.querySelector(`.tool-line[data-tool-use-id="${CSS.escape(id)}"]`);
  if (!line) return;
  const spinner = line.querySelector('.tl-spinner');
  if (spinner) {
    spinner.className = isError ? 'tl-err' : 'tl-done';
    spinner.textContent = isError ? '✗' : '✓';
  }
  const elEl = line.querySelector('.tl-elapsed');
  if (elEl) {
    if (elapsedLabel) {
      elEl.textContent = elapsedLabel;
    } else {
      const startAt = state.toolLineStartAt.get(id);
      if (startAt != null) {
        const sec = ((Date.now() - startAt) / 1000).toFixed(1);
        elEl.textContent = `${sec}s`;
      }
    }
  }
  state.toolLineStartAt.delete(id);

  // 소속 tool-group 헤더 갱신 (완료 상태 반영)
  const group = line.closest('.tool-group');
  if (group) updateGroupHeader(group);
}

export function bindUI() {
  messagesEl = document.getElementById('messages');
  runningIndicator = document.getElementById('running-indicator');
  runningTimerEl = document.getElementById('running-timer');
  killBtn = document.getElementById('kill');
  sendBtn = document.getElementById('send');
  _scrollBtnEl = document.getElementById('scroll-to-bottom');
  attachScrollListener();
  // scroll-to-bottom 버튼 클릭 시 강제 하단 + autoFollow on + 새 메시지 뱃지 리셋 (A5)
  _scrollBtnEl?.addEventListener('click', () => {
    resetUnreadDelta();
    resetAutoFollow();
  });
}

// A5: 사용자가 위에 있을 때 새 델타 도착하면 카운트 증가 + 버튼에 뱃지 노출.
// 카운트 늘 때마다 버튼 dataset 갱신 → CSS ::after 로 그림.
function bumpUnreadDelta() {
  state.unreadDeltaCount += 1;
  if (!_scrollBtnEl) return;
  _scrollBtnEl.dataset.unread = String(state.unreadDeltaCount);
  _scrollBtnEl.classList.add('has-unread');
  // 접근성용 aria-label 도 갱신 — "최신으로 (5개 새 메시지)"
  _scrollBtnEl.setAttribute('aria-label', `최신으로 스크롤 — 새 메시지 ${state.unreadDeltaCount}개`);
}

function resetUnreadDelta() {
  state.unreadDeltaCount = 0;
  if (!_scrollBtnEl) return;
  delete _scrollBtnEl.dataset.unread;
  _scrollBtnEl.classList.remove('has-unread');
  _scrollBtnEl.setAttribute('aria-label', '최신으로 스크롤');
}

export function reset() {
  if (!messagesEl) return;
  messagesEl.innerHTML = '';
  state.running = false;
  state.runStartAt = null;
  state.currentAssistantBubble = null;
  state.tools.clear();
  state.activeTools.clear();
  state.toolLineStartAt.clear();
  state.seenIds.clear();
  state.lastId = -1;
  state.thinkingEl = null;
  if (state.thinkingTimerId) { clearInterval(state.thinkingTimerId); state.thinkingTimerId = null; }
  stopTimer();
  runningIndicator.classList.add('hidden');
  killBtn.classList.add('hidden');
  sendBtn.classList.remove('hidden');
  // 페이지네이션 상태 초기화 — messagesEl.innerHTML='' 이 버튼도 같이 지우므로 별도 DOM 조작 불필요.
  // 이전 세션의 늦은 fetch 응답이 새 세션에 섞이지 않도록 sid 도 함께 clear.
  _pag.sid = null;
  _pag.oldestTurnIndex = null;
  _pag.remainingTurns = 0;
  _pag.loading = false;
  _loadMoreBtnEl = null;
  // A2 pill state — 세션마다 별도. hidden 처리 (첫 result 시 다시 나타남).
  state.lastCtxTokens = 0;
  state.lastCacheHit = 0;
  state.sessionCost = 0;
  state.sessionCtxMax = 0;
  if (_ctxPillEl) _ctxPillEl.classList.add('hidden');
  // A5 unread delta 카운트 리셋.
  resetUnreadDelta();
  // 세션 전환 시 이전 turn 의 result 에러 텍스트 잔존 방지.
  _lastResultErrText = null;
  // 세션 전환 시 오디오 게이트 닫힘 — startCatchup 보다 먼저 불리는 방어선.
  _audioLive = false;
  // A6: live 카운터 reset — 세션 전환 시 이전 세션 스트리밍 잔존 방지.
  state.liveActive = false;
  state.liveOutputTokens = 0;
  state.livePrevMsgOutput = 0;
  state.liveMsgEst = 0;
  _liveRafPending = false;
  // A6-v2: live 배지 DOM 은 위 messagesEl.innerHTML='' 로 이미 소거 — 참조만 clear.
  _liveBadgeEl = null;
}

// Drunken scroll 방지 (demo #13 lesson): 유저가 위로 스크롤해서 읽는 중이면 자동 스크롤 pause.
// bottom 80px 이내 = near bottom = 자동 팔로우.
let _autoFollow = true;
let _lastProgrammaticAt = 0;

// Catchup 모드 — 세션 진입 직후 SSE replay 동안 모든 scroll 호출을 no-op + messagesEl 가림.
// finishCatchup() 시점에 한 번만 instant jump → visible. (사용자 신고 "3초 lag")
let _catchup = false;
let _catchupSafetyTimer = null;

// 오디오 전용 게이트 — winter3.catchup_done marker 수신 시에만 true.
// _catchup (visual) 과 분리: visual 은 800ms 안전망/250ms idle 휴리스틱으로 조기 해제돼도 되지만
// (화면 영구 가림 방지), 오디오가 같은 휴리스틱을 타면 무거운 세션 재진입 replay 가 800ms 를
// 넘는 순간 남은 과거 turn_end/injected 가 live 오인 → done.wav 연발 (사용자 신고 2026-10-03
// "세션 토글마다 확인해줘 chime"). chime-bus 의 marker-only 게이트 (#39 V3) 와 동일 원칙.
let _audioLive = false;

export function startCatchup() {
  _catchup = true;
  _audioLive = false; // 세션 진입 replay 시작 — marker 전까지 무조건 mute.
  if (messagesEl) messagesEl.classList.add('catching-up');
  // 안전망 — 800ms 안엔 무조건 끝낸다 (라이브 진행 중 세션이라 record 끊임없이 와도 화면 영구 가림 방지).
  // 주의: 이 타이머는 visual (_catchup) 만 푼다. _audioLive 는 marker 로만 열림.
  if (_catchupSafetyTimer) clearTimeout(_catchupSafetyTimer);
  _catchupSafetyTimer = setTimeout(() => finishCatchup(), 800);
}

export function finishCatchup() {
  if (!_catchup) return;
  _catchup = false;
  if (_catchupSafetyTimer) { clearTimeout(_catchupSafetyTimer); _catchupSafetyTimer = null; }
  _autoFollow = true;
  if (messagesEl) {
    // 한 번만 instant jump — smooth animation 안 탐.
    messagesEl.scrollTop = messagesEl.scrollHeight;
    messagesEl.classList.remove('catching-up');
  }
}

export function isCatchup() { return _catchup; }

function isNearBottom() {
  if (!messagesEl) return true;
  return (messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight) < 80;
}

function scrollToBottom() {
  // catchup 동안엔 매 record scroll 호출 모두 무시 — finishCatchup 이 한 번에 점프.
  if (_catchup) return;
  // A5 (oracle 지적 강화): 사용자가 위에 있으면 자동 스크롤 X + 새 델타 카운트 증가.
  // 기존 코드는 return 만 하고 사용자에게 아무 알림 없어서 "왔는지도 모름" 이 문제.
  if (!_autoFollow) {
    // 위에 있음 + 이미 진짜로 위 (near bottom 아님) 일 때만 카운트. double-guard: 극단적 edge case
    // (autoFollow=false 인데 스크롤이 이미 하단) 오카운트 방지.
    if (!isNearBottom()) bumpUnreadDelta();
    return;
  }
  _lastProgrammaticAt = Date.now();
  requestAnimationFrame(() => {
    if (!messagesEl) return;
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });
}

export function resetAutoFollow() {
  _autoFollow = true;
  // 즉시 강제 스크롤 — 새 턴 시작 시
  if (messagesEl) {
    requestAnimationFrame(() => { messagesEl.scrollTop = messagesEl.scrollHeight; });
  }
  // 새 메시지 뱃지도 리셋 — 새 턴 시작 시엔 unread 개념 무의미.
  resetUnreadDelta();
}

// bindUI 시점에 scroll 이벤트 attach.
function attachScrollListener() {
  if (!messagesEl) return;
  // 버튼 visibility 는 항상 near-bottom 여부로. programmatic 가드는 autoFollow 에만 적용.
  const onScroll = () => {
    const nearBottom = isNearBottom();
    const btn = _scrollBtnEl || document.getElementById('scroll-to-bottom');
    if (btn) btn.classList.toggle('hidden', nearBottom);
    // A5 — 사용자가 스크롤로 바닥 재도달 시 unread 뱃지 리셋.
    if (nearBottom) resetUnreadDelta();
    if (Date.now() - _lastProgrammaticAt < 80) return;
    _autoFollow = nearBottom;
  };
  messagesEl.addEventListener('scroll', onScroll);
  // 사용자 의도 이벤트 — wheel/touchmove 는 programmatic 가드 무시. 즉시 autoFollow 갱신.
  const onUserIntent = () => {
    const nearBottom = isNearBottom();
    _autoFollow = nearBottom;
    const btn = _scrollBtnEl || document.getElementById('scroll-to-bottom');
    if (btn) btn.classList.toggle('hidden', nearBottom);
    if (nearBottom) resetUnreadDelta();
  };
  messagesEl.addEventListener('wheel', onUserIntent, { passive: true });
  messagesEl.addEventListener('touchmove', onUserIntent, { passive: true });
}

function startTimer(fromTs, sid) {
  stopTimer(sid);
  state.runStartAt = fromTs || Date.now();
  state.running = true;
  // sid 가드 — 현재 보고 있는 session 의 event 일 때만 viewport UI 토글.
  // sid 인자가 없으면 (legacy 콜) 이전 동작 유지 = isViewing true.
  const isViewing = (!sid || sid === _viewSid);
  if (isViewing) {
    runningIndicator.classList.remove('hidden');
    killBtn.classList.remove('hidden');
    sendBtn.classList.add('hidden');
    mkThinkingRow();
  }
  const tick = () => {
    const elapsed = (Date.now() - state.runStartAt) / 1000;
    if (isViewing && runningTimerEl) runningTimerEl.textContent = `${elapsed.toFixed(1)}s`;
    if (isViewing) updateThinkingTimer();
    // A6-v2: live 배지 경과시간 갱신 — 기존 100ms tick 재사용 (별도 타이머 불필요).
    // liveActive=false 면 updateLiveIndicator 가 배지 제거만 하므로 무해.
    if (isViewing) updateLiveIndicator();
  };
  tick();
  state.timerIntervalId = setInterval(tick, 100);
}

function stopTimer(sid) {
  if (state.timerIntervalId) { clearInterval(state.timerIntervalId); state.timerIntervalId = null; }
  state.running = false;
  const isViewing = (!sid || sid === _viewSid);
  if (isViewing) {
    runningIndicator.classList.add('hidden');
    killBtn.classList.add('hidden');
    sendBtn.classList.remove('hidden');
    removeThinkingRow();
    // A6-v2: result 없이 끝나는 경로 (kill/error) 에서도 live 배지 잔존 방지.
    removeLiveBadge();
  }
  // 메시지 큐 flush 알림 — app.js 가 listener 로 다음 큐 머리 1개 발사.
  // sid 무관하게 발사 (turn-end 자체는 항상 알림 — app.js 측 큐가 isTurnRunning 으로 가드).
  try { window.dispatchEvent(new CustomEvent('winter3:turn-end')); } catch {}
}

function mkBubble(role, text = '', ts = null) {
  const el = document.createElement('div');
  el.className = `bubble ${role}`;
  if (text) el.textContent = text;
  // assistant bubble 등장 시 thinking row 를 이 버블 앞에 유지하지 않고 제거 (이미 응답 시작됨)
  if (role === 'assistant' && state.thinkingEl) {
    // 단, thinking row 는 "대답 시작 전" 만 보여야 자연스러움. 첫 text_delta 시 한 번 제거.
    removeThinkingRow();
  }
  messagesEl.appendChild(el);
  // timestamp — append 후 sibling 으로 부착 (parentNode 필요).
  const stamp = ts || _lastRecTs;
  if (stamp) attachTimestamp(el, stamp);
  // copy 버튼 — bubble 우상단 hover 시 표시 (user/assistant). error 는 attachCopyButton 안에서 skip.
  attachCopyButton(el);
  // empty-state 숨김
  const empty = document.getElementById('empty-state');
  if (empty && !empty.classList.contains('hidden')) empty.classList.add('hidden');
  scrollToBottom();
  return el;
}

function mkToolCard(id, name) {
  // 메인 채팅에는 tool 카드 표시하지 않는다 — Activity 패널이 도구 카드 + 카운트 + 모달 전담.
  // thinking-row 도 유지 (도구 실행 중 = 여전히 처리 중) → "멈춤" 오판 방지 (#3) 충족.
  // detached element 로 만들어서 finalizeTool / handleAssistantSnapshot 의 cardEl·inputEl·resultEl
  // 참조 로직은 그대로 살려둔다 (NPE 방지).
  const card = document.createElement('div');
  card.className = 'tool-card';
  card.dataset.toolUseId = id;
  const header = document.createElement('div');
  header.className = 'tool-header';
  const spinner = document.createElement('span'); spinner.className = 'spinner';
  const label = document.createElement('span'); label.textContent = name || 'tool';
  const latency = document.createElement('span'); latency.className = 'tool-latency';
  header.appendChild(spinner); header.appendChild(label); header.appendChild(latency);
  const input = document.createElement('div'); input.className = 'tool-input';
  card.appendChild(header);
  card.appendChild(input);
  // ★ messagesEl.appendChild(card) — 의도적 제거. 메인 채팅 visual noise 차단.
  return { cardEl: card, headerEl: header, inputEl: input, resultEl: null, startAt: Date.now(), latencyEl: latency };
}

function finalizeTool(entry, resultText, isError) {
  if (!entry) return;
  entry.headerEl.classList.add(isError ? 'error' : 'done');
  const elapsed = ((Date.now() - entry.startAt) / 1000).toFixed(1);
  entry.latencyEl.textContent = `${elapsed}s`;
  if (resultText) {
    if (!entry.resultEl) {
      entry.resultEl = document.createElement('div'); entry.resultEl.className = 'tool-result';
      entry.cardEl.appendChild(entry.resultEl);
    }
    entry.resultEl.textContent = resultText.slice(0, 2000);
  }
}

function pretty(obj) {
  try { return JSON.stringify(obj, null, 2); } catch { return String(obj); }
}

// ── (b) Edit/Write diff 렌더 ──────────────────────────────────────────────
// DOM 빌드 로직은 tool-diff.js 로 분리. 여기서는 entry.inputEl 교체만 담당.

// entry.inputEl 을 diff DOM 으로 교체.
// try/catch 로 감싸서 input 이 partial/비정상이면 기존 JSON 표시 유지.
function renderToolDiff(entry, toolName, input) {
  try {
    if (!entry || !input || typeof input !== 'object') return false;

    // inputEl 을 이미 diff 로 교체했으면 재실행 방지 (snapshot 이 여러번 올 수 있음).
    if (entry.inputEl.dataset.diffRendered === '1') return true;

    const diffEl = buildToolDiffDOM(toolName, input);
    if (!diffEl) return false;

    entry.inputEl.innerHTML = '';
    entry.inputEl.className = 'tool-diff';
    entry.inputEl.appendChild(diffEl);
    entry.inputEl.dataset.diffRendered = '1';
    return true;
  } catch { return false; }
}

function handleStreamEvent(ev) {
  if (!ev || typeof ev !== 'object') return;
  if (ev.type === 'message_start') {
    // 새 assistant 메시지 시작 — msgId 저장해서 뒤의 content_block_start/delta/assistant snapshot 이
    // 같은 버블 엘리먼트를 찾아갈 수 있게.
    state.currentMessageId = ev.message?.id || null;
    // A6: 새 메시지 시작 — 현재 메시지 추정치만 reset.
    // (이전 메시지 완료분 합산은 message_delta 의 실측 정정이 담당.)
    state.liveMsgEst = 0;
    // liveActive 시작.
    state.liveActive = !isCatchup();
    // message_start.message.usage 로 ctx/cache 즉시 갱신 (turn 시작 시점 입력 토큰 최신화).
    const u = ev.message?.usage;
    if (u && state.liveActive) {
      const inp = Number(u.input_tokens) || 0;
      const cr  = Number(u.cache_read_input_tokens) || 0;
      const cc  = Number(u.cache_creation_input_tokens) || 0;
      const ctx = inp + cr + cc;
      if (ctx > 0) {
        state.lastCtxTokens = ctx;
        state.lastCacheHit = cr / ctx;
        if (ctx > state.sessionCtxMax) state.sessionCtxMax = ctx;
        renderCtxPill();
      }
    }
    return;
  }
  if (ev.type === 'message_delta') {
    // A6: 메시지 종료 시 1회 수신 — 현재 메시지 추정치(liveMsgEst)를 버리고
    // 실측 usage.output_tokens 로 정정 (공식 CLI 동일 방식: chars/4 추정 + message_delta 실측 정정).
    // 실측이 없으면 추정분 승계.
    if (state.liveActive) {
      state.livePrevMsgOutput += Number(ev.usage?.output_tokens) || Math.floor(state.liveMsgEst);
      state.liveMsgEst = 0;
      state.liveOutputTokens = state.livePrevMsgOutput;
      scheduleLiveRender();
    }
    return;
  }
  if (ev.type === 'content_block_start') {
    const cb = ev.content_block;
    if (cb?.type === 'text') {
      state.currentAssistantBubble = mkBubble('assistant');
      if (state.currentMessageId) state.currentAssistantBubble.dataset.msgId = state.currentMessageId;
    } else if (cb?.type === 'tool_use') {
      const id = cb.id;
      if (id && !state.tools.has(id)) {
        state.tools.set(id, mkToolCard(id, cb.name));
      }
      // (a) live turn 에서만 activeTools 에 등록 → thinking-row 힌트 갱신.
      // input 은 이 시점엔 {} (스트리밍 미완) 이므로 name 만으로 초기 요약.
      if (id && !isCatchup()) {
        state.activeTools.set(id, { name: cb.name || '', summary: cb.name || 'tool' });
        updateThinkingToolHint();
      }
      // A new tool block ends the current assistant bubble.
      state.currentAssistantBubble = null;
    } else if (cb?.type === 'thinking') {
      // Anthropic encrypts reasoning body. We rely on injected system-prompt
      // narrative rule instead — first sentence of next text block is plaintext self-narrative.
    }
    return;
  }
  if (ev.type === 'content_block_delta') {
    const d = ev.delta;
    if (!d) return;
    if (d.type === 'text_delta' && typeof d.text === 'string') {
      if (!state.currentAssistantBubble) state.currentAssistantBubble = mkBubble('assistant');
      // 독백 마커 streaming 파서로 누적 — 마커가 delta 경계에 걸쳐도 버퍼링 후 확정.
      feedSoliloquyDelta(state.currentAssistantBubble, d.text);
      scrollToBottom();
    }
    // A6: 스트리밍 중 라이브 토큰 추정 누적 (liveActive 가드 — catchup 중 무시).
    if (state.liveActive) accumulateLiveEstimate(d);
    return;
  }
  if (ev.type === 'message_stop') {
    // 버블에 hold 중이던 잔여 텍스트(마커 prefix 로 오인돼 대기 중이던 것) flush.
    if (state.currentAssistantBubble) flushSoliloquyPending(state.currentAssistantBubble);
    state.currentAssistantBubble = null;
  }
}

// ── 독백 마커 streaming → DOM emit ─────────────────────────────────────
// 파싱 로직은 soliloquy.js (DOM 무관, Node 테스트 공유). 여기선 segment 를 받아 DOM 에만 그린다.
// 버블별 파서 인스턴스(_soliParser) + 현재 활성 독백 span(_soliContainer) lazy init.
function feedSoliloquyDelta(bubble, deltaText) {
  if (!bubble._soliParser) { bubble._soliParser = createSoliloquyParser(); bubble._soliContainer = null; }
  for (const seg of bubble._soliParser.push(deltaText)) emitSoliloquySegment(bubble, seg);
}

// segment { text, soliloquy } → 현재 모드에 맞는 컨테이너에 textNode append.
// 같은 모드 연속이면 같은 컨테이너 재사용, 모드 전환 시 컨테이너 리셋.
function emitSoliloquySegment(bubble, seg) {
  if (!seg.text) return;
  if (seg.soliloquy) {
    let c = bubble._soliContainer;
    if (!c || !c.classList || !c.classList.contains('soliloquy')) {
      c = document.createElement('span');
      c.className = 'soliloquy';
      bubble.appendChild(c);
      bubble._soliContainer = c;
    }
    c.appendChild(document.createTextNode(seg.text));
  } else {
    bubble.appendChild(document.createTextNode(seg.text));
    bubble._soliContainer = null;
  }
}

// 스트림 종료 시 hold 중이던 잔여를 현재 모드로 강제 출력 (마커 prefix 오인분 회수).
function flushSoliloquyPending(bubble) {
  if (!bubble._soliParser) return;
  for (const seg of bubble._soliParser.flush()) emitSoliloquySegment(bubble, seg);
}

// marked del tokenizer override — ~~두 개일 때만~~ 취소선, 물결 1개는 리터럴.
// GFM 기본값은 ~one~ 도 취소선으로 처리하는데, 한국어 범위 표기(80~100분)가
// 오인식되는 문제를 방지한다.
// window.marked 존재 확인 후 모듈 로드 시 1회만 등록 (중복 등록 방지 가드).
let _markedDelOverrideInstalled = false;
function installMarkedDelOverride() {
  if (_markedDelOverrideInstalled) return;
  if (typeof window.marked === 'undefined') return;
  window.marked.use({
    tokenizer: {
      del(src) {
        // ~~text~~ 두 개일 때만 취소선. 물결 1개(~text~)는 text 토큰으로 강제 반환.
        // false 반환은 built-in fallback 을 허용하므로 사용 불가.
        // undefined(토큰 미반환) 도 blocked 이 되므로, 1개짜리는 text 토큰을 직접 생성.
        const doubleTilde = /^~~(?=[^\s~])((?:\\.|[^\\])*?)~~/.exec(src);
        if (doubleTilde) {
          return {
            type: 'del',
            raw: doubleTilde[0],
            text: doubleTilde[1],
            tokens: this.lexer.inlineTokens(doubleTilde[1]),
          };
        }
        // 물결 1개짜리 패턴 — text 토큰으로 소비해 built-in del 이 먹지 못하게 함.
        const singleTilde = /^~(?=[^\s~])((?:\\.|[^\\])*?)~/.exec(src);
        if (singleTilde) {
          return {
            type: 'text',
            raw: singleTilde[0],
            text: singleTilde[0],
          };
        }
        // 어떤 패턴도 아니면 undefined → built-in del 도 실행되지 않음 (그냥 ~ 리터럴).
        return undefined;
      },
    },
  });
  _markedDelOverrideInstalled = true;
}

// markdown 렌더링 (marked + DOMPurify 는 CDN 으로 index.html 에서 로드)
function mdToHtml(text) {
  try {
    if (typeof window.marked === 'undefined' || typeof window.DOMPurify === 'undefined') {
      return null;  // 라이브러리 로드 안 됐으면 fallback (raw text 유지)
    }
    installMarkedDelOverride();
    const raw = window.marked.parse(text, { gfm: true, breaks: true });
    return window.DOMPurify.sanitize(raw);
  } catch { return null; }
}

// 스트리밍 완료된 text 블록을 markdown 으로 재렌더. 통일된 스타일.
// timestamp 는 sibling 이라 innerHTML wipe 와 무관 — 별도 보존 불필요.
// copy-btn 은 bubble 자식이라 wipe 영향 — 보존 후 재부착.
function renderMarkdownInBubble(bubble, fullText) {
  if (!bubble || typeof fullText !== 'string') return;
  // copy-btn 자식 보존 (innerHTML wipe 가 자식 다 날림)
  const copyBtn = bubble.querySelector(':scope > .copy-btn');
  bubble.innerHTML = '';
  bubble.classList.add('markdown-rendered');
  // 독백 마커를 <span class="soliloquy"> 로 치환 후 markdown 파싱.
  // marked 가 span 을 inline HTML 로 통과시키고 DOMPurify 가 span+class 허용 → 최종 truth.
  const wrapped = wrapSoliloquyForMarkdown(fullText);
  const html = mdToHtml(wrapped);
  const container = document.createElement('div');
  container.className = 'md-body';
  if (html !== null) container.innerHTML = html;
  // fallback(markdown 라이브러리 미로드): 마커 문자는 제거해 노출 방지, 독백 스타일은 포기.
  else container.textContent = stripSoliloquyMarkers(fullText);
  bubble.appendChild(container);
  // 보존된 copy-btn 재부착, 없으면 새로 부착 (중복 가드 있음)
  if (copyBtn) bubble.appendChild(copyBtn);
  else attachCopyButton(bubble);
  // 코드 블록 마다 copy 버튼 부착 (markdown 으로 그려진 <pre> 들)
  attachCodeCopyButtons(container);
  // A1: syntax highlight — 순서상 attachCodeCopyButtons 후에 해도 무방. hljs 는 <code> 텍스트만 손댐.
  highlightCodeBlocks(container);
}

function handleAssistantSnapshot(raw) {
  const content = raw?.message?.content;
  const msgId = raw?.message?.id;
  if (!Array.isArray(content)) return;

  // 이 메시지에 속한 assistant 버블들 (content_block_start text 에서 dataset.msgId 부착된 것)
  const bubbles = msgId
    ? [...document.querySelectorAll(`.bubble.assistant[data-msg-id="${CSS.escape(msgId)}"]`)]
    : [];
  // 텍스트 블록만 골라 순서대로 버블에 매핑.
  const textBlocks = content.filter((c) => c?.type === 'text' && typeof c.text === 'string');
  for (let i = 0; i < textBlocks.length; i++) {
    let bubble = bubbles[i];
    if (!bubble) {
      // 스트림 퇴화 (content_block_start/text_delta 미도착) fallback — snapshot 이 유일한 truth 일 때 직접 생성.
      // dataset.msgId 를 박아야 같은 msgId 의 후속 snapshot 이 이 버블을 찾아 재렌더 (중복 버블 방지).
      bubble = mkBubble('assistant');
      if (msgId) bubble.dataset.msgId = msgId;
    }
    renderMarkdownInBubble(bubble, textBlocks[i].text);
  }

  // tool_use 블록 — input 확정 (snapshot) 시점 처리.
  for (const c of content) {
    if (c?.type === 'tool_use' && c.id) {
      let entry = state.tools.get(c.id);
      if (!entry) {
        entry = mkToolCard(c.id, c.name);
        state.tools.set(c.id, entry);
      }
      if (c.input !== undefined) {
        const inputObj = typeof c.input === 'object' && c.input !== null ? c.input : null;

        // (b) Edit/Write/MultiEdit → diff 렌더. 실패 시 기존 JSON 표시 fallback.
        const diffed = (c.name === 'Edit' || c.name === 'Write' || c.name === 'MultiEdit')
          && inputObj
          && renderToolDiff(entry, c.name, inputObj);

        if (!diffed) {
          // 기존 JSON 표시 (diff 미해당 tool 또는 diff 렌더 실패 시)
          if (!entry.inputEl.dataset.diffRendered) {
            const txt = typeof c.input === 'string' ? c.input : pretty(c.input);
            entry.inputEl.textContent = txt.slice(0, 1200);
          }
        }

        if (c.name === 'Agent' || c.name === 'Task') {
          const hint = `${c.input?.subagent_type || 'agent'} · ${c.input?.description || ''}`.slice(0, 80);
          const labelEl = entry.headerEl.querySelector('.tool-subhint')
            || (() => {
              const el = document.createElement('span');
              el.className = 'tool-subhint';
              entry.headerEl.insertBefore(el, entry.latencyEl);
              return el;
            })();
          labelEl.textContent = hint;
        }

        // tool-line: input 확정 시점에 생성 (dedup 포함). live/catchup 양쪽.
        // catchup 판정은 isCatchup() — replay 중엔 스피너 애니 억제.
        if (inputObj) {
          const summary = toolSummaryFromNameInput(c.name, inputObj);
          mkToolLine(c.id, c.name, summary, isCatchup());
        } else {
          mkToolLine(c.id, c.name, c.name || 'tool', isCatchup());
        }

        // (a) snapshot 에서 input 확정 — activeTools 에 있는 항목의 summary 를 정확한 값으로 갱신.
        if (!isCatchup() && state.activeTools.has(c.id) && inputObj) {
          const summary = toolSummaryFromNameInput(c.name, inputObj);
          state.activeTools.get(c.id).summary = summary;
          updateThinkingToolHint();
        }
      }
    }
  }
}

function handleUserToolResult(raw) {
  const content = raw?.message?.content;
  if (!Array.isArray(content)) return;
  for (const c of content) {
    if (c?.type === 'tool_result' && c.tool_use_id) {
      const entry = state.tools.get(c.tool_use_id);
      let text = '';
      if (typeof c.content === 'string') text = c.content;
      else if (Array.isArray(c.content)) {
        text = c.content.map((x) => (x?.text ?? pretty(x))).join('\n');
      }
      finalizeTool(entry, text, !!c.is_error);
      // tool-line 완료 처리 — ✓ or ✗ + 소요시간.
      finalizeToolLine(c.tool_use_id, !!c.is_error, null);
      // (a) tool 완료 → activeTools 에서 제거 후 thinking-row 힌트 갱신.
      if (state.activeTools.has(c.tool_use_id)) {
        state.activeTools.delete(c.tool_use_id);
        updateThinkingToolHint();
      }
    }
  }
}

// rateLimitType → 짧은 라벨. SDK 가 five_hour / seven_day 외에
// seven_day_overage_included 같은 변형을 보내기 시작 (2026-10) — exact map 은 미래 값에 또 깨짐.
// prefix 매칭 + overage 는 '+ov' suffix, 그래도 모르는 값은 8자 절단. 풀 문자열은 badge.title 로.
function shortWindowLabel(t) {
  if (!t) return '—';
  const s = String(t);
  const ov = s.includes('overage') ? '+ov' : '';
  if (s.startsWith('five_hour')) return '5h' + ov;
  if (s.startsWith('seven_day')) return (s.includes('opus') ? '7d·opus' : '7d') + ov;
  return s.length > 8 ? s.slice(0, 8) + '…' : s;
}

// rate_limit_event → 사이드바 플랜 뱃지 업데이트 (채팅 영역 pill 은 제거).
function updatePlanBadge(raw) {
  const info = raw?.rate_limit_info;
  if (!info) return;
  const badge = document.getElementById('plan-badge');
  if (!badge) return;
  badge.classList.remove('hidden');
  // 창 종류
  const winLabel = shortWindowLabel(info.rateLimitType);
  // 리셋 시각
  let resetStr = '—';
  if (info.resetsAt) {
    const d = new Date(info.resetsAt * 1000);
    resetStr = d.toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
  }
  const statusMap = { allowed: 'ok', allowed_warning: 'warn', exceeded: 'over' };
  const tone = statusMap[info.status] || 'ok';
  badge.dataset.tone = tone;
  badge.querySelector('.plan-window').textContent = winLabel;
  badge.querySelector('.plan-reset').textContent = `→ ${resetStr}`;
  badge.title = `${info.rateLimitType || ''} · ${info.status || ''} · 리셋 ${resetStr}`.replace(/^ · /, '');
}

// PATCHING #103: dispatch 409 (서버 running / UI idle 불일치) 시 app.js 가 UI 를
// 서버 상태에 동기화할 때 사용 — 서버가 진실. startTimer 경로 재사용.
export function markTurnRunning(sid) {
  startTimer(Date.now(), sid);
  document.body.dataset.lastTurnReason = 'running';  // QA hook
}

// GET /usage 응답 → 사이드바 플랜 뱃지에 사용량 % 표시.
// updatePlanBadge (rate_limit_event 기반) 와 공존 — 둘 다 뱃지에 쓸 수 있음.
export function updatePlanBadgeUsage(u) {
  if (!u) return;
  const fh = u.five_hour;
  const sd = u.seven_day;
  if (fh == null && sd == null) return;

  const badge = document.getElementById('plan-badge');
  if (!badge) return;
  badge.classList.remove('hidden');

  // ── .plan-window: "5h 24% · 7d 86%" + stale 표시 ─────────────────────────
  const parts = [];
  if (fh != null) parts.push(`5h ${fh.utilization}%`);
  if (sd != null) parts.push(`7d ${sd.utilization}%`);
  let winText = parts.join(' · ');
  if (u.stale) winText += '*';
  badge.querySelector('.plan-window').textContent = winText;

  // ── .plan-reset: 더 높은 utilization 창의 resets_at ──────────────────────
  // 둘 다 있으면 높은 쪽, 하나만 있으면 그쪽.
  let dominant = null;
  if (fh != null && sd != null) {
    dominant = (fh.utilization >= sd.utilization) ? { win: 'fh', data: fh } : { win: 'sd', data: sd };
  } else if (fh != null) {
    dominant = { win: 'fh', data: fh };
  } else {
    dominant = { win: 'sd', data: sd };
  }
  let resetStr = '—';
  if (dominant.data.resets_at) {
    const d = new Date(dominant.data.resets_at);
    if (!isNaN(d)) {
      if (dominant.win === 'sd') {
        // 날짜 포함: 10/14 09:00
        const mo = d.toLocaleString('ko-KR', { month: 'numeric' });
        const dy = d.toLocaleString('ko-KR', { day: 'numeric' });
        const tm = d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
        resetStr = `${mo}/${dy} ${tm}`;
      } else {
        // 시각만: 18:00
        resetStr = d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
      }
    }
  }
  badge.querySelector('.plan-reset').textContent = `→ ${resetStr}`;

  // ── tone: max utilization 기준 ────────────────────────────────────────────
  const maxUtil = Math.max(fh?.utilization ?? 0, sd?.utilization ?? 0);
  const tone = maxUtil >= 90 ? 'over' : maxUtil >= 70 ? 'warn' : 'ok';
  badge.dataset.tone = tone;

  // ── badge.title: 풀 상세 ─────────────────────────────────────────────────
  const opus = u.seven_day_opus;
  const son = u.seven_day_sonnet;
  function fmtDetail(win, label) {
    if (!win) return `${label}: —`;
    const rt = win.resets_at ? new Date(win.resets_at).toLocaleString('ko-KR') : '—';
    return `${label}: ${win.utilization}% (→ ${rt})`;
  }
  const staleMark = u.stale ? ' [stale]' : '';
  const fetchedStr = u.fetchedAt ? new Date(u.fetchedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '—';
  badge.title = [
    fmtDetail(fh, '5h'),
    fmtDetail(sd, '7d'),
    fmtDetail(opus, '7d opus'),
    fmtDetail(son, '7d sonnet'),
    `갱신: ${fetchedStr}${staleMark}`,
  ].join('\n');
}

// 인증 계열 에러 텍스트 감지 — 매치 시 raw 에러 대신 인증 카드 렌더 (방어 경로).
const AUTH_ERR_RE = /not logged in|failed to authenticate|oauth|\/login/i;

function mkError(text) {
  // 일반 error 경로 방어: 인증 에러 텍스트면 raw 대신 인증 카드.
  // rate-limit 류는 별도 raw.type 분기의 고정 한국어 문구라 이 정규식에 안 걸림.
  if (typeof text === 'string' && AUTH_ERR_RE.test(text)) {
    mkAuthAlert('Claude 계정 연결이 필요해 — 인증 에러가 감지됐어.', text);
    return;
  }
  mkBubble('error', text);
}

// 인증 실패 카드 — 설명 + [계정 연결] 버튼 (.bubble.auth-alert).
// winter3.auth_failed 이벤트 + mkError 의 인증 에러 방어 경로 양쪽에서 재사용.
// 버튼 → 설정 패널 열고 Claude 인증 섹션(#settings-sec-claude)으로 스크롤.
// catchup(replay) 에서도 동일 경로로 호출됨 — DOM 생성만 하므로 replay 안전.
function mkAuthAlert(text, detail) {
  const el = mkBubble('auth-alert', '');
  const msg = document.createElement('div');
  msg.className = 'auth-alert-msg';
  msg.textContent = text || 'Claude 계정 연결이 필요해.';
  el.appendChild(msg);
  if (detail) {
    // 원문 에러 보존 (root cause 추적용) — 흐리게, 500자 cap.
    const det = document.createElement('div');
    det.className = 'auth-alert-detail';
    det.textContent = String(detail).slice(0, 500);
    el.appendChild(det);
  }
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'auth-alert-btn';
  btn.textContent = '계정 연결';
  btn.addEventListener('click', () => {
    openSettings();
    // openSettings 직후 패널 DOM 은 동기 생성됨 — fade-in 시작 뒤 스크롤.
    setTimeout(() => {
      document.getElementById('settings-sec-claude')
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 80);
  });
  el.appendChild(btn);
  return el;
}

// ms 정수 → "3분 12초" / "45초" / "0.8초" 사람 읽기용.
function fmtDurMs(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  const totalSec = ms / 1000;
  if (totalSec < 1) return `${totalSec.toFixed(1)}초`;
  const min = Math.floor(totalSec / 60);
  const sec = Math.round(totalSec % 60);
  if (min === 0) return `${sec}초`;
  return `${min}분 ${sec}초`;
}

// resume 버튼 — autopsy 배지 또는 minimal 배지에 삽입.
// resumable reason: timeout / stalled / error (이미지 stuck 제외).
// catchup 중엔 클릭 없이 발사 안 됨 (버튼은 그려도 클릭 핸들러가 isCatchup 가드).
// user_prompt 도착 시 disableAllResumeButtons() 로 일괄 disable.
function _mkResumeButton() {
  const btn = document.createElement('button');
  btn.className = 'autopsy-resume';
  btn.textContent = '이어서 재개';
  btn.setAttribute('aria-label', '이어서 재개');
  btn.addEventListener('click', () => {
    if (btn.disabled) return;
    if (state.running || isCatchup()) return; // turn 진행 중 또는 catchup replay 중이면 무시 (409 방지)
    btn.disabled = true;
    try {
      window.dispatchEvent(new CustomEvent('winter3:resume-turn', {
        detail: { text: 'Continue from where you left off.' },
      }));
    } catch {}
  });
  return btn;
}

// user_prompt 도착 시 과거 resume 버튼 전부 disable — 대화가 이어진 케이스.
function disableAllResumeButtons() {
  if (!messagesEl) return;
  messagesEl.querySelectorAll('.autopsy-resume:not([disabled])').forEach((btn) => {
    btn.disabled = true;
  });
}

// autopsy 배지 — turn_end 이벤트의 raw.autopsy 존재 시 메시지 영역 하단에 삽입.
// 접힘 상태: 아이콘 칩 + classification 한 줄 (경고 주황 톤).
// 클릭 시 펼침: hint + 주요 필드 상세.
// 중복 삽입 방지: data-autopsy-turn 속성으로 같은 턴에 1개 보장.
// containerEl 이 주어지면 그 뒤에 삽입, 없으면 messagesEl 하단 append.
// reason 이 resumable(timeout/stalled/error)이면 resume 버튼도 함께 삽입.
function mkAutopsyBadge(autopsy, containerEl, reason) {
  if (!autopsy || typeof autopsy !== 'object') return;
  // 중복 방지 — containerEl 또는 messagesEl 에서 이미 autopsy 배지가 있는지 확인.
  const parent = containerEl ? containerEl.parentNode || messagesEl : messagesEl;
  // autopsy 배지는 messagesEl 에 직접 삽입 (bubble sibling 아님).
  // 같은 classification 의 배지가 이미 있으면 skip (catchup replay 중복).
  const existing = parent.querySelector
    ? parent.querySelector('.autopsy-badge')
    : null;
  // 직전 형제를 찾아 중복 확인보다 dataset 으로 턴 식별이 더 안전하지 않지만,
  // messagesEl 에는 여러 autopsy 가 있을 수 있으니 마지막 자식 기준으로 확인.
  // turn_end 는 한 턴에 한 번이라 마지막 .autopsy-badge 가 현재 턴 것일 수 없음(이전 턴).
  // 그냥 DOM 삽입 허용하고, 이중 호출을 consume() 의 seenIds dedup 으로 막음.

  const badge = document.createElement('div');
  badge.className = 'autopsy-badge';
  // 2026-10-18 (#103): 턴 삼킴 (stale notification) 배지 구분 — CSS/QA 훅.
  if (autopsy.swallowed === true) badge.classList.add('autopsy-badge--swallowed');
  badge.setAttribute('aria-label', `진단: ${autopsy.classification || '알 수 없음'}`);

  // 칩 행 (접힘 상태)
  const chip = document.createElement('div');
  chip.className = 'autopsy-chip';

  const icon = document.createElement('span');
  icon.className = 'autopsy-icon';
  icon.textContent = '!';
  icon.setAttribute('aria-hidden', 'true');

  const label = document.createElement('span');
  label.className = 'autopsy-label';
  label.textContent = autopsy.classification || '알 수 없음';

  const toggle = document.createElement('span');
  toggle.className = 'autopsy-toggle';
  toggle.textContent = '▸';
  toggle.setAttribute('aria-hidden', 'true');

  chip.appendChild(icon);
  chip.appendChild(label);
  chip.appendChild(toggle);
  badge.appendChild(chip);

  // 상세 패널 (기본 hidden)
  const detail = document.createElement('div');
  detail.className = 'autopsy-detail hidden';

  // hint
  if (autopsy.hint) {
    const hintEl = document.createElement('p');
    hintEl.className = 'autopsy-hint';
    hintEl.textContent = autopsy.hint;
    detail.appendChild(hintEl);
  }

  // 주요 필드 목록
  const fields = [];
  if (autopsy.stop_reason != null)
    fields.push(['stop_reason', String(autopsy.stop_reason)]);
  if (autopsy.elapsed_ms != null) {
    const dur = fmtDurMs(autopsy.elapsed_ms);
    if (dur) fields.push(['소요시간', dur]);
  }
  if (autopsy.last_gap_ms != null)
    fields.push(['last_gap', `${autopsy.last_gap_ms}ms`]);
  if (autopsy.wall_ext != null && autopsy.wall_ext > 0)
    fields.push(['wall_ext', String(autopsy.wall_ext)]);
  if (autopsy.tool_uses != null)
    fields.push(['tool_uses', String(autopsy.tool_uses)]);
  // 2026-10-18 (#103): 턴 삼킴 상세 — 자동 재전송 여부가 핵심 정보.
  if (autopsy.swallowed === true) {
    fields.push(['턴 삼킴', autopsy.auto_resend === true ? '자동 재전송됨 (1회)' : '재전송 안 함 — 같은 메시지 다시 보내']);
    if (autopsy.stale_notifications != null)
      fields.push(['stale_notifications', String(autopsy.stale_notifications)]);
  }
  if (autopsy.err)
    fields.push(['err', String(autopsy.err).slice(0, 300)]);

  if (fields.length > 0) {
    const table = document.createElement('dl');
    table.className = 'autopsy-fields';
    for (const [k, v] of fields) {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      table.appendChild(dt);
      table.appendChild(dd);
    }
    detail.appendChild(table);
  }

  badge.appendChild(detail);

  // 클릭 토글
  chip.addEventListener('click', () => {
    const open = !detail.classList.contains('hidden');
    detail.classList.toggle('hidden', open);
    toggle.textContent = open ? '▸' : '▾';
    badge.classList.toggle('open', !open);
  });

  // resume 버튼 — resumable reason 이면 배지 옆에 삽입.
  // stuck-image error 는 새 세션 권고라 재개 의미 없음 → 제외.
  const isResumable = (reason === 'timeout' || reason === 'stalled' ||
    (reason === 'error' && !(/dimension limit|exceeds the dimension|fewer images|many-image requests/i.test(String(autopsy.err || '')))));
  if (isResumable) {
    badge.appendChild(_mkResumeButton());
  }

  messagesEl.appendChild(badge);
  scrollToBottom();
}

// autopsy 없이 resume 버튼만 있는 minimal badge — autopsy 없는 timeout/stalled/error 케이스.
function mkResumeOnlyBadge() {
  if (!messagesEl) return;
  const badge = document.createElement('div');
  badge.className = 'autopsy-badge autopsy-badge--resume-only';
  badge.appendChild(_mkResumeButton());
  messagesEl.appendChild(badge);
  scrollToBottom();
}

// turn 요약 pill — 소요시간만. 비용은 제거 (Max 플랜이라 무의미).
function mkResultSummary(raw) {
  const dur = typeof raw.duration_ms === 'number' ? `${(raw.duration_ms/1000).toFixed(1)}s` : null;
  const isErr = raw.subtype === 'error' || raw.is_error === true;
  if (!dur && !isErr) return;
  const el = document.createElement('div');
  el.className = 'rate-limit turn-summary';
  el.textContent = `turn: ${isErr ? 'error · ' : ''}${dur || ''}`;
  messagesEl.appendChild(el);
  scrollToBottom();
}

export function consume(rec) {
  const raw = rec?.raw;
  if (!raw || typeof raw !== 'object') return;
  // Dedup by record id — defense against any reconnect duplication.
  if (typeof rec.id === 'number') {
    if (state.seenIds.has(rec.id)) return;
    state.seenIds.add(rec.id);
    if (rec.id > state.lastId) state.lastId = rec.id;
  }
  // 후속 mkBubble 들이 timestamp 박을 수 있게 capture (handleStreamEvent 경로 fallback).
  if (rec.ts) _lastRecTs = rec.ts;

  // winter3.* synthetic records
  // #39 V3 — 서버 SSE catchup 끝남 명시 marker. timing-only 휴리스틱 (250ms idle / 800ms safety)
  // 보강. 큰 세션 (32MB+) replay 도중 idle 250ms 만족돼 finishCatchup 조기 발화 → 남은
  // turn_end:completed 다중 playChime 사고 (3cf72315, 2026-05-13).
  if (raw.type === 'winter3.catchup_done') {
    finishCatchup();
    _audioLive = true; // 이 시점부터만 chime 허용 (marker-only 오디오 게이트).
    return;
  }
  // 페이지네이션 — ?turns=N 으로 연결했을 때만 catchup_done 직전에 도착.
  // remainingTurns > 0 이면 "이전 N턴 더보기" 버튼을 목록 최상단에 생성.
  if (raw.type === 'winter3.catchup_info') {
    if (raw.remainingTurns > 0) {
      _pag.sid = rec.sid || _viewSid;
      _pag.oldestTurnIndex = raw.oldestSentTurnIndex;
      _pag.remainingTurns = raw.remainingTurns;
      _pag.loading = false;
      _renderLoadMoreBtn();
    }
    return;
  }
  // 외부 프로세스 (cron heartbeat 등) 가 POST /api/inject 로 꽂은 Winter 발화.
  // assistant 버블로 렌더 + source 뱃지 (예: [heartbeat]) 로 일반 응답과 구분.
  // LLM 호출 없이 events jsonl 에만 남음 (raw=truth). 카체업 replay 시에도 그대로 재현.
  if (raw.type === 'winter3.injected') {
    const bubble = mkBubble('assistant', '', rec.ts);
    bubble.classList.add('injected');
    if (raw.source) {
      const badge = document.createElement('div');
      badge.className = 'inject-source-badge';
      badge.textContent = raw.source;
      bubble.appendChild(badge);
    }
    // 텍스트는 마크다운으로 렌더 (일반 assistant 스냅샷 경로와 동일한 파이프).
    const textEl = document.createElement('div');
    textEl.className = 'inject-body';
    bubble.appendChild(textEl);
    renderMarkdownInBubble(textEl, String(raw.text || ''));
    // catchup(SSE replay) 중엔 소리 억제 — 세션 열 때 과거 injected 마다 울리는 버그 (#75/#76).
    // chime-bus 의 catchupDone 게이트와 동일 원칙 — live 도착분만 소리.
    if (_audioLive) playChime();
    scrollToBottom();
    return;
  }
  if (raw.type === 'winter3.user_prompt') {
    const bubble = mkBubble('user', raw.text || '', rec.ts);
    if (raw.researchMode === true) markResearchBubble(bubble);
    // rec.sid 는 app.js 의 openStream callback 에서 주입 (SSE record 자체엔 sid 없음).
    startTimer(Date.parse(rec.ts) || Date.now(), rec.sid);
    document.body.dataset.lastTurnReason = 'running';  // QA hook
    // 이전 resume 버튼 전부 disable — 대화가 이어졌으므로 재개 불필요.
    disableAllResumeButtons();
    // 같은 턴에 attachments 가 뒤따라 온다. 버블을 lastUserBubble 로 기억해서 거기에 thumb 붙임.
    state.lastUserBubble = bubble;
    return;
  }
  // PATCHING #103: 턴 삼킴 자동 재전송 — 서버가 turn_end(autopsy.swallowed) 직후 1.5s 뒤
  // 같은 발화를 _skipUserLog 로 재전송. user_prompt 가 다시 안 오므로 여기서 running 상태 재진입.
  // 유저 버블은 안 그림 (재전송 ≠ 새 발화) — 노트 한 줄 + startTimer 만. 안 하면 UI idle /
  // 서버 busy 불일치 → 새 메시지가 큐 안 타고 /dispatch 직행 → 409 차단.
  if (raw.type === 'winter3.stale_swallow_resend') {
    mkError('🔁 직전 턴이 삼켜져서 같은 메시지 자동 재전송 중...');
    startTimer(Date.parse(rec.ts) || Date.now(), rec.sid);
    document.body.dataset.lastTurnReason = 'running';  // QA hook
    disableAllResumeButtons();
    return;
  }
  if (raw.type === 'winter3.attachments') {
    // user bubble 에 썸네일/칩 추가. 직전에 만들어진 user bubble 타겟.
    // ref.kind: 'image' → <img> thumb, 그 외 ('document' / 'text') → 파일 칩 (다운로드 링크).
    // 구버전 events 는 kind 가 없을 수 있어 mime 으로 fallback.
    const bubble = state.lastUserBubble;
    const refs = raw.refs || [];
    if (bubble && refs.length) {
      const row = document.createElement('div');
      row.className = 'bubble-attach-row';
      for (const r of refs) {
        const mime = (r.mime || '').toLowerCase();
        const kind = r.kind || (mime.startsWith('image/') ? 'image' : (mime === 'application/pdf' ? 'document' : 'text'));
        if (kind === 'image') {
          const img = document.createElement('img');
          img.className = 'bubble-attach-thumb';
          img.src = r.url;
          img.alt = r.name || 'attachment';
          img.dataset.fullUrl = r.url;
          img.addEventListener('click', () => openImagePreview(r.url, r.name));
          row.appendChild(img);
        } else {
          const link = document.createElement('a');
          link.className = 'bubble-attach-file';
          link.href = r.url;
          link.target = '_blank';
          link.rel = 'noopener';
          link.title = `${r.name || 'attachment'} (${kind})`;
          const icon = document.createElement('span');
          icon.className = 'bubble-attach-file-icon';
          icon.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
          const nm = document.createElement('span');
          nm.className = 'bubble-attach-file-name';
          nm.textContent = r.name || 'attachment';
          link.appendChild(icon);
          link.appendChild(nm);
          row.appendChild(link);
        }
      }
      bubble.insertBefore(row, bubble.firstChild);
    }
    return;
  }
  // #39: server 가 image >5MB / dimension >1568px 등 한도 초과 첨부를 SDK 안 보내고 skip 한 경우 알림.
  if (raw.type === 'winter3.attach_skipped') {
    const items = raw.skipped || [];
    if (items.length > 0) {
      const lines = items.map((s) => {
        if (s.reason === 'image_too_large') {
          return `${s.name} — 용량 초과 (${(s.bytes / 1024 / 1024).toFixed(1)}MB > 5MB)`;
        }
        if (s.reason === 'image_dimension_too_large') {
          return `${s.name} — 크기 초과 (${s.width}x${s.height}px > 1568px). 새 세션 권장.`;
        }
        if (s.reason === 'image_dimension_unknown') {
          return `${s.name} — 이미지 크기 확인 불가로 전송 안 함 (세션 보호). 리사이즈/재인코딩 후 재첨부.`;
        }
        return `${s.name} — ${s.reason || 'skipped'}`;
      });
      mkError(`첨부 ${items.length}개 SDK 전송 안 됨:\n${lines.join('\n')}`);
    }
    return;
  }
  // #39 V2: turn_end:error 의 message 가 dimension 한도 초과 면 사용자한테 "새 세션 시작" 명확히 안내.
  // SDK 가 conversation history 에 stuck image 박혀 있으면 후속 turn 도 모두 fail — 회복 불가, 새 session 만이 답.
  if (raw.type === 'winter3.turn_end' && raw.reason === 'error' && typeof raw.error === 'string') {
    if (/dimension limit|exceeds the dimension|fewer images|too large.*image/i.test(raw.error)) {
      mkError(`⚠️ 이 세션의 conversation history 에 큰 이미지가 박혀 있어 후속 응답이 모두 실패합니다.\n좌측 사이드바 "+" 로 새 세션 시작하세요. (이전 대화 내용이 필요하면 복사해 두세요.)`);
      // 일반 turn_end:error 처리는 그대로 진행 — return 안 함, fallthrough.
    }
  }
  // 자동 격리+재시도 가시화 — #26 V2 auto_rate_limit_retry 노트 패턴 재사용.
  if (raw.type === 'winter3.turn_quarantined') {
    mkError(`🧹 직전 턴이 차단돼 기록에서 격리했어요 — 자동 재시도 중 (${raw.attempt}/${raw.max})`);
    return;
  }
  if (raw.type === 'winter3.turn_quarantine_failed') {
    const r = raw?.reason || 'unknown';
    const msg = r === 'result_error_msg'
      ? '서버 에러로 오염 턴을 지우지 못했어요'
      : r === 'stop_reason_refusal'
        ? '분류기 거부 턴을 기록에서 지우지 못했어요'
        : '격리 실패';
    mkError(`⚠️ 격리 실패 — ${msg}. 수동으로 다시 보내주세요.`);
    return;
  }
  if (raw.type === 'winter3.quarantine_exhausted') {
    mkError('격리 재시도 한도 초과 — 다른 방법으로 답을 가져올게요...');
    return;
  }
  if (raw.type === 'winter3.agent_fallback_start') {
    mkError('다른 방법으로 답을 가져올게요...');
    return;
  }
  if (raw.type === 'winter3.agent_fallback_success') {
    mkError('✅ 다른 방법으로 답을 가져왔어요');
    return;
  }
  if (raw.type === 'winter3.session_forked') {
    mkError('🔁 세션 정리됨');
    return;
  }
  if (raw.type === 'winter3.agent_fallback_failed') {
    mkError(`⚠️ fallback 도 실패 — ${raw?.error || '알 수 없는 에러'}`);
    return;
  }
  if (raw.type === 'winter3.turn_rephrased') {
    const methodLabel = raw.method === 'llm' ? 'LLM' : '사전치환';
    mkError(`📝 질문을 이렇게 바꿔서 재시도: "${raw.rephrased}" (${methodLabel})`);
    return;
  }
  // #26 V2: rate-limit retry 가시화 — 사용자가 "끝났는지 진행 중인지" 명확히.
  // server 가 retry 진행 중엔 turn_end 안 적고 lock 유지 → running indicator 그대로 + 이 노트만 추가.
  if (raw.type === 'winter3.auto_rate_limit_retry') {
    const sec = Math.round((raw.delayMs || 0) / 1000);
    const tag = raw.rateLimitType ? ` [${raw.rateLimitType}]` : '';
    const reset = raw.usedReset ? ' · reset 시각 기반' : '';
    mkError(`⏳ Anthropic API throttle — 자동 재시도 ${raw.attempt}/${raw.max} (${sec}s 후)${tag}${reset}`);
    return;
  }
  if (raw.type === 'winter3.auto_rate_limit_exhausted') {
    mkError(`API throttle — 자동 재시도 ${raw.attempts}/${raw.max} 모두 실패. 잠시 후 같은 메시지 다시 보내세요.`);
    return;
  }
  // #26 V3: 5h (또는 장기) quota 도달 — retry 자체 무의미, reset 시각 + overage 안내.
  if (raw.type === 'winter3.auto_rate_limit_quota_hit') {
    const sec = raw.secUntilReset || 0;
    const hr = Math.floor(sec / 3600);
    const min = Math.floor((sec % 3600) / 60);
    const eta = sec > 0
      ? (hr > 0 ? `${hr}시간 ${min}분 후` : `${min}분 후`)
      : '곧';
    const resetTs = raw.resetsAt
      ? new Date(raw.resetsAt * 1000).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
      : null;
    const typeLabel = raw.rateLimitType === 'five_hour' ? '5시간 quota' : (raw.rateLimitType || 'quota');
    const overage = raw.overageStatus === 'rejected'
      ? ' Anthropic 콘솔에서 overage 켜면 즉시 통과 가능.'
      : '';
    mkError(`🛑 ${typeLabel} 한도 도달 — reset ${resetTs || '미상'} (${eta}). 자동 재시도 의미 없음.${overage}`);
    return;
  }
  // 토큰 만료 / OAuth 인증 실패 — server runner 가 auth 에러 감지 시 발화.
  // 터미널 안내 대신 "계정 연결" 버튼 카드 — 설정 패널의 Claude 인증 섹션으로 유도.
  // (server: winter3.auth_failed. raw.text 는 detail 로 보존.)
  if (raw.type === 'winter3.auth_failed') {
    mkAuthAlert('Claude 계정 연결이 필요해 — 토큰이 만료됐거나 로그인이 풀렸어.', raw.text || null);
    return;
  }
  if (raw.type === 'winter3.turn_end') {
    // rec.sid 는 app.js 가 주입. mismatch 면 UI 토글 skip — 신규 페이지의 send 버튼이
    // 다른 세션의 turn_end 로 hidden 풀리거나 잘못 토글되는 회귀 방어.
    stopTimer(rec.sid);
    // (a) turn 종료 시 activeTools 전부 정리.
    if (state.activeTools.size > 0) {
      state.activeTools.clear();
      updateThinkingToolHint();
    }
    // 진행 중이던 tool card 가 남아있으면 visual 한 표시로 마감.
    for (const [id, entry] of state.tools) {
      if (!entry.headerEl.classList.contains('done') && !entry.headerEl.classList.contains('error')) {
        entry.headerEl.classList.add('error');
        const elapsed = ((Date.now() - entry.startAt) / 1000).toFixed(1);
        entry.latencyEl.textContent = `${elapsed}s (중단)`;
      }
    }
    // tool-line 중 미완료(스피너 남아있는) 것들 → ✗ aborted.
    if (messagesEl) {
      const pendingLines = messagesEl.querySelectorAll('.tool-line .tl-spinner');
      pendingLines.forEach((spinner) => {
        const line = spinner.closest('.tool-line');
        if (!line) return;
        const id = line.dataset.toolUseId;
        finalizeToolLine(id, true, 'aborted');
      });
    }
    // QA hooks: last-turn state 를 DOM 에 expose → puppeteer 가 "그냥 끝남" 과
    // "완료됨" 을 구분할 수 있게. 네 이전 QA 는 running-indicator hidden 만 봐서
    // interrupted / stalled / error 를 pass 로 오판했음 (과거 회귀 사례).
    document.body.dataset.lastTurnReason = raw.reason || 'unknown';
    if (raw.reason === 'error' && raw.error) {
      // #39 V3 — stuck-session 패턴 매칭. dim cap 통과 못 한 이미지가 conversation history 에 박히면
      // SDK --resume 마다 같은 400 — 사용자가 영문 모르고 같은 세션 두드림. 명시 안내 + 새 세션 권장.
      const errStr = String(raw.error || '');
      if (/dimension limit|exceeds the dimension|fewer images|many-image requests/i.test(errStr)) {
        mkError('⚠️ 이 세션의 history 에 큰 이미지가 박혀있어 후속 응답이 모두 실패. 좌측 + 로 새 세션 시작 (이 세션은 복구 불가). 원본 에러: ' + errStr);
      } else {
        // 이중 표시 방지: result 핸들러가 이미 같은 텍스트를 mkError 했으면 skip.
        const errSlice = String(raw.error).slice(0, 500);
        if (!(_lastResultErrText && errSlice === _lastResultErrText)) {
          mkError(raw.error);
        }
      }
    } else if (raw.reason === 'interrupted') {
      // 2026-10-18 (#103): user_kill:true = UI stop 버튼 (POST /kill) 중단 — 명시 구분.
      mkError(raw.user_kill === true ? '(사용자 중단)' : '(중단됨)');
    } else if (raw.reason === 'stalled') {
      mkError('(응답 stall — 120s 무음으로 자동 중단. winter3 서버 로그 확인)');
    } else if (raw.reason === 'rate_limited') {
      // #26 V2: retry 한도 초과 시에만 발화 (server V2 변경).
      mkError('(API throttle — 자동 재시도 한도 초과)');
    }
    _lastResultErrText = null; // 다음 turn 오염 방지
    // autopsy 배지 — 백엔드가 원인 진단해서 turn_end 에 동봉한 경우 표시.
    // live/catchup 양쪽 동일 경로. completed + 빈응답/refusal 이 핵심 신규 케이스.
    // reason 을 넘겨 resumable 케이스에 resume 버튼도 함께 삽입.
    const _turnReason = raw.reason;
    const _stuckImgRe = /dimension limit|exceeds the dimension|fewer images|many-image requests/i;
    if (raw.autopsy && typeof raw.autopsy === 'object') {
      mkAutopsyBadge(raw.autopsy, state.currentAssistantBubble, _turnReason);
    } else if (_turnReason === 'timeout' || _turnReason === 'stalled' ||
               (_turnReason === 'error' && raw.error && !_stuckImgRe.test(String(raw.error)))) {
      // autopsy 없어도 resumable reason 이면 resume 버튼만 있는 minimal badge 삽입.
      mkResumeOnlyBadge();
    }
    // reason === 'auth_failed' 는 별도 winter3.auth_failed 이벤트(turn_end 직전)가
    // 이미 배너를 띄움 → 여기서 중복 텍스트 안 냄. dataset.lastTurnReason 만 'auth_failed' 로 세팅됨(위).
    // #25 — turn 종료 알림음. catchup(replay) 중엔 안 울림(과거 turn_end 무음).
    // chime 가드: autopsy 가 빈 응답 / refusal 이면 "답 왔다" 소리 오인 방지.
    const autopsyMuted = raw.autopsy?.empty_response || raw.autopsy?.stop_reason === 'refusal';
    if (_audioLive && raw.reason === 'completed' && !autopsyMuted) { playChime(); }
    return;
  }

  // SDK messages
  if (raw.type === 'system' && raw.subtype === 'init') {
    // Just log; not user-facing.
    return;
  }
  if (raw.type === 'system') return; // status etc.
  if (raw.type === 'stream_event') { handleStreamEvent(raw.event); return; }
  if (raw.type === 'assistant') { handleAssistantSnapshot(raw); return; }
  if (raw.type === 'user') { handleUserToolResult(raw); return; }
  if (raw.type === 'rate_limit_event') { updatePlanBadge(raw); return; }
  if (raw.type === 'result') {
    // A2: usage/cost pill 갱신 — 서버 이벤트 변경 없이 pill 만 추가 (minerva 확인 통과).
    updateCtxFromResult(raw);
    mkResultSummary(raw);
    if (raw.is_error === true && typeof raw.result === 'string' && raw.result) {
      _lastResultErrText = raw.result.slice(0, 500);
      mkError(_lastResultErrText);
    }
    return;
  }
  if (raw.type === 'error') { mkError(raw.error?.message || raw.message || pretty(raw)); return; }
  // Unknown types: silently ignore (raw view still shows them).
}

// ─── 페이지네이션: 더보기 버튼 렌더 ─────────────────────────────────────────
// 버튼을 messagesEl 의 첫 자식(prepend)으로 둔다.
// → 메시지 목록 스크롤 최상단에 위치 — "이전 N턴 더보기" UX 충족.
// → empty-state 충돌 방지: updateEmptyState() 가 .load-more-btn 을 제외하고 카운트 (app.js 수정).
function _renderLoadMoreBtn() {
  if (!messagesEl) return;
  // 이미 있으면 텍스트만 갱신
  if (_loadMoreBtnEl && _loadMoreBtnEl.isConnected) {
    if (_pag.remainingTurns <= 0) {
      _loadMoreBtnEl.remove();
      _loadMoreBtnEl = null;
    } else {
      _loadMoreBtnEl.textContent = `이전 ${_pag.remainingTurns}턴 더보기`;
    }
    return;
  }
  if (_pag.remainingTurns <= 0) return;
  const btn = document.createElement('button');
  btn.className = 'load-more-btn';
  btn.textContent = `이전 ${_pag.remainingTurns}턴 더보기`;
  btn.addEventListener('click', loadMoreHistory);
  messagesEl.prepend(btn);
  _loadMoreBtnEl = btn;
}

// ─── 페이지네이션: /history fetch → 위쪽 prepend ─────────────────────────────
// D 함정 준수: consume() 미경유. chime / timer / autoscroll / empty-state 토글 전부 스킵.
// E 함정 준수: consumeTaskStack / consumeActivity 에 넣지 않음.
// G 함정 준수: fetch 응답 처리 전 sid 대조.
async function loadMoreHistory() {
  if (_pag.loading) return;
  if (_pag.oldestTurnIndex === null || _pag.remainingTurns <= 0) return;
  const requestSid = _pag.sid;
  if (!requestSid) return;
  _pag.loading = true;
  if (_loadMoreBtnEl) {
    _loadMoreBtnEl.disabled = true;
    _loadMoreBtnEl.textContent = '불러오는 중...';
  }
  try {
    const url = `/history/${encodeURIComponent(requestSid)}?beforeTurn=${_pag.oldestTurnIndex}&turns=20`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    // G — cross-session 오염 가드: 응답 도착 시점에 현재 보고 있는 sid 와 다르면 폐기.
    if (requestSid !== _viewSid) return;
    const records = data.records || [];
    if (records.length > 0) {
      renderHistoryRecords(records);
    }
    // 상태 갱신
    _pag.oldestTurnIndex = data.oldestTurnIndex;
    _pag.remainingTurns = data.remainingTurns || 0;
    if (data.hasMore && _pag.remainingTurns > 0) {
      if (_loadMoreBtnEl) {
        _loadMoreBtnEl.textContent = `이전 ${_pag.remainingTurns}턴 더보기`;
        _loadMoreBtnEl.disabled = false;
      }
    } else {
      // 더 없음 — 버튼 제거
      if (_loadMoreBtnEl && _loadMoreBtnEl.isConnected) _loadMoreBtnEl.remove();
      _loadMoreBtnEl = null;
    }
  } catch (err) {
    console.error('[pagination] loadMoreHistory 실패:', err);
    if (_loadMoreBtnEl) {
      _loadMoreBtnEl.textContent = `이전 ${_pag.remainingTurns}턴 더보기 (재시도)`;
      _loadMoreBtnEl.disabled = false;
    }
  } finally {
    _pag.loading = false;
  }
}

// ─── 별도 렌더 경로: 과거 히스토리 레코드를 메시지 목록 위에 prepend ────────────────
// D 함정 준수 — consume() 을 통하지 않고 user/assistant 스냅샷만 버블로 그린다.
//   chime (playChime) / timer (startTimer) / autoscroll (scrollToBottom) / empty-state 토글
//   전부 호출하지 않는다.
// F 스크롤 앵커링 — renderMarkdownInBubble 이 동기라 prepend 완료 시점에 높이 확정됨.
//   prepend 전후 scrollHeight 차분을 동기로 messagesEl.scrollTop 에 더해 복원.
//   _lastProgrammaticAt 을 갱신해 80ms 가드 이전의 scroll 이벤트가 _autoFollow 를 오염하지 않도록.
// F 이미지 리플로우 — bubble-attach-thumb <img> 에 width/height 속성이 없어 로드 후 리플로우로
//   앵커가 깨질 수 있다. 즉각 해결이 어려우므로 리스크로 보고(아래 주석) + 컨테이너 min-height 없음.
//   대안: IntersectionObserver 나 load 이벤트로 다시 보정 — 현재 미구현, 이미지 첨부 세션에서
//   prepend 후 수십px 스크롤 점프 발생 가능. (리스크 허용)
function renderHistoryRecords(records) {
  if (!messagesEl || !records || records.length === 0) return;

  // prepend 전 스크롤 위치 스냅샷 — F 앵커링용.
  const scrollHeightBefore = messagesEl.scrollHeight;
  const scrollTopBefore = messagesEl.scrollTop;

  // prepend 할 노드들을 DocumentFragment 에 쌓아서 한 번에 insertBefore.
  const frag = document.createDocumentFragment();

  for (const rec of records) {
    const raw = rec?.raw;
    if (!raw || typeof raw !== 'object') continue;
    const ts = rec.ts || null;

    if (raw.type === 'winter3.injected') {
      // 외부 주입 Winter 발화 — assistant 스타일 + source 뱃지 (라이브 경로와 동일).
      const { el, timeEl } = _mkDetachedBubble('assistant', '', ts);
      el.classList.add('injected');
      if (raw.source) {
        const badge = document.createElement('div');
        badge.className = 'inject-source-badge';
        badge.textContent = raw.source;
        el.appendChild(badge);
      }
      const textEl = document.createElement('div');
      textEl.className = 'inject-body';
      el.appendChild(textEl);
      renderMarkdownInBubble(textEl, String(raw.text || ''));
      frag.appendChild(el);
      if (timeEl) frag.appendChild(timeEl);
    } else if (raw.type === 'winter3.user_prompt') {
      // 유저 버블 — mkBubble 을 쓰되 messagesEl.appendChild 하지 않고 frag 에 수동으로 붙인다.
      // mkBubble 내부가 messagesEl.appendChild 를 직접 호출하므로, 대신 _mkDetachedBubble 사용.
      const { el, timeEl } = _mkDetachedBubble('user', raw.text || '', ts);
      if (raw.researchMode === true) markResearchBubble(el);
      frag.appendChild(el);
      if (timeEl) frag.appendChild(timeEl);

      // attachments — 같은 records 배열에서 user_prompt 직후 winter3.attachments 가 있으면 붙임.
      // (서버 필터 결과물이라 순서 보장됨)
    } else if (raw.type === 'winter3.attachments') {
      // frag 마지막 자식이 user bubble 이면 거기에 썸네일 row 삽입.
      const lastChild = frag.lastChild;
      // timeEl 이 마지막일 수 있으니 그 앞도 확인.
      const userBubble = (lastChild && lastChild.classList && lastChild.classList.contains('user'))
        ? lastChild
        : (lastChild && lastChild.previousSibling && lastChild.previousSibling.classList && lastChild.previousSibling.classList.contains('user'))
          ? lastChild.previousSibling
          : null;
      if (userBubble) {
        const refs = raw.refs || [];
        if (refs.length) {
          const row = document.createElement('div');
          row.className = 'bubble-attach-row';
          for (const r of refs) {
            const mime = (r.mime || '').toLowerCase();
            const kind = r.kind || (mime.startsWith('image/') ? 'image' : (mime === 'application/pdf' ? 'document' : 'text'));
            if (kind === 'image') {
              const img = document.createElement('img');
              img.className = 'bubble-attach-thumb';
              img.src = r.url;
              img.alt = r.name || 'attachment';
              img.dataset.fullUrl = r.url;
              img.addEventListener('click', () => openImagePreview(r.url, r.name));
              row.appendChild(img);
            } else {
              const link = document.createElement('a');
              link.className = 'bubble-attach-file';
              link.href = r.url;
              link.target = '_blank';
              link.rel = 'noopener';
              link.title = `${r.name || 'attachment'} (${kind})`;
              const icon = document.createElement('span');
              icon.className = 'bubble-attach-file-icon';
              icon.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
              const nm = document.createElement('span');
              nm.className = 'bubble-attach-file-name';
              nm.textContent = r.name || 'attachment';
              link.appendChild(icon);
              link.appendChild(nm);
              row.appendChild(link);
            }
          }
          userBubble.insertBefore(row, userBubble.firstChild);
        }
      }
    } else if (raw.type === 'assistant') {
      // assistant 스냅샷 — 텍스트 블록 버블 + tool_use 블록 → tool-line.
      const content = raw?.message?.content;
      const msgId = raw?.message?.id;
      if (!Array.isArray(content)) continue;
      const textBlocks = content.filter((c) => c?.type === 'text' && typeof c.text === 'string');
      for (const block of textBlocks) {
        const { el, timeEl } = _mkDetachedBubble('assistant', '', ts);
        if (msgId) el.dataset.msgId = msgId;
        // renderMarkdownInBubble 은 동기. 반환 시 높이 확정.
        renderMarkdownInBubble(el, block.text);
        frag.appendChild(el);
        if (timeEl) frag.appendChild(timeEl);
      }
      // tool_use 블록 → tool-group 안 tool-line (history replay: catchup=true 고정).
      // ensureToolGroup(frag) 으로 연속 라인을 하나의 그룹에 묶음.
      // dedup: _fragFindToolLine 헬퍼로 frag 하위 트리 전체 탐색.
      for (const c of content) {
        if (c?.type !== 'tool_use' || !c.id) continue;
        if (_fragFindToolLine(frag, c.id)) continue; // 중복 스킵
        const inputObj = (typeof c.input === 'object' && c.input !== null) ? c.input : null;
        const summary = inputObj ? toolSummaryFromNameInput(c.name, inputObj) : (c.name || 'tool');
        const lineEl = _mkToolLineEl(c.id, c.name, summary, true /* catchup */);
        const group = ensureToolGroup(frag);
        group.querySelector('.tg-body').appendChild(lineEl);
        // 헤더는 tool_result 완료 처리 후 일괄 갱신 — 루프 후 처리하면 충분
      }
    } else if (raw.type === 'user') {
      // tool_result — frag 안에 있는 pending tool-line 을 완료 처리.
      // history 경로는 tool_use→tool_result 쌍이 같은 records 에 있으므로 frag 안에서 탐색.
      const content = raw?.message?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c?.type !== 'tool_result' || !c.tool_use_id) continue;
          const targetLine = _fragFindToolLine(frag, c.tool_use_id);
          if (!targetLine) continue;
          const spinner = targetLine.querySelector('.tl-spinner');
          if (spinner) {
            const isErr = !!c.is_error;
            spinner.className = isErr ? 'tl-err' : 'tl-done';
            spinner.textContent = isErr ? '✗' : '✓';
          }
          // history 경로에선 시각 정보가 없으므로 elapsed 는 생략.
          // 소속 그룹 헤더 갱신
          const group = targetLine.closest('.tool-group');
          if (group) updateGroupHeader(group);
        }
      }
    }
    // stream_event 등은 채팅 버블 없음 — 스킵.
  }

  // messagesEl 의 맨 앞에 prepend (기존 메시지 위).
  // 단, 첫 자식이 .load-more-btn 이면 버튼은 항상 최상단에 있어야 하므로 버튼 다음에 삽입.
  const firstChild = messagesEl.firstChild;
  const insertRef = (firstChild && firstChild.classList && firstChild.classList.contains('load-more-btn'))
    ? firstChild.nextSibling  // 버튼 다음 — 버튼은 그대로 최상단 유지
    : firstChild;             // 맨 앞
  if (insertRef) {
    messagesEl.insertBefore(frag, insertRef);
  } else {
    messagesEl.appendChild(frag);
  }

  // F 스크롤 앵커링 — prepend 후 scrollHeight 증가분만큼 scrollTop 을 당겨서 뷰 고정.
  // _lastProgrammaticAt 갱신으로 80ms 가드 이전 scroll 이벤트가 _autoFollow 오염 방지.
  const scrollHeightAfter = messagesEl.scrollHeight;
  const delta = scrollHeightAfter - scrollHeightBefore;
  if (delta > 0) {
    _lastProgrammaticAt = Date.now();
    messagesEl.scrollTop = scrollTopBefore + delta;
  }
}

// mkBubble 의 messagesEl.appendChild 없는 변형 — prepend/fragment 용.
// timestamp 는 sibling DOM 노드로 반환 (fragment 에 caller 가 순서 맞춰 append).
function _mkDetachedBubble(role, text, ts) {
  const el = document.createElement('div');
  el.className = `bubble ${role}`;
  if (text) el.textContent = text;
  attachCopyButton(el);
  // timestamp sibling
  let timeEl = null;
  const stamp = ts || _lastRecTs;
  if (stamp) {
    const short = fmtTimeShort(stamp);
    if (short) {
      timeEl = document.createElement('div');
      timeEl.className = 'bubble-time';
      if (role === 'user') timeEl.classList.add('for-user');
      else if (role === 'assistant') timeEl.classList.add('for-assistant');
      timeEl.textContent = short;
      timeEl.title = fmtTimeFull(stamp) || short;
      timeEl.dataset.ts = stamp;
    }
  }
  return { el, timeEl };
}

// 리서치 모드 배지 — raw.researchMode === true 인 user 버블에만 붙임.
// XSS 방지: textContent 사용, innerHTML 없음.
function markResearchBubble(el) {
  el.classList.add('research-turn');
  const badge = document.createElement('span');
  badge.className = 'research-badge';
  badge.textContent = '리서치';
  el.prepend(badge);
}
