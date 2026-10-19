// web/js/artifacts.js — 축 5 Artifacts 사이드바 섹션 + REA 서브 (TaskInfo §5-3(e), 결정 17)
// + composer REA drop zone (결정 14).
//
// Contract:
//   GET    /api/rea[?projectId=]  → { items:[meta…] }
//   GET    /api/rea/:hash         → meta + result + mechanical {strings,tree,grepIndex,beautified}
//   POST   /api/rea               → { dataBase64, name, sid?, depth?, projectId? } → meta
//   DELETE /api/rea/:hash         → .trash 이동 (hard delete 없음)
//
// 렌더 원칙: XSS-free (textContent 만 — lol-view.js 관행). 서버 산출을 해석 없이 표시 (P1).
// 폴링 없음 — REA 는 저빈도: init + 탭 복귀 + 수동 ↻ + drop 직후만 fetch.

import { showToast } from './toast.js';

let _getSid = null;        // app.js 가 현재 세션 id getter 주입
let _collapsed = false;
let _cache = [];
let _pending = [];         // 분석 진행 중 행 — {key,name,size}. POST /api/rea 응답 대기 동안 표시
let _modalData = null;     // 열린 모달의 GET /api/rea/:hash 응답
let _modalHash = null;     // 열린 모달의 hash — ↻ 재fetch 용 (B4-2)
let _tab = 'result';
const COLLAPSE_KEY = 'winter3:artifacts-collapsed';
const MAX_UPLOAD_BYTES = 60 * 1024 * 1024; // 서버 readBody 80MB (base64 팽창) 와 정합

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function fmtBytes(n) {
  if (n == null) return '?';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

// ─── 리스트 렌더 ────────────────────────────────────────────────────────────
function render() {
  const ul = document.getElementById('rea-list');
  if (!ul) return;
  document.getElementById('artifacts-section')?.classList.toggle('collapsed', _collapsed);
  ul.innerHTML = '';
  if (_collapsed) return;
  // 분석 진행 중 pending 행 — 완료 전에도 "되고 있다" 가 보여야 함 (silent 금지)
  for (const p of _pending) {
    const li = el('li', 'rea-row pending');
    const name = el('span', 'rea-name', p.name);
    name.title = `${p.name}\n분석 중 — 큰 파일은 수십 초 걸릴 수 있음`;
    li.appendChild(name);
    li.appendChild(el('span', 'rea-meta', fmtBytes(p.size)));
    li.appendChild(el('span', 'rea-status pending', '분석중'));
    ul.appendChild(li);
  }
  if (_cache.length === 0) {
    if (_pending.length === 0) ul.appendChild(el('li', 'rea-row dim', '분석 없음 — composer 에 파일 drop 또는 rea-ctl add'));
    return;
  }
  for (const m of _cache) {
    const li = el('li', 'rea-row');
    li.dataset.hash = m.hash;
    const name = el('span', 'rea-name', m.origName || m.hash.slice(0, 12));
    name.title = `${m.origName || ''}\n${m.hash}\nstatus: ${m.status} / ${fmtBytes(m.size)}`;
    const meta = el('span', 'rea-meta', `${m.hash.slice(0, 8)} · ${m.format || '?'}`);
    li.appendChild(name);
    li.appendChild(meta);
    if (m.projectId) li.appendChild(el('span', 'rea-proj', m.projectId.slice(0, 8)));
    if (m.status && m.status !== 'mechanical' && m.status !== 'done') {
      li.appendChild(el('span', 'rea-status', m.status)); // unsupported / routed / bomb_guard / error 가시화
    }
    // llmStatus 뱃지 (B4-2) — pending/failed 만 표시. ok 는 기본값이라 생략 (행 노이즈 최소).
    if (m.llmStatus === 'pending') li.appendChild(el('span', 'rea-status rea-llm-pending', 'LLM중'));
    else if (m.llmStatus === 'failed') li.appendChild(el('span', 'rea-status rea-llm-failed', 'LLM실패'));
    li.addEventListener('click', () => openModal(m.hash));
    ul.appendChild(li);
  }
}

async function refresh() {
  try {
    const r = await fetch('/api/rea', { cache: 'no-store' });
    if (!r.ok) throw new Error(String(r.status));
    const data = await r.json();
    _cache = Array.isArray(data.items) ? data.items : [];
    render();
  } catch (err) {
    console.warn('[artifacts] /api/rea fetch 실패:', err.message);
  }
}

// ─── 상세 모달 (result / tree / strings / grep) ─────────────────────────────
function renderModalBody() {
  const body = document.getElementById('rea-modal-body');
  if (!body || !_modalData) return;
  const d = _modalData;
  let text = '';
  if (_tab === 'result') text = d.result || '(result.md 없음)';
  else if (_tab === 'tree') text = d.mechanical?.tree || '(tree 없음)';
  else if (_tab === 'strings') text = d.mechanical?.strings || '(strings 없음)';
  else if (_tab === 'grep') {
    const gi = d.mechanical?.grepIndex;
    if (!gi || !gi.tokens || Object.keys(gi.tokens).length === 0) text = '(grep hit 없음)';
    else {
      const lines = [];
      for (const [tok, v] of Object.entries(gi.tokens)) {
        lines.push(`${tok}  ×${v.count}`);
        for (const s of v.samples || []) lines.push(`    ${s.file}:${s.line}  ${s.text}`);
      }
      text = lines.join('\n');
    }
  }
  body.textContent = text; // XSS-free
  document.querySelectorAll('#rea-modal-tabs button').forEach((b) => {
    b.classList.toggle('on', b.dataset.tab === _tab);
  });
}

async function openModal(hash) {
  const modal = document.getElementById('rea-modal');
  const title = document.getElementById('rea-modal-title');
  if (!modal) return;
  _tab = 'result';
  _modalData = null;
  _modalHash = hash;
  title.textContent = `REA — 로드 중…`;
  modal.classList.remove('hidden');
  try {
    const r = await fetch(`/api/rea/${hash}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(String(r.status));
    _modalData = await r.json();
    title.textContent = `REA — ${_modalData.origName || hash.slice(0, 12)} (${_modalData.status})`;
    renderModalBody();
  } catch (err) {
    title.textContent = 'REA — 로드 실패';
    const body = document.getElementById('rea-modal-body');
    if (body) body.textContent = `GET /api/rea/${hash} 실패: ${err.message}`;
  }
}

// 모달 ↻ (B4-2) — 모달은 1회 fetch 라 LLM 분석 중 열면 placeholder 영구 표시 → 수동 재fetch.
// 탭 유지한 채 result.md + meta 재조회. 리스트 llmStatus 뱃지도 같이 동기화.
async function refreshModal() {
  if (!_modalHash) return;
  const keepTab = _tab;
  await openModal(_modalHash);
  if (_modalData) { _tab = keepTab; renderModalBody(); }
  refresh();
}

export function isReaModalOpen() {
  return !document.getElementById('rea-modal')?.classList.contains('hidden');
}
export function closeReaModal() {
  document.getElementById('rea-modal')?.classList.add('hidden');
  _modalData = null;
  _modalHash = null;
}

// ─── composer drop zone (결정 14) ──────────────────────────────────────────
function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

async function analyzeDroppedFile(file) {
  if (file.size > MAX_UPLOAD_BYTES) {
    showToast(`REA: ${file.name} 은 ${fmtBytes(file.size)} — 업로드 상한 ${fmtBytes(MAX_UPLOAD_BYTES)} 초과. rea-ctl add <path> 를 써라`, 'error', 5000);
    return;
  }
  // 분석 중 가시화 — 리스트에 pending 행 + 토스트. POST 는 분석 완료까지 블록되므로 (폴링 불필요)
  // 응답이 올 때까지 이 행이 "진행 중" 상태 그 자체다. finally 에서 반드시 제거 (leak 방지).
  const pendingEntry = { key: `${Date.now()}:${file.name}`, name: file.name, size: file.size };
  _pending.push(pendingEntry);
  render();
  showToast(`REA 분석 중… — ${file.name} (${fmtBytes(file.size)}) · 큰 파일은 수십 초`, '', 4000);
  try {
    const dataUrl = await readAsDataURL(file);
    const r = await fetch('/api/rea', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dataBase64: dataUrl.split(',')[1],
        name: file.name,
        sid: _getSid ? (_getSid() || undefined) : undefined, // 세션 있으면 winter3.rea_meta ref 기록
      }),
    });
    const meta = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(meta.error || `HTTP ${r.status}`);
    const hit = meta.cacheHit ? ' (cache hit)' : '';
    showToast(`REA ${meta.status}${hit} — ${meta.hash?.slice(0, 12)} ${file.name}`, 'success', 4000);
    await refresh();
  } catch (err) {
    showToast(`REA 실패 — ${file.name}: ${err.message}`, 'error', 5000);
  } finally {
    _pending = _pending.filter((p) => p !== pendingEntry);
    render();
  }
}

function bindDropZone() {
  const zone = document.getElementById('rea-drop');
  if (!zone) return;
  // stopPropagation — #chat 전역 이미지 drop 핸들러/overlay 와 분리 (이 zone 은 REA 전용)
  zone.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault(); e.stopPropagation();
    zone.classList.add('over');
  });
  zone.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault(); e.stopPropagation();
  });
  zone.addEventListener('dragleave', (e) => {
    e.stopPropagation();
    zone.classList.remove('over');
  });
  zone.addEventListener('drop', async (e) => {
    e.preventDefault(); e.stopPropagation();
    zone.classList.remove('over');
    // #chat dragenter 가 먼저 띄운 이미지 overlay 는 drop 시 dragleave 가 안 와서 잔류 — 수동 정리
    document.getElementById('drop-overlay')?.classList.add('hidden');
    const files = [...(e.dataTransfer?.files || [])];
    for (const f of files) await analyzeDroppedFile(f); // 직렬 — 서버 부하/quota 보호 (#26 동형)
  });
}

// ─── 공개 진입점 ────────────────────────────────────────────────────────────
export function initArtifacts({ getSid } = {}) {
  _getSid = getSid || null;
  _collapsed = localStorage.getItem(COLLAPSE_KEY) === '1';

  document.getElementById('art-collapse')?.addEventListener('click', () => {
    _collapsed = !_collapsed;
    try { localStorage.setItem(COLLAPSE_KEY, _collapsed ? '1' : '0'); } catch {}
    document.getElementById('art-collapse')?.setAttribute('aria-expanded', String(!_collapsed));
    render();
  });
  document.getElementById('art-refresh')?.addEventListener('click', refresh);

  // 모달 "↻ 갱신" 버튼 (B4-2) — index.html 수정 없이 JS 주입. ✕ 왼쪽에 배치.
  const reaHead = document.querySelector('#rea-modal .modal-head');
  if (reaHead && !document.getElementById('rea-modal-refresh')) {
    const btn = el('button', null, '↻');
    btn.id = 'rea-modal-refresh';
    btn.type = 'button';
    btn.title = 'result.md + meta 재조회 (LLM 분석 완료 시 placeholder 교체)';
    btn.setAttribute('aria-label', '갱신');
    btn.addEventListener('click', refreshModal);
    reaHead.insertBefore(btn, document.getElementById('rea-modal-close'));
  }

  // 모달 close / tab 전환
  document.getElementById('rea-modal-close')?.addEventListener('click', closeReaModal);
  document.getElementById('rea-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'rea-modal') closeReaModal();
  });
  document.getElementById('rea-modal-tabs')?.addEventListener('click', (e) => {
    const tab = e.target?.dataset?.tab;
    if (!tab) return;
    _tab = tab;
    renderModalBody();
  });

  bindDropZone();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  // boot burst 회피 — jobs(1200ms)/projects(1600ms) 와 어긋나게
  setTimeout(refresh, 2000);
}
