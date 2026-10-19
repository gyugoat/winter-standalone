// web/js/search.js — 세션 검색 (사이드바 debounce, XSS-free)

let _debounceTimer = null;
let _searchActive = false;
let _openSessionFn = null; // app.js setCurrentSession 참조

/**
 * 안전 텍스트 삽입 — textContent 기반.
 * 하이라이트가 필요한 경우 문자열 분할 후 span.mark 요소를 DOM 으로 조립.
 * innerHTML raw 삽입 절대 금지.
 */
function buildHighlightedText(text, query) {
  const frag = document.createDocumentFragment();
  if (!query || query.length < 2) {
    const t = document.createTextNode(text);
    frag.appendChild(t);
    return frag;
  }
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  let cursor = 0;
  while (cursor < text.length) {
    const idx = lower.indexOf(q, cursor);
    if (idx === -1) {
      frag.appendChild(document.createTextNode(text.slice(cursor)));
      break;
    }
    if (idx > cursor) {
      frag.appendChild(document.createTextNode(text.slice(cursor, idx)));
    }
    const mark = document.createElement('span');
    mark.className = 'search-mark';
    mark.textContent = text.slice(idx, idx + q.length);
    frag.appendChild(mark);
    cursor = idx + q.length;
  }
  return frag;
}

function buildResultItem(r, query, openFn) {
  const li = document.createElement('li');
  li.className = 'search-result-item';
  li.dataset.sid = r.sid;

  const titleEl = document.createElement('span');
  titleEl.className = 'search-result-title';
  titleEl.appendChild(buildHighlightedText(r.title || '(제목 없음)', query));

  const dateEl = document.createElement('span');
  dateEl.className = 'search-result-date';
  // ts: ISO 문자열 또는 타임스탬프
  try {
    const d = new Date(r.ts);
    dateEl.textContent = isNaN(d) ? '' : d.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
  } catch {
    dateEl.textContent = '';
  }

  const snippetEl = document.createElement('span');
  snippetEl.className = 'search-result-snippet';
  if (r.snippet) {
    snippetEl.appendChild(buildHighlightedText(r.snippet, query));
  }

  li.appendChild(titleEl);
  li.appendChild(dateEl);
  li.appendChild(snippetEl);

  li.addEventListener('click', () => {
    if (openFn) openFn(r.sid);
    clearSearch();
  });
  return li;
}

function showSearchResults(results, query, ul) {
  ul.innerHTML = '';
  if (results.length === 0) {
    const li = document.createElement('li');
    li.className = 'search-empty';
    li.textContent = '결과 없음';
    ul.appendChild(li);
    return;
  }
  for (const r of results) {
    ul.appendChild(buildResultItem(r, query, _openSessionFn));
  }
}

function showSearchError(ul, isNotReady) {
  ul.innerHTML = '';
  const li = document.createElement('li');
  li.className = 'search-empty search-error';
  li.textContent = isNotReady
    ? '검색 서버 준비 안 됨 (restart 필요)'
    : '검색 실패 — 잠시 후 재시도';
  ul.appendChild(li);
}

async function doSearch(query, ul) {
  let resp;
  try {
    resp = await fetch(`/search?q=${encodeURIComponent(query)}&limit=20`);
  } catch {
    showSearchError(ul, false);
    return;
  }
  if (resp.status === 404) {
    showSearchError(ul, true);
    return;
  }
  if (!resp.ok) {
    showSearchError(ul, false);
    return;
  }
  let data;
  try {
    data = await resp.json();
  } catch {
    showSearchError(ul, false);
    return;
  }
  showSearchResults(Array.isArray(data.results) ? data.results : [], query, ul);
}

function clearSearch() {
  _searchActive = false;
  const input = document.getElementById('search-input');
  if (input) input.value = '';
  restoreSessionList();
}

function restoreSessionList() {
  const ul = document.getElementById('session-list');
  const searchUl = document.getElementById('search-result-list');
  if (ul) ul.style.display = '';
  if (searchUl) {
    searchUl.innerHTML = '';
    searchUl.style.display = 'none';
  }
  _searchActive = false;
}

function activateSearch(ul) {
  const searchUl = document.getElementById('search-result-list');
  if (!searchUl) return;
  if (ul) ul.style.display = 'none';
  searchUl.style.display = '';
  _searchActive = true;
}

export function initSearch(openSessionFn) {
  _openSessionFn = openSessionFn;

  const input = document.getElementById('search-input');
  const ul = document.getElementById('session-list');
  const searchUl = document.getElementById('search-result-list');
  if (!input || !ul || !searchUl) return;

  // 초기 숨김
  searchUl.style.display = 'none';

  input.addEventListener('input', () => {
    const q = input.value.trim();
    if (_debounceTimer) clearTimeout(_debounceTimer);

    if (q.length < 2) {
      restoreSessionList();
      return;
    }

    activateSearch(ul);
    // 검색 중 placeholer 표시
    searchUl.innerHTML = '';
    const loading = document.createElement('li');
    loading.className = 'search-empty';
    loading.textContent = '검색 중…';
    searchUl.appendChild(loading);

    _debounceTimer = setTimeout(() => {
      doSearch(q, searchUl);
    }, 300);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      clearSearch();
      input.blur();
    }
  });
}

/** app.js esc 체인에서 검색 활성 상태 닫기용 */
export function isSearchActive() {
  return _searchActive;
}

export { clearSearch };
