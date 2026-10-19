// web/js/pip-monitor.js — Multi-Session PiP Monitor 자체 entry.
// escapeHtml: SSE 서버 데이터(cur.name 등)를 innerHTML 삽입 전 이스케이프.
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
//
// #20 — Document PiP 안 iframe 으로 격리 로드 (메인 winter3 web UI DOM/JS 의존 0).
// 메인 reload / close 와 무관하게 자체 EventSource 로 SSE 직접 listen.
// Oracle 5/5 합의된 함정 회피:
//   - DOM ownership: iframe 격리 + 자체 부트스트랩 (메인 import 0)
//   - fan-in id 충돌: dedup key `${sid}:${id}` 로 sid 별 namespace
//   - active 감지: /sessions/active 가 runner.runningTurns ∪ jsonl dangling
//   - 진행률: A (TodoWrite) 폐기 — 데이터 없음. B (sub-agent count) + C (elapsed) 만
//   - HTTP/1.1 6-conn 한계: /events-multi fan-in 으로 1 connection
//   - 알림음 dedup: BroadcastChannel 로 메인에 'mute' 신호 → 메인 task-stack 음소거
//
// 진행률 정의:
//   - 세션 카드 = sub-agent 수 중 done 수 비율 (B)
//   - sub-agent 0 개면 elapsed 만 (C)
//   - 색상: 진행 중 sub-agent 의 색 (running 파랑 / 60s+ 노랑 / 180s+/error 빨강) 합집합
//
// turn 상태 (#22):
//   - winter3.user_prompt → turnRunning=true (Winter 응답 시작)
//   - winter3.turn_end    → turnRunning=false (Winter 응답 끝)
//   - 사용 이유: 툴 (Agent/Task) 안 쓴 turn 도 진행 중 / 종료 구분 필요. cards.length 만으론
//     "툴 안 쓰는 평문 응답" 의 진행 / 완료 구분 못 해서 PiP status 가 "대기 중..." 영구 표시되던 버그.
//
// 데이터 흐름:
//   1. polling /sessions/active (5s) → active sid 목록
//   2. sid 변경 시 EventSource('/events-multi?sids=A,B,C') reopen
//   3. record 받아 sid 별 그룹에 carry → 세션 카드 + sub-agent 카드 update
//   4. dedup: seenIds Set<"sid:id">
//   5. session card click → expanded toggle (accordion 강제 X — 펼침 동시 가능)

const POLL_MS = 5000;        // /sessions/active polling
const WARN_AT = 60_000;
const DANGER_AT = 180_000;
const SOUND_KEY = 'winter3:pip-sound';
const BC_NAME = 'winter3-pip';

const state = {
  sessions: new Map(),    // sid → { meta, cards: Map, expanded, lastTouchAt }
  seenIds: new Set(),     // dedup "sid:id"
  evtSource: null,
  pollTimer: null,
  tickTimer: null,
  audioCtx: null,
  pendingDing: null,
  bc: null,
  activeSidsKey: '',      // 마지막 EventSource sids 비교 (재연결 트리거)
};

// ─── DOM refs ───
const listEl = document.getElementById('pip-list');
const emptyEl = document.getElementById('pip-empty');
const countEl = document.getElementById('pip-count');
const statusEl = document.getElementById('pip-status');
const muteBtn = document.getElementById('pip-mute');

// ─── BroadcastChannel — 메인과 통신 (mute coordination) ───
function bc() {
  if (!state.bc && 'BroadcastChannel' in window) {
    state.bc = new BroadcastChannel(BC_NAME);
    state.bc.onmessage = (e) => {
      // 메인이 'pip-closed' 받으면 자체 task-stack 음소거 해제. 여기선 처리 X.
    };
    // PiP open 시 메인에 mute 신호.
    state.bc.postMessage({ type: 'pip-open' });
    window.addEventListener('pagehide', () => {
      try { state.bc.postMessage({ type: 'pip-closed' }); } catch {}
    }, { once: true });
  }
  return state.bc;
}

