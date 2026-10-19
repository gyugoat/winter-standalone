// web/js/app.js — entry point. Session management + stream wiring.

import { openStream, closeStream } from './stream.js';
import { reset as resetChat, consume as consumeChat, bindUI as bindChatUI, resetAutoFollow, startCatchup, finishCatchup, setViewSid, setToolDetailHandler, updatePlanBadgeUsage, markTurnRunning } from './render.js';
import { bindActivityUI, reset as resetActivity, consume as consumeActivity, togglePanel as toggleActivity, openToolDetailById } from './activity.js';
import { bindTaskStackUI, reset as resetTaskStack, consume as consumeTaskStack, finishCatchupCards } from './task-stack.js';
import { initSnow, toggleSnow } from './snow.js';
import { primeChimeAudio, playChime } from './chime.js';
import { startChimeBus, isWatched } from './chime-bus.js';
import { showToast } from './toast.js';
import { registerShortcut, listShortcuts, prettyCombo } from './keymap.js';
import { openSettings, initSettings } from './settings.js';
import { initSearch, isSearchActive, clearSearch } from './search.js';
import { initJobs } from './jobs.js';
import { initProjects, syncSessionProjectSelect } from './projects.js';
import { initArtifacts, isReaModalOpen, closeReaModal } from './artifacts.js';

// researchMode: 1회성 플래그 (전송 성공 직후 자동 false 로 리셋 — oracle 확정, sticky 금지).
// composer 의 #research-toggle 로만 flip. sendMessage 가 body 에 실어 서버 runner 에 넘김.
const state = { currentSid: null, researchMode: false };

// inject 세션 배지 chime 판정용 — null: 첫 로드 시딩 직후 (무음 보장), Set 이후: diff 기반 chime.
let prevBadgedSids = null;

// running 세션 존재 시 3s 적응 폴링 타이머 — 중첩 방지 가드.
let runningRefreshTimer = null;

// ─── 다이아몬드 배지 — lastSeen 기반 (SSE 무관, 데이터 기반) ─────────────────
// localStorage winter3.lastSeen = JSON map { sid: updatedAt(ms) }
// 렌더 시: session.updatedAt > lastSeen[sid] → 미열람 배지 표시.
// 세션 진입 or 현재 세션에 record 도착 시 lastSeen[sid]=now 갱신.
// 초기화: lastSeen 자체 없으면 현재 목록 전체를 seen 으로 시딩 (기존 세션 배지 폭탄 방지).
const LAST_SEEN_KEY = 'winter3.lastSeen';

