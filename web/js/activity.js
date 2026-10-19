// web/js/activity.js — raw 스트림 → 클래스별 카드. 네 "class → card 매핑" 원칙.
// 파싱 아니라 "view dispatch" — 파서가 틀리면 UI 한 칸만 빈 카드, persistence 무사.

import { getViewSid } from './render.js';
import { buildToolDiffDOM } from './tool-diff.js';

// v2 — default open 정책 도입 시 기존 LS='0' 강제 무효화 (마이그레이션).
const ACTIVITY_OPEN_KEY = 'winter3:activity-open-v2';

let listEl, panelEl, toggleBtn, emptyEl;
let modalEl, modalTitleEl, modalBodyEl, modalCloseEl;

const state = {
  currentTurn: null,      // { turnEl, bodyEl, countEl, n }
  toolCards: new Map(),   // tool_use_id → { cardEl, statusEl, latencyEl, briefEl, useRecId, startAt }
  rawById: new Map(),     // recId → full raw record (modal lookup)
  // Dedup by record id — EventSource 자동 reconnect 시 server catchup 이 같은 id 다시 push 하면
  // toolCard / metaCard 가 중복 append. render.js 와 동일 패턴 (#14/#15 회귀 방지).
  // 17-oracle audit 2026-05-03: render.js 만 dedup 1겹, activity/task-stack 0겹 비대칭 발견.
  seenIds: new Set(),
};

export function bindActivityUI() {
  listEl = document.getElementById('activity-list');
  panelEl = document.getElementById('activity-view');
  toggleBtn = document.getElementById('toggle-activity');
  emptyEl = document.getElementById('activity-empty');
  modalEl = document.getElementById('activity-modal');
  modalTitleEl = document.getElementById('activity-modal-title');
  modalBodyEl = document.getElementById('activity-modal-body');
  modalCloseEl = document.getElementById('activity-modal-close');

  toggleBtn?.addEventListener('click', togglePanel);
  modalCloseEl?.addEventListener('click', closeModal);
  modalEl?.addEventListener('click', (e) => { if (e.target === modalEl) closeModal(); });
  listEl?.addEventListener('click', handleListClick);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modalEl.classList.contains('hidden')) closeModal();
  });

  // Default = 열림. 사용자가 명시적으로 닫은 경우만 닫힌 상태로 복원.
  // (오라클 5/5 권고 — Option B: activity 패널 default open 으로 multi-agent 진행 상황 즉시 노출)
  applyInitialPanelState();
}

function applyInitialPanelState() {
  if (!panelEl) return;
  const stored = localStorage.getItem(ACTIVITY_OPEN_KEY);
  // null = 첫 방문 / 미설정 → default open. '1' = open. '0' = 사용자가 닫음.
  const open = stored === null ? true : stored === '1';
  panelEl.classList.toggle('hidden', !open);
  // head inline script 가 박은 FOUC 방지 마커 제거 — 이제 .hidden 클래스가 source of truth.
  document.documentElement.classList.remove('activity-closed');
}

export function togglePanel() {
  if (!panelEl) return;
  panelEl.classList.toggle('hidden');
  const open = !panelEl.classList.contains('hidden');
  localStorage.setItem(ACTIVITY_OPEN_KEY, open ? '1' : '0');
}

export function reset() {
  if (!listEl) return;
  listEl.innerHTML = '';
  state.currentTurn = null;
  state.toolCards.clear();
  state.rawById.clear();
  state.seenIds.clear();
  updateEmpty();
}

function updateEmpty() {
  if (!emptyEl) return;
  emptyEl.style.display = listEl.children.length ? 'none' : 'flex';
}

// ─── class → card dispatch ───────────────────────────────────

