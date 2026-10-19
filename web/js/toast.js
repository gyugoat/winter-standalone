// web/js/toast.js — 전역 토스트 알림. winter v2 에서 이식 + winter3 디자인 토큰 사용.
// 원본: ../winter/web/js/toast.js
//
// 사용:
//   import { showToast } from './toast.js';
//   showToast('메시지');                   // 기본 (3초, 중립 스타일)
//   showToast('에러', 'error');            // 에러 스타일 (빨강)
//   showToast('경고', 'warn');             // 경고 스타일 (주황)
//   showToast('성공', 'success', 2000);   // 성공 스타일 + 2초

const MAX_CONCURRENT = 3;

export function showToast(message, type = '', duration = 3000) {
  if (typeof document === 'undefined' || !document.body) return;
  const existing = document.querySelectorAll('.toast');
  if (existing.length >= MAX_CONCURRENT) existing[0].remove();

  const toast = document.createElement('div');
  toast.className = 'toast' + (type ? ` toast-${type}` : '');
  toast.textContent = message;
  document.body.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add('visible'));
  setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}
