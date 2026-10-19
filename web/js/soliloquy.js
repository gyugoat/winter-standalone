// web/js/soliloquy.js — Winter 독백(soliloquy) 마커 파서. DOM 무관 순수 로직.
// render.js(streaming + snapshot) 와 Node 단위 테스트(scripts/qa-soliloquy.mjs)가 같은 모듈을 공유.
//
// 마커 규약은 server/runner.js buildWinterSystemPrompt 의 "## 말투" 섹션과 **정확히 일치**해야 한다.
// 안 맞으면 마커 글자가 화면에 노출되거나 독백이 일반 텍스트로 샌다.
// U+27EA/U+27EB MATHEMATICAL DOUBLE ANGLE BRACKET — markdown 무해 + 본문 우연 등장 ~0.
export const SOLI_OPEN = '⟪독백⟫';
export const SOLI_CLOSE = '⟪/독백⟫';
// LLM(Winter)이 닫기 마커를 규칙(⟪/독백⟫)대로 안 쓰고 단독 ⟫(U+27EB)로 줄여 닫는 실수를 빈번히 한다
// (data/events 세션 로그 측정 — #49). 규약은 그대로 두고 파서가 graceful 흡수.
// ⟫ 는 본문 우연 등장 ~0(주석 6행) 이라 단독 ⟫ 를 닫기로 취급해도 안전. 단 OPEN/CLOSE full 마커의
// 마지막 글자 ⟫ 와 충돌하면 안 되므로 full 마커를 항상 우선 매칭/소비하고, 거기 안 속한 "고립 ⟫" 만 닫기로.
export const SOLI_CLOSE_LONE = '⟫';
// streaming 버퍼가 hold 해야 할 최대 길이 (긴 마커 기준 — 경계에 절반 걸렸을 때 판정 대기).
export const SOLI_MAX_MARKER_LEN = Math.max(SOLI_OPEN.length, SOLI_CLOSE.length);

// ── markdown code span 인식 (code-aware 마스킹) ────────────────────────
// 백틱 인라인 코드(`...`) / 펜스(``` ```)는 그 안의 마커 문자(⟪/독백⟫, ⟫)가 제어 신호가 아니라
// 리터럴(인용)이다. 파서가 이걸 진짜 마커로 소비/strip 하면 백틱 짝이 깨지고 독백 span 이 코드 한가운데서
// 끊긴다 (실제 깨진 세션 data/events/bef87896 — winter 가 자기 파서 설명하는 메타 메시지마다 터짐).
// → code region 을 sentinel 로 마스킹 → 검증된 마커 로직 그대로 실행 → 복원. 회귀 위험 최소.

// markdown code span 구간 [start,end) 배열 반환 (CommonMark 근사 — 백틱 run 매칭).
// 여는 백틱 run 과 같은 길이의 백틱 run 만 닫기로 인정. 인라인(단일/다중 백틱) + 펜스(run3) 모두 커버.
function codeRegions(text) {
  const regions = []; const n = text.length; let i = 0;
  while (i < n) {
    if (text[i] === '`') {
      let j = i; while (j < n && text[j] === '`') j++;      // 여는 run 길이
      const runLen = j - i;
      let k = j, closeStart = -1;
      while (k < n) {
        if (text[k] === '`') {
          let m = k; while (m < n && text[m] === '`') m++;
          if (m - k === runLen) { closeStart = k; break; }   // 정확히 같은 길이만 닫기
          k = m;
        } else k++;
      }
      if (closeStart !== -1) { regions.push([i, closeStart + runLen]); i = closeStart + runLen; continue; }
      i = j; continue;   // 닫는 run 없음 → 리터럴 백틱(코드 아님)
    }
    i++;
  }
  return regions;
}

// sentinel — 본문에 절대 안 나오는 PUA(U+E000~). 마커(⟪⟫)/백틱/markdown 특수문자와 안 겹침.
// 사이 인덱스는 \d+ 뿐이라 wrap/strip 로직이 sentinel 을 마커로 오인하지 않는다.
const SENT_OPEN = '', SENT_CLOSE = '';

