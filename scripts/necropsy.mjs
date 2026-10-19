#!/usr/bin/env node
// scripts/necropsy.mjs — 죽은 세션 안전 부검 도구.
//
// ═══════════════════════════════════════════════════════════════════════════
// 철칙 (#59 부검 감염 방지)
// ═══════════════════════════════════════════════════════════════════════════
// data/events/*.jsonl 에는 모델 raw output / thinking delta / tool_result 내용이
// 통째로 저장된다 (P1 raw=truth 설계). 이 내용이 이 스크립트 stdout 을 통해
// 라이브 세션 컨텍스트로 유입되면 Anthropic AUP classifier
// ("duplicating model outputs") 가 그 세션도 죽인다. 실제 사례:
// mac 19a24f09 + sub-agent 2 = 3세션 연쇄 사망.
//
// **본 스크립트는 어떤 모드에서도 아래 내용을 print 하지 않는다**:
//   - assistant 의 text delta / message content
//   - assistant 의 thinking delta / redacted_thinking
//   - user 의 tool_result content (bytes/존재 여부만)
//   - user_prompt 원문 (120자 컷 + …)
//
// print 되는 것은 오로지 **구조 메타** — id, ts, type, is_error 플래그,
// stop_reason, stop_details.category, turn_end reason, 각 필드의 존재 여부와
// 바이트 수.  이걸 위반하면 이 도구를 돌린 세션도 감염될 수 있다.
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync, statSync, existsSync } from 'node:fs';
import { resolve as pathResolve, join as pathJoin, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WINTER3_ROOT = pathResolve(__dirname, '..');
const EVENTS_DIR = pathJoin(WINTER3_ROOT, 'data', 'events');

const USER_PROMPT_MAX = 120;   // user_prompt 축약 상한
const MAX_LINE_LEN = 400;      // 어떤 출력 라인도 이 길이 넘으면 잘라라 (안전 장치)

// ─── args ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { mode: 'timeline', session: null, file: null };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--stats') args.mode = 'stats';
    else if (a === '--timeline') args.mode = 'timeline';
    else if (a === '--session') args.session = argv[++i];
    else if (a === '--file') args.file = argv[++i];
    else if (a === '-h' || a === '--help') args.help = true;
    else if (a.startsWith('--session=')) args.session = a.slice('--session='.length);
    else if (a.startsWith('--file=')) args.file = a.slice('--file='.length);
  }
  return args;
}

function usage() {
  process.stdout.write([
    'usage: necropsy.mjs [--timeline|--stats] --session <id> | --file <path>',
    '',
    '  --timeline   (default) 각 이벤트 id/ts/type + user_prompt 120자컷 + stop_reason/category',
    '  --stats      type 카운트 + stop_reason 분포 + refusal 요약',
    '',
    '  --session <id>  data/events/<id>.jsonl 을 읽음',
    '  --file    <p>   임의 jsonl 경로',
    '',
    '철칙: assistant text / thinking / tool_result content 는 print 하지 않음 (#59).',
    '',
  ].join('\n'));
}

// ─── safe stringify — 어떤 라인도 MAX_LINE_LEN 넘지 않게 클램프 ──────────────
function clampLine(s) {
  if (typeof s !== 'string') s = String(s);
  if (s.length > MAX_LINE_LEN) return s.slice(0, MAX_LINE_LEN) + '…[TRUNCATED]';
  return s;
}
function outln(s) { process.stdout.write(clampLine(s) + '\n'); }

function abbreviatePrompt(s) {
  if (typeof s !== 'string') return '';
  // 개행/제어문자 스트립 + 앞 USER_PROMPT_MAX 자만.
  const oneLine = s.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (oneLine.length <= USER_PROMPT_MAX) return oneLine;
  return oneLine.slice(0, USER_PROMPT_MAX) + '…';
}

// ─── event parsing (구조만 추출, content 는 만지지도 마) ─────────────────────
function parseLine(line) {
  try { return JSON.parse(line); } catch { return null; }
}