export function consume(rec) {
  // cross-session 가드 — 다른 세션의 SSE 잔존 record 가 viewport DOM 오염하는 것 차단.
  // app.js openStream callback 이 rec.sid 주입 (winter3/web/js/app.js L58).
  // sid 없으면 (legacy/synthetic) fallback 통과 — render.js _viewSid 가드와 동일 정책.
  // guard 가 state.rawById.set 위에 있어야 cross-session record 가 modal 캐시에도 안 들어감
  // (메모리 leak + modal 오작동 방어).
  const viewSid = getViewSid();
  const isViewing = (!rec?.sid || !viewSid || rec.sid === viewSid);
  if (!isViewing) return;

  // Dedup by record id — EventSource 자동 reconnect 시 server catchup 이 같은 id 다시 push 가능.
  // #14/#15 의 3겹 dedup 약속 중 activity 측 누락 보정 (17-oracle audit 2026-05-03).
  // cross-session 가드 통과 후, rawById set 전에 dedup — 이미 본 id 면 modal 캐시도 갱신 X.
  if (typeof rec?.id === 'number') {
    if (state.seenIds.has(rec.id)) return;
    state.seenIds.add(rec.id);
    state.rawById.set(rec.id, rec);
  }
  const raw = rec?.raw;
  if (!raw || typeof raw !== 'object') return;

  const handlers = {
    'winter3.user_prompt': onUserPrompt,
    'winter3.turn_end': onTurnEnd,    // #40 — running 카드 abort close
    'assistant': onAssistant,
    'user': onUser,
    // rate_limit_event 는 메타 카드로 안 표시. 사이드바 플랜 뱃지가 그 역할 전담.
    'result': onResult,
  };
  const fn = handlers[raw.type];
  if (fn) fn(rec, raw);
  updateEmpty();
}

// ─── per-class handlers ──────────────────────────────────────

function onUserPrompt(rec, raw) {
  openTurn(raw.text || '');
}

function onAssistant(rec, raw) {
  const blocks = raw.message?.content || [];
  for (const block of blocks) {
    if (block?.type === 'tool_use' && block.id) {
      addToolCard(block, rec.id, rec.ts);
    } else if (block?.type === 'text' && block.text) {
      // thinking narrative first sentence → small "i" note card
      // (skip — too chatty for feed; main bubble already shows text)
    }
  }
}

function onUser(rec, raw) {
  const blocks = raw.message?.content || [];
  for (const block of blocks) {
    if (block?.type === 'tool_result' && block.tool_use_id) {
      resolveToolCard(block.tool_use_id, block, rec.ts);
    }
  }
}

// #40 — turn_end 시 미해결 running 도구카드 close (aborted).
// 원인: 메인 turn 이 stop_sequence/stalled/error 로 cut 되면 sub-agent 의 tool_result 가
// jsonl 에 영영 append 안 됨 → resolveToolCard 영영 안 불림 → status='running' 영구 박힘.
// 사용자 신고 (2026-05-02 sid 73f6006d): "활동탭에 헤르메스는 계속 돌아가고 ... 0초부터 다시 세고".
function onTurnEnd(rec, raw) {
  const endTsMs = Date.parse(rec.ts) || Date.now();
  for (const entry of state.toolCards.values()) {
    if (!entry.statusEl?.classList.contains('running')) continue;
    entry.statusEl.classList.remove('running');
    entry.statusEl.classList.add('aborted');
    const elapsed = Math.max(0, endTsMs - entry.startAt);
    entry.latencyEl.textContent = `${(elapsed / 1000).toFixed(1)}s`;
  }
}

// onRateLimit 제거 — 뱃지 로직은 render.js 가 담당.

function onResult(rec, raw) {
  // cost 제거. 지속시간 + 에러 플래그만.
  const parts = [];
  if (raw.subtype === 'error') parts.push('error');
  if (typeof raw.duration_ms === 'number') parts.push(`${(raw.duration_ms / 1000).toFixed(1)}s`);
  addMetaCard(parts.join('  ·  ') || 'done', 'result', rec.id);
}

// ─── turn container ──────────────────────────────────────────

function openTurn(userText) {
  const turnEl = document.createElement('section');
  turnEl.className = 'act-turn';

  const header = document.createElement('div');
  header.className = 'act-turn-header';
  const dot = document.createElement('span'); dot.className = 'act-turn-dot';
  const q = document.createElement('span');
  q.className = 'act-turn-q';
  const t = (userText || '(empty)').trim();
  q.textContent = t.length > 80 ? t.slice(0, 80) + '…' : t;
  const countEl = document.createElement('span');
  countEl.className = 'act-turn-count';
  countEl.textContent = '0';
  header.appendChild(dot);
  header.appendChild(q);
  header.appendChild(countEl);

  const bodyEl = document.createElement('div');
  bodyEl.className = 'act-turn-body';

  turnEl.appendChild(header);
  turnEl.appendChild(bodyEl);
  listEl.appendChild(turnEl);
  scrollBottom();

  state.currentTurn = { turnEl, bodyEl, countEl, n: 0 };
}