// code region 을 sentinel(인덱스) 로 치환 + 원문 stash. masked 텍스트와 복원용 stash 반환.
function maskCode(text) {
  // 입력에 이미 들어있는 raw sentinel(U+E000/U+E001) 은 먼저 제거.
  // 안 그러면 본문(백틱·펜스 밖)에 우연/의도적으로 들어온 sentinel+숫자+sentinel 시퀀스를
  // unmaskCode 정규식이 stash 인덱스로 오인 → code 원문 복제 삽입 또는 stash 범위 초과 시 'undefined' 노출.
  // (winter 가 자기 파서를 설명하며 펜스 밖 inline 으로 sentinel 을 언급하는 메타 메시지에서 정확히 터지는 경로.)
  // PUA 문자라 본문에서 제거해도 의미 손실 ~0.
  if (text.indexOf(SENT_OPEN) !== -1 || text.indexOf(SENT_CLOSE) !== -1) {
    text = text.split(SENT_OPEN).join('').split(SENT_CLOSE).join('');
  }
  const regions = codeRegions(text); const stash = [];
  let out = '', last = 0;
  for (const [s, e] of regions) {
    out += text.slice(last, s) + SENT_OPEN + stash.length + SENT_CLOSE;
    stash.push(text.slice(s, e)); last = e;
  }
  out += text.slice(last);
  return { masked: out, stash };
}

// sentinel 을 stash 원문으로 복원.
function unmaskCode(text, stash) {
  if (!stash.length) return text;
  return text.replace(/(\d+)/g, (_, n) => stash[+n]);
}

// ── 헬퍼: bare bracket strip ──────────────────────────────────────────
// 유효 마커(SOLI_OPEN/SOLI_CLOSE)가 이미 처리·소비된 뒤 남은 맨 ⟪/⟫ 를 제거.
// push() 에서 확정 emit 에만 적용 — holdFrom 이후 pending 엔 절대 적용 금지
// (미래 델타와 합쳐져 진짜 마커가 될 수 있는 꼬리를 깨뜨리지 않기 위해).
export function stripStrayBrackets(s) {
  return typeof s === 'string' ? s.split('⟪').join('').split('⟫').join('') : s;
}