// 이벤트 구조 요약 (safe fields only)
function summarizeEvent(evt, lineNo) {
  if (!evt || typeof evt !== 'object') {
    return { lineNo, type: 'invalid', id: null, ts: null };
  }
  // events jsonl 은 {id, ts, raw: <SDK msg>} 봉투 형태 (runner.js log.append 설계).
  // raw 를 unwrap 해서 기존 로직이 SDK msg 필드를 직접 볼 수 있게 한다.
  // id/ts 는 봉투 값 우선 (SDK msg 의 id/ts 보다 runner 가 찍은 값이 신뢰도 높음).
  if (evt && typeof evt.raw === 'object' && evt.raw !== null) {
    evt = { ...evt.raw, id: evt.id ?? evt.raw.id, ts: evt.ts ?? evt.raw.ts };
  }
  const type = evt.type || evt.event || evt.kind || 'unknown';
  const id = evt.id || evt.uuid || evt.request_id || null;
  const ts = evt.ts || evt.timestamp || evt.created_at || null;

  const out = { lineNo, type, id, ts };

  // user_prompt 는 축약해서만 (원문 금지)
  if (type === 'user_prompt' || type === 'winter3.user_prompt' || type === 'user' || type === 'user_message') {
    // user prompt 는 사용자 자신이 입력한 문자열이라 model output 이 아님 —
    // classifier 트리거 요인 낮음. 그래도 120자 컷.
    const raw = evt.prompt ?? evt.text ?? evt.content ?? evt.message ?? '';
    const rawStr = typeof raw === 'string' ? raw : JSON.stringify(raw);
    out.userPromptSnip = abbreviatePrompt(rawStr);
    out.userPromptLen = typeof rawStr === 'string' ? rawStr.length : 0;
  }

  // result / message_stop 구조 — stop_reason / stop_details 만 뽑아라.
  // ★ content / message.content / text / thinking 절대 만지지 마 ★
  const stopReason = evt.stop_reason
    || evt.result?.stop_reason
    || evt.message?.stop_reason
    || null;
  const stopCategory = evt.stop_details?.category
    || evt.result?.stop_details?.category
    || evt.message?.stop_details?.category
    || null;
  const isError = Boolean(
    evt.is_error
    || evt.result?.is_error
    || evt.error
    || evt.message?.error
  );
  if (stopReason || stopCategory || isError) {
    out.stopReason = stopReason;
    out.stopCategory = stopCategory;
    out.isError = isError;
  }

  // turn_end 계열 이벤트
  if (type === 'turn_end' || type === 'winter3.turn_end' || type === 'end_turn' || type === 'turn_complete') {
    out.turnEndReason = evt.reason || evt.end_reason || stopReason || null;
  }

  // tool_result — content 크기만
  if (type === 'tool_result' || type === 'user' && evt.tool_use_id) {
    // 존재만 표기, 내용 만지지 마 (아예 length 만).
    const content = evt.content ?? evt.result ?? evt.output;
    if (content !== undefined) {
      const bytes = (() => {
        try {
          if (typeof content === 'string') return content.length;
          return JSON.stringify(content).length;
        } catch { return -1; }
      })();
      out.toolResultBytes = bytes;
      out.toolUseId = evt.tool_use_id || evt.tool_call_id || null;
    }
  }

  // assistant / message delta — content 는 절대 만지지 마.  bytes 만.
  if (type === 'assistant' || type === 'message' || type === 'content_block_delta' || type === 'message_start' || type === 'message_delta' || type === 'content_block_start' || type === 'content_block_stop') {
    // 크기만 (참고용). content 원문 접근 금지.
    let bytes = 0;
    try {
      // 라인 자체 길이로 근사 — content 를 stringify 하면 이 스크립트가 그 내용을
      // 메모리에 담아 결과 print 로 오염될 위험. 라인 크기만 신뢰한다.
      bytes = -1; // 안 잰다. 필요하면 stats 모드에서 라인 길이로 근사.
    } catch { /* noop */ }
    out.assistantBytes = bytes;
  }

  return out;
}

