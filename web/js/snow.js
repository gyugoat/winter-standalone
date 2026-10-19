// web/js/snow.js — 배경 눈 효과. winter v2 에서 직접 이식.
// 원본: ../winter/web/js/snow.js
//
// winter3 적응 변경:
// - localStorage key: winter-snow-off → winter3:snow-off (네임스페이스)
// - named export만 (CommonJS 호환 로직 삭제)
// - CSS (#ws-canvas.bg-mode) 는 style.css 의 "snow canvas" 섹션에 통합

let canvas = null;
let ctx = null;
let particles = [];
let animId = null;
let W = 0, H = 0, dpr = 1;

const isMobile = /Mobi|Android/i.test(navigator.userAgent);
const MAX_P = isMobile ? 20 : 45;
const COLOR = { r: 200, g: 220, b: 255 };
const LS_KEY = 'winter3:snow-off';

function spawn() {
  const size = Math.random() * 3 + 1.5;
  return {
    x: Math.random() * W,
    y: Math.random() * H,
    size,
    speedY: Math.random() * 1 + 0.5,
    speedX: Math.random() * 0.4 - 0.2,
    wobbleAmp: Math.random() * 0.5 + 0.2,
    wobbleFreq: Math.random() * 0.02 + 0.01,
    wobblePhase: Math.random() * Math.PI * 2,
    opacity: Math.random() * 0.5 + 0.3,
    t: 0,
  };
}

let lastTime = 0;
function draw(now = 0) {
  if (document.hidden) { animId = null; return; }
  // 매 프레임 렌더 (60fps). 입자 최대 45개라 CPU 부담 낮음.
  // 낙하 속도는 dt 기반이라 프레임레이트와 무관하게 일정.
  const dt = Math.min((now - lastTime) / 16.667, 3);
  lastTime = now;
  ctx.clearRect(0, 0, W, H);
  if (particles.length < MAX_P && Math.random() < 0.3) particles.push(spawn());
  for (let j = particles.length - 1; j >= 0; j--) {
    const p = particles[j];
    p.t += dt;
    p.y += p.speedY * dt;
    p.x += p.speedX * dt + Math.sin(p.wobblePhase + p.t * p.wobbleFreq) * p.wobbleAmp * dt;
    if (p.x < -10) p.x = W + 10;
    if (p.x > W + 10) p.x = -10;
    if (p.y > H + 10) { particles.splice(j, 1); continue; }
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${COLOR.r},${COLOR.g},${COLOR.b},${p.opacity * 0.5})`;
    ctx.fill();
  }
  animId = requestAnimationFrame(draw);
}

function resize() {
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);
}

export function initSnow() {
  if (canvas) return;

  canvas = document.createElement('canvas');
  canvas.id = 'ws-canvas';
  canvas.className = 'bg-mode';
  document.body.insertBefore(canvas, document.body.firstChild);

  ctx = canvas.getContext('2d');
  if (!ctx) return;

  dpr = Math.min(window.devicePixelRatio || 1, 2);
  resize();

  for (let i = 0; i < MAX_P; i++) particles.push(spawn());

  const disabled = localStorage.getItem(LS_KEY) === '1';
  if (!disabled) {
    animId = requestAnimationFrame(draw);
  } else {
    canvas.style.display = 'none';
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !animId && localStorage.getItem(LS_KEY) !== '1') {
      animId = requestAnimationFrame(draw);
    }
  });

  window.addEventListener('resize', resize);
}

export function toggleSnow(forceState) {
  if (!canvas) return false;
  const shouldBeOn = forceState !== undefined ? !!forceState : !animId;
  if (shouldBeOn && !animId) {
    particles = [];
    for (let k = 0; k < MAX_P; k++) particles.push(spawn());
    canvas.style.display = '';
    localStorage.setItem(LS_KEY, '0');
    animId = requestAnimationFrame(draw);
  } else if (!shouldBeOn && animId) {
    cancelAnimationFrame(animId);
    animId = null;
    particles = [];
    canvas.style.display = 'none';
    localStorage.setItem(LS_KEY, '1');
  }
  return !!animId;
}

export function isSnowOn() { return !!animId; }