// ─── mute toggle ───
function applyMuteUI() {
  const muted = localStorage.getItem(SOUND_KEY) === '0';
  muteBtn.textContent = muted ? '🔕' : '🔔';
  muteBtn.classList.toggle('muted', muted);
}
muteBtn.addEventListener('click', () => {
  const cur = localStorage.getItem(SOUND_KEY);
  const next = cur === '0' ? '1' : '0';
  localStorage.setItem(SOUND_KEY, next);
  applyMuteUI();
  // #23 — mute click 자체가 user gesture. sound ON 으로 토글하면 audioCtx prime.
  if (next === '1') primeAudio();
});
applyMuteUI();

// ─── /sessions/active polling ───
async function pollActive() {
  try {
    const r = await fetch('/sessions/active', { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const list = await r.json();
    syncActiveSids(list);
    setStatus(`연결됨 · ${list.length} 세션`, true);
  } catch (e) {
    setStatus(`polling fail: ${e.message}`, false);
  }
}

function setStatus(msg, ok) {
  statusEl.textContent = msg;
  statusEl.classList.toggle('connected', !!ok);
  statusEl.classList.toggle('disconnected', !ok);
}

// active sid 목록 변경 시 EventSource 재연결 + 세션 그룹 prune.
function syncActiveSids(list) {
  const newSids = list.map((s) => s.id).sort();
  const newKey = newSids.join(',');

  // 메타 update / 신규 세션 그룹 생성.
  for (const meta of list) {
    if (!state.sessions.has(meta.id)) {
      state.sessions.set(meta.id, {
        meta,
        cards: new Map(),
        expanded: false,
        lastTouchAt: Date.now(),
        turnRunning: false,    // #22 — winter3.user_prompt / turn_end 로 갱신
        turnStartAt: 0,
      });
    } else {
      state.sessions.get(meta.id).meta = meta;
    }
  }

  // 더 이상 active 가 아닌 sid 는 60s 후 prune (running 카드 끝까지 보여주기 위해).
  // #22 — turnRunning 살아있으면 prune 보류 (race 보정).
  for (const [sid, sess] of state.sessions) {
    if (!newSids.includes(sid)) {
      const stale = Date.now() - sess.lastTouchAt > 60_000;
      const allCardsDone = [...sess.cards.values()].every((c) => c.status !== 'running');
      if (stale && allCardsDone && !sess.turnRunning) {
        state.sessions.delete(sid);
      }
    }
  }

  if (newKey !== state.activeSidsKey) {
    state.activeSidsKey = newKey;
    reopenEventSource(newSids);
  }

  render();
}

function reopenEventSource(sids) {
  if (state.evtSource) { state.evtSource.close(); state.evtSource = null; }
  if (sids.length === 0) return;
  // dedup: 새 SSE 연결 시 seenIds 유지 — fresh open 해도 catchup replay 가 sid:id 중복 차단.
  const url = `/events-multi?sids=${sids.join(',')}`;
  state.evtSource = new EventSource(url);
  state.evtSource.onmessage = (e) => {
    try {
      const env = JSON.parse(e.data);
      const key = `${env.sid}:${env.id}`;
      if (state.seenIds.has(key)) return;
      state.seenIds.add(key);
      consume(env);
    } catch (err) {
      console.error('[pip] parse fail', err);
    }
  };
  state.evtSource.onerror = () => setStatus('SSE error', false);
  state.evtSource.onopen = () => setStatus(`SSE open (${sids.length})`, true);
}

// ─── consume — sid 별 그룹에 카드 추가/update ───
function consume(env) {
  const sid = env.sid;
  const raw = env.raw;
  if (!raw || typeof raw !== 'object') return;

  const sess = state.sessions.get(sid);
  if (!sess) return; // 세션 그룹 없으면 무시 (active 목록에 없는 sid)
  sess.lastTouchAt = Date.now();

  // #40 — record ts 기반 시각 (catchup replay 후에도 진실 보존).
  // env.ts 가 없거나 parse 실패 시만 Date.now() 로 fallback.
  const recTsMs = Date.parse(env.ts) || Date.now();

  if (raw.type === 'winter3.user_prompt') {
    // turn 시작 — 툴 안 쓰는 평문 응답도 진행 중 / 완료 구분 가능하게.
    sess.turnRunning = true;
    sess.turnStartAt = recTsMs;
    // #24 V2 — 새 turn 시작 시 이전 turn 의 done/error/aborted sub-agent 카드 정리.
    // running 카드는 유지 (이전 turn 이 끝나기 전 새 turn 시작은 비정상이지만 안전).
    for (const [id, c] of sess.cards) {
      if (c.status === 'done' || c.status === 'error' || c.status === 'aborted') sess.cards.delete(id);
    }
  } else if (raw.type === 'winter3.turn_end') {
    sess.turnRunning = false;
    // #40 — turn_end 시 미해결 running 카드 = 결과 못 받은 sub-agent. aborted 로 close.
    // 원인: 메인 turn 이 stop_sequence/stalled/error 로 cut 되면 sub-agent (Agent tool) 의
    // tool_result block 이 jsonl 에 영영 append 안 됨 → resolveCard 영영 안 불림 → 영구 running.
    // 사용자 신고 (2026-05-02 73f6006d): "활동탭에 헤르메스는 계속 돌아가고 심지어 세션 나갔다 다시 들어가면 0초부터 다시 세고 자빠짐".
    abortRunningCards(sess, recTsMs);
  } else if (raw.type === 'assistant') {
    const blocks = raw.message?.content || [];
    for (const block of blocks) {
      if (block?.type === 'tool_use' && block.id && (block.name === 'Agent' || block.name === 'Task')) {
        addCard(sess, block, recTsMs);
      }
    }
  } else if (raw.type === 'user') {
    const blocks = raw.message?.content || [];
    for (const block of blocks) {
      if (block?.type === 'tool_result' && block.tool_use_id) {
        resolveCard(sess, block.tool_use_id, block, recTsMs);
      }
    }
  }
  render();
}

// #40 — turn_end 시 미해결 running 카드 close.
function abortRunningCards(sess, endTsMs) {
  for (const c of sess.cards.values()) {
    if (c.status === 'running') {
      c.status = 'aborted';
      c.elapsed = Math.max(0, endTsMs - c.startAt);
    }
  }
}

function addCard(sess, useBlock, recTsMs) {
  if (sess.cards.has(useBlock.id)) {
    // 입력 채워지면 라벨만 update.
    const c = sess.cards.get(useBlock.id);
    if (useBlock.input?.subagent_type) c.name = useBlock.input.subagent_type;
    if (useBlock.input?.description) c.desc = useBlock.input.description;
    return;
  }
  // #40 — startAt = SDK 가 tool_use 받은 시각 (server ts).
  // catchup replay 시 Date.now() 박으면 "재진입 시각 = 0초" 버그 (사용자 73f6006d 신고).
  sess.cards.set(useBlock.id, {
    id: useBlock.id,
    name: useBlock.input?.subagent_type || '에이전트',
    desc: useBlock.input?.description || '준비 중...',
    startAt: recTsMs || Date.now(),
    status: 'running',
    elapsed: 0,
  });
}

function resolveCard(sess, toolUseId, resultBlock, recTsMs) {
  const c = sess.cards.get(toolUseId);
  if (!c || c.status !== 'running') return;
  // #40 — elapsed 도 record ts 기반 (catchup replay 일관성).
  c.elapsed = Math.max(0, (recTsMs || Date.now()) - c.startAt);
  c.status = resultBlock.is_error ? 'error' : 'done';
  // #25 — sub-agent 별 ding/buzz 폐기. turn 끝날 때 한 번만 (render.js 의 turn_end 분기).
  // PiP 의 sub-agent 카드는 시각만. 알림음은 메인 turn 종료 시 단일 chime.
}

// ─── render — 세션 카드 + sub-agent 카드 + 진행률 ───
function render() {
  const sids = [...state.sessions.keys()];
  countEl.textContent = String(sids.length);
  emptyEl.style.display = sids.length === 0 ? 'block' : 'none';

  // 기존 DOM diff 대신 단순 rebuild — 5~10 카드라 비용 미미. raw=truth 패턴.
  // expanded state 는 state.sessions[sid].expanded 만 truth (DOM OR 하면 collapse 안 됨).
  listEl.innerHTML = '';
  for (const sid of sids) {
    const sess = state.sessions.get(sid);
    listEl.appendChild(buildSessionCard(sid, sess, !!sess.expanded));
  }
}

function buildSessionCard(sid, sess, expanded) {
  const cards = [...sess.cards.values()];
  const running = cards.filter((c) => c.status === 'running');
  const done = cards.filter((c) => c.status === 'done');
  const errored = cards.filter((c) => c.status === 'error');
  // #40 — aborted = turn 끝났는데 결과 못 받은 sub-agent. fail signal 로 묶음.
  const aborted = cards.filter((c) => c.status === 'aborted');

  // 색상 — running 카드들의 worst case 채택. error > danger > warn > running.
  // #22 — turnRunning (평문 응답) 도 elapsed 기반 색상 전환.
  const turnElapsed = sess.turnRunning && sess.turnStartAt ? Date.now() - sess.turnStartAt : 0;
  let cardCls = 'sess-card';
  if (errored.length > 0 || aborted.length > 0) cardCls += ' status-error';
  else if (running.some((c) => Date.now() - c.startAt >= DANGER_AT)) cardCls += ' status-error';
  else if (turnElapsed >= DANGER_AT) cardCls += ' status-error';
  else if (running.some((c) => Date.now() - c.startAt >= WARN_AT)) cardCls += ' status-warn';
  else if (turnElapsed >= WARN_AT) cardCls += ' status-warn';
  else if (!sess.turnRunning && running.length === 0 && cards.length > 0) cardCls += ' status-done';
  if (expanded) cardCls += ' expanded';

  const wrap = document.createElement('div');
  wrap.className = cardCls;
  wrap.dataset.sid = sid;

  const head = document.createElement('div');
  head.className = 'sess-head';
  // head 본체 click = 메인 winter3 창에 그 세션 활성화 (BroadcastChannel).
  head.onclick = (e) => {
    if (e.target.closest('.sess-chev')) return; // chevron 은 별도 (펼침 토글)
    if (state.bc) state.bc.postMessage({ type: 'open-session', sid });
  };

  const chev = document.createElement('button');
  chev.className = 'sess-chev';
  chev.textContent = '▶';
  chev.title = '펼치기 / 접기';
  chev.onclick = (e) => {
    e.stopPropagation();
    sess.expanded = !sess.expanded;
    render();
  };

  const title = document.createElement('span');
  title.className = 'sess-title';
  title.textContent = sess.meta.title || sid.slice(0, 8);
  title.title = '클릭 — 메인 창에서 이 세션 열기';

  const status = document.createElement('span');
  status.className = 'sess-status';
  if (running.length > 0) {
    // 진행 중 sub-agent 있음 → 그 이름 + elapsed
    const cur = running[running.length - 1];
    const elapsedSec = ((Date.now() - cur.startAt) / 1000).toFixed(0);
    status.innerHTML = `<span class="now">${escapeHtml(cur.name)}</span> · ${elapsedSec}s`;
  } else if (sess.turnRunning) {
    // 평문 응답 진행 중 (툴 호출 0 또는 모두 done) — turn 자체 진행 중 표시 (#22)
    const elapsedSec = sess.turnStartAt ? ((Date.now() - sess.turnStartAt) / 1000).toFixed(0) : '0';
    if (cards.length > 0) {
      status.innerHTML = `<span class="now">응답 중</span> · ${done.length}/${cards.length} · ${elapsedSec}s`;
    } else {
      status.innerHTML = `<span class="now">응답 중</span> · ${elapsedSec}s`;
    }
  } else if (cards.length > 0) {
    // turn 끝났고 sub-agent 호출 있었음 → 완료 N/M
    // #40 — aborted 도 "끊김" 으로 명시 (사용자가 "헤르메스 계속 돈다" 오해 방지).
    const failParts = [];
    if (errored.length) failParts.push(`${errored.length} 실패`);
    if (aborted.length) failParts.push(`${aborted.length} 끊김`);
    const failTail = failParts.length ? ' · ' + failParts.join(' · ') : '';
    status.innerHTML = `<span class="now">완료</span> · ${done.length}/${cards.length}${failTail}`;
  } else {
    // turn 끝났고 sub-agent 호출 0 (평문 응답 완료) — 회색 idle
    status.innerHTML = '<span class="idle">완료</span>';
  }

  head.appendChild(chev);
  head.appendChild(title);
  head.appendChild(status);

  const bar = document.createElement('div');
  bar.className = 'sess-bar';
  const fill = document.createElement('div');
  fill.className = 'sess-bar-fill';
  // 진행률 (B): done / total. running 만 있으면 elapsed 기반 (C).
  // #22 — cards 0 + turnRunning 일 땐 turnElapsed 기반 가짜 진행 (max 90%).
  let pct;
  if (cards.length > 0) {
    pct = (done.length / cards.length) * 100;
    if (pct === 0 && running.length > 0) {
      // 아직 done 0 인데 running 있음 → 시각적 시그널 위해 elapsed 기반 가짜 진행 (max 90% 까지)
      const maxElapsed = Math.max(...running.map((c) => Date.now() - c.startAt));
      pct = Math.min(90, (maxElapsed / 60_000) * 30); // 60s = 30%
    }
  } else if (sess.turnRunning && turnElapsed > 0) {
    // 평문 응답 중 — 카드 0 이라도 elapsed 기반 가짜 진행 (max 90%, done 만 100%)
    pct = Math.min(90, (turnElapsed / 60_000) * 30);
  } else {
    pct = 0;
  }
  fill.style.width = `${pct.toFixed(1)}%`;
  bar.appendChild(fill);

  wrap.appendChild(head);
  wrap.appendChild(bar);

  if (expanded) {
    const body = document.createElement('div');
    body.className = 'sess-body';
    if (cards.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sub-card';
      empty.style.opacity = '0.5';
      empty.innerHTML = '<span class="sub-desc">sub-agent 호출 없음</span>';
      body.appendChild(empty);
    } else {
      for (const c of cards) {
        body.appendChild(buildSubCard(c, sess));
      }
    }
    wrap.appendChild(body);
  }

  return wrap;
}

function buildSubCard(c, sess) {
  const el = document.createElement('div');
  el.className = `sub-card ${c.status}`;
  const dot = document.createElement('span'); dot.className = 'sub-dot';
  const name = document.createElement('span'); name.className = 'sub-name'; name.textContent = c.name;
  const desc = document.createElement('span'); desc.className = 'sub-desc'; desc.textContent = c.desc;
  const el2 = document.createElement('span'); el2.className = 'sub-elapsed';
  const ms = c.status === 'running' ? Date.now() - c.startAt : c.elapsed;
  el2.textContent = `${(ms / 1000).toFixed(1)}s`;
  el.appendChild(dot); el.appendChild(name); el.appendChild(desc); el.appendChild(el2);

  // #24 — done/error/aborted 카드 click → dismiss (running 은 dismiss X — 진행 중 카드 보호).
  if (sess && (c.status === 'done' || c.status === 'error' || c.status === 'aborted')) {
    el.classList.add('dismissable');
    el.title = '클릭해서 닫기';
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      sess.cards.delete(c.id);
      render();
    });
  }
  return el;
}