// ── streaming 파서 ────────────────────────────────────────────────────
// 토큰 단위 delta 가 마커를 절반만 담고 올 수 있어 버퍼링 필수.
// createSoliloquyParser() 가 stateful 파서를 반환. 각 버블당 하나 생성.
//   parser.push(deltaText) → [{ type:'text', text, soliloquy:bool }, ...] 확정 세그먼트 배열
//   parser.flush()         → 스트림 종료 시 hold 중이던 잔여를 현재 모드로 마저 방출
// DOM 을 전혀 안 만지므로 Node 에서 그대로 단위 테스트 가능.
export function createSoliloquyParser() {
  let pending = '';
  let inSoli = false;
  let codeRun = 0;   // 0=코드 밖, n=백틱 n개로 열린 code span 안 (그 안의 마커는 리터럴)

  function push(deltaText) {
    pending += deltaText;
    const segs = [];
    // 현재 inSoli 모드로 [0,n) 방출 + pending 앞부분 잘라냄.
    const emitFront = (n) => {
      if (n <= 0) return;
      const t = pending.slice(0, n);
      if (t) segs.push({ type: 'text', text: t, soliloquy: inSoli });
      pending = pending.slice(n);
    };

    while (true) {
      // ── code span 안: 같은 길이 닫는 백틱 run 만 닫기. 그 안 마커는 전부 리터럴(텍스트). ──
      if (codeRun > 0) {
        const closeAt = findBacktickRun(pending, 0, codeRun);   // 정확히 codeRun 길이 run 의 시작 인덱스
        if (closeAt === -1) {
          // 닫힘 없음. trailing 백틱(닫는 run 일 수 있음)은 hold, 나머지 코드 텍스트로 방출.
          const tb = trailingBacktickStart(pending);
          emitFront(tb);
          break;   // hold (다음 delta 대기) — pending 에 trailing 백틱만 남음(또는 비었으면 그대로)
        }
        // 닫는 run 끝까지(백틱 포함) 코드 텍스트로 방출, code span 종료.
        emitFront(closeAt + codeRun);
        codeRun = 0;
        continue;
      }

      // ── code span 밖: 백틱 run 시작 / full 마커 / 고립 ⟫ 중 가장 이른 이벤트 처리. ──
      const bi = pending.indexOf('`');   // 백틱 run 시작 후보
      const oi = pending.indexOf(SOLI_OPEN);
      const ci = pending.indexOf(SOLI_CLOSE);
      let fi = -1, mlen = 0, opening = false;   // full 마커 후보
      if (oi !== -1 && (ci === -1 || oi <= ci)) { fi = oi; mlen = SOLI_OPEN.length; opening = true; }
      else if (ci !== -1) { fi = ci; mlen = SOLI_CLOSE.length; opening = false; }

      // 고립 ⟫(단독 닫기) 후보. full 마커 위치(fi) 이전의 ⟫ 는 full 마커 일부일 수 없어 무조건 고립.
      const li = pending.indexOf(SOLI_CLOSE_LONE);
      const loneIsolated = li !== -1 && (fi === -1 || li < fi);

      // 마커 후보(full 또는 고립 ⟫) 위치/종류 확정.
      let mi = -1;
      if (loneIsolated) { mi = li; mlen = SOLI_CLOSE_LONE.length; opening = false; }
      else if (fi !== -1) { mi = fi; }

      // 백틱이 마커보다 더 이르면(또는 마커 없으면) code span 진입 우선.
      const backtickFirst = bi !== -1 && (mi === -1 || bi < mi);
      if (backtickFirst) {
        const runEnd = backtickRunEnd(pending, bi);   // bi 부터 백틱 run 끝 인덱스(exclusive)
        if (runEnd === pending.length) {
          // run 이 delta 끝에 걸침 — 길이 미확정. 백틱 직전까지만 방출하고 hold.
          emitFront(bi);
          break;
        }
        const runLen = runEnd - bi;
        // 백틱 앞 텍스트 방출, 여는 백틱 run 은 코드 텍스트로 방출(화면에 코드 박스로 남김).
        emitFront(runEnd);
        codeRun = runLen;
        continue;
      }

      if (mi === -1) {
        // 마커 없음(또는 백틱 hold 도 아님). 끝부분이 마커/백틱 prefix 면 hold, 나머지 방출.
        const holdFrom = Math.min(holdStart(pending), trailingBacktickStart(pending));
        // holdFrom 이전은 미래 마커의 시작이 될 수 없으므로 bare bracket strip 안전.
        const emit = stripStrayBrackets(pending.slice(0, holdFrom));
        if (emit) segs.push({ type: 'text', text: emit, soliloquy: inSoli });
        pending = pending.slice(holdFrom);
        break;
      }
      // 마커 앞 텍스트 방출 후 모드 전환, 마커 문자 소비(화면 노출 X).
      // mi 이전은 유효 마커 직전이므로 미래 마커 일부가 될 수 없음 → strip 안전.
      const emit = stripStrayBrackets(pending.slice(0, mi));
      if (emit) segs.push({ type: 'text', text: emit, soliloquy: inSoli });
      // 중첩·고립 방어: 이미 독백 중이면 열기 무시, 독백 아닐 때 닫기 무시.
      if (opening && !inSoli) inSoli = true;
      else if (!opening && inSoli) inSoli = false;
      // else: opening+inSoli(중첩) → 무시(마커만 소비), !opening+!inSoli(고립 닫기) → 무시
      pending = pending.slice(mi + mlen);
    }
    return segs;
  }

  function flush() {
    if (!pending) return [];
    // 스트림 종료 시점 — 더 올 델타가 없으므로 미완 마커 prefix 도 어차피 누출, strip 적용.
    const seg = { type: 'text', text: stripStrayBrackets(pending), soliloquy: inSoli };
    pending = '';
    if (!seg.text) return [];
    return [seg];
  }

  return { push, flush };
}

