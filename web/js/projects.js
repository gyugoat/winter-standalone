// web/js/projects.js — 축 4 Projects 사이드바 섹션 (TaskInfo §4-3(d), 결정 9-13).
// Contract:
//   GET  /api/projects        → { projects:[{id,name,status,createdAt,lastActivityAt,idleDays,inactive,counts}], dangling:[] }
//   GET  /api/projects/:id    → 상세 + members.sessions[]
//   POST /api/projects        → { name }
//   PATCH /api/projects/:id   → { name? | archived? }  (hard delete 없음 — archive 만)
//
// 렌더 원칙: 서버가 derive 한 lastActivityAt/inactive 를 그대로 표시 (P1 — 해석은 서버 derive 1곳).
// 폴링: 60s + 탭 복귀 시 즉시 — projects 는 저빈도 데이터라 세션 목록(15s)보다 느슨하게.

import { showToast } from './toast.js';

let _onOpenSession = null;      // app.js 의 setCurrentSession 주입
let _pollTimer = null;
let _showArchived = false;
let _collapsed = false;
const _expandedIds = new Set(); // 펼친 project — 재렌더 후 유지 (jobs.js _expandedIds 와 동형)
let _cache = [];                // 마지막 fetch 결과 (토글 재렌더용)
let _lastFetchFailed = false;   // 콘솔 스팸 억제 — 첫 실패만 warn (#34/#35: 숨기되 소리는 1회 낸다)

const COLLAPSE_KEY = 'winter3:projects-collapsed';
const POLL_MS = 60_000;

