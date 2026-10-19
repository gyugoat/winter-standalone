// web/js/chime.js — turn 종료 알림음 (음성 파일 재생).
//
// #25 (V1) — Web Audio 오실레이터 합성 (frostStrike/frostBell/frostShimmer) 으로 "띵띵".
// 2026-06-23 (V2) — 미리 녹음한 음성 파일(/sounds/done.wav) 재생으로 교체.
//   - 음원: tts-alerts/final/done_확인해줘_JP.wav → web/sounds/done.wav.
//   - export 시그니처 전부 유지 (playChime / isChimeEnabled / getChimeVolume / setChimeEnabled
//     / primeChimeAudio / _chimeState) — 외부 호출부 깨지면 안 됨.
//
// 호출 시점 (#25): turn 자체 끝날 때 한 번만. catchup (history replay) 중엔 mute.
// #25/#24 — 알림음은 단일 출처. 2026-06-23 fix 로 메인 멀티SSE(app.js) 단일 트리거.

const VOLUME_KEY = 'winter3:chime-volume';
const ENABLED_KEY = 'winter3:chime-enabled';
const SOUND_SRC = '/sounds/done.wav';

// 단일 Audio 인스턴스 재사용 — 연속 재생 시 currentTime=0 후 play. 매번 new Audio 하면
// GC 부담 + autoplay prime 무의미.
let _audio = null;
let _primed = false;

function getAudio() {
  if (_audio) return _audio;
  try {
    _audio = new Audio(SOUND_SRC);
    _audio.preload = 'auto';
    return _audio;
  } catch {
    return null;
  }
}

export function isChimeEnabled() {
  return localStorage.getItem(ENABLED_KEY) !== '0';
}

export function getChimeVolume() {
  const v = parseFloat(localStorage.getItem(VOLUME_KEY) || '0.5');
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5;
}

export function setChimeEnabled(on) {
  localStorage.setItem(ENABLED_KEY, on ? '1' : '0');
}

/**
 * playChime — turn 종료 알림음. catchup 중이거나 disabled 면 skip.
 * @param {object} opts - { force?: boolean } — force 면 enabled/volume 0 가드만 통과시키되
 *   수동 테스트용. (catchup gate 는 호출부 책임 — 여기선 enabled/volume 만 본다.)
 */
export function playChime(opts = {}) {
  if (!isChimeEnabled()) return;
  const volume = getChimeVolume();
  if (volume <= 0) return;
  const audio = getAudio();
  if (!audio) return;
  try {
    audio.volume = Math.max(0, Math.min(1, volume));
    // 연속 재생 안정 — 이전 재생이 진행 중이어도 처음부터 다시.
    audio.currentTime = 0;
    const p = audio.play();
    if (p && typeof p.catch === 'function') {
      p.catch((err) => {
        // autoplay policy / user gesture 부재 시 reject. silent fail — 다음 user gesture 에 prime.
        console.warn('[chime] play 실패 (autoplay policy?):', err && err.message);
      });
    }
  } catch (err) {
    console.warn('[chime] 재생 실패:', err && err.message);
  }
}

// 첫 user gesture 에 Audio prime — autoplay policy 우회.
// 무음(volume=0) 으로 한 번 play→pause 하면 이후 코드 트리거 play 가 gesture 없이도 허용됨.
export function primeChimeAudio() {
  if (_primed) return;
  const audio = getAudio();
  if (!audio) return;
  try {
    const prevVol = audio.volume;
    audio.volume = 0;
    audio.currentTime = 0;
    const p = audio.play();
    const finish = () => {
      try { audio.pause(); audio.currentTime = 0; } catch {}
      audio.volume = prevVol;
      _primed = true;
    };
    if (p && typeof p.then === 'function') {
      p.then(finish).catch(() => { audio.volume = prevVol; /* gesture 다시 필요 */ });
    } else {
      finish();
    }
  } catch {
    /* prime 실패 — 다음 gesture 에 재시도 */
  }
}

// QA hook — production 무관.
export function _chimeState() {
  return {
    enabled: isChimeEnabled(),
    volume: getChimeVolume(),
    hasAudio: !!_audio,
    primed: _primed,
    src: SOUND_SRC,
  };
}