// pending 끝부분이 OPEN/CLOSE 마커의 prefix 와 일치하면 그 시작 인덱스 반환 (hold 지점).
// 일치 없으면 buf.length (= hold 안 함). 가장 긴 매칭 suffix 우선.
function holdStart(buf) {
  const maxCheck = Math.min(buf.length, SOLI_MAX_MARKER_LEN - 1);
  for (let k = maxCheck; k >= 1; k--) {
    const suffix = buf.slice(buf.length - k);
    if (SOLI_OPEN.startsWith(suffix) || SOLI_CLOSE.startsWith(suffix)) return buf.length - k;
  }
  return buf.length;
}

// ── streaming code span 추적 헬퍼 ─────────────────────────────────────
// pos 부터 시작하는 백틱 run 의 끝 인덱스(exclusive). buf[pos] 는 '`' 라고 가정.
function backtickRunEnd(buf, pos) {
  let j = pos; while (j < buf.length && buf[j] === '`') j++;
  return j;
}

// from 이후에서 정확히 wantLen 길이의 백틱 run 시작 인덱스 반환 (code span 닫기 탐색). 없으면 -1.
function findBacktickRun(buf, from, wantLen) {
  let k = from;
  while (k < buf.length) {
    if (buf[k] === '`') {
      const end = backtickRunEnd(buf, k);
      if (end - k === wantLen) return k;
      k = end;   // 다른 길이 run 은 건너뜀
    } else k++;
  }
  return -1;
}

// 버퍼 끝의 연속 백틱 run 시작 인덱스 (delta 경계에서 run 길이/닫힘 미확정 → hold 대상).
// 끝이 백틱 아니면 buf.length (= hold 안 함).
function trailingBacktickStart(buf) {
  let k = buf.length; while (k > 0 && buf[k - 1] === '`') k--;
  return k;
}

// ── snapshot(full text) 치환 ──────────────────────────────────────────
// full text 안의 독백 구간을 <span class="soliloquy">…</span> 로 치환.
// markdown 파서(marked) 통과 전에 호출 — span 은 inline HTML 로 살아남고 DOMPurify 가 span+class 허용.
// 미완결(닫기 없는) 독백은 문서 끝까지 독백으로 처리. 고립된 닫기 마커는 제거.
// 닫기는 full(⟪/독백⟫) 우선, 그게 없으면 LLM 이 줄여 쓴 고립 ⟫ 도 닫기로 인식 (#49).
//
// 다문단 처리: 독백 본문 내 \n\n(blank line) 은 marked(gfm:true, breaks:true) 가 문단 경계로
// 인식하여 inline <span> 을 첫 문단에서 끊어버린다. 이를 방지하기 위해 cleanBody 를 \n\n 기준으로
// 쪼개어 각 문단을 개별 <span class="soliloquy"> 로 감싼 뒤 \n\n 으로 재결합한다.
function wrapBodyAsSpans(body) {
  const paras = body.split('\n\n');
  return paras.map(p => `<span class="soliloquy">${p}</span>`).join('\n\n');
}