// ─── 포맷 ──────────────────────────────────────────────────────────────────
function fmtRelative(ms) {
  if (ms == null) return '—';
  const diff = Date.now() - ms;
  if (diff < 60_000) return '방금';
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

// ─── 렌더 ──────────────────────────────────────────────────────────────────
function render() {
  const ul = document.getElementById('projects-list');
  if (!ul) return;
  document.getElementById('projects-section')?.classList.toggle('collapsed', _collapsed);
  ul.innerHTML = '';
  if (_collapsed) return;

  const visible = _cache.filter((p) => _showArchived || p.status !== 'archived');
  for (const pr of visible) {
    const li = document.createElement('li');
    li.className = 'proj-row';
    li.dataset.pid = pr.id;
    if (pr.status === 'archived') li.classList.add('archived');

    const head = document.createElement('div');
    head.className = 'proj-row-head';

    const name = document.createElement('span');
    name.className = 'proj-name';
    name.textContent = pr.name;
    name.title = `${pr.name} — 세션 ${pr.counts.sessions} / job ${pr.counts.jobs} / rea ${pr.counts.rea}`;

    const meta = document.createElement('span');
    meta.className = 'proj-meta';
    meta.textContent = fmtRelative(pr.lastActivityAt);

    head.appendChild(name);
    // inactivity 뱃지 (§4-3(d)): active 7일+ 무활동 → "N일 전" 강조. 색 단계 없음 — 숫자가 정보.
    if (pr.inactive) {
      const badge = document.createElement('span');
      badge.className = 'proj-badge';
      badge.textContent = `${pr.idleDays}일 전`;
      badge.title = `${pr.idleDays}일째 활동 없음`;
      head.appendChild(badge);
    } else {
      head.appendChild(meta);
    }

    // archive 토글 버튼 — hard delete 없음.
    const arch = document.createElement('button');
    arch.className = 'proj-act';
    arch.type = 'button';
    arch.textContent = pr.status === 'archived' ? '복원' : '보관';
    arch.title = pr.status === 'archived' ? '아카이브 해제' : '아카이브 (삭제 아님)';
    arch.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        const r = await fetch(`/api/projects/${pr.id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ archived: pr.status !== 'archived' }),
        });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
        await refresh();
      } catch (err) { showToast(`아카이브 실패: ${err.message}`, 'error', 3000); }
    });
    head.appendChild(arch);

    // 펼침 본문 — 클릭 시 멤버 세션 lazy fetch (재방문 경로: project → 세션 2클릭, §4-2 metric)
    const body = document.createElement('ul');
    body.className = 'proj-members';
    if (!_expandedIds.has(pr.id)) body.classList.add('hidden');

    head.addEventListener('click', async () => {
      const nowHidden = body.classList.toggle('hidden');
      if (nowHidden) { _expandedIds.delete(pr.id); return; }
      _expandedIds.add(pr.id);
      body.innerHTML = '<li class="proj-member dim">로드 중…</li>';
      try {
        const r = await fetch(`/api/projects/${pr.id}`);
        if (!r.ok) throw new Error(String(r.status));
        const detail = await r.json();
        body.innerHTML = '';
        const sess = detail.members?.sessions || [];
        if (sess.length === 0) {
          const empty = document.createElement('li');
          empty.className = 'proj-member dim';
          empty.textContent = '아직 할당된 세션 없음 — 채팅 상단의 Project 드롭다운에서 이 프로젝트를 선택하면 현재 세션이 여기 묶인다';
          body.appendChild(empty);
        }
        for (const s of sess) {
          const mi = document.createElement('li');
          mi.className = 'proj-member';
          mi.textContent = s.title;
          mi.title = `${s.title} — ${fmtRelative(s.updatedAt)}`;
          mi.addEventListener('click', (e) => {
            e.stopPropagation();
            if (_onOpenSession) _onOpenSession(s.id);
          });
          body.appendChild(mi);
        }
        for (const j of detail.members?.jobs || []) {
          const mi = document.createElement('li');
          mi.className = 'proj-member dim';
          mi.textContent = `job: ${j.id} (${fmtRelative(j.lastRun)})`;
          body.appendChild(mi);
        }
      } catch (err) {
        body.innerHTML = '';
        const el = document.createElement('li');
        el.className = 'proj-member dim';
        el.textContent = `멤버 로드 실패: ${err.message}`;
        body.appendChild(el);
      }
    });

    li.appendChild(head);
    li.appendChild(body);
    ul.appendChild(li);
  }
}

// ─── 세션 ↔ Project 바인딩 드롭다운 (#chat-project, 채팅 헤더) ────────────────
// app.js 가 세션 전환 시 syncSessionProjectSelect(sid, meta.projectId) 호출.
// refresh() 성공 시에도 옵션 재구성 (project 생성/아카이브 반영).
let _selSid = null;  // 드롭다운이 가리키는 세션
let _selPid = null;  // 그 세션의 projectId (서버 기준)

function renderProjectSelect() {
  const sel = document.getElementById('chat-project');
  if (!sel) return;
  if (!_selSid) { sel.classList.add('hidden'); return; }
  sel.classList.remove('hidden');
  sel.innerHTML = '';
  const opt = (value, label) => {
    const o = document.createElement('option');
    o.value = value; o.textContent = label;
    return o;
  };
  sel.appendChild(opt('', 'Project: 없음'));
  for (const p of _cache) {
    if (p.status === 'archived' && p.id !== _selPid) continue;
    sel.appendChild(opt(p.id, p.name));
  }
  // 할당된 project 가 목록에 없음 (projects fetch 전 / dangling) — 값 유실 방지용 표시 옵션
  if (_selPid && !_cache.some((p) => p.id === _selPid)) {
    sel.appendChild(opt(_selPid, `(프로젝트 ${_selPid.slice(0, 8)})`));
  }
  sel.appendChild(opt('__new__', '+ 새 프로젝트…'));
  sel.value = _selPid || '';
}

export function syncSessionProjectSelect(sid, projectId) {
  _selSid = sid || null;
  _selPid = projectId || null;
  renderProjectSelect();
}

function bindProjectSelect() {
  const sel = document.getElementById('chat-project');
  if (!sel) return;
  sel.addEventListener('change', async () => {
    if (!_selSid) return;
    const prev = _selPid || '';
    let pid = sel.value;
    try {
      if (pid === '__new__') {
        const name = (window.prompt('새 프로젝트 이름') || '').trim();
        if (!name) { sel.value = prev; return; }
        const cr = await fetch('/api/projects', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        const created = await cr.json().catch(() => ({}));
        if (!cr.ok) throw new Error(created.error || `HTTP ${cr.status}`);
        pid = created.id;
      }
      const r = await fetch(`/sessions/${_selSid}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: pid === '' ? null : pid }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      const updated = await r.json();
      _selPid = updated.projectId || null;
      const pname = _cache.find((p) => p.id === _selPid)?.name || _selPid?.slice(0, 8);
      showToast(_selPid ? `프로젝트 할당: ${pname}` : '프로젝트 해제', 'success', 2000);
      await refresh(); // 리스트 counts 갱신 + renderProjectSelect 재호출
    } catch (err) {
      sel.value = prev;
      showToast(`프로젝트 할당 실패: ${err.message}`, 'error', 3500);
    }
  });
}