// ─── modes ───────────────────────────────────────────────────────────────────
function renderTimeline(events, header) {
  outln(header);
  outln('─'.repeat(80));
  let refusalReported = false;
  for (const e of events) {
    const bits = [];
    bits.push(`L${String(e.lineNo).padStart(5, '0')}`);
    if (e.ts) bits.push(String(e.ts).slice(0, 24));
    bits.push(`[${e.type}]`);
    if (e.id) bits.push(`id=${String(e.id).slice(0, 16)}`);
    if (e.userPromptSnip !== undefined) {
      bits.push(`prompt(${e.userPromptLen}B)="${e.userPromptSnip}"`);
    }
    if (e.stopReason || e.stopCategory) {
      bits.push(`stop=${e.stopReason || '?'}`);
      if (e.stopCategory) bits.push(`cat=${e.stopCategory}`);
    }
    if (e.isError) bits.push('IS_ERROR');
    if (e.turnEndReason) bits.push(`turn_end=${e.turnEndReason}`);
    if (e.toolResultBytes !== undefined) {
      bits.push(`tool_result(${e.toolResultBytes}B)`);
    }
    outln(bits.join(' '));

    // refusal 조기 요약
    if (!refusalReported && e.stopCategory && /refusal|reasoning_extraction|duplicating/i.test(e.stopCategory)) {
      outln(`  ⚠ REFUSAL DETECTED — category=${e.stopCategory} line=${e.lineNo} id=${e.id || '?'} ts=${e.ts || '?'}`);
      refusalReported = true;
    }
  }
  outln('─'.repeat(80));
}

function renderStats(events, header) {
  outln(header);
  outln('─'.repeat(80));
  const typeCounts = new Map();
  const stopCounts = new Map();
  const catCounts = new Map();
  let errorCount = 0;
  let firstRefusal = null;
  for (const e of events) {
    typeCounts.set(e.type, (typeCounts.get(e.type) || 0) + 1);
    if (e.stopReason) stopCounts.set(e.stopReason, (stopCounts.get(e.stopReason) || 0) + 1);
    if (e.stopCategory) {
      catCounts.set(e.stopCategory, (catCounts.get(e.stopCategory) || 0) + 1);
      if (!firstRefusal && /refusal|reasoning_extraction|duplicating/i.test(e.stopCategory)) {
        firstRefusal = { lineNo: e.lineNo, id: e.id, ts: e.ts, category: e.stopCategory };
      }
    }
    if (e.isError) errorCount += 1;
  }

  outln(`총 이벤트: ${events.length}`);
  outln(`is_error 개수: ${errorCount}`);
  outln('');
  outln('type 분포:');
  for (const [t, c] of [...typeCounts.entries()].sort((a, b) => b[1] - a[1])) {
    outln(`  ${String(c).padStart(6)}  ${t}`);
  }
  outln('');
  outln('stop_reason 분포:');
  if (stopCounts.size === 0) outln('  (없음)');
  for (const [s, c] of [...stopCounts.entries()].sort((a, b) => b[1] - a[1])) {
    outln(`  ${String(c).padStart(6)}  ${s}`);
  }
  outln('');
  outln('stop_details.category 분포:');
  if (catCounts.size === 0) outln('  (없음)');
  for (const [k, c] of [...catCounts.entries()].sort((a, b) => b[1] - a[1])) {
    outln(`  ${String(c).padStart(6)}  ${k}`);
  }
  outln('');
  if (firstRefusal) {
    outln(`⚠ REFUSAL 최초 발생: line=${firstRefusal.lineNo} id=${firstRefusal.id || '?'} ts=${firstRefusal.ts || '?'} category=${firstRefusal.category}`);
  } else {
    outln('refusal: 감지 안 됨.');
  }
  outln('─'.repeat(80));
}

// ─── main ────────────────────────────────────────────────────────────────────
function main() {
  const args = parseArgs(process.argv);
  if (args.help) { usage(); process.exit(0); }

  let path = null;
  if (args.file) path = pathResolve(args.file);
  else if (args.session) path = pathJoin(EVENTS_DIR, `${args.session}.jsonl`);
  else { usage(); process.exit(2); }

  if (!existsSync(path)) {
    outln(`ERR: 파일 없음: ${path}`);
    process.exit(3);
  }
  const st = statSync(path);
  const raw = readFileSync(path, 'utf8');
  const lines = raw.split(/\r?\n/);
  const events = [];
  for (let i = 0; i < lines.length; i += 1) {
    const ln = lines[i];
    if (!ln || !ln.trim()) continue;
    const evt = parseLine(ln);
    events.push(summarizeEvent(evt, i + 1));
  }

  const header = `necropsy: ${path} (${st.size}B, ${events.length} events, mode=${args.mode})`;
  if (args.mode === 'stats') renderStats(events, header);
  else renderTimeline(events, header);
}

main();
