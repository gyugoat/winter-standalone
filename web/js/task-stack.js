// web/js/task-stack.js — Multi-agent task progress cards.
// 채팅 입력창 위 floating stack. Agent tool 호출 1 개 = 카드 1 개.
// installer-style progress bar + elapsed timer + 색상 (파랑/노랑/빨강) + 알림음.
//
// 설계 (#19 V2 — 사용자 비전 풀 스펙):
//   - SSE raw 에서 derive (raw=truth, P1). 별도 SSE 이벤트 신설 X.
//   - Agent (= subagent_type 호출) 만 카드. Bash/Read 같은 일반 도구는 X — 이미 activity.js 가 처리.
//   - tool_use 시점에 placeholder 카드 (input 아직 비어있음 — content_block_stop 까지 deferred).
//   - tool_result 시점에 색상 done(파랑→스러짐) / error(빨강 stick).
//   - 색상 임계: < 60s 파랑 / 60~180s 노랑 / 180s+ 또는 is_error 빨강 (Oracle "절대값" 권고).
//   - 평균 학습 X (데이터 부족, false positive 폭주). 절대 임계값 hard-code.
//   - 알림음: 완료 ding / 에러 buzz. Web Audio API 톤 합성 (mp3 의존성 0).
//   - debounce: 같은 turn 내 동시 완료는 100ms window 로 묶어서 ding 1 회.
//   - localStorage 'winter3:task-sound' = '0' 이면 무음.

import { getViewSid, isCatchup } from './render.js';

const SOUND_KEY = 'winter3:task-sound';
const WARN_AT_MS = 60_000;   // 노랑 전환
const DANGER_AT_MS = 180_000; // 빨강 전환 (timeout 의심)

// #49 — dismiss persist + catchup-done orphan 마감.
// 증상1: 카드 click dismiss → 다른 세션 갔다 오면 catchup replay 가 같은 tool_use record 재생 → 부활.
//   원인: dismissCard 가 in-memory(cards.delete)만 → replay 가 다시 addCard. localStorage 흔적 0.
//   fix: sid 별 dismissed tool_use_id 를 localStorage 에 persist. addCard 진입 시 차단.
// 증상2: nested Agent / cut turn 으로 tool_result/turn_end record 가 이 sid replay 에 안 섞이면
//   카드가 영원히 'running' ("준비 중... 0.0s") orphan.
//   fix: catchup(과거 로그 replay) 완료 시점에 *catchup 으로 들어온* running 카드를 'aborted' 마감.
//   라이브 turn 카드(fromCatchup=false)는 건드리지 않음.
const DISMISSED_KEY_PREFIX = 'winter3:dismissed:';
const DISMISSED_MAX = 200;   // sid 별 상한 — localStorage 무한 증식 방지. 초과 시 앞쪽 trim.

function dismissedKey(sid) { return DISMISSED_KEY_PREFIX + sid; }

