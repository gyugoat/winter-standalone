// web/js/jobs.js — Background job 진행 패널 (사이드바).
// Contract: GET /api/jobs → { jobs: [...] }
//   alive=true: 돌아가는 중. stalled=true: alive 이지만 로그 90s 무성장.
//   alive=false: 종료됨. POST /api/jobs/kill { id } → { ok, error? }.
//
// 이 모듈은 순수 렌더 함수(buildJobCard) + 폴링 루프로 구성.
// app.js 가 boot() 에서 initJobs() 한 줄로 활성화.

import { playChime } from './chime.js';
import { showToast } from './toast.js';

// ─── 상태 ──────────────────────────────────────────────────────────────────
let _pollTimer = null;
// 이전 폴링 결과 — alive 전이 감지용. null = 첫 로드 (알림 울리지 않음).
let _prevAliveIds = null;
// 펼침 상태 — 재렌더 후도 유지. Set<id>
const _expandedIds = new Set();

// ─── 폴링 주기 ─────────────────────────────────────────────────────────────
const POLL_ACTIVE_MS  = 5000;   // job >= 1개일 때
const POLL_IDLE_MS    = 60000;  // job 0개일 때

// ─── 경과 시간 포맷 ────────────────────────────────────────────────────────
function fmtElapsed(ms) {
  if (ms == null || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}시간 ${m % 60}분`;
  if (m > 0) return `${m}분 ${s % 60}초`;
  return `${s}초`;
}

// ─── bytes/s 포맷 ──────────────────────────────────────────────────────────
function fmtBps(bps) {
  if (bps == null || bps <= 0) return null;
  if (bps >= 1048576) return `${(bps / 1048576).toFixed(1)} MB/s`;
  if (bps >= 1024)    return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${Math.round(bps)} B/s`;
}

// ─── 상태 점 클래스 ────────────────────────────────────────────────────────
function statusDotClass(job) {
  if (!job.alive) return 'job-dot dead';
  if (job.stalled) return 'job-dot stalled';
  return 'job-dot alive';
}

// ─── 카드 빌드 (순수 — DOM 만 만들고 부작용 없음) ───────────────────────
// 외부에서 테스트할 수 있도록 export.
export function buildJobCard(job) {
  const card = document.createElement('div');
  card.className = 'job-card';
  card.dataset.jobId = job.id;

  // ── 접힘 헤더 ──────────────────────────────────────────────────────────
  const header = document.createElement('div');
  header.className = 'job-card-header';

  const dot = document.createElement('span');
  dot.className = statusDotClass(job);
  dot.title = !job.alive ? '종료됨' : job.stalled ? '응답 없음 (stalled)' : '실행 중';

  const labelSpan = document.createElement('span');
  labelSpan.className = 'job-card-label';
  labelSpan.textContent = job.label || job.id;

  const metaSpan = document.createElement('span');
  metaSpan.className = 'job-card-meta';
  const elapsed = fmtElapsed(job.elapsed_ms);
  const bpsStr = job.alive ? fmtBps(job.bytes_per_sec) : null;
  metaSpan.textContent = bpsStr ? `${elapsed} · ${bpsStr}` : elapsed;

  // tail 마지막 1줄 (접힘 상태 미리보기)
  const tailLines = Array.isArray(job.tail) ? job.tail : [];
  const lastLine = tailLines.length > 0 ? tailLines[tailLines.length - 1] : '';
  const preview = document.createElement('span');
  preview.className = 'job-card-preview';
  preview.textContent = lastLine;

  header.appendChild(dot);
  header.appendChild(labelSpan);
  header.appendChild(metaSpan);

  // ── 펼침 본문 ──────────────────────────────────────────────────────────
  const body = document.createElement('div');
  body.className = 'job-card-body';

  const logBox = document.createElement('pre');
  logBox.className = 'job-log-box';
  logBox.textContent = tailLines.join('\n') || '(로그 없음)';

  const metaRow = document.createElement('div');
  metaRow.className = 'job-meta-row';

  const pathSpan = document.createElement('span');
  pathSpan.className = 'job-log-path';
  pathSpan.textContent = job.log_path || '';

  const killBtn = document.createElement('button');
  killBtn.className = 'job-kill-btn';
  killBtn.textContent = '중단';
  killBtn.type = 'button';
  if (!job.alive) killBtn.style.display = 'none';

  killBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm(`'${job.label || job.id}' 작업을 중단할까?`)) return;
    try {
      const r = await fetch('/api/jobs/kill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: job.id }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        showToast(`중단 실패: ${data.error || r.status}`, 'error', 3000);
      } else {
        showToast(`중단 요청됨: ${job.label || job.id}`, '', 2000);
      }
    } catch (err) {
      showToast(`중단 요청 실패: ${err.message}`, 'error', 3000);
    }
  });

  metaRow.appendChild(pathSpan);
  metaRow.appendChild(killBtn);

  body.appendChild(logBox);
  body.appendChild(metaRow);

  // ── 접힘 토글 ──────────────────────────────────────────────────────────
  const isExpanded = _expandedIds.has(job.id);
  if (!isExpanded) body.classList.add('hidden');

  header.addEventListener('click', () => {
    const nowExpanded = !body.classList.contains('hidden');
    if (nowExpanded) {
      body.classList.add('hidden');
      _expandedIds.delete(job.id);
    } else {
      body.classList.remove('hidden');
      _expandedIds.add(job.id);
    }
  });

  card.appendChild(header);
  card.appendChild(preview);
  card.appendChild(body);

  return card;
}