function loadLastSeen() {
  try {
    const raw = localStorage.getItem(LAST_SEEN_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return null; // null = 아직 한 번도 저장 안 됨 (첫 로드 판별용)
}
function saveLastSeen(map) {
  try { localStorage.setItem(LAST_SEEN_KEY, JSON.stringify(map)); } catch {}
}
// sid 를 지금 본 것으로 기록 (진입 or record 도착).
function markSeen(sid) {
  if (!sid) return;
  const map = loadLastSeen() || {};
  map[sid] = Date.now();
  saveLastSeen(map);
}
// 첫 로드 시딩 — sessionList 에서 전 세션을 현재 updatedAt 값으로 기록해 배지 초기화.
function seedLastSeenIfAbsent(sessionList) {
  if (loadLastSeen() !== null) return; // 이미 있으면 건드리지 않음
  const map = {};
  for (const s of sessionList) {
    if (s.id && s.updatedAt) map[s.id] = s.updatedAt;
  }
  saveLastSeen(map);
}

// 멀티탭 동기화 — 한 탭에서 세션 변경 시 localStorage bump key 증가 → 다른 탭은 storage 이벤트로 목록 재렌더.
const BUMP_KEY = 'winter3:session-bump';
function bumpSessionChange() {
  try { localStorage.setItem(BUMP_KEY, String(Date.now())); } catch {}
}
window.addEventListener('storage', (e) => {
  if (e.key !== BUMP_KEY) return;
  renderSessionList();
});

async function setCurrentSession(sid) {
  if (state.currentSid === sid) return;
  // 떠나는 세션을 seen 처리 → 세션 전환 후 배지/chime 오발사 방지.
  // 진짜 새 응답(turn_end 이후 updatedAt bump)은 이후 markSeen 없으므로 정상 발화됨.
  if (state.currentSid && state.currentSid !== sid) markSeen(state.currentSid);
  if (state.currentSid) closeStream();
  state.currentSid = sid;
  setViewSid(sid);  // render.js 의 startTimer/stopTimer sid 가드용 — cross-session UI 오염 방어.
  localStorage.setItem('winter3:lastSid', sid);
  clearQueue();  // 세션 전환 → 이전 세션 큐는 의미 없음
  resetChat();
  resetActivity();
  resetTaskStack();

  // 세션 메타 로드 → 헤더 title 갱신
  let sessMeta = null;
  try {
    const meta = await fetch(`/sessions/${sid}`).then((r) => r.ok ? r.json() : null);
    if (meta) {
      sessMeta = meta;
      document.getElementById('chat-title').textContent = meta.title || '새 대화';
      document.getElementById('chat-meta').textContent = sid.slice(0, 8);
      // 2026-08-19: 세션별 model override 반영 → composer-hint 의 모델 span 갱신.
      if (typeof window.__winter3ApplySessionModel === 'function') {
        window.__winter3ApplySessionModel(meta);
      }
    }
  } catch { /* */ }
  // 축 4 — 헤더 Project 드롭다운을 이 세션 기준으로 동기화 (meta 실패해도 sid 는 유효 → 미할당 표시).
  syncSessionProjectSelect(sid, sessMeta?.projectId || null);

  // 세션 진입 → lastSeen 갱신 (배지 소멸).
  markSeen(sid);

  renderSessionList();

  // #92 S3: startCatchup 을 openStream 직전으로 이동.
  // 기존: fetch 완료 전에 800ms 안전망 시작 → SSE 열리기 전에 finishCatchup 발화 → 빈 화면.
  // 수정: fetch/markSeen/renderSessionList 모두 완료 후 startCatchup → openStream 순서 보장.
  startCatchup();
  // record 도착 시마다 idle 타이머 리셋 — 250ms 동안 새 record 없으면 catchup 종료.
  let idleTimer = null;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    // #49 — catchup 종료 시 task-stack 의 orphan 'running' 카드도 'aborted' 마감.
    // SSE catchup_done marker 경로(task-stack.consume)와 중복 호출돼도 idempotent.
    // #88 — catchup 종료 후 이 세션의 대기 메시지 큐 flush 시도.
    // turn 진행 중이면 tryFlushMsgQueue 내부에서 no-op. 큐 비면 no-op → idempotent.
    // armIdle 이 여러 번 fire 돼도 큐 비면 이후 호출 전부 no-op 이라 안전.
    idleTimer = setTimeout(() => { finishCatchup(); finishCatchupCards(); tryFlushMsgQueue(); idleTimer = null; }, 250);
  };
  // 빈 세션 보호 — 첫 record 가 영영 안 오면 250ms 뒤 catchup 종료해서 빈 화면 보이게.
  armIdle();
  openStream(sid, (rec) => {
    // SSE record 자체엔 sid 가 없음 (server/index.js handleEventsSSE 의 envelope = {id,ts,raw}).
    // render.js startTimer/stopTimer sid 가드가 비교할 수 있게 여기서 주입.
    if (rec && typeof rec === 'object' && rec.sid === undefined) rec.sid = sid;
    consumeChat(rec);
    consumeActivity(rec);
    consumeTaskStack(rec);
    updateEmptyState();
    armIdle();
    // 현재 보고 있는 세션에 record 도착 → lastSeen 갱신 (배지가 생기지 않게).
    markSeen(sid);
  });
  updateEmptyState();
}

function updateEmptyState() {
  const msgs = document.getElementById('messages');
  const empty = document.getElementById('empty-state');
  if (!msgs || !empty) return;
  // .load-more-btn 은 페이지네이션 버튼 — 메시지 아님. 카운트 제외해서 빈 세션 판정 오염 방지.
  const realChildCount = [...msgs.children].filter((el) => !el.classList.contains('load-more-btn')).length;
  empty.classList.toggle('hidden', realChildCount > 0);
}

async function renderSessionList() {
  // lastEventId 정보도 같이 — 빈 세션 필터링 위해. list endpoint 는 meta 만 반환하므로
  // 개별 요청 대신 간단히 list 에 _counts 를 추가하거나, 클라에서 event count 가늠.
  // 여기선 title='새 대화' AND claudeSessionId=null 패턴을 "빈" 으로 간주 (서버 기본 created-but-empty).
  // /sessions/active 는 실패해도 리스트 렌더를 막지 않음 — 빈 배열로 degrade.
  const [list, activeList] = await Promise.all([
    fetch('/sessions').then((r) => r.json()),
    fetch('/sessions/active').then((r) => (r.ok ? r.json() : [])).catch(() => []),
  ]);
  const runningSids = new Set((Array.isArray(activeList) ? activeList : []).map((a) => a.id));
  // 첫 로드 판별 — localStorage 에 lastSeen 없으면 전체 시딩 (기존 세션 배지 폭탄 방지).
  seedLastSeenIfAbsent(list);
  const filtered = list.filter((s) => {
    // active 세션은 빈이어도 보이게
    if (s.id === state.currentSid) return true;
    // "새 대화" 제목 그대로 + claudeSessionId 없음 = 실질적 빈 세션
    const looksEmpty = (s.title === '새 대화' || !s.title) && !s.claudeSessionId;
    return !looksEmpty;
  });
  const ul = document.getElementById('session-list');
  ul.innerHTML = '';
  // 이번 렌더에서 배지 붙은 sid 수집 — 렌더 끝에 chime 판정에 사용.
  const thisBadgedSids = new Set();
  for (const s of filtered) {
    const li = document.createElement('li');
    li.dataset.sid = s.id;
    if (s.id === state.currentSid) li.classList.add('active');

    const label = document.createElement('span');
    label.className = 'session-label';
    label.textContent = s.title || '(제목 없음)';
    // 세션 전환 click 은 ul 이벤트 위임(initSessionListDelegate)으로 처리.
    // label 자체 click 핸들러 제거 — stopPropagation 이 위임을 막아 dot/여백 탭 시 미반응했던 버그 수정.
    label.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      label.contentEditable = 'true';
      label.focus();
      // 커서 끝에
      const range = document.createRange(); range.selectNodeContents(label); range.collapse(false);
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    });
    label.addEventListener('blur', async () => {
      if (!label.isContentEditable) return;
      label.contentEditable = 'false';
      const newTitle = label.textContent.trim().slice(0, 120);
      if (!newTitle || newTitle === (s.title || '')) return;
      try {
        await fetch(`/sessions/${s.id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: newTitle }),
        });
        if (s.id === state.currentSid) document.getElementById('chat-title').textContent = newTitle;
        bumpSessionChange();
        showToast('제목 변경됨', 'success', 1400);
      } catch (err) { showToast('이름 변경 실패: ' + err.message, 'error', 3000); }
    });
    label.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); label.blur(); }
      if (e.key === 'Escape') { label.textContent = s.title || '(제목 없음)'; label.blur(); }
    });

    const actions = document.createElement('span');
    actions.className = 'session-actions';

    // ✎ 이름변경 — 명시적 버튼 (dblclick 도 유지)
    const edit = document.createElement('button');
    edit.className = 'session-act edit';
    edit.title = '이름 변경';
    edit.setAttribute('aria-label', '이름 변경');
    edit.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z"/></svg>';
    edit.addEventListener('click', (e) => {
      e.stopPropagation();
      label.contentEditable = 'true';
      label.focus();
      const range = document.createRange(); range.selectNodeContents(label); range.collapse(false);
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    });

    // × 삭제 — confirm 없이 즉시 + undo 토스트
    const del = document.createElement('button');
    del.className = 'session-act del';
    del.title = '세션 삭제 (⌘⇧⌫ = 현재 세션 즉시)';
    del.setAttribute('aria-label', '삭제');
    del.innerHTML = '×';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteSessionWithUndo(s.id, s.title || s.id.slice(0, 8));
    });

    actions.appendChild(edit);
    actions.appendChild(del);

    // 다이아몬드 배지 — running 세션은 회전 다이아, 그 외 lastSeen 기반 미열람 정적 다이아.
    // running 은 thisBadgedSids 에 안 넣음 → chime/rail-noti-dot 억제. 턴 종료 후 다음 렌더에서
    // updatedAt > lastSeen 이 잡혀 그때 정적 다이아 + chime = "응답 완료" 알림.
    if (runningSids.has(s.id)) {
      const dot = document.createElement('span');
      dot.className = 'session-diamond running';
      dot.title = '응답 생성 중';
      li.prepend(dot);
    } else if (s.id !== state.currentSid && s.updatedAt) {
      const lastSeen = loadLastSeen() || {};
      const seenAt = lastSeen[s.id];
      if (!seenAt || s.updatedAt > seenAt) {
        const dot = document.createElement('span');
        dot.className = 'session-diamond';
        dot.title = '미열람 업데이트';
        li.prepend(dot);
        thisBadgedSids.add(s.id);
      }
    }

    li.appendChild(label);
    li.appendChild(actions);
    ul.appendChild(li);
  }

  // inject 세션 배지 chime 판정 — prevBadgedSids null 은 첫 로드 시딩 직후 (무음 보장).
  // 이번 렌더에서 새로 배지가 붙은 sid 중 chime-bus 가 감시하지 않는 것이 있으면 chime 한 번.
  // (chime-bus 가 감시 중인 세션은 turn_end 경로에서 이미 울리므로 제외 — 이중 울림 방지.)
  if (prevBadgedSids !== null) {
    let needChime = false;
    for (const sid of thisBadgedSids) {
      if (!prevBadgedSids.has(sid) && !isWatched(sid)) {
        needChime = true;
        break;
      }
    }
    if (needChime) playChime();
  }
  prevBadgedSids = thisBadgedSids;

  // rail 알림 점 — 미열람 세션 1개 이상일 때만 표시.
  document.getElementById('rail-noti-dot')?.classList.toggle('hidden', thisBadgedSids.size === 0);

  // 적응 폴링 — running 세션이 있는 동안만 3s 재렌더 (스피너→다이아 전환 + chime 지연 최소화).
  // 기본 15s setInterval 은 그대로 baseline. 매 렌더마다 기존 타이머 clear 라 중복 예약 없음.
  clearTimeout(runningRefreshTimer);
  if (runningSids.size > 0) runningRefreshTimer = setTimeout(renderSessionList, 3000);
}

/** 현재 세션이 비어있으면 (user_prompt 0개) 새 세션 만들지 않고 그대로. */
async function isCurrentSessionEmpty() {
  if (!state.currentSid) return false;
  try {
    const info = await fetch(`/sessions/${state.currentSid}`).then((r) => r.ok ? r.json() : null);
    if (!info) return false;
    return (info.lastEventId === undefined || info.lastEventId < 0);
  } catch { return false; }
}

async function createNewSession() {
  if (await isCurrentSessionEmpty()) {
    showToast('이미 빈 세션이야', '', 1200);
    document.getElementById('input')?.focus();
    return;
  }
  const resp = await fetch('/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const meta = await resp.json();
  setCurrentSession(meta.id);
  bumpSessionChange();
}

// 삭제 + 5s undo — confirm 팝업 대체. 서버는 archived/ 로 이동 + summary.md 생성.
// #94 — 진행 중 세션 삭제 전 확인: /sessions/active 로 running 판별.
// fetch 실패 시 degrade (삭제 차단 안 함) — renderSessionList 의 동일 원칙.
async function deleteSessionWithUndo(sid, preview) {
  // running 판별 — 실패해도 삭제 진행 (degrade).
  let isRunning = false;
  try {
    const activeList = await fetch('/sessions/active').then((r) => r.ok ? r.json() : []).catch(() => []);
    isRunning = (Array.isArray(activeList) ? activeList : []).some((a) => a.id === sid);
  } catch { /* degrade */ }
  if (isRunning) {
    const ok = confirm('이 세션은 지금 작업 중이야. 끊고 지울까?');
    if (!ok) return;
  }
  try {
    await fetch(`/sessions/${sid}`, { method: 'DELETE' });
  } catch (err) { showToast('삭제 실패: ' + err.message, 'error', 3000); return; }

  const wasCurrent = (sid === state.currentSid);
  if (wasCurrent) {
    state.currentSid = null;
    localStorage.removeItem('winter3:lastSid');
    resetChat(); resetActivity();
    document.getElementById('chat-title').textContent = '새 대화';
    document.getElementById('chat-meta').textContent = '';
  }
  // #88 — 삭제된 세션의 메시지 큐 drop + 토스트 (큐가 있었을 때만).
  const _deletedQueue = messageQueues.get(sid);
  if (_deletedQueue && _deletedQueue.length > 0) {
    messageQueues.delete(sid);
    persistMsgQueues();
    showToast(`대기 메시지 ${_deletedQueue.length}개 함께 삭제됨`, 'warn', 3000);
  } else {
    messageQueues.delete(sid);
    persistMsgQueues();
  }
  // retryQueue 도 비움 (삭제된 세션에 잘못 재발사 방지 — #57).
  clearRetryQueue();
  await renderSessionList();
  bumpSessionChange();

  // Undo 토스트 (클릭 시 restore). showToast 가 일반 텍스트 전용이라 inline DOM 으로 띄움.
  const existing = document.querySelectorAll('.toast');
  if (existing.length >= 3) existing[0].remove();
  const toast = document.createElement('div');
  toast.className = 'toast toast-undo visible';
  toast.innerHTML = '';
  const msg = document.createElement('span');
  msg.textContent = `삭제됨: ${String(preview).slice(0, 40)}`;
  const btn = document.createElement('button');
  btn.className = 'toast-action';
  btn.textContent = '실행취소';
  btn.addEventListener('click', async () => {
    try {
      const r = await fetch(`/sessions/${sid}/restore`, { method: 'POST' });
      if (!r.ok) throw new Error('restore failed');
      await renderSessionList();
      if (wasCurrent) setCurrentSession(sid);
      toast.remove();
      showToast('복원됨', 'success', 1400);
    } catch (err) { showToast('복원 실패: ' + err.message, 'error', 3000); }
  });
  toast.appendChild(msg);
  toast.appendChild(btn);
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 300);
  }, 5000);
}

// #57 — send 실패 판정 (network error / timeout / 5xx) + 실패 시 재시도 큐 적재.
// dispatch POST 는 fire-and-forget 이 아니라 실제 서버 상태의 유일한 초기 신호.
// 실패 = 서버 down 가능성 → 배너 + 큐 + health poll 로 자동 복구 파이프라인 활성.
const SEND_TIMEOUT_MS = 10000;

async function sendMessage(text) {
  if (!state.currentSid) await createNewSession();
  const sid = state.currentSid;
  resetAutoFollow();  // 새 턴 시작 → 자동 스크롤 재개

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort('timeout'), SEND_TIMEOUT_MS);

  // researchMode: 1회성. 이 turn 에만 실어 보내고, 성공 후 아래에서 리셋.
  // 원칙 P1: userText 는 raw = truth 이므로 절대 변조 금지. 플래그는 별도 필드로만.
  const researchMode = state.researchMode === true;

  let resp;
  try {
    resp = await fetch('/dispatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sid, userText: text, researchMode }),
      signal: controller.signal,
    });
  } catch (err) {
    // network error (fetch reject) 또는 abort(timeout). 서버 down 판정.
    clearTimeout(timeoutId);
    const reason = (err && err.name === 'AbortError') ? 'timeout' : (err?.message || 'network');
    enqueueRetry({ sid, text }, `연결 실패 (${reason})`);
    return false;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!resp.ok) {
    if (resp.status >= 500) {
      // 5xx = 서버 문제. 큐에 적재 후 poll 로 복구.
      enqueueRetry({ sid, text }, `서버 오류 (${resp.status})`);
      return false;
    }
    // PATCHING #103: 409 = 서버 turn 진행 중인데 UI 는 idle (삼킴 자동 재전송 등 서버 주도 턴).
    // 서버가 진실 — UI 를 running 으로 동기화 + 메시지는 세션 큐로 (#88 경로, turn_end 후 자동 발사).
    // return true: input 복원 금지 (이미 큐에 들어감) + sendBtn hidden (running 중).
    if (resp.status === 409) {
      markTurnRunning(sid);
      msgQueueFor(sid).push(text);
      persistMsgQueues();
      showToast(`응답 진행 중 — 큐 추가됨 (대기 ${msgQueueFor(sid).length}개)`, '', 2200);
      return true;
    }
    // 그 외 4xx = 클라 문제. 큐 안 함, 토스트만.
    const err = await resp.json().catch(() => ({ error: 'unknown' }));
    showToast('dispatch 실패: ' + (err.error || resp.statusText), 'error', 5000);
    return false;
  }
  // 전송 성공 → researchMode 1회성 리셋 (sticky 금지 — oracle 확정).
  // 실패 경로에선 리셋 안 함 (재시도 시 그대로 유지).
  if (state.researchMode) {
    state.researchMode = false;
    const btn = document.getElementById('research-toggle');
    if (btn) {
      btn.classList.remove('active');
      btn.setAttribute('aria-pressed', 'false');
    }
  }
  bumpSessionChange();
  return true;
}

// ─── #57. 서버 down 배너 + 재시도 큐 + health poll ───────────────
// 정책:
//   - send 가 network/timeout/5xx 로 실패하면 큐에 push + 빨강 배너 표시 + health poll 시작.
//   - health poll 은 down 상태에서만 (3s interval). 200 뜨면 큐 순서대로 재발사.
//   - 재발사 중 실패면 다시 큐 앞에 unshift + poll 지속.
//   - sessionStorage 백업 — 새로고침해도 큐 살아있음. 성공 시 지움.
//   - 세션 전환 시 큐는 clearQueue() 로 비움 (다른 세션에 잘못 보내면 안 됨).

const HEALTH_POLL_MS = 3000;
const RETRY_QUEUE_KEY = 'winter3:retry-queue';
const retryQueue = [];  // [{ sid, text, ts }]
let _healthPollTimer = null;
let _draining = false;

function loadRetryQueueFromStorage() {
  try {
    const raw = sessionStorage.getItem(RETRY_QUEUE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (item && typeof item.sid === 'string' && typeof item.text === 'string') {
          retryQueue.push(item);
        }
      }
    }
  } catch {}
}
function persistRetryQueue() {
  try {
    if (retryQueue.length === 0) sessionStorage.removeItem(RETRY_QUEUE_KEY);
    else sessionStorage.setItem(RETRY_QUEUE_KEY, JSON.stringify(retryQueue));
  } catch {}
}
function updateOfflineBannerQueueCount() {
  const el = document.querySelector('#offline-banner .offline-banner-queue');
  if (!el) return;
  el.textContent = retryQueue.length > 0 ? `(대기 ${retryQueue.length}건)` : '';
}
function showOfflineBanner(reason) {
  const banner = document.getElementById('offline-banner');
  if (!banner) return;
  const msg = banner.querySelector('.offline-banner-msg');
  if (msg) msg.textContent = `서버 응답 없음 — 연결 복구 대기 중 · ${reason} · 메시지는 큐에 보관됨`;
  updateOfflineBannerQueueCount();
  banner.classList.remove('hidden');
}
function hideOfflineBanner() {
  document.getElementById('offline-banner')?.classList.add('hidden');
}
// canary 미해소 알림 배너 — /settings 의 canaryAlert (플래그 파일 내용 | null) 반영.
// null = 플래그 소멸(해소) → 숨김. dismiss 버튼 없음 (플래그 소멸이 유일한 해소 경로).
function updateCanaryBanner(text) {
  const banner = document.getElementById('canary-banner');
  if (!banner) return;
  if (text == null) { banner.classList.add('hidden'); return; }
  const msg = banner.querySelector('.canary-banner-msg');
  if (msg) msg.textContent = `CANARY ALERT: ${text}`;
  banner.classList.remove('hidden');
}
// ── 서버 재시작 버튼 — POST /restart (LLM 안 거침, 서버가 restart.sh 직접 spawn — #37) ──
// 흐름: confirm 1회 → POST → 배너 표시 → 2s 간격 /health poll.
// 재기동 판별 3중: (a) fetch 실패(down)를 본 뒤 다시 ok, (b) /health 의 up(uptime) 이
// POST 이전 사전캡처값(baseUp)보다 감소 — down 창이 poll 간격(2s)보다 짧아 (a) 를 놓쳐도 잡는다,
// (c) baseUp null fallback: up 이 배너 이후 경과시간보다 짧음 = 그 사이 재기동.
// 90s 내 확인 실패 → 수동 새로고침 안내. fetch 실패는 재시작 중 정상이라 catch 로 무시.
let _restartPolling = false;
function showRestartBanner(text) {
  const banner = document.getElementById('restart-banner');
  if (!banner) return;
  const msg = banner.querySelector('.restart-banner-msg');
  if (msg) msg.textContent = text;
  banner.classList.remove('hidden');
}
async function requestServerRestart() {
  if (_restartPolling) return;
  if (!confirm('서버를 재시작할까? 진행 중 작업은 종료된 뒤 적용된다.')) return;
  // baseUp 은 POST 이전, 구 서버의 uptime 으로 사전 캡처 — poll 루프 안에서 잡으면
  // down 창(~1s)이 첫 poll(+2s) 전에 끝났을 때 새 서버 uptime 이 잡혀 영원히 감소 미관측 (버그).
  let baseUp = null;
  try {
    const h = await fetch('/health', { cache: 'no-store' });
    if (h.ok) {
      const b = await h.json().catch(() => ({}));
      if (typeof b.up === 'number') baseUp = b.up;
    }
  } catch { /* 캡처 실패해도 진행 — sawDown/보너스 조건이 fallback */ }
  try {
    const r = await fetch('/restart', { method: 'POST' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
  } catch (e) {
    showToast('재시작 요청 실패', e.message || '', 3000);
    return;
  }
  _restartPolling = true;
  showRestartBanner('서버 재시작 중… (진행 중 작업 종료 후 적용)');
  const startedAt = Date.now();
  let sawDown = false; // down 을 한 번이라도 봤는가
  const timer = setInterval(async () => {
    if (Date.now() - startedAt > 90_000) {
      clearInterval(timer);
      _restartPolling = false;
      showRestartBanner('재시작 확인 실패 — 수동 새로고침 필요');
      return;
    }
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const res = await fetch('/health', { signal: ctrl.signal, cache: 'no-store' });
      clearTimeout(t);
      if (!res.ok) { sawDown = true; return; }
      const body = await res.json().catch(() => ({}));
      const up = typeof body.up === 'number' ? body.up : null;
      // 보너스 조건: baseUp 사전캡처 실패(null) 시 fallback — 서버 uptime 이 배너 띄운 뒤
      // 경과시간보다 짧으면 그 사이 재기동한 것 (up*1000 < elapsed).
      if (sawDown ||
          (baseUp != null && up != null && up < baseUp) ||
          (up != null && up * 1000 < Date.now() - startedAt)) {
        clearInterval(timer);
        location.reload();
        return;
      }
    } catch { sawDown = true; /* 서버 내려간 동안 fetch 실패 = 정상 */ }
  }, 2000);
}
// 5분 주기 재조회 전용 경량 함수 — renderSettings(모델/힌트 초기화) 재실행 없이 배너만 갱신.
async function refreshCanaryAlert() {
  try {
    const r = await fetch('/settings');
    if (!r.ok) return;
    const s = await r.json();
    updateCanaryBanner(s.canaryAlert ?? null);
  } catch { /* 서버 down 은 offline-banner 영역 — 여기선 무시 */ }
}
function enqueueRetry(item, reason) {
  retryQueue.push({ ...item, ts: Date.now() });
  persistRetryQueue();
  showOfflineBanner(reason);
  startHealthPoll();
}
function startHealthPoll() {
  if (_healthPollTimer) return;  // 이미 돌면 재진입 금지
  _healthPollTimer = setInterval(pollHealthAndDrain, HEALTH_POLL_MS);
  // 즉시 한 번 시도 (interval 첫 tick 을 3s 기다리지 않게)
  setTimeout(pollHealthAndDrain, 250);
}
function stopHealthPoll() {
  if (_healthPollTimer) { clearInterval(_healthPollTimer); _healthPollTimer = null; }
}
async function pollHealthAndDrain() {
  if (_draining) return;  // in-flight guard — 중복 drain 금지
  if (retryQueue.length === 0) { stopHealthPoll(); hideOfflineBanner(); return; }
  // /health 200 확인
  let alive = false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const r = await fetch('/health', { signal: ctrl.signal });
    clearTimeout(t);
    alive = r.ok;
  } catch { alive = false; }
  if (!alive) {
    updateOfflineBannerQueueCount();
    return;  // 다음 tick 재시도
  }
  await drainRetryQueue();
}
async function drainRetryQueue() {
  if (_draining) return;
  _draining = true;
  const initialCount = retryQueue.length;
  try {
    while (retryQueue.length > 0) {
      const item = retryQueue[0];
      // 이미 세션 전환된 경우 (sid 안 맞음): 큐에서 버림 — 다른 세션으로 재발사하면 안 됨.
      if (state.currentSid && item.sid !== state.currentSid) {
        retryQueue.shift();
        persistRetryQueue();
        continue;
      }
      let ok = false;
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort('timeout'), SEND_TIMEOUT_MS);
        const resp = await fetch('/dispatch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: item.sid, userText: item.text }),
          signal: ctrl.signal,
        });
        clearTimeout(t);
        if (resp.ok) {
          ok = true;
        } else if (resp.status >= 500) {
          ok = false;  // 여전히 서버 아픔 → 큐 유지
        } else {
          // 4xx (예: 409 turn 진행 중) — 재발사 잠시 뒤로. 다음 poll tick 에 재시도.
          ok = false;
        }
      } catch {
        ok = false;
      }
      if (ok) {
        retryQueue.shift();
        persistRetryQueue();
        updateOfflineBannerQueueCount();
        bumpSessionChange();
      } else {
        // 실패 → drain 중단, 다음 poll tick 대기
        updateOfflineBannerQueueCount();
        break;
      }
    }
    if (retryQueue.length === 0) {
      hideOfflineBanner();
      stopHealthPoll();
      const sent = initialCount;
      if (sent > 0) showToast(`재접속됨 — ${sent}건 재전송 완료`, 'success', 2400);
    }
  } finally {
    _draining = false;
  }
}

async function killCurrent() {
  if (!state.currentSid) return;
  await fetch(`/kill/${state.currentSid}`, { method: 'POST' });
}

// ─── 메시지 큐 (응답 진행 중 추가 입력) ──────────────────────────
// 진행 중에 submit 하면 dispatch 가 409 → input 텍스트 손실. 그래서:
//   - 진행 중이면 client-side 큐에 push, input 비우고 토스트.
//   - render.js 의 stopTimer 가 'winter3:turn-end' CustomEvent dispatch → 여기서 받아 flush.
//   - 세션 전환 시 큐를 버리지 않는다 (세션별 Map 이라 cross-fire 없음) — #88.
//   - 세션 삭제 시만 해당 sid 큐 drop + 토스트.
//   - 첨부 (staged) 가 있으면 큐 거부 (이미지는 즉시 업로드 흐름이라 큐화 복잡).
//
// #88 — 세션별 큐 (messageQueues Map, sid→[text]) + sessionStorage 영속화.
// 이전 단일 배열(messageQueue)은 세션 전환 시 clearQueue() 가 조용히 버려 유저 메시지 증발.
// retryQueue 의 loadRetryQueueFromStorage/persistRetryQueue 패턴 그대로 복제.
const MSG_QUEUE_KEY = 'winter3:msg-queue';
const messageQueues = new Map(); // sid → string[]

function loadMsgQueuesFromStorage() {
  try {
    const raw = sessionStorage.getItem(MSG_QUEUE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [sid, arr] of Object.entries(parsed)) {
        if (typeof sid === 'string' && Array.isArray(arr)) {
          const texts = arr.filter((t) => typeof t === 'string');
          if (texts.length > 0) messageQueues.set(sid, texts);
        }
      }
    }
  } catch {}
}

function persistMsgQueues() {
  try {
    if (messageQueues.size === 0) {
      sessionStorage.removeItem(MSG_QUEUE_KEY);
      return;
    }
    const obj = {};
    for (const [sid, arr] of messageQueues.entries()) {
      if (arr.length > 0) obj[sid] = arr;
    }
    if (Object.keys(obj).length === 0) sessionStorage.removeItem(MSG_QUEUE_KEY);
    else sessionStorage.setItem(MSG_QUEUE_KEY, JSON.stringify(obj));
  } catch {}
}

// 해당 sid 의 큐 배열 반환 — 없으면 빈 배열 생성 후 등록.
function msgQueueFor(sid) {
  if (!messageQueues.has(sid)) messageQueues.set(sid, []);
  return messageQueues.get(sid);
}

function isTurnRunning() {
  const ind = document.getElementById('running-indicator');
  return !!(ind && !ind.classList.contains('hidden'));
}

// clearRetryQueue — 세션 전환/삭제 시 down-창 재시도 큐만 비움 (#57).
// 다른 세션에 잘못 재발사되면 안 됨. drain 도 다음 poll 에 자동 no-op.
// 메시지 큐(messageQueues)는 세션별이므로 세션 전환 시 건드리지 않는다 — #88.
function clearRetryQueue() {
  if (retryQueue.length > 0) {
    retryQueue.length = 0;
    persistRetryQueue();
    updateOfflineBannerQueueCount();
    hideOfflineBanner();
    stopHealthPoll();
  }
}

// clearQueue — 하위 호환 래퍼 (세션 전환 경로: retryQueue 만 비움, messageQueues 유지).
function clearQueue() {
  clearRetryQueue();
}

// ─── #88: tryFlushMsgQueue — 모듈 스코프 hoist ───────────────────────
// turn-end listener 와 setCurrentSession catchup idleTimer 양쪽에서 호출.
// 현재 세션 큐 머리 1개를 꺼내 250ms 후 발사. isTurnRunning() 가드는 기존 그대로.
// 발사 직전 input.value.trim() 이 비어있지 않으면 (유저가 타이핑 중) 큐에 unshift 유지.
// 큐가 비면 no-op → idleTimer 에서 여러 번 호출돼도 idempotent.
function tryFlushMsgQueue() {
  if (!state.currentSid) return;
  const sid = state.currentSid; // 세션 전환 감지용 — setTimeout 250ms 사이에 바뀔 수 있음.
  const q = msgQueueFor(sid);
  if (q.length === 0) return;
  const next = q.shift();
  persistMsgQueues();
  setTimeout(() => {
    // #88 가드: 250ms 사이에 세션이 바뀌었으면 원래 세션 큐에 되돌리고 발사 중단.
    // 복귀 시 catchup idleTimer 의 tryFlushMsgQueue 가 다시 집어든다.
    if (state.currentSid !== sid) {
      q.unshift(next);
      persistMsgQueues();
      return;
    }
    const input = document.getElementById('input');
    const form = document.getElementById('composer');
    if (!input || !form) {
      // DOM 없으면 되돌려놓음.
      q.unshift(next);
      persistMsgQueues();
      return;
    }
    if (isTurnRunning()) {
      // 다른 dispatch 가 먼저 들어왔으면 다시 큐 앞에 도로 push.
      q.unshift(next);
      persistMsgQueues();
      return;
    }
    // 유저가 타이핑 중이면 덮어쓰지 않고 다음 기회에.
    if (input.value.trim() !== '') {
      q.unshift(next);
      persistMsgQueues();
      return;
    }
    input.value = next;
    form.requestSubmit();
  }, 250);
}

// ─── 첨부 (이미지 paste / drop / click) ────────────────────────────
const staged = []; // [{ dataUrl, blob, name }]

function renderAttachPreview() {
  const host = document.getElementById('attach-preview');
  const attachBtn = document.getElementById('attach-btn');
  host.innerHTML = '';
  if (staged.length === 0) {
    host.classList.add('hidden');
    attachBtn?.classList.remove('staged');
    return;
  }
  host.classList.remove('hidden');
  attachBtn?.classList.add('staged');
  staged.forEach((s, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'attach-thumb';
    const img = document.createElement('img');
    img.src = s.dataUrl;
    img.addEventListener('click', () => {
      if (window.__winter3_openImagePreview) window.__winter3_openImagePreview(s.dataUrl, s.name);
    });
    wrap.appendChild(img);
    const rm = document.createElement('button');
    rm.className = 'attach-remove';
    rm.textContent = '×';
    rm.title = '제거';
    rm.addEventListener('click', (e) => {
      e.stopPropagation();
      staged.splice(i, 1);
      renderAttachPreview();
    });
    wrap.appendChild(rm);
    host.appendChild(wrap);
  });
}

async function uploadStagedAndClear() {
  if (!state.currentSid || staged.length === 0) return { ok: true };
  const failures = [];
  for (const s of staged) {
    const base64 = s.dataUrl.split(',')[1];
    try {
      const res = await fetch(`/sessions/${state.currentSid}/attach`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataBase64: base64, mime: s.blob.type || 'image/png' }),
      });
      if (!res.ok) failures.push({ s, reason: `HTTP ${res.status}` });
    } catch (err) {
      failures.push({ s, reason: err?.message || '네트워크 오류' });
    }
  }
  if (failures.length === 0) {
    staged.length = 0;
  } else {
    // 실패 항목은 staged 에 보존, 성공 항목만 제거
    const failSet = new Set(failures.map((f) => f.s));
    staged.splice(0, staged.length, ...staged.filter((s) => failSet.has(s)));
    for (const { s, reason } of failures) {
      showToast(`첨부 실패 — ${s.name}: ${reason}`, 'error', 4000);
    }
  }
  renderAttachPreview();
  return failures.length === 0 ? { ok: true } : { ok: false };
}

// #39 V3 — frontend pre-upload downscale.
// Anthropic Vision many-image 한도 2000px. 안전마진 1568px (server runner IMAGE_MAX_LONG_EDGE 와 일치).
// V2 문서엔 있다고 했는데 실측 시 코드 누락 — V3 가 진짜 추가. canvas resize 후 dataURL/blob 갱신.
const IMAGE_MAX_EDGE = 1568;
async function downscaleImageIfNeeded(file) {
  // SVG / non-bitmap 은 그냥 통과 (vector 라 SDK 가 OK)
  if (!file.type.startsWith('image/') || file.type === 'image/svg+xml') {
    return { dataUrl: await readAsDataURL(file), blob: file, downscaled: false };
  }
  try {
    const bitmap = await createImageBitmap(file);
    const longEdge = Math.max(bitmap.width, bitmap.height);
    if (longEdge <= IMAGE_MAX_EDGE) {
      // 원본 그대로
      bitmap.close?.();
      return { dataUrl: await readAsDataURL(file), blob: file, downscaled: false };
    }
    const scale = IMAGE_MAX_EDGE / longEdge;
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    // PNG 로 출력 — quality 손실 없음. JPEG 도 가능하지만 lossless 우선.
    const outType = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    const outQuality = outType === 'image/jpeg' ? 0.92 : undefined;
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, outType, outQuality));
    // canvas 메모리 부족 등으로 toBlob 이 null 을 resolve 하는 케이스 — fail-closed.
    if (!blob) return { failed: true, error: 'toBlob null (메모리 부족 추정)' };
    const dataUrl = await readAsDataURL(blob);
    return { dataUrl, blob, downscaled: true, originalWidth: bitmap.width, originalHeight: bitmap.height, newWidth: w, newHeight: h };
  } catch (err) {
    // #39 V6 — fail-closed: 원본 통과 제거. 리사이즈 실패는 차단.
    console.warn('[attach] downscale 실패:', err?.message);
    return { failed: true, error: err?.message || '알 수 없는 오류' };
  }
}
function readAsDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// #39 V6 — attach confirm modal (순차 처리, 한 번에 하나)
// _attachConfirmCleanup: Esc 핸들러가 cleanup(false) 전체(리스너 제거 + resolve)를 타도록 노출.
let _attachConfirmResolve = null;

function showAttachConfirmModal({ title, previewSrc, desc, okLabel, showCancel }) {
  return new Promise((resolve) => {
    _attachConfirmResolve = resolve;
    const modal = document.getElementById('attach-confirm-modal');
    const titleEl = document.getElementById('attach-confirm-title');
    const preview = document.getElementById('attach-confirm-preview');
    const descEl = document.getElementById('attach-confirm-desc');
    const okBtn = document.getElementById('attach-confirm-ok');
    const cancelBtn = document.getElementById('attach-confirm-cancel');
    const closeBtn = document.getElementById('attach-confirm-close');

    titleEl.textContent = title;
    descEl.textContent = desc;
    if (previewSrc) {
      preview.src = previewSrc;
      preview.style.display = '';
    } else {
      preview.src = '';
      preview.style.display = 'none';
    }
    okBtn.textContent = okLabel || '확인';
    cancelBtn.style.display = showCancel ? '' : 'none';

    modal.classList.remove('hidden');

    function cleanup(result) {
      _attachConfirmResolve = null;
      _attachConfirmCleanup = null;
      modal.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      closeBtn.removeEventListener('click', onCancel);
      modal.removeEventListener('click', onBackdrop);
      resolve(result);
    }
    _attachConfirmCleanup = cleanup;
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }
    function onBackdrop(e) { if (e.target === modal) cleanup(false); }

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    closeBtn.addEventListener('click', onCancel);
    modal.addEventListener('click', onBackdrop);
  });
}

// attach-confirm-modal 이 열려 있는지 외부에서 확인하는 헬퍼 (Esc 스택용)
function isAttachConfirmOpen() {
  return !document.getElementById('attach-confirm-modal')?.classList.contains('hidden');
}
// Esc 에서 호출 — cleanup wrapper 를 통해 resolve(false) + removeEventListener 까지 처리
let _attachConfirmCleanup = null;
function closeAttachConfirmModal() {
  if (_attachConfirmCleanup) {
    _attachConfirmCleanup(false);
    _attachConfirmCleanup = null;
  } else {
    document.getElementById('attach-confirm-modal')?.classList.add('hidden');
  }
}

// Fix S1: 재진입 시 Promise 덮어쓰기 방지 — 직렬 chain 으로 enqueue
let _stageChain = Promise.resolve();
function readFilesToStage(files) {
  const arr = [...files];
  _stageChain = _stageChain.then(() => processFilesToStage(arr)).catch(() => {});
  return _stageChain;
}

// 기존 readFilesToStage 본문 — chain 안에서만 실행되므로 모달 재진입 불가
async function processFilesToStage(files) {
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;

    let result;
    try {
      result = await downscaleImageIfNeeded(f);
    } catch (err) {
      // downscaleImageIfNeeded 자체가 throw 하면 (예: readAsDataURL 실패)
      await showAttachConfirmModal({
        title: '첨부 차단',
        previewSrc: null,
        desc: `리사이즈 실패 — ${f.name}: ${err?.message || '알 수 없는 오류'}. 이 파일은 첨부할 수 없음 (세션 보호).`,
        okLabel: '확인',
        showCancel: false,
      });
      continue;
    }

    if (result.failed) {
      // fail-closed: 차단 모달, 원본 강행 없음
      await showAttachConfirmModal({
        title: '첨부 차단',
        previewSrc: null,
        desc: `리사이즈 실패 — ${f.name}: ${result.error}. 이 파일은 첨부할 수 없음 (세션 보호).`,
        okLabel: '확인',
        showCancel: false,
      });
      continue;
    }

    if (result.downscaled) {
      // 다운스케일 발생 — 미리보기 + 확인 모달
      const confirmed = await showAttachConfirmModal({
        title: '이미지 첨부 확인',
        previewSrc: result.dataUrl,
        desc: `원본 ${result.originalWidth}×${result.originalHeight} → ${result.newWidth}×${result.newHeight} (1568px 한도)로 줄여서 첨부합니다.`,
        okLabel: '첨부',
        showCancel: true,
      });
      if (!confirmed) continue;
    }
    // 작은 이미지 (downscaled: false, failed 없음) — 조용히 통과
    staged.push({ dataUrl: result.dataUrl, blob: result.blob, name: f.name });
    renderAttachPreview();
  }
}

function initAttach() {
  const btn = document.getElementById('attach-btn');
  const fileInput = document.getElementById('attach-input');
  btn?.addEventListener('click', () => fileInput.click());
  fileInput?.addEventListener('change', (e) => {
    const files = [...(e.target.files || [])];
    readFilesToStage(files);
    e.target.value = '';
  });

  // paste
  document.addEventListener('paste', (e) => {
    const items = [...(e.clipboardData?.items || [])];
    const files = items.filter((it) => it.kind === 'file').map((it) => it.getAsFile()).filter(Boolean);
    if (files.length > 0) {
      e.preventDefault();
      readFilesToStage(files);
    }
  });

  // drag & drop — 전체 chat 영역에 drop + overlay 표시
  const dropEl = document.getElementById('chat');
  const overlay = document.getElementById('drop-overlay');
  let dragDepth = 0;
  dropEl?.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    dragDepth++;
    overlay?.classList.remove('hidden');
  });
  dropEl?.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types?.includes('Files')) e.preventDefault();
  });
  dropEl?.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) overlay?.classList.add('hidden');
  });
  dropEl?.addEventListener('drop', (e) => {
    dragDepth = 0;
    overlay?.classList.add('hidden');
    if (!e.dataTransfer?.files) return;
    e.preventDefault();
    readFilesToStage([...e.dataTransfer.files]);
  });
}

function initComposer() {
  const form = document.getElementById('composer');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  let submitting = false;

  // 리서치 모드 토글 — 이번 turn 한정 (1회성). 전송 성공 후 sendMessage 에서 리셋.
  // oracle 확정: sticky 금지 — 잡담 turn 에 fanout 방지.
  const researchBtn = document.getElementById('research-toggle');
  if (researchBtn) {
    researchBtn.addEventListener('click', () => {
      state.researchMode = !state.researchMode;
      researchBtn.classList.toggle('active', state.researchMode);
      researchBtn.setAttribute('aria-pressed', state.researchMode ? 'true' : 'false');
    });
  }

  // input 높이 동기 (autosize 결과 적용)
  function autosizeInput() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  }
  // 텍스트 복원 (dispatch 실패 시) — autosize 동반
  function restoreInput(text) {
    input.value = text;
    autosizeInput();
    input.focus();
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submitting) return;
    const text = input.value.trim();
    if (!text && staged.length === 0) return;

    // ★ 슬래시 커맨드 감지 — winter3 웹 UI 엔 /mcp /help /model 등이 없음 (Claude Code CLI 전용).
    //   그냥 전송하면 일반 메시지로 나가서 유저가 헷갈림. 명확히 안내하고 input 보존.
    //   trigger: `/` + 영문/숫자만 최대 30자 (공백/한글/줄바꿈 없음). 예: /mcp, /help, /model
    //   `/some/path` 같은 문장은 슬래시 두 번 이상 → 정규식 unmatch → 정상 전송.
    if (/^\/[a-zA-Z][a-zA-Z0-9_-]{0,30}$/.test(text)) {
      showToast('winter3 웹 UI 엔 슬래시 커맨드 (/mcp 등) 없어 — 문장으로 얘기해', 'warn', 3600);
      return;  // input 보존 (사용자가 편집해서 다시 보낼 수 있게)
    }

    // ★ 응답 진행 중이면 큐에 push (첨부 있으면 거부 — 이미지는 큐화 안 함)
    if (isTurnRunning()) {
      if (staged.length > 0) {
        showToast('응답 중엔 첨부 큐 안 됨 — 끝나면 다시 보내', 'error', 2800);
        return;  // input 보존
      }
      // #88 — 세션별 큐에 push + sessionStorage 영속화.
      const _enqueueSid = state.currentSid;
      msgQueueFor(_enqueueSid).push(text);
      persistMsgQueues();
      input.value = '';
      input.style.height = 'auto';
      showToast(`큐 추가됨 (대기 ${msgQueueFor(_enqueueSid).length}개)`, '', 1500);
      return;
    }

    submitting = true;
    sendBtn.disabled = true;
    // input 즉시 비우되, dispatch 실패하면 복원할 수 있게 snapshot 보관.
    const snapshot = text;
    input.value = '';
    input.style.height = 'auto';

    let ok = false;
    try {
      if (staged.length > 0) {
        if (!state.currentSid) await createNewSession();
        const uploadResult = await uploadStagedAndClear();
        if (!uploadResult.ok) {
          // 업로드 실패 — dispatch 스킵. restoreInput 은 finally 에서 !ok 경로로 처리.
          return;
        }
      }
      ok = await sendMessage(snapshot || '(이미지 첨부)');
      // #92 S4: dispatch 202 성공 직후 sendBtn hidden — SSE winter3.user_prompt 오기 전
      // 수백ms gap 동안 중복 전송 가능 문제 방어. render.js startTimer 가 SSE 레코드 도착 시
      // sendBtn.hidden 을 설정하지만 그 전 틈새를 메운다. stopTimer 는 sendBtn.remove('hidden')
      // 을 호출하므로 turn 종료 시 자동 복원.
      if (ok) sendBtn.classList.add('hidden');
    } finally {
      submitting = false;
      sendBtn.disabled = false;
      if (!ok) restoreInput(snapshot);
    }
  });

  input.addEventListener('keydown', (e) => {
    // IME composition 중 Enter 는 조합 확정용 — submit 금지.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  // #92 S5: slash 입력 중 인라인 힌트 — 전송 전에 사용자에게 알림.
  // composer-hint 아래 작은 span 을 동적으로 추가/제거. DOM 새로 만들지 않고 단일 요소 재사용.
  let slashHintEl = null;
  function updateSlashHint() {
    const val = input.value;
    const isSlash = /^\/[a-zA-Z0-9_-]{0,30}$/.test(val.trim());
    if (isSlash) {
      if (!slashHintEl) {
        slashHintEl = document.createElement('span');
        slashHintEl.id = 'slash-cmd-hint';
        slashHintEl.style.cssText = 'font-size:11px;color:rgba(232,232,240,0.45);padding-left:4px;pointer-events:none;';
        const hint = document.getElementById('composer-hint');
        if (hint && hint.parentNode) hint.parentNode.insertBefore(slashHintEl, hint.nextSibling);
      }
      slashHintEl.textContent = '⚠ 슬래시 커맨드 없음 — 문장으로 입력하세요';
    } else if (slashHintEl) {
      slashHintEl.remove();
      slashHintEl = null;
    }
    autosizeInput();
  }
  input.addEventListener('input', updateSlashHint);
  document.getElementById('kill').addEventListener('click', killCurrent);

  // ─── turn-end 수신 → 큐 flush ─────────────────────────────
  // render.js stopTimer 가 dispatch 하는 CustomEvent. 한 턴 끝날 때마다 큐 머리 1개 자동 발사.
  // #88: tryFlushMsgQueue() 로 위임 (세션별 Map 기준, 타이핑 중 덮어쓰기 방지 포함).
  window.addEventListener('winter3:turn-end', () => {
    tryFlushMsgQueue();
  });

  // ─── resume-turn 수신 → 기존 sendMessage 경로로 재개 ──────────────────────
  // render.js 의 autopsy resume 버튼이 dispatch. turn 진행 중이면 무시 (버튼도 가드하지만 이중 안전).
  window.addEventListener('winter3:resume-turn', (e) => {
    if (isTurnRunning()) return;
    const text = (e.detail && typeof e.detail.text === 'string')
      ? e.detail.text
      : 'Continue from where you left off.';
    sendMessage(text);
  });
}

function toggleCheatsheet() {
  const modal = document.getElementById('cheatsheet-modal');
  const willOpen = modal.classList.contains('hidden');
  if (willOpen) {
    const body = document.getElementById('cheatsheet-body');
    body.innerHTML = '';
    for (const { combo, description } of listShortcuts()) {
      if (!description) continue;
      const row = document.createElement('div');
      row.className = 'cheat-row';
      const desc = document.createElement('span');
      desc.className = 'cheat-desc';
      desc.textContent = description;
      const c = document.createElement('span');
      c.className = 'cheat-combo';
      c.textContent = prettyCombo(combo);
      row.appendChild(desc);
      row.appendChild(c);
      body.appendChild(row);
    }
  }
  modal.classList.toggle('hidden');
}

const SIDEBAR_KEY = 'winter3:sidebar-collapsed';
function applySidebarState() {
  const collapsed = localStorage.getItem(SIDEBAR_KEY) === '1';
  document.body.classList.toggle('sidebar-collapsed', collapsed);
}
function toggleSidebar() {
  const collapsed = !document.body.classList.contains('sidebar-collapsed');
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0');
}

// ─── 모바일 drawer (mob overlay) ───────────────────────────────────────────
function closeMobDrawers() {
  document.body.classList.remove('mob-sidebar-open', 'mob-activity-open');
  document.body.style.overflow = '';
  document.getElementById('mob-backdrop')?.classList.add('hidden');
}
function openMobSidebar() {
  if (window.innerWidth > 480) return;
  document.body.classList.add('mob-sidebar-open');
  document.body.classList.remove('mob-activity-open');
  document.body.style.overflow = 'hidden';
  document.getElementById('mob-backdrop')?.classList.remove('hidden');
}
function openMobActivity() {
  if (window.innerWidth > 480) return;
  document.body.classList.add('mob-activity-open');
  document.body.classList.remove('mob-sidebar-open');
  document.body.style.overflow = 'hidden';
  document.getElementById('mob-backdrop')?.classList.remove('hidden');
}

// #20 — Multi-Session PiP Monitor 열기.
// Document Picture-in-Picture API (Chrome 116+ / Edge / Brave). user gesture 필요 (이미 click).
// iframe 으로 /pip.html 격리 → DOM ownership 함정 0 (Oracle 5/5 합의).
// 메인 reload / close 시 PiP iframe 자체 EventSource 라 영향 0.
let _pipWindow = null;

// #21 V2 — PiP 의 세션 카드 click → 메인 창에서 그 세션 활성화.
// BroadcastChannel('winter3-pip') 의 'open-session' 메시지 listen.
function bindPipSessionListener() {
  if (!('BroadcastChannel' in window)) return;
  const bc = new BroadcastChannel('winter3-pip');
  bc.onmessage = (e) => {
    if (e.data?.type === 'open-session' && e.data.sid) {
      setCurrentSession(e.data.sid);
      try { window.focus(); } catch {}
    }
  };
}
async function openPipMonitor() {
  if (!('documentPictureInPicture' in window)) {
    showToast('PiP 미지원', 'Chrome 116+ / Edge / Brave 필요', 3000);
    return;
  }
  // 이미 열려있으면 focus.
  if (_pipWindow && !_pipWindow.closed) {
    try { _pipWindow.focus(); return; } catch {}
  }
  try {
    _pipWindow = await documentPictureInPicture.requestWindow({ width: 480, height: 640 });
    // iframe 격리 — 메인 winter3 web UI 의 DOM/JS/state 의존 0.
    const iframe = _pipWindow.document.createElement('iframe');
    iframe.src = '/pip.html';
    iframe.style.cssText = 'width:100%;height:100%;border:0;display:block;';
    _pipWindow.document.body.style.cssText = 'margin:0;padding:0;background:#0A0A12;height:100vh;overflow:hidden;';
    _pipWindow.document.body.appendChild(iframe);
    _pipWindow.addEventListener('pagehide', () => { _pipWindow = null; }, { once: true });
  } catch (e) {
    showToast('PiP 열기 실패', e.message || '', 3000);
  }
}

function initSessionListDelegate() {
  // 세션 목록 이벤트 위임 — renderSessionList 가 ul.innerHTML='' 로 재렌더해도 리스너 유실 없음.
  // label.click 핸들러의 stopPropagation 을 제거하고 위임으로 통합 (버그3 fix):
  //   dot/li-여백 탭 시 label 핸들러 미도달 → 세션 전환/drawer 닫힘 미작동 문제 해결.
  const ul = document.getElementById('session-list');
  if (!ul) return;
  ul.addEventListener('click', (e) => {
    // session-act 버튼(edit/del)은 자체 stopPropagation → 이 위임 미도달. 별도 처리 불필요.
    const li = e.target.closest('li[data-sid]');
    if (!li) return;
    const sid = li.dataset.sid;
    if (!sid) return;
    // label 편집 중이면 세션 전환 금지
    const label = li.querySelector('.session-label');
    if (label && label.isContentEditable === true) return;
    setCurrentSession(sid);
    if (window.innerWidth <= 480) closeMobDrawers();
  });
}

function initGlobalShortcuts() {
  document.getElementById('new-chat')?.addEventListener('click', createNewSession);  // legacy, 없어도 OK
  document.getElementById('close-activity')?.addEventListener('click', () => { toggleActivity(); closeMobDrawers(); });

  // mob drawer 버튼 + backdrop
  document.getElementById('mob-new-btn')?.addEventListener('click', () => { closeMobDrawers(); createNewSession(); });
  document.getElementById('mob-sidebar-btn')?.addEventListener('click', openMobSidebar);
  document.getElementById('mob-activity-btn')?.addEventListener('click', openMobActivity);
  document.getElementById('mob-backdrop')?.addEventListener('click', closeMobDrawers);

  // resize — 데스크톱으로 전환 시 drawer 자동 닫힘
  window.addEventListener('resize', () => { if (window.innerWidth > 480) closeMobDrawers(); });
  document.getElementById('cheatsheet-close')?.addEventListener('click', () => {
    document.getElementById('cheatsheet-modal').classList.add('hidden');
  });

  // icon-bar (winter v2 이식) — 모든 전역 액션의 단일 진입점.
  // Diamond (◇ home) = 사이드바 토글. 새 대화 아님. (기존 잘못 wired 된 것 정정.)
  document.getElementById('ib-home')?.addEventListener('click', toggleSidebar);
  document.getElementById('ib-sidebar')?.addEventListener('click', toggleSidebar);
  document.getElementById('ib-new')?.addEventListener('click', createNewSession);
  document.getElementById('ib-activity')?.addEventListener('click', toggleActivity);
  document.getElementById('ib-pip')?.addEventListener('click', openPipMonitor);
  document.getElementById('ib-snow')?.addEventListener('click', () => {
    const on = toggleSnow();
    showToast(on ? '눈 켜짐' : '눈 꺼짐', '', 1500);
  });
  document.getElementById('ib-help')?.addEventListener('click', toggleCheatsheet);
  document.getElementById('ib-restart')?.addEventListener('click', requestServerRestart);
  document.getElementById('ib-settings')?.addEventListener('click', () => {
    openSettings();
  });

  // Empty-state 프롬프트 카드 — 클릭 시 input 에 넣고 전송
  document.getElementById('empty-state')?.addEventListener('click', (e) => {
    const card = e.target.closest('.empty-card');
    if (!card) return;
    const q = card.dataset.q;
    if (!q) return;
    const input = document.getElementById('input');
    input.value = q;
    input.focus();
    document.getElementById('composer').requestSubmit();
  });
  document.getElementById('cheatsheet-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'cheatsheet-modal') e.target.classList.add('hidden');
  });

  // 단축키 — Chrome OS-level 선점 회피 (⌘⇧N = 시크릿창, ⌘⇧R = 하드리프레시 등).
  // 대원칙: 단일 modifier (⌘) + 고유 레터, 또는 ⌘⌥ 조합.
  registerShortcut('cmd+k', () => createNewSession(), {
    description: '새 대화 (⌘K)',
  });
  registerShortcut('cmd+i', () => toggleActivity(), {
    description: '활동 패널 (⌘I — VS Code idiom)',
  });
  registerShortcut('cmd+b', () => toggleSidebar(), {
    description: '사이드바 접기/펼치기 (⌘B)',
  });
  registerShortcut(['cmd+/', 'cmd+shift+/'], () => toggleCheatsheet(), {
    description: '단축키 도움말 (⌘/)',
  });
  registerShortcut('cmd+alt+s', () => {
    const on = toggleSnow();
    showToast(on ? '눈 켜짐' : '눈 꺼짐', '', 1500);
  }, { description: '배경 눈 on/off (⌘⌥S)' });
  registerShortcut(['cmd+shift+backspace', 'cmd+shift+delete'], async () => {
    if (!state.currentSid) return;
    const info = await fetch(`/sessions/${state.currentSid}`).then((r) => r.ok ? r.json() : null);
    if (!info) return;
    deleteSessionWithUndo(state.currentSid, info.title || '현재 세션');
  }, { description: '현재 세션 즉시 삭제 (⌘⇧⌫ — 실행취소 가능)' });
  registerShortcut('esc', (e) => {
    // 모달 열려있으면 먼저 닫음 (역순). 그 다음 진행 중 턴이면 kill.
    // 입력창 포커스 상태에서도 작동해야 한다 — 응답 중 Esc 로 멈추는 게 가장 자연스러운 UX.
    const cheat = document.getElementById('cheatsheet-modal');
    const act = document.getElementById('activity-modal');
    const img = document.getElementById('image-preview-modal');
    if (cheat && !cheat.classList.contains('hidden')) { cheat.classList.add('hidden'); return; }
    if (act && !act.classList.contains('hidden')) { act.classList.add('hidden'); return; }
    if (img && !img.classList.contains('hidden')) { img.classList.add('hidden'); return; }
    // attach-confirm-modal — Promise resolve(false) 로 취소 처리 (closeAttachConfirmModal 단독 호출은 Promise 미완료라 직접 닫기만)
    if (isAttachConfirmOpen()) { closeAttachConfirmModal(); return; }
    // 축 5 REA 상세 모달 — 다른 모달과 동일 우선순위 패턴
    if (isReaModalOpen()) { closeReaModal(); return; }
    // search — settings 모달과 동일 우선순위 패턴 (z-index 190)
    if (isSearchActive()) { clearSearch(); return; }
    if (isTurnRunning()) { killCurrent(); return; }
  }, { description: '모달 닫기 / 응답 중단', allowInInput: true, preventDefault: false });
}

async function boot() {
  startChimeBus();
  bindChatUI();
  bindActivityUI();
  // tool-line 클릭 → activity 모달 연결. circular dep 방지: render→activity import 대신 주입.
  setToolDetailHandler(openToolDetailById);
  bindTaskStackUI();
  bindPipSessionListener();
  initComposer();
  initAttach();
  initGlobalShortcuts();
  initSessionListDelegate();
  initSnow();
  initSettings();
  initSearch(setCurrentSession);
  initJobs();
  // 축 4 Projects 사이드바 — 세션 열기는 기존 setCurrentSession 재사용 (진입점 증설 없음).
  initProjects({ onOpenSession: setCurrentSession });
  // 축 5 Artifacts (REA 서브, 결정 17) — 현재 세션 id 는 getter 주입 (drop 시점 값 사용).
  initArtifacts({ getSid: () => state.currentSid });
  applySidebarState();
  // #57 — 새로고침해도 down-창 큐 살아있게 sessionStorage 에서 복원 + 즉시 drain 시도.
  // 서버 up 상태면 poll 첫 tick 에서 큐가 비워지고 배너도 안 뜬다.
  loadRetryQueueFromStorage();
  // #88 — 새로고침해도 세션별 메시지 큐 살아있게 sessionStorage 에서 복원.
  // 세션 진입 시 tryFlushMsgQueue 가 turn 종료 후 자동 flush.
  loadMsgQueuesFromStorage();
  if (retryQueue.length > 0) {
    showOfflineBanner('새로고침 전 미전송 큐 있음');
    startHealthPoll();
  }
  // #25 — chime audioCtx prime: 첫 user gesture 에 한 번만.
  // composer click / sendBtn click / 어디든 click → audioCtx unsuspend.
  // autoplay policy 우회 (#23 와 동일 패턴, 메인 frame 용).
  ['click', 'keydown'].forEach((ev) =>
    document.addEventListener(ev, () => primeChimeAudio(), { once: true, capture: true })
  );
  // /settings 동적 갱신 — composer-hint / empty-meta / about modal. server 가
  // 진짜 fetch 가능한 정보만. cosmetic 거짓 ("Claude Max" / "/max effort" /
  // "1M context") 절대 X — 모르는 건 표시 안 함.
  let _aboutCache = null;
  // 2026-08-19: 세션별 model override 캐시 — setCurrentSession 이 세션 meta 받아서 갱신.
  // null 이면 override 없음 → DEFAULT_MODEL 사용. 모델 popover 렌더 & 표시 텍스트 갱신에 참조.
  const _modelCtx = { effective: null, allowlist: null, defaultModel: null, override: null };
  // 짧은 표시 label — alias 는 명시 맵, 나머지는 generic 축약.
  const _MODEL_LABELS = { 'opus': 'opus (5.5)', 'claude-opus-4-7': 'opus 4.7' };
  function _fmtModelShort(m) {
    if (!m) return '?';
    if (_MODEL_LABELS[m]) return _MODEL_LABELS[m];
    return m.replace(/^claude-/, '').replace(/-/g, ' ');
  }
  function renderSettings(s) {
    if (!s) return;
    _aboutCache = s;
    // 세션 model override 안 잡혔으면 /settings 의 model 로 폴백.
    if (_modelCtx.effective == null) _modelCtx.effective = s.model || null;
    if (_modelCtx.defaultModel == null) _modelCtx.defaultModel = s.model || null;
    _paintHint(s);
  }
  function _paintHint(s) {
    const permShort = s.permissionMode === 'bypassPermissions' ? 'bypass permissions' : s.permissionMode;
    const verShort = s.claudeVersion ? s.claudeVersion.split(' ')[0] : '';
    const modelShort = _fmtModelShort(_modelCtx.effective);
    const hint = document.getElementById('composer-hint');
    if (hint) {
      // 모델 부분만 별도 span (id: composer-hint-model) → 클릭 = popover, 상위 hint click = about modal 유지.
      hint.innerHTML = '';
      hint.appendChild(document.createTextNode(`${permShort} · `));
      const modelSpan = document.createElement('span');
      modelSpan.id = 'composer-hint-model';
      modelSpan.className = 'composer-hint-model';
      modelSpan.textContent = modelShort;
      modelSpan.title = '클릭하여 모델 변경';
      modelSpan.addEventListener('click', (ev) => { ev.stopPropagation(); openModelPopover(modelSpan); });
      hint.appendChild(modelSpan);
      if (verShort) hint.appendChild(document.createTextNode(` · CLI ${verShort}`));
      hint.dataset.loaded = '1';
    }
    const meta = document.getElementById('empty-meta');
    if (meta) meta.textContent = `${modelShort}${verShort ? ' · Claude Code ' + verShort : ''} · winter3`;
  }
  // 세션 진입시 세션별 model override 반영 (setCurrentSession 에서 호출).
  window.__winter3ApplySessionModel = function (sessionMeta) {
    if (!sessionMeta) return;
    _modelCtx.effective = sessionMeta.effectiveModel || sessionMeta.model || _modelCtx.effective;
    _modelCtx.override = sessionMeta.modelOverride || null;
    if (sessionMeta.defaultModel) _modelCtx.defaultModel = sessionMeta.defaultModel;
    if (Array.isArray(sessionMeta.modelAllowlist)) _modelCtx.allowlist = sessionMeta.modelAllowlist;
    if (_aboutCache) _paintHint(_aboutCache);
  };
  // 모델 popover — 클릭시 열림, 바깥 클릭/ESC 시 닫힘. 단일 인스턴스.
  function openModelPopover(anchor) {
    closeModelPopover();
    const list = _modelCtx.allowlist || ['claude-fable-5', 'opus', 'claude-opus-4-7', 'haiku'];
    const current = _modelCtx.effective;
    const pop = document.createElement('div');
    pop.id = 'model-popover';
    pop.className = 'model-popover';
    pop.setAttribute('role', 'menu');
    const title = document.createElement('div');
    title.className = 'model-popover-title';
    title.textContent = '모델 선택';
    pop.appendChild(title);
    for (const m of list) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'model-popover-item';
      item.setAttribute('role', 'menuitem');
      const check = document.createElement('span');
      check.className = 'model-popover-check';
      check.textContent = (m === current) ? '◇' : '';
      const label = document.createElement('span');
      label.className = 'model-popover-label';
      label.textContent = _fmtModelShort(m);
      if (m === _modelCtx.defaultModel) {
        const badge = document.createElement('span');
        badge.className = 'model-popover-badge';
        badge.textContent = 'default';
        label.appendChild(badge);
      }
      item.appendChild(check);
      item.appendChild(label);
      item.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        closeModelPopover();
        if (m === current) return;
        await _switchModel(m);
      });
      pop.appendChild(item);
    }
    document.body.appendChild(pop);
    // 앵커 기준 위쪽에 띄움 (composer-hint 가 하단부).
    const r = anchor.getBoundingClientRect();
    pop.style.left = `${Math.max(8, r.left)}px`;
    pop.style.bottom = `${Math.max(8, window.innerHeight - r.top + 6)}px`;
    // 바깥 클릭 & ESC 로 닫기.
    setTimeout(() => {
      document.addEventListener('click', _outsideClose, { once: false });
      document.addEventListener('keydown', _escClose, { once: false });
    }, 0);
  }
  function _outsideClose(ev) {
    const pop = document.getElementById('model-popover');
    if (!pop) return;
    if (pop.contains(ev.target)) return;
    if (ev.target && ev.target.id === 'composer-hint-model') return;
    closeModelPopover();
  }
  function _escClose(ev) { if (ev.key === 'Escape') closeModelPopover(); }
  function closeModelPopover() {
    const pop = document.getElementById('model-popover');
    if (pop) pop.remove();
    document.removeEventListener('click', _outsideClose);
    document.removeEventListener('keydown', _escClose);
  }
  async function _switchModel(model) {
    const sid = state.currentSid;
    if (!sid) { showToast('세션 없음', 'error'); return; }
    try {
      const r = await fetch(`/sessions/${sid}/model`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        showToast(`모델 변경 실패: ${err.error || r.status}`, 'error');
        return;
      }
      const data = await r.json();
      _modelCtx.effective = data.effectiveModel || model;
      _modelCtx.override = data.modelOverride || null;
      if (_aboutCache) _paintHint(_aboutCache);
      showToast(`모델 → ${_fmtModelShort(_modelCtx.effective)} (다음 턴부터)`, 'success', 2500);
    } catch (e) {
      showToast(`모델 변경 실패: ${e.message}`, 'error');
    }
  }
  function showAbout() {
    const modal = document.getElementById('about-modal');
    const body = document.getElementById('about-body');
    if (!modal || !body) return;
    if (_aboutCache) {
      body.textContent = JSON.stringify(_aboutCache, null, 2);
    }
    modal.classList.remove('hidden');
  }
  function hideAbout() { document.getElementById('about-modal')?.classList.add('hidden'); }
  fetch('/settings').then((r) => r.ok ? r.json() : null).then((s) => {
    renderSettings(s);
    if (s) updateCanaryBanner(s.canaryAlert ?? null);
  }).catch(() => {});
  // canary 배너 5분 주기 갱신 — 플래그 소멸 시 자동 제거, 재발 시 재표시
  setInterval(refreshCanaryAlert, 5 * 60 * 1000);
  // 세션 목록 15s 주기 refetch — inject 세션 배지+chime 감지 (60s → 15s, inject-chime).
  setInterval(renderSessionList, 15 * 1000);
  // window focus 시 즉시 refetch — 탭 복귀 때 목록 갱신.
  window.addEventListener('focus', renderSessionList);
  // /usage 폴링 — boot 시 1회 + 10분 주기. 실패/파싱 오류는 무시 (뱃지 기존 상태 유지).
  async function refreshUsage() {
    try {
      const r = await fetch('/usage');
      if (!r.ok) return;
      const data = await r.json();
      if (data && data.data !== null) updatePlanBadgeUsage(data);
    } catch (e) {
      console.warn('[usage] fetch 실패:', e.message);
    }
  }
  refreshUsage();
  setInterval(refreshUsage, 10 * 60 * 1000);
  // about modal triggers — composer-hint click + ESC close + close 버튼
  document.getElementById('composer-hint')?.addEventListener('click', showAbout);
  document.querySelector('#about-modal .about-close')?.addEventListener('click', hideAbout);
  document.getElementById('about-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'about-modal') hideAbout();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.getElementById('about-modal')?.classList.contains('hidden')) hideAbout();
  });
  await renderSessionList();
  const last = localStorage.getItem('winter3:lastSid');
  if (last) {
    try {
      const r = await fetch(`/sessions/${last}`);
      if (r.ok) { setCurrentSession(last); return; }
    } catch { /* */ }
  }
  const list = await fetch('/sessions').then((r) => r.json());
  if (list.length > 0) setCurrentSession(list[0].id);
  else createNewSession();
}

boot();
