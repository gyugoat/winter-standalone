// server/session-title.js
// 세션 제목 LLM 자동생성 — 첫 turn 정상 종료 후 한 번만 실행.
//
// 핵심 함정 (#28 V3): server 프로세스 안에서 Anthropic SDK query() 를
// 추가 호출하면 hang 한다. 그래서 제목 요약은 SDK 가 아니라 로컬 ollama HTTP API
// (localhost:11434) 로 처리한다. SDK 와 완전히 무관한 fetch 경로라 hang 위험 없음.
//
// 동작 원칙:
// - fire-and-forget: turn 응답/SSE 흐름을 절대 막지 않는다. 호출부에서 await 하지 마라.
// - graceful fallback: ollama 미응답/타임아웃/에러/빈 응답 시 기존 제목(첫 40자 slice) 유지.
//   절대 throw 로 turn 을 깨뜨리지 않는다. 모든 경로 try/catch.
// - 첫 turn 한정: meta.titleAuto !== false 일 때만 갱신. 갱신 성공 시 titleAuto=false 박아
//   이후 turn / 수동 rename 은 안 건드린다.

import { fileURLToPath } from 'node:url';
import { promises as fs, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as session from './session.js';

const HOME = process.env.WINTER3_HOME || fileURLToPath(new URL('..', import.meta.url));
const EVT_DIR = join(HOME, 'data', 'events');

const OLLAMA_URL = process.env.WINTER3_OLLAMA_URL || 'http://localhost:11434/api/generate';
const OLLAMA_MODEL = process.env.WINTER3_TITLE_MODEL || 'qwen2.5:7b';
// 15s — 콜드로드/235b 큐 대기 시 5s 초과 가능. 사용자 turn 흐름과 분리된 백그라운드라 여유 있음.
const TIMEOUT_MS = 15000;

// jsonl 에서 첫 user prompt + 첫 assistant 텍스트 추출.
// 너무 길면 잘라서 반환 (요약 입력으로 충분한 앞부분만).
async function extractFirstExchange(sessionId) {
  const evtPath = join(EVT_DIR, `${sessionId}.jsonl`);
  if (!existsSync(evtPath)) return null;
  let text;
  try { text = await fs.readFile(evtPath, 'utf8'); }
  catch { return null; }

  let firstUser = null;
  let firstAssistant = null;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    const raw = rec.raw || {};
    if (!firstUser && raw.type === 'winter3.user_prompt' && typeof raw.text === 'string') {
      firstUser = raw.text;
    } else if (!firstAssistant && raw.type === 'assistant' && raw.message?.content) {
      const parts = [];
      for (const c of raw.message.content) {
        if (c?.type === 'text' && typeof c.text === 'string') parts.push(c.text);
      }
      const joined = parts.join(' ').trim();
      if (joined) firstAssistant = joined;
    }
    if (firstUser && firstAssistant) break;
  }
  if (!firstUser) return null;
  return {
    user: firstUser.slice(0, 600),
    assistant: (firstAssistant || '').slice(0, 600),
  };
}

