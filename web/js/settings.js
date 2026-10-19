// web/js/settings.js — 설정 패널 (modal). openSettings / closeSettings export.
// 항목: 사운드(chime on/off + 볼륨, pip 사운드, task 사운드) + 화면(눈, 독백 표시).

import { isChimeEnabled, getChimeVolume, setChimeEnabled } from './chime.js';
import { toggleSnow, isSnowOn } from './snow.js';

const CHIME_VOL_KEY  = 'winter3:chime-volume';
const PIP_SOUND_KEY  = 'winter3:pip-sound';
const TASK_SOUND_KEY = 'winter3:task-sound';
const SOLI_KEY       = 'winter3:soli-hidden';

// ── 독백 body 클래스 초기화 (페이지 로드 시점에 호출됨) ──────────────
export function initSettings() {
  if (localStorage.getItem(SOLI_KEY) === '1') {
    document.body.classList.add('soli-hidden');
  }
}

// ── 헬퍼 ──────────────────────────────────────────────────────────────
function lsGet(key, fallback) {
  const v = localStorage.getItem(key);
  return v === null ? fallback : v;
}

function lsSet(key, val) {
  try { localStorage.setItem(key, val); } catch {}
}

// ── Claude 폴링 (모듈 스코프) ──────────────────────────────────────────
let _claudePollTimer = null;

function stopClaudePolling() {
  if (_claudePollTimer !== null) {
    clearTimeout(_claudePollTimer);
    _claudePollTimer = null;
  }
}

// ── DOM 생성 ───────────────────────────────────────────────────────────
let _overlay = null;