// ─── fetch ─────────────────────────────────────────────────────────────────
async function refresh() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch('/api/projects', { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(t);
    if (!r.ok) throw new Error(String(r.status));
    const data = await r.json();
    _cache = Array.isArray(data.projects) ? data.projects : [];
    _lastFetchFailed = false;
    // dangling 참조는 서버 stderr 에 이미 기록 — UI 는 콘솔 warn 만 (silent 금지, 단 매 폴링 스팸 방지로 1회성 아님 허용: 건수 적음)
    if (Array.isArray(data.dangling) && data.dangling.length > 0) {
      console.warn('[projects] dangling projectId 참조:', data.dangling);
    }
    render();
    renderProjectSelect(); // 헤더 드롭다운 옵션도 최신 project 목록으로 재구성
  } catch (err) {
    if (!_lastFetchFailed) { console.warn('[projects] /api/projects fetch 실패:', err.message); _lastFetchFailed = true; }
    // 섹션은 숨기지 않음 — 입구(+)는 살아 있어야 재시도 가능. 리스트만 기존 상태 유지.
  }
  schedule();
}

function schedule() {
  if (_pollTimer) clearTimeout(_pollTimer);
  _pollTimer = setTimeout(refresh, POLL_MS);
}

// ─── 생성 입력 ─────────────────────────────────────────────────────────────
function bindCreateRow() {
  const row = document.getElementById('proj-new-row');
  const input = document.getElementById('proj-new-input');
  document.getElementById('proj-new')?.addEventListener('click', () => {
    row?.classList.toggle('hidden');
    if (!row?.classList.contains('hidden')) input?.focus();
  });
  input?.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') { row?.classList.add('hidden'); input.value = ''; return; }
    if (e.key !== 'Enter') return;
    const name = input.value.trim();
    if (!name) return;
    try {
      const r = await fetch('/api/projects', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
      input.value = '';
      row?.classList.add('hidden');
      showToast(`프로젝트 생성: ${name}`, 'success', 2000);
      await refresh();
    } catch (err) { showToast(`생성 실패: ${err.message}`, 'error', 3000); }
  });
}

// ─── 공개 진입점 ───────────────────────────────────────────────────────────
export function initProjects({ onOpenSession } = {}) {
  _onOpenSession = onOpenSession || null;
  _collapsed = localStorage.getItem(COLLAPSE_KEY) === '1';

  document.getElementById('proj-collapse')?.addEventListener('click', () => {
    _collapsed = !_collapsed;
    try { localStorage.setItem(COLLAPSE_KEY, _collapsed ? '1' : '0'); } catch {}
    document.getElementById('proj-collapse')?.setAttribute('aria-expanded', String(!_collapsed));
    render();
  });
  document.getElementById('proj-archived-toggle')?.addEventListener('click', (e) => {
    _showArchived = !_showArchived;
    e.currentTarget.setAttribute('aria-pressed', String(_showArchived));
    e.currentTarget.classList.toggle('on', _showArchived);
    render();
  });
  bindCreateRow();
  bindProjectSelect();

  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  // boot burst 회피 — jobs.js(1200ms) 와 어긋나게.
  setTimeout(refresh, 1600);
}