function loadDismissed(sid) {
  if (!sid) return [];
  try {
    const raw = localStorage.getItem(dismissedKey(sid));
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function isDismissed(sid, toolUseId) {
  if (!sid || !toolUseId) return false;
  return loadDismissed(sid).includes(toolUseId);
}

function persistDismissed(sid, toolUseId) {
  if (!sid || !toolUseId) return;
  try {
    let arr = loadDismissed(sid);
    if (arr.includes(toolUseId)) return;
    arr.push(toolUseId);
    // 상한 초과 시 가장 오래된(앞쪽) 항목 trim — 키는 sid 단위라 세션 많아도 한 키 폭주 안 함.
    if (arr.length > DISMISSED_MAX) arr = arr.slice(arr.length - DISMISSED_MAX);
    localStorage.setItem(dismissedKey(sid), JSON.stringify(arr));
  } catch { /* localStorage full/disabled — persist 실패해도 in-memory dismiss 는 동작 */ }
}

// #24 — 자동 fade 폐기. 사용자 click 으로만 dismiss.
// 이전 design: done 1.5s 후 자동 fade. 사용자 신고 "조용히 사라짐 — 클릭 전엔 안 사라져야".
// 이유: 알림음 fail (#23) + 자동 fade = 사용자가 완료 자체를 인지 못 함.

// #24 — pipActive mute 제거. 메인이 *항상* 알림음 재생 (PiP 도 자체 시도 — 중복 허용).
// 이전 design: PiP open 시 메인 mute (#21 V2). PiP 가 iframe AudioContext 한계로
// silent 되면 둘 다 무음 → 알림음 0. 메인은 user gesture 풀 → fail-safe.

const state = {
  stackEl: null,
  cards: new Map(),     // tool_use_id → { cardEl, fillEl, elapsedEl, descEl, startAt, status }
  tickTimer: null,
  audioCtx: null,
  pendingDing: null,    // setTimeout handle for debounce
  bc: null,             // BroadcastChannel ref
  // Dedup by record id — EventSource 자동 reconnect 시 server catchup 이 같은 id 다시 push 하면
  // task 카드가 두 번 append (특히 tool_use_id 같으면 첫 카드 덮어쓰면서 startAt 재설정 →
  // elapsed timer 거짓). render.js 와 동일 패턴 (#14/#15 회귀 방지).
  // 17-oracle audit 2026-05-03: render.js 만 dedup, task-stack 0겹 비대칭 발견.
  seenIds: new Set(),
};

export function bindTaskStackUI() {
  state.stackEl = document.getElementById('task-stack');
  if (!state.stackEl) {
    console.warn('[task-stack] #task-stack element not found');
    return;
  }
  startTicker();
  bindPipChannel();
}

function bindPipChannel() {
  // #24 — pip-open/closed 무시. 메인이 항상 알림음 재생 (fail-safe).
  // BroadcastChannel 자체는 다른 용도 ('open-session' 등) 위해 유지 가능하지만 task-stack 측에선 listen 0.
  // 함수는 backward compat 위해 남김.
}

export function reset() {
  if (!state.stackEl) return;
  state.cards.clear();
  state.seenIds.clear();
  state.stackEl.innerHTML = '';
  state.stackEl.classList.remove('has-cards');
}

// ─── SSE consumer ───────────────────────────────────────────────

export function consume(rec) {
  const raw = rec?.raw;
  if (!raw || typeof raw !== 'object') return;

  // cross-session 가드 — render.js _viewSid 와 동기. activity.js 와 동일 정책.
  // 다른 세션의 SSE 잔존 record 가 신규 페이지 #task-stack 에 카드 append 하는 것 차단.
  const viewSid = getViewSid();
  const isViewing = (!rec.sid || !viewSid || rec.sid === viewSid);
  if (!isViewing) return;

  // Dedup by record id — EventSource 자동 reconnect 시 catchup 으로 같은 id 다시 push 가능.
  // #14/#15 의 3겹 dedup 약속 중 task-stack 측 누락 보정 (17-oracle audit 2026-05-03).
  // tool_use_id 같은 카드가 두 번 들어오면 startAt 재설정되며 elapsed timer 가 거짓이 됨.
  if (typeof rec?.id === 'number') {
    if (state.seenIds.has(rec.id)) return;
    state.seenIds.add(rec.id);
  }

  if (raw.type === 'winter3.user_prompt') {
    // #24 V2 — 새 turn 시작 시 이전 turn 의 done/error/aborted 카드 자동 정리.
    // running 카드는 유지 (진행 중 = 보호). 알림음 (#24) 이 인지 책임 짐.
    clearFinishedCards();
    return;
  }
  if (raw.type === 'winter3.turn_end') {
    // #40 — turn_end 시 미해결 running 카드 = sub-agent 결과 못 받은 채 turn cut.
    // aborted 로 close (영구 0s 부터 다시 세는 버그 차단). 사용자 73f6006d 신고.
    abortRunningCards(rec.ts);
    return;
  }
  if (raw.type === 'winter3.catchup_done') {
    // #49 — catchup replay 끝. catchup 으로 들어온 채 종료 record 못 받아
    // 'running' 으로 매달린 orphan 카드를 'aborted' 로 마감. 라이브 카드는 보호.
    finishCatchupCards();
    return;
  }
  if (raw.type === 'assistant') {
    const blocks = raw.message?.content || [];
    for (const block of blocks) {
      if (block?.type === 'tool_use' && block.id && (block.name === 'Agent' || block.name === 'Task')) {
        addCard(block, rec.ts);
      }
    }
  } else if (raw.type === 'user') {
    const blocks = raw.message?.content || [];
    for (const block of blocks) {
      if (block?.type === 'tool_result' && block.tool_use_id) {
        resolveCard(block.tool_use_id, block, rec.ts);
      }
    }
  }
}

// #24 V2 — done/error/aborted 카드 일괄 dismiss. running 은 유지.
function clearFinishedCards() {
  for (const [id, entry] of state.cards) {
    if (entry.status === 'done' || entry.status === 'error' || entry.status === 'aborted') {
      dismissCard(id);
    }
  }
}

// #40 — turn_end 시 미해결 running 카드 abort close.
function abortRunningCards(recTs) {
  const endMs = Date.parse(recTs) || Date.now();
  for (const entry of state.cards.values()) {
    if (entry.status !== 'running') continue;
    entry.status = 'aborted';
    const elapsed = Math.max(0, endMs - entry.startAt);
    entry.cardEl.classList.remove('status-running', 'status-warn', 'status-danger');
    entry.cardEl.classList.add('status-aborted');
    entry.elapsedEl.textContent = `${(elapsed / 1000).toFixed(1)}s`;
    entry.fillEl.style.width = '100%';
    entry.cardEl.classList.add('dismissable');
    entry.cardEl.title = '클릭해서 닫기';
    const id = entry.cardEl.dataset.toolUseId;
    entry.cardEl.addEventListener('click', () => dismissCard(id), { once: true });
  }
}

// ─── card lifecycle ─────────────────────────────────────────────

function addCard(useBlock, recTs) {
  if (state.cards.has(useBlock.id)) {
    // 입력 채워지면서 다시 들어올 수 있음 → 라벨만 update.
    updateCardLabel(useBlock.id, useBlock);
    return;
  }

  // #49 — 사용자가 이미 dismiss 한 카드면 부활 차단. catchup replay 가
  // 같은 tool_use record 를 재생해도 다시 안 생김. sid = 현재 보고 있는 세션.
  const sid = getViewSid();
  if (isDismissed(sid, useBlock.id)) return;

  // catchup(과거 로그 replay) 중 들어온 카드인지 표시 — finishCatchupCards 가 orphan 마감 대상 식별용.
  // 라이브 turn 카드(fromCatchup=false)는 실제 진행 중이므로 마감 X.
  const fromCatchup = isCatchup();

  const card = document.createElement('div');
  card.className = 'task-card status-running';
  card.dataset.toolUseId = useBlock.id;

  const head = document.createElement('div');
  head.className = 'task-card-head';

  const dot = document.createElement('span');
  dot.className = 'task-dot';

  const name = document.createElement('span');
  name.className = 'task-name';
  name.textContent = (useBlock.input?.subagent_type) || '에이전트';

  const desc = document.createElement('span');
  desc.className = 'task-desc';
  desc.textContent = useBlock.input?.description || '준비 중...';

  const elapsed = document.createElement('span');
  elapsed.className = 'task-elapsed';
  elapsed.textContent = '0s';

  head.appendChild(dot);
  head.appendChild(name);
  head.appendChild(desc);
  head.appendChild(elapsed);

  const bar = document.createElement('div');
  bar.className = 'task-bar';
  const fill = document.createElement('div');
  fill.className = 'task-bar-fill';
  bar.appendChild(fill);

  card.appendChild(head);
  card.appendChild(bar);
  state.stackEl.appendChild(card);
  state.stackEl.classList.add('has-cards');

  // #40 — startAt = SDK record ts. catchup replay 후에도 진실 보존.
  // 이전: Date.now() → 세션 재진입 시 항상 "재진입 시각" 으로 박혀 0s 부터 다시 카운트.
  state.cards.set(useBlock.id, {
    cardEl: card,
    fillEl: fill,
    elapsedEl: elapsed,
    descEl: desc,
    nameEl: name,
    startAt: Date.parse(recTs) || Date.now(),
    status: 'running',
    fromCatchup,   // #49 — catchup-done orphan 마감 대상 식별.
  });
}

function updateCardLabel(toolUseId, useBlock) {
  const entry = state.cards.get(toolUseId);
  if (!entry) return;
  if (useBlock.input?.subagent_type) entry.nameEl.textContent = useBlock.input.subagent_type;
  if (useBlock.input?.description) entry.descEl.textContent = useBlock.input.description;
}

function resolveCard(toolUseId, resultBlock, recTs) {
  const entry = state.cards.get(toolUseId);
  if (!entry || entry.status !== 'running') return;

  // #40 — elapsed 도 record ts 기반.
  const endMs = Date.parse(recTs) || Date.now();
  const elapsed = Math.max(0, endMs - entry.startAt);
  const isError = !!resultBlock.is_error;
  entry.status = isError ? 'error' : 'done';

  entry.cardEl.classList.remove('status-running', 'status-warn', 'status-danger');
  entry.cardEl.classList.add(isError ? 'status-error' : 'status-done');
  entry.elapsedEl.textContent = `${(elapsed / 1000).toFixed(1)}s`;
  entry.fillEl.style.width = '100%';

  // #25 — sub-agent 별 ding/buzz 폐기. turn 끝날 때 한 번만 (render.js 의 turn_end 분기).
  // 요구: 완료 알림음은 턴 종료 시점 한 번만 — 세션 진입/전환마다 울리면 안 됨.
  // sub-agent N 개 = N 번 ding + 카탑업 history replay 중에도 ding → 시끄럽고 잘못된 신호.

  // #24 — 자동 fade 폐기. 카드 click → dismiss (사용자 명시적 인지 후).
  // 카드 click → fade out + remove. dismissable 표시 위해 클래스 추가.
  entry.cardEl.classList.add('dismissable');
  entry.cardEl.title = '클릭해서 닫기';
  entry.cardEl.addEventListener('click', () => dismissCard(toolUseId), { once: true });
}

function dismissCard(toolUseId) {
  const entry = state.cards.get(toolUseId);
  if (!entry) return;
  // #49 — dismiss 를 localStorage 에 persist. 세션 재진입 시 catchup replay 가
  // 같은 tool_use record 를 재생해도 addCard 가 isDismissed 로 차단 → 부활 안 함.
  persistDismissed(getViewSid(), toolUseId);
  entry.cardEl.classList.add('fading');
  setTimeout(() => {
    entry.cardEl.remove();
    state.cards.delete(toolUseId);
    if (state.stackEl && state.stackEl.childElementCount === 0) state.stackEl.classList.remove('has-cards');
  }, 250);
}

// #49 — catchup replay 완료 시점. catchup 으로 들어온 채 종료 record(tool_result/turn_end)를
// 못 받아 'running' 으로 매달린 orphan 카드를 'aborted' 로 마감 ("준비 중... 0.0s" 영구 매달림 차단).
// 라이브 turn 카드(fromCatchup=false)는 실제 진행 중이므로 건드리지 않음.
// idempotent — 이미 마감된 카드는 status!=='running' 이라 skip. 여러 경로(catchup_done marker / app.js
// idleTimer / safety timer)에서 중복 호출돼도 안전.
export function finishCatchupCards() {
  for (const entry of state.cards.values()) {
    if (entry.status !== 'running') continue;
    if (!entry.fromCatchup) continue;   // 라이브 카드 보호.
    entry.status = 'aborted';
    entry.cardEl.classList.remove('status-running', 'status-warn', 'status-danger');
    entry.cardEl.classList.add('status-aborted');
    entry.fillEl.style.width = '100%';
    entry.cardEl.classList.add('dismissable');
    entry.cardEl.title = '클릭해서 닫기';
    const id = entry.cardEl.dataset.toolUseId;
    entry.cardEl.addEventListener('click', () => dismissCard(id), { once: true });
  }
}

// ─── ticker — elapsed timer + 색상 전환 (100ms) ────────────────

function startTicker() {
  if (state.tickTimer) return;
  state.tickTimer = setInterval(tick, 200);
}

function tick() {
  const now = Date.now();
  for (const entry of state.cards.values()) {
    if (entry.status !== 'running') continue;
    const elapsed = now - entry.startAt;
    entry.elapsedEl.textContent = `${(elapsed / 1000).toFixed(1)}s`;

    // 색상 전환
    if (elapsed >= DANGER_AT_MS) {
      entry.cardEl.classList.remove('status-running', 'status-warn');
      entry.cardEl.classList.add('status-danger');
    } else if (elapsed >= WARN_AT_MS) {
      entry.cardEl.classList.remove('status-running');
      entry.cardEl.classList.add('status-warn');
    }

    // progress bar — danger 임계 도달율 (정직한 metric).
    // 17-oracle audit 2026-05-03 narrative-fabrication 지적: 이전 "0~30s 0~50%, 30~60s 50~80%" 류
    // elapsed-based mapping 은 진행 신호 0 인데 "거의 다 됐다" 는 거짓 인상. 실제 신호 = 임계까지의 시간.
    // 이제 elapsed/DANGER_AT_MS 로 변경: 60s(WARN) = 33%, 180s(DANGER) = 100%. 색상 임계와 일치.
    const pct = Math.min(100, (elapsed / DANGER_AT_MS) * 100);
    entry.fillEl.style.width = `${pct.toFixed(1)}%`;
  }
}

// ─── 알림음 (Web Audio API tone synth — 의존성 0) ───────────────

function soundOn() {
  // #24 — pipActive 체크 제거. 메인이 항상 재생 (PiP 도 자체 시도, 중복 허용).
  // PiP 가 iframe AudioContext 한계로 silent 될 때 fail-safe.
  return localStorage.getItem(SOUND_KEY) !== '0';
}

function getAudioCtx() {
  if (!soundOn()) return null;
  if (!state.audioCtx) {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      state.audioCtx = new Ctx();
    } catch { return null; }
  }
  return state.audioCtx;
}

function playTone({ freq, durMs, type = 'sine', gain = 0.08 }) {
  const ctx = getAudioCtx();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  g.gain.value = 0;
  // attack/release envelope — click 방지
  const now = ctx.currentTime;
  g.gain.linearRampToValueAtTime(gain, now + 0.01);
  g.gain.linearRampToValueAtTime(0, now + durMs / 1000);
  osc.connect(g).connect(ctx.destination);
  osc.start(now);
  osc.stop(now + durMs / 1000 + 0.02);
}

// 같은 turn 내 동시 완료 100ms 안에 묶어서 ding 1 회.
function queueDing() {
  if (state.pendingDing) return;
  state.pendingDing = setTimeout(() => {
    state.pendingDing = null;
    playTone({ freq: 880, durMs: 120, type: 'sine', gain: 0.06 });
  }, 80);
}

// 에러 buzz — 즉시 두 톤 (낮은 톤 두 번)
function queueBuzz() {
  playTone({ freq: 220, durMs: 90, type: 'square', gain: 0.05 });
  setTimeout(() => playTone({ freq: 180, durMs: 110, type: 'square', gain: 0.05 }), 130);
}