function buildPanel() {
  // overlay
  const overlay = document.createElement('div');
  overlay.id = 'settings-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', '설정');

  // card
  const card = document.createElement('div');
  card.id = 'settings-card';

  // header
  const header = document.createElement('div');
  header.className = 'settings-header';
  header.innerHTML = '<span class="settings-title">설정</span>';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'settings-close';
  closeBtn.textContent = '×';
  closeBtn.setAttribute('aria-label', '닫기');
  closeBtn.addEventListener('click', closeSettings);
  header.appendChild(closeBtn);
  card.appendChild(header);

  // body
  const body = document.createElement('div');
  body.className = 'settings-body';

  // ─ 사운드 섹션 ─
  const secSound = mkSection('사운드');

  // chime on/off
  const chimeOn = isChimeEnabled();
  secSound.appendChild(mkRow(
    '응답 알림음',
    mkToggle('settings-chime', chimeOn, (on) => {
      setChimeEnabled(on);
      volRow.style.opacity = on ? '1' : '0.35';
      volRow.querySelector('input').disabled = !on;
    })
  ));

  // chime volume
  const volRow = mkRow('알림 볼륨', mkSlider('settings-vol', getChimeVolume(), 0, 1, 0.05, (v) => {
    const clamped = Math.max(0, Math.min(1, v));
    lsSet(CHIME_VOL_KEY, String(clamped));
  }));
  if (!chimeOn) {
    volRow.style.opacity = '0.35';
    volRow.querySelector('input').disabled = true;
  }
  secSound.appendChild(volRow);

  // pip sound
  const pipOn = lsGet(PIP_SOUND_KEY, '1') !== '0';
  secSound.appendChild(mkRow(
    'PiP 모니터 사운드',
    mkToggle('settings-pip', pipOn, (on) => lsSet(PIP_SOUND_KEY, on ? '1' : '0'))
  ));

  // task sound
  const taskOn = lsGet(TASK_SOUND_KEY, '1') !== '0';
  secSound.appendChild(mkRow(
    'Task 완료 사운드',
    mkToggle('settings-task', taskOn, (on) => lsSet(TASK_SOUND_KEY, on ? '1' : '0'))
  ));

  body.appendChild(secSound);

  // ─ 화면 섹션 ─
  const secView = mkSection('화면');

  // snow — isSnowOn() 은 canvas animId 기반 실제 상태
  const snowOn = isSnowOn();
  secView.appendChild(mkRow(
    '눈 내림',
    mkToggle('settings-snow', snowOn, (on) => {
      toggleSnow(on);
    })
  ));

  // soli hidden
  const soliHidden = lsGet(SOLI_KEY, '') === '1';
  secView.appendChild(mkRow(
    '독백 표시',
    mkToggle('settings-soli', !soliHidden, (on) => {
      if (on) {
        lsSet(SOLI_KEY, '0');
        document.body.classList.remove('soli-hidden');
      } else {
        lsSet(SOLI_KEY, '1');
        document.body.classList.add('soli-hidden');
      }
    })
  ));

  body.appendChild(secView);

  // ─ Claude 인증 섹션 ─ (boin settings.js 동형 이식 — API: /settings, /claude/connect/*, /auth-token)
  const secAuth = mkSection('Claude 인증');
  secAuth.id = 'settings-sec-claude'; // render.js 인증 카드의 scrollIntoView 타겟

  // 상태 행
  const authStatusSpan = document.createElement('span');
  authStatusSpan.className = 'settings-row-label';
  authStatusSpan.textContent = '확인 중…';

  const authStatusRow = document.createElement('div');
  authStatusRow.className = 'settings-row';
  authStatusRow.appendChild(authStatusSpan);
  secAuth.appendChild(authStatusRow);

  // 상태 갱신 헬퍼
  function applyClaudeStatus(tokenSet, tokenSuffix) {
    if (tokenSet && tokenSuffix) {
      authStatusSpan.textContent = '설정됨 (····' + tokenSuffix + ')';
    } else {
      authStatusSpan.textContent = '미설정';
    }
  }

  // fetch 현재 상태
  fetch('/settings')
    .then(r => r.ok ? r.json() : Promise.reject(r.status))
    .then(d => { applyClaudeStatus(d.tokenSet, d.tokenSuffix); })
    .catch(() => { authStatusSpan.textContent = '확인 불가'; });

  // ── 주 연결 버튼 영역 ──────────────────────────────────────────────
  const claudeBtnWrap = document.createElement('div');
  claudeBtnWrap.className = 'settings-token-ctrl';

  const claudeConnectBtn = document.createElement('button');
  claudeConnectBtn.className = 'settings-token-btn';
  claudeConnectBtn.textContent = 'Claude 계정 연결';

  const claudeConnectHint = document.createElement('div');
  claudeConnectHint.className = 'settings-token-hint';
  claudeConnectHint.textContent = '버튼 누르면 Claude 로그인 창이 열려. 로그인하면 자동으로 연결돼.';

  const claudeConnectError = document.createElement('span');
  claudeConnectError.className = 'settings-token-error';
  claudeConnectError.style.display = 'none';

  function startClaudePolling(prevSuffix) {
    const deadline = Date.now() + 5 * 60 * 1000; // 5분

    function poll() {
      if (Date.now() > deadline) {
        stopClaudePolling();
        claudeConnectError.textContent = '시간 초과 — 다시 시도해.';
        claudeConnectError.style.display = 'inline';
        claudeConnectBtn.disabled = false;
        claudeConnectBtn.textContent = 'Claude 계정 연결';
        return;
      }
      fetch('/settings')
        .then(r => r.ok ? r.json() : Promise.reject(r.status))
        .then(d => {
          if (d.tokenSet && (d.tokenSuffix !== prevSuffix || !prevSuffix)) {
            stopClaudePolling();
            applyClaudeStatus(d.tokenSet, d.tokenSuffix);
            claudeConnectBtn.disabled = false;
            claudeConnectBtn.textContent = '연결 완료';
            claudeConnectHint.textContent = '버튼 누르면 Claude 로그인 창이 열려. 로그인하면 자동으로 연결돼.';
            setTimeout(() => { claudeConnectBtn.textContent = 'Claude 계정 연결'; }, 2000);
          } else {
            _claudePollTimer = setTimeout(poll, 5000);
          }
        })
        .catch(() => {
          _claudePollTimer = setTimeout(poll, 5000);
        });
    }

    _claudePollTimer = setTimeout(poll, 5000);
  }

  claudeConnectBtn.addEventListener('click', () => {
    claudeConnectBtn.disabled = true;
    claudeConnectBtn.textContent = '브라우저에서 Claude 로그인을 완료해…';
    claudeConnectError.style.display = 'none';
    stopClaudePolling();

    // 현재 suffix 기억 (변경 감지용)
    const prevSuffix = authStatusSpan.textContent.includes('설정됨')
      ? authStatusSpan.textContent.replace(/.*····/, '').replace(/[)].*/, '')
      : null;

    fetch('/claude/connect/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(r => r.json().then(d => ({ ok: r.ok, data: d })))
      .then(({ ok, data }) => {
        if (ok && data.ok && data.authUrl) {
          window.open(data.authUrl, '_blank');
          startClaudePolling(prevSuffix);
        } else {
          claudeConnectError.textContent = (data && data.error) || '연결 시작 실패';
          claudeConnectError.style.display = 'inline';
          claudeConnectBtn.disabled = false;
          claudeConnectBtn.textContent = 'Claude 계정 연결';
        }
      })
      .catch(() => {
        claudeConnectError.textContent = '서버 연결 실패';
        claudeConnectError.style.display = 'inline';
        claudeConnectBtn.disabled = false;
        claudeConnectBtn.textContent = 'Claude 계정 연결';
      });
  });

  claudeBtnWrap.appendChild(claudeConnectBtn);
  claudeBtnWrap.appendChild(claudeConnectError);
  secAuth.appendChild(mkRow('계정 연결', claudeBtnWrap));
  secAuth.appendChild(claudeConnectHint);

  // ── 코드 붙여넣기 보조 플로우 (/claude/connect/finish) ─────────────
  const codeInput = document.createElement('input');
  codeInput.type = 'text';
  codeInput.placeholder = '인증 코드 붙여넣기';
  codeInput.className = 'settings-token-input';

  const codeSubmitBtn = document.createElement('button');
  codeSubmitBtn.className = 'settings-token-btn';
  codeSubmitBtn.textContent = '확인';

  const codeError = document.createElement('span');
  codeError.className = 'settings-token-error';
  codeError.style.display = 'none';

  codeSubmitBtn.addEventListener('click', () => {
    const code = codeInput.value.trim();
    if (!code) return;

    codeSubmitBtn.disabled = true;
    codeError.style.display = 'none';

    fetch('/claude/connect/finish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    })
      .then(r => r.json().then(d => ({ ok: r.ok, data: d })))
      .then(({ ok, data }) => {
        if (ok && data.ok) {
          stopClaudePolling();
          applyClaudeStatus(true, data.suffix || '');
          codeInput.value = '';
          codeSubmitBtn.textContent = '완료';
          claudeConnectBtn.disabled = false;
          claudeConnectBtn.textContent = 'Claude 계정 연결';
          setTimeout(() => { codeSubmitBtn.textContent = '확인'; codeSubmitBtn.disabled = false; }, 1500);
        } else {
          codeError.textContent = (data && data.error) || '코드 인증 실패';
          codeError.style.display = 'inline';
          codeSubmitBtn.disabled = false;
        }
      })
      .catch(() => {
        codeError.textContent = '서버 연결 실패';
        codeError.style.display = 'inline';
        codeSubmitBtn.disabled = false;
      });
  });

  const codeCtrl = document.createElement('div');
  codeCtrl.className = 'settings-token-ctrl';
  codeCtrl.appendChild(codeInput);
  codeCtrl.appendChild(codeSubmitBtn);
  codeCtrl.appendChild(codeError);

  const codeHint = document.createElement('div');
  codeHint.className = 'settings-token-hint';
  codeHint.textContent = '창이 안 뜨거나 코드가 표시되면 여기 붙여넣기';

  secAuth.appendChild(codeHint);
  secAuth.appendChild(codeCtrl);

  // ── 고급 토글 (sk-ant-oat 직접 입력 — /auth-token) ─────────────────
  const advToggle = document.createElement('button');
  advToggle.className = 'settings-token-hint';
  advToggle.style.cssText = 'background:none;border:none;padding:0;cursor:pointer;text-decoration:underline;';
  advToggle.textContent = '▶ 고급';

  const advSection = document.createElement('div');
  advSection.style.display = 'none';

  let advOpen = false;
  advToggle.addEventListener('click', () => {
    advOpen = !advOpen;
    advSection.style.display = advOpen ? 'block' : 'none';
    advToggle.textContent = (advOpen ? '▼' : '▶') + ' 고급';
  });

  // 고급 안내문
  const advHint = document.createElement('div');
  advHint.className = 'settings-token-hint';
  advHint.textContent = '터미널에서 claude setup-token 실행 → 나온 토큰을 붙여넣어. 다음 메시지부터 적용돼.';
  advSection.appendChild(advHint);

  // 토큰 직접 입력
  const tokenInput = document.createElement('input');
  tokenInput.type = 'password';
  tokenInput.placeholder = 'sk-ant-oat... 토큰 붙여넣기';
  tokenInput.className = 'settings-token-input';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'settings-token-btn';
  saveBtn.textContent = '저장';

  const tokenErrorSpan = document.createElement('span');
  tokenErrorSpan.className = 'settings-token-error';
  tokenErrorSpan.style.display = 'none';

  saveBtn.addEventListener('click', () => {
    const token = tokenInput.value.trim();
    if (!token) return;

    saveBtn.disabled = true;
    tokenErrorSpan.style.display = 'none';

    fetch('/auth-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    })
      .then(r => r.json().then(d => ({ ok: r.ok, data: d })))
      .then(({ ok, data }) => {
        if (ok && data.ok) {
          applyClaudeStatus(true, data.suffix || '');
          tokenInput.value = '';
          saveBtn.textContent = '저장됨';
          setTimeout(() => {
            saveBtn.textContent = '저장';
            saveBtn.disabled = false;
          }, 1500);
        } else {
          tokenErrorSpan.textContent = (data && data.error) || '저장 실패';
          tokenErrorSpan.style.display = 'inline';
          saveBtn.disabled = false;
        }
      })
      .catch(() => {
        tokenErrorSpan.textContent = '서버 연결 실패';
        tokenErrorSpan.style.display = 'inline';
        saveBtn.disabled = false;
      });
  });

  const tokenCtrl = document.createElement('div');
  tokenCtrl.className = 'settings-token-ctrl';
  tokenCtrl.appendChild(tokenInput);
  tokenCtrl.appendChild(saveBtn);
  tokenCtrl.appendChild(tokenErrorSpan);

  advSection.appendChild(mkRow('토큰 직접 입력', tokenCtrl));

  secAuth.appendChild(advToggle);
  secAuth.appendChild(advSection);

  body.appendChild(secAuth);
  card.appendChild(body);
  overlay.appendChild(card);

  // overlay 클릭(카드 외부)으로 닫기
  overlay.addEventListener('click', (e) => {
    if (!card.contains(e.target)) closeSettings();
  });

  return overlay;
}

function mkSection(label) {
  const sec = document.createElement('div');
  sec.className = 'settings-section';
  const h = document.createElement('div');
  h.className = 'settings-section-label';
  h.textContent = label;
  sec.appendChild(h);
  return sec;
}

function mkRow(label, control) {
  const row = document.createElement('div');
  row.className = 'settings-row';
  const lbl = document.createElement('span');
  lbl.className = 'settings-row-label';
  lbl.textContent = label;
  row.appendChild(lbl);
  row.appendChild(control);
  return row;
}

let _toggleSeq = 0;
function mkToggle(id, checked, onChange) {
  const uid = id + '-' + (++_toggleSeq);
  const wrap = document.createElement('label');
  wrap.className = 'settings-toggle';
  wrap.setAttribute('for', uid);

  const inp = document.createElement('input');
  inp.type = 'checkbox';
  inp.id = uid;
  inp.checked = checked;
  inp.addEventListener('change', () => onChange(inp.checked));

  const track = document.createElement('span');
  track.className = 'settings-toggle-track';
  const thumb = document.createElement('span');
  thumb.className = 'settings-toggle-thumb';
  track.appendChild(thumb);

  wrap.appendChild(inp);
  wrap.appendChild(track);
  return wrap;
}

function mkSlider(id, value, min, max, step, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'settings-slider-wrap';

  const inp = document.createElement('input');
  inp.type = 'range';
  inp.id = id;
  inp.min = String(min);
  inp.max = String(max);
  inp.step = String(step);
  inp.value = String(value);
  inp.className = 'settings-slider';
  inp.addEventListener('input', () => onChange(parseFloat(inp.value)));

  const valDisplay = document.createElement('span');
  valDisplay.className = 'settings-slider-val';
  valDisplay.textContent = Math.round(value * 100) + '%';
  inp.addEventListener('input', () => {
    valDisplay.textContent = Math.round(parseFloat(inp.value) * 100) + '%';
  });

  wrap.appendChild(inp);
  wrap.appendChild(valDisplay);
  return wrap;
}

// ── ESC 핸들러 ─────────────────────────────────────────────────────────
function onKeyDown(e) {
  if (e.key === 'Escape') closeSettings();
}

// ── 공개 API ───────────────────────────────────────────────────────────
export function openSettings() {
  if (_overlay) return; // 이미 열림
  _overlay = buildPanel();
  document.body.appendChild(_overlay);
  // 렌더 후 fade-in 트리거
  requestAnimationFrame(() => _overlay.classList.add('settings-open'));
  document.addEventListener('keydown', onKeyDown);
  _overlay.querySelector('.settings-close')?.focus();
}

export function closeSettings() {
  if (!_overlay) return;
  // 패널 닫히면 Claude 연결 폴링 중단 — detached DOM 갱신 leak 방지 (boin 동형)
  stopClaudePolling();
  _overlay.classList.remove('settings-open');
  _overlay.addEventListener('transitionend', () => {
    _overlay?.remove();
    _overlay = null;
  }, { once: true });
  document.removeEventListener('keydown', onKeyDown);
}