// ollama 로 한 줄 제목 생성. 실패 시 null (throw 안 함).
export async function generateTitle(userText, assistantText) {
  const convo = assistantText
    ? `사용자: ${userText}\nWinter: ${assistantText}`
    : `사용자: ${userText}`;
  // 병합 주: WSL 판(금지 문자를 명시)이 mac 판("한국어와 영어만")보다 구체적이라 채택.
  const prompt = `다음 대화의 핵심 주제를 한국어로 12~18자 제목으로 요약해라. 따옴표·마침표·접두어 없이 제목 텍스트만 한 줄로 출력해라. 한자·중국어·일본어 문자 금지, 반드시 한글과 영문·숫자만 사용해라.\n\n${convo}\n\n제목:`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt,
        stream: false,
        // 소형모델 다국어 토큰 누출 억제: temperature 낮춰 결정적, num_predict 로 길이 제한,
        // top_p 로 low-prob 토큰(희귀 스크립트) 확률 하락.
        options: { temperature: 0.2, num_predict: 40, top_p: 0.9 },
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    let title = (data && typeof data.response === 'string') ? data.response : '';
    title = cleanTitle(title);
    return title || null;
  } catch {
    // 타임아웃(AbortError) / 네트워크 / JSON 파싱 실패 전부 여기로 — 조용히 넘어간다.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 허용 문자 판정용 정규식.
// - 한글 완성형/자모: 가-힣, ᄀ-ᇿ, ㄰-㆏
// - 한자(CJK Unified Ideographs, 30% 상한으로 별도 제어): 一-鿿
// - 라틴/숫자/공백/기본 문장부호
// 이 집합 밖의 문자(아랍어·키릴·태국어·데바나가리·히라가나·가타카나 등)가 1자라도
// 있으면 쓰레기로 판정한다.
const ALLOWED_RE = /^[가-힣ᄀ-ᇿ㄰-㆏一-鿿A-Za-z0-9\s\-_:·,()\[\]&+/?!.'"]+$/;
const CJK_RE = /[一-鿿]/g;

// LLM 응답에서 제목만 추출 — 공백/따옴표/줄바꿈/마침표 trim, 첫 줄만, 길면 cut.
// 쓰레기 판정에 걸리면 빈 문자열 반환 → 호출부는 null 처리 → slice fallback 유지.
// export: 단위 테스트를 위해 노출.
export function cleanTitle(raw) {
  let t = String(raw || '').trim();
  // qwen 계열이 가끔 <think>...</think> 를 앞에 붙임 — 제거.
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  // 첫 비어있지 않은 줄만 사용.
  const firstLine = t.split('\n').map((l) => l.trim()).find((l) => l.length > 0) || '';
  t = firstLine;
  // 흔한 접두어 제거 (제목:, Title: 등) — 여러 번 겹쳐 있을 수 있으니 반복.
  for (let i = 0; i < 3; i += 1) {
    const before = t;
    t = t.replace(/^(제목|title)\s*[:：]\s*/i, '');
    if (t === before) break;
  }
  // 감싼 따옴표 제거.
  t = t.replace(/^["'「『“”]+/, '').replace(/["'」』“”]+$/, '');
  // 끝 마침표류 제거.
  t = t.replace(/[.。·…]+$/, '');
  t = t.trim();
  if (t.length > 40) t = t.slice(0, 40);

  // ─── 쓰레기 판정 ───
  // 병합 주: mac(화이트리스트 리젝) 과 WSL(#39 V4 한자 strip) 이 같은 버그를 각자 고쳤다.
  // 화이트리스트 쪽이 상위집합(아랍어·키릴·태국어·가나까지 차단)이라 그걸 본체로 두고,
  // 한자는 "전량 strip" 대신 30% 비율 상한으로 둔다 — 한국어 제목에 소량 한자는 정상이라
  // 무조건 지우면 멀쩡한 제목이 훼손된다.
  // 1) 정제 후에도 `제목:` / `title:` 잔여 접두어가 어디든 남아있으면 리젝.
  //    (실 사례: `بدلاً من الفحص"title:` — 아랍어 조각 뒤에 title: 잔여)
  if (/(^|\s|["'])(제목|title)\s*[:：]/i.test(t)) return '';
  // 2) 허용 문자 집합 밖 문자가 하나라도 있으면 리젝.
  //    (아랍어·키릴·태국어·히라가나·가타카나 등 다국어 토큰 누출 차단)
  if (t.length > 0 && !ALLOWED_RE.test(t)) return '';
  // 3) 정제 후 길이가 너무 짧으면 리젝 (의미 있는 제목 불가).
  if (t.length < 4) return '';
  // 4) 한자 비율 30% 상한 — 소량 한자 허용, 다수면 중국어 누출로 판정 (WSL #39 V4 대체).
  const cjkCount = (t.match(CJK_RE) || []).length;
  if (cjkCount > 0 && cjkCount / t.length > 0.3) return '';

  return t;
}

// 첫 turn 정상 종료 후 호출 — fire-and-forget. await 금지.
// titleAuto !== false 인 세션만 LLM 제목으로 갱신. 갱신 후 titleAuto=false.
export async function maybeAutoTitle(sessionId) {
  try {
    const meta = await session.load(sessionId);
    if (!meta) return;
    // 이미 수동 rename 됐거나(titleAuto===false) 한 번 자동생성 완료된 세션은 건드리지 않는다.
    if (meta.titleAuto === false) return;

    const exchange = await extractFirstExchange(sessionId);
    if (!exchange) return;

    const title = await generateTitle(exchange.user, exchange.assistant);
    if (!title) return; // ollama 실패 → 기존 40자 slice 제목 유지 (fallback).

    // race 방지: 생성 도중 사용자가 수동 rename 했을 수 있으니 다시 확인.
    const fresh = await session.load(sessionId);
    if (!fresh || fresh.titleAuto === false) return;

    await session.rename(sessionId, title, { auto: true });
  } catch (err) {
    // 절대 throw 하지 않는다 — turn 흐름과 분리된 백그라운드 작업.
    try { process.stderr.write(`[session-title] ${sessionId} 자동제목 실패: ${err.message}\n`); } catch {}
  }
}