// ─── 섹션 렌더 ─────────────────────────────────────────────────────────────
function renderJobs(jobs) {
  const section = document.getElementById('jobs-section');
  if (!section) return;

  if (!Array.isArray(jobs) || jobs.length === 0) {
    section.style.display = 'none';
    return;
  }

  section.style.display = '';
  const list = document.getElementById('jobs-list');
  if (!list) return;

  // 재렌더: 기존 카드 전부 교체. 펼침 상태는 _expandedIds Set 이 유지.
  list.innerHTML = '';
  for (const job of jobs) {
    list.appendChild(buildJobCard(job));
  }
}

// ─── 폴링 루프 ─────────────────────────────────────────────────────────────
let _lastFetchFailed = false;  // 404/오류 시 콘솔 스팸 억제용 — 첫 실패만 warn.

async function fetchJobs() {
  // 탭 비가시 시 skip
  if (document.hidden) return schedule(POLL_IDLE_MS);

  let jobs;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch('/api/jobs', { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(t);
    if (!r.ok) {
      // 404 = 아직 미구현. 섹션 숨김 + 조용히 처리.
      if (!_lastFetchFailed) {
        if (r.status !== 404) console.warn('[jobs] /api/jobs', r.status);
        _lastFetchFailed = true;
      }
      const section = document.getElementById('jobs-section');
      if (section) section.style.display = 'none';
      return schedule(POLL_IDLE_MS);
    }
    _lastFetchFailed = false;
    const data = await r.json();
    jobs = Array.isArray(data.jobs) ? data.jobs : [];
  } catch {
    // network 오류 — 조용히 섹션 숨김
    const section = document.getElementById('jobs-section');
    if (section) section.style.display = 'none';
    return schedule(POLL_IDLE_MS);
  }

  // ── 완료 전이 감지 ──────────────────────────────────────────────────────
  // 첫 로드(_prevAliveIds === null): 알림 없음. 이미 dead 인 job 은 조용히.
  const nowAliveIds = new Set(jobs.filter((j) => j.alive).map((j) => j.id));
  if (_prevAliveIds !== null) {
    for (const [id, label] of _prevAliveIds) {
      if (!nowAliveIds.has(id)) {
        // alive → dead 전이 감지
        playChime();
        showToast(`작업 완료: ${label}`, 'success', 5000);
        // rail-noti-dot 표시
        document.getElementById('rail-noti-dot')?.classList.remove('hidden');
      }
    }
  }
  // 다음 폴링 비교용으로 id → label Map 저장
  _prevAliveIds = new Map(jobs.filter((j) => j.alive).map((j) => [j.id, j.label || j.id]));

  // ── 렌더 ────────────────────────────────────────────────────────────────
  renderJobs(jobs);

  // ── 다음 폴링 스케줄 ────────────────────────────────────────────────────
  const hasActive = jobs.some((j) => j.alive);
  schedule(hasActive ? POLL_ACTIVE_MS : POLL_IDLE_MS);
}

function schedule(ms) {
  if (_pollTimer) clearTimeout(_pollTimer);
  _pollTimer = setTimeout(fetchJobs, ms);
}

// ─── 공개 진입점 ───────────────────────────────────────────────────────────
export function initJobs() {
  // 페이지 복귀 시 즉시 갱신
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) fetchJobs();
  });
  // 첫 fetch — 짧은 딜레이 후 (boot 직후 다른 fetch 들과 burst 회피)
  setTimeout(fetchJobs, 1200);
}