function appendToTurn(el) {
  if (!state.currentTurn) openTurn('');
  state.currentTurn.bodyEl.appendChild(el);
  state.currentTurn.n += 1;
  state.currentTurn.countEl.textContent = String(state.currentTurn.n);
  scrollBottom();
}

function scrollBottom() {
  requestAnimationFrame(() => {
    listEl.scrollTop = listEl.scrollHeight;
  });
}

// ─── tool card ───────────────────────────────────────────────

function addToolCard(useBlock, useRecId, recTs) {
  if (state.toolCards.has(useBlock.id)) return;

  const card = document.createElement('div');
  card.className = 'act-card tool';
  card.dataset.toolUseId = useBlock.id;
  card.dataset.useRecId = String(useRecId);

  const status = document.createElement('span');
  status.className = 'act-status running';

  const name = document.createElement('span');
  name.className = 'act-name';
  name.textContent = useBlock.name || 'tool';

  const brief = document.createElement('span');
  brief.className = 'act-brief';
  brief.textContent = formatBrief(useBlock.name, useBlock.input);

  const latency = document.createElement('span');
  latency.className = 'act-latency';

  card.appendChild(status);
  card.appendChild(name);
  card.appendChild(brief);
  card.appendChild(latency);

  appendToTurn(card);

  // #40 — startAt = SDK 가 tool_use 받은 시각 (record ts).
  // 이전: Date.now() 박았는데, 세션 catchup replay 시 매번 Date.now() = "재진입 시각"
  // 으로 박혀서 "0.x s" 부터 다시 카운트 — 사용자 73f6006d 신고 ("0초부터 다시 세고").
  state.toolCards.set(useBlock.id, {
    cardEl: card,
    statusEl: status,
    latencyEl: latency,
    briefEl: brief,
    useRecId,
    startAt: Date.parse(recTs) || Date.now(),
  });
}

function resolveToolCard(toolUseId, resultBlock, recTs) {
  const entry = state.toolCards.get(toolUseId);
  if (!entry) return;
  entry.statusEl.classList.remove('running');
  entry.statusEl.classList.add(resultBlock.is_error ? 'error' : 'done');
  // #40 — elapsed 도 record ts 기반 (catchup replay 일관성).
  const endMs = Date.parse(recTs) || Date.now();
  const elapsed = (Math.max(0, endMs - entry.startAt) / 1000).toFixed(1);
  entry.latencyEl.textContent = `${elapsed}s`;
}

function formatBrief(name, input) {
  if (!input || typeof input !== 'object') return '';
  const firstPath = (p) => typeof p === 'string' ? p.split('/').slice(-2).join('/') : '';
  switch (name) {
    case 'Bash':      return (input.command || '').slice(0, 90);
    case 'Read':      return firstPath(input.file_path);
    case 'Write':     return firstPath(input.file_path);
    case 'Edit':      return firstPath(input.file_path);
    case 'Grep':      return input.pattern ? `"${String(input.pattern).slice(0, 60)}"` : '';
    case 'Glob':      return (input.pattern || '').slice(0, 80);
    case 'WebSearch': return (input.query || '').slice(0, 80);
    case 'WebFetch':  return (input.url || '').slice(0, 80);
    case 'TodoWrite': return Array.isArray(input.todos) ? `${input.todos.length} todos` : '';
    case 'Agent':
    case 'Task': {
      const sub = input.subagent_type || '?';
      const desc = input.description || '';
      return `${sub}${desc ? ' · ' + desc : ''}`.slice(0, 80);
    }
    default:          return '';
  }
}

// ─── meta card (rate_limit, result) ──────────────────────────

function addMetaCard(text, variant, recId) {
  const card = document.createElement('div');
  card.className = `act-card meta ${variant}`;
  card.dataset.recId = String(recId);
  card.textContent = text;
  appendToTurn(card);
}

