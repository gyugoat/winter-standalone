// web/js/keymap.js — 전역 단축키 매니저. winter v2 에서 직접 이식.
// 원본: ../winter/web/js/keymap.js
//
// IME-safe: 한국어 조합 중엔 모든 핸들러 bail.
// 모든 단축키는 ⌘ (mac) / Ctrl (win/linux) modifier 를 요구.
//
//   registerShortcut('cmd+k', handler, { description })
//   registerShortcut(['cmd+1','cmd+2'], handler)

const handlers = [];
let listenerInstalled = false;

function isMac() {
  return /Mac|iP(hone|od|ad)/.test(navigator.platform);
}

function eventToCombo(e) {
  const parts = [];
  const cmdHeld = isMac() ? e.metaKey : e.ctrlKey;
  if (cmdHeld) parts.push('cmd');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  let key = e.key;
  if (key === ' ') key = 'space';
  else if (key === 'Enter') key = 'enter';
  else if (key === 'Escape') key = 'esc';
  else if (key === 'Backspace') key = 'backspace';
  else if (key === 'Delete') key = 'delete';
  else if (key === 'Tab') key = 'tab';
  else if (key === 'ArrowUp') key = 'up';
  else if (key === 'ArrowDown') key = 'down';
  else if (key === 'ArrowLeft') key = 'left';
  else if (key === 'ArrowRight') key = 'right';
  else if (key.length === 1) key = key.toLowerCase();
  if (e.shiftKey && /^Key[A-Z]$/.test(e.code || '')) key = e.code.slice(3).toLowerCase();
  if (e.shiftKey && /^Digit\d$/.test(e.code || '')) key = e.code.slice(5);
  parts.push(key);
  return parts.join('+');
}

export function registerShortcut(combo, fn, opts = {}) {
  const combos = Array.isArray(combo) ? combo : [combo];
  for (const c of combos) {
    handlers.push({ matcher: c, fn, opts: { allowInInput: true, preventDefault: true, ...opts } });
  }
  installListener();
}

function installListener() {
  if (listenerInstalled) return;
  listenerInstalled = true;
  window.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    const combo = eventToCombo(e);
    for (const h of handlers) {
      if (h.matcher !== combo) continue;
      const target = e.target;
      const inInput = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (!h.opts.allowInInput && inInput) continue;
      try { h.fn(e); }
      catch (err) { console.warn('[keymap] handler 실패:', h.matcher, err.message); }
      if (h.opts.preventDefault) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
  }, true);
}

export function listShortcuts() {
  return handlers.map(h => ({
    combo: h.matcher,
    description: h.opts.description || '',
  }));
}

export function prettyCombo(combo) {
  const mac = isMac();
  return combo.split('+').map(p => {
    if (p === 'cmd') return mac ? '⌘' : 'Ctrl';
    if (p === 'shift') return mac ? '⇧' : 'Shift';
    if (p === 'alt') return mac ? '⌥' : 'Alt';
    if (p === 'enter') return '↵';
    if (p === 'esc') return 'Esc';
    if (p === 'up') return '↑';
    if (p === 'down') return '↓';
    if (p === 'left') return '←';
    if (p === 'right') return '→';
    if (p === 'space') return '␣';
    if (p.length === 1) return p.toUpperCase();
    return p;
  }).join(mac ? '' : '+');
}