export function wrapSoliloquyForMarkdown(text) {
  if (typeof text !== 'string') return text;
  // code span 안의 마커는 리터럴 — sentinel 로 가린 뒤 마커 로직 실행, 끝에서 복원.
  const { masked, stash } = maskCode(text);
  if (masked.indexOf('⟪') === -1) {
    // 독백 열기 없음 → span 생성 불가. 고립 ⟫ 만 혹시 있으면 raw 노출 막게 제거.
    const cleaned = masked.indexOf('⟫') === -1 ? masked : masked.split(SOLI_CLOSE_LONE).join('');
    return unmaskCode(cleaned, stash);
  }
  let out = '';
  let i = 0;
  while (i < masked.length) {
    const open = masked.indexOf(SOLI_OPEN, i);
    if (open === -1) { out += masked.slice(i); break; }
    out += masked.slice(i, open);                       // 마커 앞 발화 구간
    const bodyStart = open + SOLI_OPEN.length;
    // full 닫기(⟪/독백⟫) 와 고립 ⟫ 중 더 이른 것을 닫기로. bodyStart 이후 영역에서 둘 다 탐색.
    const closeFull = masked.indexOf(SOLI_CLOSE, bodyStart);
    // 고립 ⟫ 탐색 — full 마커(SOLI_OPEN/SOLI_CLOSE)의 마지막 글자 ⟫ 는 고립 아님 → 건너뜀.
    let closeLone = -1;
    {
      let loneSearch = bodyStart;
      while (true) {
        const li = masked.indexOf(SOLI_CLOSE_LONE, loneSearch);
        if (li === -1) break;
        // SOLI_CLOSE 의 마지막 글자 ⟫ 인지 확인 (full 우선).
        const isCloseTail = closeFull !== -1 && li === closeFull + SOLI_CLOSE.length - 1;
        // SOLI_OPEN 의 마지막 글자 ⟫ 인지 확인 (독백 본문 안 인용된 OPEN 마커의 ⟫).
        const isOpenTail = li >= SOLI_OPEN.length - 1 &&
          masked.slice(li - SOLI_OPEN.length + 1, li + 1) === SOLI_OPEN;
        if (!isCloseTail && !isOpenTail) { closeLone = li; break; }
        loneSearch = li + 1;
      }
    }
    let close = -1, closeLen = 0;
    if (closeLone !== -1 && (closeFull === -1 || closeLone < closeFull)) { close = closeLone; closeLen = SOLI_CLOSE_LONE.length; }
    else if (closeFull !== -1) { close = closeFull; closeLen = SOLI_CLOSE.length; }
    // 독백 본문 내 인용된 SOLI_OPEN 글자 제거 (중첩 인용 → 마커 노출 방지).
    if (close === -1) {                               // 닫기 없음 → 끝까지 독백
      const rawBody = masked.slice(bodyStart);
      const cleanBody = rawBody.split(SOLI_OPEN).join('');
      out += wrapBodyAsSpans(cleanBody);
      i = masked.length;
      break;
    }
    const rawBody = masked.slice(bodyStart, close);
    const cleanBody = rawBody.split(SOLI_OPEN).join('');
    out += wrapBodyAsSpans(cleanBody);
    i = close + closeLen;
  }
  // 혹시 남은 고립 닫기 마커 (열기 없이 닫기만 온 비정상 케이스) 제거. full → 고립 ⟫ 순.
  // 이후 글로벌 bare bracket strip: 유효 마커는 이미 span 변환·소비됐고, 남은 ⟪/⟫ 는
  // 전부 누출 쓰레기(bare 마커 또는 본문 내 고립 ⟫). span 태그는 <> 라 영향 없음.
  out = stripStrayBrackets(out.split(SOLI_CLOSE).join(''));
  return unmaskCode(out, stash);   // sentinel → code 원문 복원 (백틱·마커 리터럴 보존)
}

// fallback(markdown 라이브러리 미로드) 시 마커 문자만 제거해 노출 방지.
// full 마커 먼저 제거(⟫ 포함) 후 잔여 고립 ⟫ 도 제거.
// bare ⟪/⟫ 도 함께 제거 (stripStrayBrackets 가 SOLI_OPEN/CLOSE strip 후 잔여도 처리).
export function stripSoliloquyMarkers(text) {
  if (typeof text !== 'string') return text;
  // code span 안 마커는 리터럴 — 마스킹해 보존하고 진짜 마커만 제거 후 복원.
  const { masked, stash } = maskCode(text);
  const stripped = stripStrayBrackets(masked.split(SOLI_OPEN).join('').split(SOLI_CLOSE).join(''));
  return unmaskCode(stripped, stash);
}