// ─── ticker — elapsed 갱신 + 색상 자동 전환 ───
function tick() {
  // 진행 중 카드 또는 진행 중 turn 있는 세션만 re-render (효율).
  // #22 — turnRunning 도 체크해서 평문 응답 중에도 elapsed 갱신.
  let anyActive = false;
  for (const sess of state.sessions.values()) {
    if (sess.turnRunning) { anyActive = true; break; }
    for (const c of sess.cards.values()) {
      if (c.status === 'running') { anyActive = true; break; }
    }
    if (anyActive) break;
  }
  if (anyActive) render();
}

// ─── 알림음 (Web Audio API) ───
function soundOn() { return localStorage.getItem(SOUND_KEY) !== '0'; }
function getCtx() {
  if (!soundOn()) return null;
  if (!state.audioCtx) {
    try { state.audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch { return null; }
  }
  return state.audioCtx;
}
// #23 — iframe 안 AudioContext 가 PiP window 의 user gesture 상속 못 받아
// 'suspended' 상태로 boot. setTimeout (debounce) 안에서 ctx.resume() 호출하면 user gesture
// 컨텍스트 깨져서 promise reject. 결과: 알림음 영구 무음.
//
// 해결 (3 layer):
//   1. boot 직후 즉시 ctx.resume() 시도 (PiP open 자체가 user gesture 일 수 있음)
//   2. 첫 user gesture (click/keydown/pointerdown) 에 prime + 무음 톤으로 실제 unsuspend 보장
//   3. playTone 이 async 로 resume 결과 await 후 osc.start (suspended 상태에서 start = silent)
async function playTone({ freq, durMs, type = 'sine', gain = 0.06 }) {
  const ctx = getCtx(); if (!ctx) return;
  if (ctx.state === 'suspended') {
    try { await ctx.resume(); } catch { return; }   // user gesture 없으면 reject — silent fail
  }
  if (ctx.state !== 'running') return;              // 그래도 안 되면 포기
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type; osc.frequency.value = freq; g.gain.value = 0;
  const now = ctx.currentTime;
  g.gain.linearRampToValueAtTime(gain, now + 0.01);
  g.gain.linearRampToValueAtTime(0, now + durMs / 1000);
  osc.connect(g).connect(ctx.destination);
  osc.start(now); osc.stop(now + durMs / 1000 + 0.02);
}
function queueDing() {
  if (state.pendingDing) return;
  state.pendingDing = setTimeout(() => {
    state.pendingDing = null;
    playTone({ freq: 880, durMs: 120, type: 'sine', gain: 0.06 });
  }, 80);
}
function queueBuzz() {
  playTone({ freq: 220, durMs: 90, type: 'square', gain: 0.05 });
  setTimeout(() => playTone({ freq: 180, durMs: 110, type: 'square', gain: 0.05 }), 130);
}

// 첫 user gesture 에 audioCtx 활성화 + 무음 톤으로 unsuspend.
// #23 — iframe 안 AudioContext 는 *iframe 내부* user gesture 필요.
// PiP open 자체의 parent window user gesture 는 propagate 안 됨.
async function primeAudio() {
  if (!soundOn()) return;
  const ctx = getCtx();
  if (!ctx) return;
  if (ctx.state === 'suspended') {
    try { await ctx.resume(); } catch { /* 사용자가 click 다시 해야 함 */ }
  }
  // 무음 톤으로 실제 unsuspend 보장 (resume 만으로는 some browser 가 다시 suspend 시킴)
  if (ctx.state === 'running') {
    try {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      g.gain.value = 0;
      o.connect(g).connect(ctx.destination);
      o.start(); o.stop(ctx.currentTime + 0.01);
    } catch {}
  }
}
function bindAudioPrime() {
  const handler = () => { primeAudio(); };
  ['click', 'keydown', 'pointerdown'].forEach((ev) =>
    document.addEventListener(ev, handler, { once: true, capture: true })
  );
}

// ─── boot ───
bc();
pollActive();
state.pollTimer = setInterval(pollActive, POLL_MS);
state.tickTimer = setInterval(tick, 250);
// #23 — audioCtx prime: boot 시 즉시 시도 + 첫 user gesture fallback.
primeAudio();          // PiP open 의 parent gesture 가 iframe 까지 전파될 수도 (브라우저별 다름)
bindAudioPrime();      // 안 됐으면 첫 click/keydown 에 prime

window.addEventListener('pagehide', () => {
  if (state.evtSource) state.evtSource.close();
  if (state.pollTimer) clearInterval(state.pollTimer);
  if (state.tickTimer) clearInterval(state.tickTimer);
}, { once: true });

// QA / dev hook — production import 0, 메인 의존 X. qa-pip-monitor.mjs 에서만 사용.
// state 직접 조작으로 SSE message 시뮬 없이 status 분기 검증 가능.
// _audioState() — #23 검증용 (audioCtx 가 boot 후 / user gesture 후 어느 state 인지).
export { state, consume, render, primeAudio };
export function _audioState() {
  return {
    soundOn: soundOn(),
    hasCtx: !!state.audioCtx,
    ctxState: state.audioCtx?.state || 'none',
  };
}
