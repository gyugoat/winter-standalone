// web/js/chime-bus.js — 메인 화면용 멀티 세션 알림음 버스.
//
// 배경 (사용자 신고 2026-06-23): "알림음이 현재 보고 있는 세션에서만 나고, 안 보는
// 백그라운드 세션에서 응답이 끝나도 소리가 안 난다."
//
// 원인: 메인 화면(index.html)은 단일 세션 SSE(stream.js → /events/<sid>)만 listen.
//   보고 있는 세션의 turn_end 만 도달. pip-monitor.js 의 멀티SSE 는 PiP iframe 전용이라
//   PiP 안 열면 안 뜸 → 백그라운드 세션 turn_end 무음.
//
// fix: 메인 화면이 항상 /events-multi (모든 active 세션) 를 listen 하는 경량 버스.
//   turn_end(reason='completed') 받으면 playChime() 단 한 번. render.js 의 현재세션
//   playChime 호출은 제거(2026-06-23) — 이 버스가 단일 출처라 현재/백그라운드 구분 없이
//   정확히 한 번.
//
// 중복 방지 (2겹):
//   1. seenIds Set<"sid:id"> — 재연결/replay 시 같은 record 두 번 chime 차단.
//   2. catchup mute — open 후 서버의 winter3.catchup_done marker 받기 전까지 전부 mute.
//      (#39 V3 marker. render.js 의 시간 휴리스틱 isCatchup 과 달리 timing race 없음
//       → 3cf72315 "큰 세션 replay 중 조기 finishCatchup → 다중 chime" 사고 구조적 회피.)
//
// #25 정신 유지: 알림음은 turn 자체 끝날 때만 (completed). interrupted/stalled/
//   error/rate_limited 는 chime X. catchup(history replay) 중엔 mute.

import { playChime } from './chime.js';

const POLL_MS = 5000;
const MAX_SIDS = 12;          // 서버 /events-multi 한계와 일치.

const state = {
  evtSource: null,
  pollTimer: null,
  seenIds: new Set(),         // dedup "sid:id"
  activeSidsKey: '',          // 마지막 EventSource sids (재연결 트리거)
  catchupDone: false,         // 현재 연결의 catchup replay 끝났는지 (marker 기반 mute gate)
  watchedSids: new Set(),     // syncActiveSids 가 현재 감시 중인 sid 집합 (isWatched 용)
};

async function pollActive() {
  try {
    const r = await fetch('/sessions/active', { cache: 'no-store' });
    if (!r.ok) return;
    const list = await r.json();
    syncActiveSids(Array.isArray(list) ? list : []);
  } catch { /* polling fail — 다음 tick 재시도 */ }
}

function syncActiveSids(list) {
  // 서버 한계 (12) 초과 시 앞쪽만. active 세션이 12 넘는 극단 케이스 — 일부 백그라운드 무음
  // 가능하지만 현실적으로 동시 active 12+ 는 드묾. 안전하게 slice.
  const newSids = list.map((s) => s.id).filter(Boolean).sort().slice(0, MAX_SIDS);
  const newKey = newSids.join(',');
  // 감시 중인 sid 집합 항상 최신으로 유지 (isWatched 체크용).
  state.watchedSids = new Set(newSids);
  if (newKey !== state.activeSidsKey) {
    state.activeSidsKey = newKey;
    reopenEventSource(newSids);
  }
}

function reopenEventSource(sids) {
  if (state.evtSource) { try { state.evtSource.close(); } catch {} state.evtSource = null; }
  if (sids.length === 0) return;
  // 재연결 시 catchup 다시 시작 → marker 전까지 mute. seenIds 는 유지(중복 chime 이중 방어).
  state.catchupDone = false;
  const url = `/events-multi?sids=${sids.join(',')}`;
  const es = new EventSource(url);
  es.onmessage = (e) => {
    let env;
    try { env = JSON.parse(e.data); } catch { return; }
    consume(env);
  };
  es.onerror = () => { /* EventSource 자동 재연결. catchupDone 은 reopen 시 reset. */ };
  state.evtSource = es;
}

function consume(env) {
  const raw = env && env.raw;
  if (!raw || typeof raw !== 'object') return;

  // catchup 끝남 marker — sid 없는 글로벌 record. 이 시점부터 live.
  if (raw.type === 'winter3.catchup_done') {
    state.catchupDone = true;
    return;
  }

  // dedup — sid:id. (catchup_done marker 는 id 없을 수 있어 위에서 먼저 처리.)
  if (env.sid !== undefined && env.id !== undefined) {
    const key = `${env.sid}:${env.id}`;
    if (state.seenIds.has(key)) return;
    state.seenIds.add(key);
  }

  // catchup replay 중엔 mute (세션 진입/리프레시 시 history 의 옛 turn_end 폭주 차단 — #25).
  if (!state.catchupDone) return;

  // turn 자체 정상 종료에만 chime. 단일 출처 — 현재/백그라운드 구분 없이 한 번.
  if (raw.type === 'winter3.turn_end' && raw.reason === 'completed') {
    playChime();
  }
  // injected (heartbeat 등 proactive 발화) — chime 은 render.js 가 담당.
  // 다이아몬드 배지는 app.js lastSeen 방식이 담당 (60s refetch + focus refetch).
}

// boot — 메인 화면 로드 시 항상 구독 시작.
export function startChimeBus() {
  if (state.pollTimer) return; // 중복 시작 방지
  pollActive();
  state.pollTimer = setInterval(pollActive, POLL_MS);
  window.addEventListener('pagehide', () => {
    if (state.evtSource) { try { state.evtSource.close(); } catch {} }
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  }, { once: true });
}

// inject 로 생성된 세션처럼 /sessions/active 에 없는 세션은 chime-bus 가 감시 안 함.
// app.js 의 배지 chime 판정이 이 함수로 이중 울림 여부를 확인한다.
export function isWatched(sid) {
  return state.watchedSids.has(sid);
}

// QA / dev hook.
export { state, consume };
export function _chimeBusState() {
  return {
    activeSidsKey: state.activeSidsKey,
    seenCount: state.seenIds.size,
    catchupDone: state.catchupDone,
    hasEvtSource: !!state.evtSource,
    polling: !!state.pollTimer,
  };
}