// ─── click → modal ───────────────────────────────────────────

function handleListClick(e) {
  const card = e.target.closest('.act-card');
  if (!card) return;
  if (card.classList.contains('tool')) {
    openToolDetail(card.dataset.toolUseId, Number(card.dataset.useRecId));
  } else if (card.classList.contains('meta')) {
    openRawDetail(Number(card.dataset.recId));
  }
}

// render.js 의 tool-line 클릭이 직접 호출할 수 있도록 export.
// toolUseId 만으로 lookup 하는 경로 제공 — activity toolCards 에서 useRecId 조회 후 위임.
export function openToolDetailById(toolUseId) {
  const entry = state.toolCards.get(toolUseId);
  if (!entry) {
    console.warn('[activity] openToolDetailById: no card for', toolUseId);
    return;
  }
  openToolDetail(toolUseId, entry.useRecId);
}

function openToolDetail(toolUseId, useRecId) {
  const useRec = state.rawById.get(useRecId);
  if (!useRec) return;
  const useBlock = useRec.raw?.message?.content?.find((c) => c?.type === 'tool_use' && c.id === toolUseId);
  if (!useBlock) return;

  let resultBlock = null;
  for (const rec of state.rawById.values()) {
    if (rec.raw?.type !== 'user') continue;
    const content = rec.raw.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c?.type === 'tool_result' && c.tool_use_id === toolUseId) { resultBlock = c; break; }
    }
    if (resultBlock) break;
  }

  modalTitleEl.textContent = useBlock.name || 'tool';
  modalBodyEl.innerHTML = '';

  const inputSec = document.createElement('section');
  inputSec.className = 'modal-sec';
  const h1 = document.createElement('h3'); h1.textContent = 'input';
  inputSec.appendChild(h1);

  // Edit/Write/MultiEdit → diff DOM 삽입. 실패/비대상 시 plain JSON pre fallback.
  const DIFF_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);
  let diffInserted = false;
  if (DIFF_TOOLS.has(useBlock.name) && useBlock.input && typeof useBlock.input === 'object') {
    try {
      const diffEl = buildToolDiffDOM(useBlock.name, useBlock.input);
      if (diffEl) {
        inputSec.appendChild(diffEl);
        diffInserted = true;
      }
    } catch { /* fallback below */ }
  }
  if (!diffInserted) {
    const pre1 = document.createElement('pre');
    pre1.textContent = safeJson(useBlock.input);
    inputSec.appendChild(pre1);
  }

  modalBodyEl.appendChild(inputSec);

  if (resultBlock) {
    const outSec = document.createElement('section');
    outSec.className = 'modal-sec';
    const h2 = document.createElement('h3');
    h2.textContent = resultBlock.is_error ? 'output (error)' : 'output';
    if (resultBlock.is_error) h2.classList.add('error');
    const pre2 = document.createElement('pre');
    pre2.textContent = stringifyContent(resultBlock.content);
    outSec.appendChild(h2); outSec.appendChild(pre2);
    modalBodyEl.appendChild(outSec);
  } else {
    const note = document.createElement('div');
    note.className = 'modal-note';
    note.textContent = '아직 결과 없음 — 도구 실행 중';
    modalBodyEl.appendChild(note);
  }

  modalEl.classList.remove('hidden');
}

function openRawDetail(recId) {
  const rec = state.rawById.get(recId);
  if (!rec) return;
  modalTitleEl.textContent = rec.raw?.type || 'record';
  modalBodyEl.innerHTML = '';
  const sec = document.createElement('section');
  sec.className = 'modal-sec';
  const h = document.createElement('h3'); h.textContent = `raw · id=${rec.id}`;
  const pre = document.createElement('pre');
  pre.textContent = safeJson(rec.raw);
  sec.appendChild(h); sec.appendChild(pre);
  modalBodyEl.appendChild(sec);
  modalEl.classList.remove('hidden');
}

function closeModal() {
  modalEl.classList.add('hidden');
}

function safeJson(o) {
  try { return JSON.stringify(o, null, 2); } catch { return String(o); }
}
function stringifyContent(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => x?.text ?? safeJson(x)).join('\n');
  return safeJson(c);
}
