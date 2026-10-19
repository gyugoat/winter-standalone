// server/event-log.js
// Append-only jsonl per session. One line = one raw SDK message.
// ID = monotonic integer starting at 0 per session. Source of truth.
//
// Concurrency contract:
//   - id allocation is synchronous (no await between read-and-increment) so
//     two overlapping append() calls never get the same id.
//   - file writes are serialized per session via a tail Promise chain to
//     preserve byte-order on disk matching id order.

import { fileURLToPath } from 'node:url';
import { promises as fs, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { open as fsOpen } from 'node:fs/promises';

const HOME = process.env.WINTER3_HOME || fileURLToPath(new URL('..', import.meta.url));
const EVENTS_DIR = join(HOME, 'data', 'events');
const BLOBS_BASE = join(EVENTS_DIR, 'blobs');
if (!existsSync(EVENTS_DIR)) mkdirSync(EVENTS_DIR, { recursive: true });

const nextIdBySession = new Map();     // sid → next integer id (sync)
const initPromises = new Map();        // sid → promise while first-loading id
const writeQueueBySession = new Map(); // sid → tail promise (serialize writes)
const emitterBySession = new Map();    // sid → EventEmitter for SSE live tail

function pathFor(sid) {
  return join(EVENTS_DIR, `${sid}.jsonl`);
}

// =============================================================================
// 턴 오프셋 사이드카 인덱스 — data/events/<sid>.turns.idx
// 형식: 한 줄당 "<turnIdx> <byteOffset>\n"
// byteOffset = 해당 winter3.user_prompt 레코드 라인이 시작하는 jsonl 파일 내 바이트 오프셋.
// idx 는 재생성 가능한 캐시 — 쓰기 실패/내용 이상 시 warn 하고 full-scan 으로 재생성.
// =============================================================================

function idxPathFor(sid) {
  return join(EVENTS_DIR, `${sid}.turns.idx`);
}

// idx 파일 텍스트 파싱. [{turnIdx, byteOffset}] 반환. 파싱 실패 줄은 무시.
function parseIdx(text) {
  const result = [];
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sp = trimmed.indexOf(' ');
    if (sp < 0) continue;
    const ti = Number(trimmed.slice(0, sp));
    const bo = Number(trimmed.slice(sp + 1));
    if (!Number.isFinite(ti) || !Number.isFinite(bo) || ti < 0 || bo < 0) continue;
    result.push({ turnIdx: ti, byteOffset: bo });
  }
  return result;
}

// idx 유효성 검증: 모든 오프셋이 파일 크기 내 + 마지막 오프셋 위치 라인이 user_prompt 인지.
// 유효 → true, 무효 → false (폐기 후 재생성 필요).
async function validateIdx(idxEntries, jsonlPath) {
  if (idxEntries.length === 0) return true; // 턴 없는 세션은 유효
  let stat;
  try { stat = await fs.stat(jsonlPath); } catch { return false; }
  const fileSize = stat.size;
  for (const entry of idxEntries) {
    if (entry.byteOffset >= fileSize) return false;
  }
  const lastEntry = idxEntries[idxEntries.length - 1];
  const offset = lastEntry.byteOffset;
  let fh;
  try {
    fh = await fsOpen(jsonlPath, 'r');
    const readLen = Math.min(4096, fileSize - offset);
    const buf = Buffer.allocUnsafe(readLen);
    const { bytesRead } = await fh.read(buf, 0, readLen, offset);
    await fh.close();
    fh = null;
    const chunk = buf.slice(0, bytesRead);
    const nlIdx = chunk.indexOf(0x0a);
    const lineStr = nlIdx >= 0 ? chunk.slice(0, nlIdx).toString('utf8') : chunk.toString('utf8');
    let parsed;
    try { parsed = JSON.parse(lineStr); } catch { return false; }
    return parsed?.raw?.type === 'winter3.user_prompt';
  } catch {
    if (fh) { try { await fh.close(); } catch { /* */ } }
    return false;
  }
}

// idx 파일 전체 생성 (full scan). writeQueue chain 밖에서 호출 금지 — BUG 1 fix 참고.
// scan 만 수행하고 엔트리 배열을 반환. 파일 쓰기는 하지 않는다.
// @returns {Array<{turnIdx:number, byteOffset:number}>}
async function scanIdxFromFile(sid) {
  const jsonlPath = pathFor(sid);
  let buf;
  try { buf = await fs.readFile(jsonlPath); } catch { return []; }

  const entries = [];
  let pos = 0;
  let turnIdx = 0;
  while (pos < buf.length) {
    const nlPos = buf.indexOf(0x0a, pos);
    const end = nlPos >= 0 ? nlPos : buf.length;
    const lineStr = buf.slice(pos, end).toString('utf8');
    if (lineStr.trim().length > 0) {
      try {
        const o = JSON.parse(lineStr);
        if (o?.raw?.type === 'winter3.user_prompt') {
          entries.push({ turnIdx, byteOffset: pos });
          turnIdx++;
        }
      } catch { /* skip */ }
    }
    pos = nlPos >= 0 ? nlPos + 1 : buf.length;
  }
  return entries;
}

// BUG 1 FIX: 백필(scan+write)을 해당 세션의 writeQueueBySession chain 안에서 직렬화.
// append() 의 appendIdxIfNeeded 와 상호 배제 → 레이스 원천 차단.
// scan 이 수백 ms 걸려도 append 는 chain 뒤에서 대기하면 되므로 정합성 100%.
//
// @returns {Promise<Array<{turnIdx:number, byteOffset:number}>>}
function buildIdxFromFullScan(sid) {
  const idxPath = idxPathFor(sid);
  const prev = writeQueueBySession.get(sid) || Promise.resolve();
  let resolveEntries, rejectEntries;
  const entriesPromise = new Promise((res, rej) => {
    resolveEntries = res;
    rejectEntries = rej;
  });

  const writeOp = prev
    .catch(() => {})
    .then(async () => {
      try {
        const entries = await scanIdxFromFile(sid);
        try {
          const idxContent = entries.map((e) => `${e.turnIdx} ${e.byteOffset}`).join('\n') +
            (entries.length > 0 ? '\n' : '');
          await fs.writeFile(idxPath, idxContent, 'utf8');
        } catch (e) {
          console.warn(`[event-log] idx write failed sid=${sid}: ${e.message}`);
        }
        resolveEntries(entries);
      } catch (e) {
        console.warn(`[event-log] idx scan failed sid=${sid}: ${e.message}`);
        resolveEntries([]);
      }
    });

  // chain 을 덮어써야 이후 append 가 이 작업 완료 후 실행됨.
  writeQueueBySession.set(sid, writeOp.catch(() => {}));
  return entriesPromise;
}

// startOffset 이전 구간에서 winter3.injected 레코드만 추출.
// lastNTurns 슬라이싱으로 잘리는 injected 를 SSE catchup 에 포함시키기 위해 사용.
// (fix #76: SSE catchup lastNTurns 가 non-turn 경계 레코드를 자름)
// @returns {object[]} injected 레코드 배열 (빈 배열 가능)
async function readInjectedBefore(jsonlPath, beforeOffset) {
  if (beforeOffset <= 0) return [];
  let fh;
  let buf;
  try {
    fh = await fsOpen(jsonlPath, 'r');
    buf = Buffer.allocUnsafe(beforeOffset);
    const { bytesRead } = await fh.read(buf, 0, beforeOffset, 0);
    await fh.close();
    fh = null;
    buf = buf.slice(0, bytesRead);
  } catch (e) {
    if (fh) { try { await fh.close(); } catch { /* */ } }
    return [];
  }

  const result = [];
  let pos = 0;
  while (pos < buf.length) {
    const nlPos = buf.indexOf(0x0a, pos);
    const end = nlPos >= 0 ? nlPos : buf.length;
    const lineStr = buf.slice(pos, end).toString('utf8');
    if (lineStr.trim().length > 0) {
      try {
        const rec = JSON.parse(lineStr);
        if (rec?.raw?.type === 'winter3.injected') result.push(rec);
      } catch { /* skip */ }
    }
    pos = nlPos >= 0 ? nlPos + 1 : buf.length;
  }
  return result;
}

// idx 로부터 부분 읽기로 records 파싱.
// [startTurnIdx, endTurnIdx) 구간의 레코드 + 전체 턴 경계 정보 반환.
// turnBoundaries 의 recIdx 는 sliced 배열 내 상대 위치 기준.
// @returns {{ allRecords: object[], turnBoundaries: {turnIdx,recIdx}[], totalTurns: number }}
async function readWithIdxFast(sid, jsonlPath, idxEntries, startOffset, endOffset) {
  let buf;
  const fSize = (await fs.stat(jsonlPath)).size;
  const readEnd = endOffset !== null ? Math.min(endOffset, fSize) : fSize;
  const readLen = readEnd - startOffset;
  if (readLen <= 0) {
    return { allRecords: [], turnBoundaries: [], totalTurns: idxEntries.length };
  }

  let fh;
  try {
    fh = await fsOpen(jsonlPath, 'r');
    buf = Buffer.allocUnsafe(readLen);
    const { bytesRead } = await fh.read(buf, 0, readLen, startOffset);
    await fh.close();
    fh = null;
    buf = buf.slice(0, bytesRead);
  } catch (e) {
    if (fh) { try { await fh.close(); } catch { /* */ } }
    throw e;
  }

  // half-line 방어: 마지막 줄이 '\n' 으로 끝나지 않으면 버림.
  const lastNl = buf.lastIndexOf(0x0a);
  const safeBuf = lastNl >= 0 ? buf.slice(0, lastNl + 1) : buf;

  const allRecords = [];
  let pos = 0;
  while (pos < safeBuf.length) {
    const nlPos = safeBuf.indexOf(0x0a, pos);
    const end = nlPos >= 0 ? nlPos : safeBuf.length;
    const lineStr = safeBuf.slice(pos, end).toString('utf8');
    if (lineStr.trim().length > 0) {
      try { allRecords.push(JSON.parse(lineStr)); } catch { /* skip */ }
    }
    pos = nlPos >= 0 ? nlPos + 1 : safeBuf.length;
  }

  // turnBoundaries: idxEntries 중 startOffset 이상인 항목을 sliced 배열 내 recIdx 로 재매핑.
  // startOffset 기준 바이트 오프셋 → 해당 레코드가 allRecords 배열의 몇 번째인지 찾기.
  const turnBoundaries = [];
  // allRecords 의 각 record 가 원래 파일 내 어느 byteOffset 에 있었는지 계산.
  // 부분 읽기 buf 내 상대 위치 + startOffset = 절대 오프셋.
  const recordAbsOffsets = [];
  {
    let p2 = 0;
    let ri = 0;
    while (p2 < safeBuf.length && ri < allRecords.length) {
      const nlP = safeBuf.indexOf(0x0a, p2);
      const lineEnd = nlP >= 0 ? nlP : safeBuf.length;
      const lineStr = safeBuf.slice(p2, lineEnd).toString('utf8');
      if (lineStr.trim().length > 0) {
        recordAbsOffsets.push(startOffset + p2);
        ri++;
      }
      p2 = nlP >= 0 ? nlP + 1 : safeBuf.length;
    }
  }

  for (const entry of idxEntries) {
    if (entry.byteOffset < startOffset) continue;
    // recordAbsOffsets 에서 이 byteOffset 과 일치하는 recIdx 찾기.
    const recIdx = recordAbsOffsets.indexOf(entry.byteOffset);
    if (recIdx < 0) continue;
    turnBoundaries.push({ turnIdx: entry.turnIdx, recIdx });
  }

  return { allRecords, turnBoundaries, totalTurns: idxEntries.length };
}

// =============================================================================
// 이미지 블롭 분리 — append 시 base64 스텁화
// =============================================================================

// image+base64 블록인지 판별.
function isBase64ImageBlock(block) {
  return (
    block != null &&
    typeof block === 'object' &&
    block.type === 'image' &&
    block.source != null &&
    block.source.type === 'base64' &&
    typeof block.source.data === 'string'
  );
}

// content 배열을 재귀적으로 walk 해 base64 image 블록을 스텁으로 치환.
// 치환된 경우에만 새 배열을 반환, 아니면 원본 배열 반환.
// blobInfos: [{absPath, relPath, mediaType, bytes, buf}] 에 블롭 정보를 append.
// counter.n: 레코드 전체에서 몇 번째 블롭인지 0-based 카운터.
function walkContent(contentArr, sid, id, blobInfos, counter) {
  if (!Array.isArray(contentArr)) return { arr: contentArr, changed: false };
  let changed = false;
  const arr = contentArr.map((block) => {
    if (isBase64ImageBlock(block)) {
      const n = counter.n++;
      const relPath = `blobs/${sid}/${id}-${n}.bin`;
      const absPath = join(EVENTS_DIR, relPath);
      const mediaType = block.source.media_type;
      const buf = Buffer.from(block.source.data, 'base64');
      blobInfos.push({ absPath, relPath, mediaType, bytes: buf.length, buf });
      changed = true;
      return {
        ...block,
        source: { type: 'winter3_blob', path: relPath, media_type: mediaType, bytes: buf.length },
      };
    }
    // tool_result 안의 content[] 재귀 처리.
    if (
      block != null &&
      typeof block === 'object' &&
      block.type === 'tool_result' &&
      Array.isArray(block.content)
    ) {
      const { arr: inner, changed: innerChanged } = walkContent(block.content, sid, id, blobInfos, counter);
      if (innerChanged) {
        changed = true;
        return { ...block, content: inner };
      }
    }
    return block;
  });
  return { arr, changed };
}

// raw SDK 메시지를 walk 해 이미지 base64 를 블롭 스텁으로 치환.
// 이미지가 없으면 raw 원본 반환 (복사 비용 0).
// 이미지가 있으면 shallow-patch 후 치환된 rawStubbed + blobInfos 반환.
//
// @export — migrate 스크립트에서 재사용.
// @param {string} sid
// @param {number} id
// @param {object} raw
// @returns {{ rawStubbed: object, blobInfos: Array }}
export function stubImageBlocks(sid, id, raw) {
  if (raw == null || typeof raw !== 'object') return { rawStubbed: raw, blobInfos: [] };

  const blobInfos = [];
  const counter = { n: 0 };
  let changed = false;
  let patchedRaw = raw;

  // 경로 ①: raw.message.content[] (assistant/user SDK envelope)
  if (raw.message != null && Array.isArray(raw.message.content)) {
    const { arr, changed: c } = walkContent(raw.message.content, sid, id, blobInfos, counter);
    if (c) {
      changed = true;
      patchedRaw = { ...patchedRaw, message: { ...patchedRaw.message, content: arr } };
    }
  }

  // 경로 ②: raw.content[] (직속)
  if (Array.isArray(raw.content)) {
    const { arr, changed: c } = walkContent(raw.content, sid, id, blobInfos, counter);
    if (c) {
      changed = true;
      patchedRaw = { ...patchedRaw, content: arr };
    }
  }

  if (!changed) return { rawStubbed: raw, blobInfos: [] };
  return { rawStubbed: patchedRaw, blobInfos };
}

function ensureInit(sid) {
  if (nextIdBySession.has(sid)) return Promise.resolve();
  if (initPromises.has(sid)) return initPromises.get(sid);
  const p = (async () => {
    if (nextIdBySession.has(sid)) return;
    const fp = pathFor(sid);
    if (!existsSync(fp)) { nextIdBySession.set(sid, 0); return; }
    const text = await fs.readFile(fp, 'utf8');
    const lines = text.split('\n').filter((l) => l.length > 0);
    let maxId = -1;
    for (const line of lines) {
      try {
        const o = JSON.parse(line);
        if (typeof o.id === 'number' && o.id > maxId) maxId = o.id;
      } catch { /* skip */ }
    }
    nextIdBySession.set(sid, maxId + 1);
  })();
  initPromises.set(sid, p);
  p.finally(() => initPromises.delete(sid));
  return p;
}

function getEmitter(sid) {
  if (!emitterBySession.has(sid)) {
    const em = new EventEmitter();
    em.setMaxListeners(0);
    emitterBySession.set(sid, em);
  }
  return emitterBySession.get(sid);
}

export async function append(sid, raw) {
  await ensureInit(sid);
  // ⚠ Synchronous id allocation (no await between these two lines).
  const id = nextIdBySession.get(sid);
  nextIdBySession.set(sid, id + 1);

  // 이미지 블롭 분리 — 동기 walk (await 없음, id 할당 안전 구간 유지).
  const { rawStubbed, blobInfos } = stubImageBlocks(sid, id, raw);

  const ts = new Date().toISOString();

  // idx 갱신 헬퍼 — writeQueue chain 안에서 호출.
  // isUserPrompt 일 때만 jsonl 쓰기 직전 파일 크기를 오프셋으로 idx 에 append.
  // #71 주의: stubbed 처리 후 실제 jsonl 에 쓰이는 바이트 기준이어야 하므로 appendFile 직전 stat.
  // idx 쓰기 실패는 warn 만 — jsonl 쓰기는 항상 진행 (idx 는 재생성 가능한 캐시).
  const isUserPrompt = (rawArg) => rawArg?.type === 'winter3.user_prompt';

  async function appendIdxIfNeeded(rawArg, jsonlPath) {
    if (!isUserPrompt(rawArg)) return;
    try {
      let offset = 0;
      try {
        const st = await fs.stat(jsonlPath);
        offset = st.size;
      } catch {
        offset = 0; // 파일 없으면 오프셋 0 (첫 번째 레코드)
      }
      // idx 에 "turnIdx byteOffset\n" 추가.
      // turnIdx 는 idx 파일의 현재 줄 수 (= 기존 턴 개수).
      let existingTurnCount = 0;
      try {
        const idxText = await fs.readFile(idxPathFor(sid), 'utf8');
        existingTurnCount = parseIdx(idxText).length;
      } catch { /* idx 없으면 0 */ }
      await fs.appendFile(idxPathFor(sid), `${existingTurnCount} ${offset}\n`, 'utf8');
    } catch (e) {
      console.warn(`[event-log] idx append failed sid=${sid} id=${id}: ${e.message}`);
    }
  }

  // Serialize file writes per session so on-disk order matches id order.
  // blob 파일 쓰기도 같은 chain 안에서 처리 (직렬화 보장).
  const prev = writeQueueBySession.get(sid) || Promise.resolve();
  const writeOp = prev
    .catch(() => { /* don't break the chain on prior failures */ })
    .then(async () => {
      const jsonlPath = pathFor(sid);
      // blob 파일 먼저 쓰기 — jsonl 보다 먼저 flush 해야 스텁 참조가 유효.
      if (blobInfos.length > 0) {
        const blobDir = join(BLOBS_BASE, sid);
        try {
          await fs.mkdir(blobDir, { recursive: true });
          for (const info of blobInfos) {
            await fs.writeFile(info.absPath, info.buf);
          }
          // 블롭 정상 저장 → stubbed record 를 jsonl 에 기록.
          const record = { id, ts, raw: rawStubbed };
          // idx 갱신: jsonl appendFile 직전 (stubbed raw 기준).
          await appendIdxIfNeeded(rawStubbed, jsonlPath);
          await fs.appendFile(jsonlPath, JSON.stringify(record) + '\n', 'utf8');
          return { record, usedFallback: false };
        } catch (e) {
          // Fail-safe: blob 쓰기 실패 시 원본 raw 로 fallback — 이벤트 유실 방지.
          console.warn(`[event-log] blob write failed sid=${sid} id=${id}: ${e.message}. falling back to original raw.`);
          const record = { id, ts, raw };
          // fallback 경로도 idx 갱신 (원본 raw 기준).
          await appendIdxIfNeeded(raw, jsonlPath);
          await fs.appendFile(jsonlPath, JSON.stringify(record) + '\n', 'utf8');
          return { record, usedFallback: true };
        }
      }
      // 이미지 없는 99% 경로 — 복사 비용 0.
      const record = { id, ts, raw };
      // idx 갱신: jsonl appendFile 직전.
      await appendIdxIfNeeded(raw, jsonlPath);
      await fs.appendFile(jsonlPath, JSON.stringify(record) + '\n', 'utf8');
      return { record, usedFallback: false };
    });
  // writeQueueBySession 에는 에러 없는 tail 을 걸어야 chain 이 안 끊김.
  writeQueueBySession.set(sid, writeOp.catch(() => {}));
  const { record } = await writeOp;

  getEmitter(sid).emit('line', record);
  return record;
}

export async function readSince(sid, afterId = -1) {
  const p = pathFor(sid);
  if (!existsSync(p)) return [];
  const text = await fs.readFile(p, 'utf8');
  const lines = text.split('\n').filter((l) => l.length > 0);
  const out = [];
  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      if (typeof rec.id === 'number' && rec.id > afterId) out.push(rec);
    } catch { /* skip */ }
  }
  return out;
}

export function subscribe(sid, onLine) {
  const em = getEmitter(sid);
  em.on('line', onLine);
  return () => em.off('line', onLine);
}

export async function lastId(sid) {
  await ensureInit(sid);
  return nextIdBySession.get(sid) - 1;
}

// #20 — jsonl tail 검사로 "user_prompt 후 turn_end 안 도착한 sid" 감지.
// runner.runningTurns 가 truth 지만, 서버 재시작 후 in-memory Map 이 비어있는 race
// window 가 있음. recovery.js (#6) 가 startup 에 dangling 청소하지만 그 1~2 초 사이.
// → Multi-Session Monitor 가 이 함수도 같이 보고 union 해서 표시.
export async function isDangling(sid) {
  const fp = pathFor(sid);
  if (!existsSync(fp)) return false;
  const text = await fs.readFile(fp, 'utf8');
  const lines = text.split('\n').filter((l) => l.length > 0);
  if (lines.length === 0) return false;
  // 끝에서부터 user_prompt vs turn_end 먼저 만나는 거 확인.
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const o = JSON.parse(lines[i]);
      const t = o?.raw?.type;
      if (t === 'winter3.turn_end') return false;       // 가장 최근이 turn_end → idle
      if (t === 'winter3.user_prompt') return true;      // 가장 최근이 user_prompt → dangling
    } catch { /* skip */ }
  }
  return false;
}

// =============================================================================
// 작업 1+2+3: catchup 감축 + 페이지네이션 공용 유틸리티
// =============================================================================

// --- 공용 필터 함수 (작업 1) --------------------------------------------------
//
// catchup(과거 replay) 구간에서 클라이언트가 항상 버리는 stream_event 를 드롭.
// P1 원칙 준수: 디스크 파일 무수정. 전송 시점에만 필터링.
//
// 필터 규칙:
//   1. stream_event + content_block_delta + (input_json_delta | signature_delta | thinking_delta)
//      → 무조건 드롭. 클라이언트(render.js L459-468) 가 항상 버린다.
//   2. stream_event + content_block_delta + text_delta + 해당 message 에 assistant 스냅샷 존재
//      → 드롭. 스냅샷이 최종 텍스트를 갖고 있어 100% 중복.
//   3. stream_event + content_block_delta + text_delta + 스냅샷 없음 (중단된 turn 3건)
//      → 보존. 이 텍스트를 버리면 화면에서 사라진다.
//   4. 나머지 모든 record → 그대로 통과.
//
// 2-pass 이유: stream_event 자체에 message_id 가 없다. message_start 이벤트를 순서대로
// 추적해 현재 message_id 를 알아내야 한다. 그런데 "이 message 에 스냅샷이 있는가"는
// 파일 전체를 봐야 알 수 있다 → 1패스에서 스냅샷 id 집합 수집, 2패스에서 필터.
//
// 주의: 라이브 tail(실시간 스트리밍) 경로에는 이 필터를 적용하면 안 된다.
// text_delta 를 버리면 타자 효과가 사라진다.
//
// @param {object[]} records — readSince 또는 readTurns 가 반환한 record 배열
// @returns {object[]} — 필터링된 record 배열
export function filterCatchupRecords(records) {
  // Pass 1: assistant 스냅샷이 있는 message id 집합 수집.
  const snapshotMsgIds = new Set();
  for (const rec of records) {
    if (rec?.raw?.type === 'assistant') {
      const msgId = rec.raw?.message?.id;
      if (msgId) snapshotMsgIds.add(msgId);
    }
  }

  // Pass 2: 필터 적용. message_start 를 순서대로 추적해 현재 message_id 유지.
  const out = [];
  let currentMsgId = null;
  for (const rec of records) {
    const raw = rec?.raw;
    if (!raw) { out.push(rec); continue; }

    if (raw.type === 'stream_event') {
      const ev = raw.event;
      const et = ev?.type;

      // message_start 를 만날 때마다 현재 message id 갱신.
      if (et === 'message_start') {
        currentMsgId = ev?.message?.id ?? null;
        out.push(rec);
        continue;
      }

      if (et === 'content_block_delta') {
        const dt = ev?.delta?.type;
        // 항상 드롭: input_json_delta, signature_delta, thinking_delta.
        if (dt === 'input_json_delta' || dt === 'signature_delta' || dt === 'thinking_delta') {
          continue; // drop
        }
        // text_delta: 스냅샷이 있는 message 에 속하면 드롭, 없으면 보존.
        if (dt === 'text_delta') {
          if (currentMsgId && snapshotMsgIds.has(currentMsgId)) {
            continue; // drop — 스냅샷이 최종 텍스트를 대체
          }
          out.push(rec);
          continue;
        }
      }

      // 다른 stream_event 는 전부 통과.
      out.push(rec);
      continue;
    }

    // stream_event 가 아닌 모든 record (user, assistant, winter3.*, system 등) 통과.
    out.push(rec);
  }

  return out;
}

// --- 턴 인덱스 추출 유틸 (작업 2+3) ------------------------------------------
//
// 파싱된 record 배열에서 winter3.user_prompt record 의 인덱스(배열상 위치 아닌 턴 순번)
// 와 해당 record 의 배열 인덱스를 매핑한 배열을 반환.
//
// @param {object[]} records
// @returns {{ turnIdx: number, recIdx: number }[]}
//   turnIdx: 0-based 턴 번호 (파일 전체 기준)
//   recIdx:  records 배열 내 인덱스
function findTurnBoundaries(records) {
  const turns = [];
  for (let i = 0; i < records.length; i++) {
    if (records[i]?.raw?.type === 'winter3.user_prompt') {
      turns.push({ turnIdx: turns.length, recIdx: i });
    }
  }
  return turns;
}

// --- readAllWithTurns: 하이브리드 경로 — idx 있으면 부분 읽기, 없으면 full-scan + lazy 백필 ---
//
// 반환 shape: { allRecords, turnBoundaries, totalTurns }
//   - allRecords: [fromTurnIdx, toTurnIdx) 구간 레코드 (opts 없으면 전체)
//   - turnBoundaries: allRecords 내 상대 recIdx 기준. turnIdx 는 파일 전체 기준 (0-based).
//   - totalTurns: 파일 전체 턴 수 (항상).
//
// opts.fromTurnIdx (number): 이 턴 인덱스부터 읽기 시작 (해당 턴의 byteOffset 부터 pread).
// opts.toTurnIdx (number): 이 턴 인덱스 직전까지 읽기 (해당 턴의 byteOffset 까지, null=EOF).
// opts.lastNTurns (number): fromTurnIdx 를 totalTurns - lastNTurns 으로 자동 계산 (SSE catchup 용).
//   - 세 옵션 모두 생략 → 파일 전체 읽기 (하위호환).
//
// 반환 계약:
//   - allRecords: [fromTurnIdx 오프셋, toTurnIdx 오프셋) 구간의 레코드만. opts 없으면 전체.
//   - turnBoundaries: allRecords 내 상대 recIdx. turnIdx 는 파일 전체 기준 (0-based).
//   - totalTurns: 파일 전체 턴 수 (항상, opts와 무관).
//
// 두 호출부 (index.js 업데이트):
//   - SSE catchup L770: readAllWithTurns(sid, { lastNTurns: turnsN })
//       → allRecords = (totalTurns-turnsN)번 오프셋부터 EOF.
//       → turnBoundaries 의 recIdx 는 allRecords 내 상대 위치.
//       → 호출부: sliceFrom = turnBoundaries[0]?.recIdx ?? 0 (첫 항목 = startTurnIdx).
//   - handleHistory L1095: readAllWithTurns(sid, { fromTurnIdx: startTurnIdx, toTurnIdx: upperTurnIdx })
//       → allRecords 는 [startTurnIdx, upperTurnIdx) 구간만.
//       → 호출부: allRecords.slice(0, allRecords.length) 또는 전체 사용.
//
// @param {string} sid
// @param {{ fromTurnIdx?: number, toTurnIdx?: number, lastNTurns?: number }} [opts]
// @returns {{ allRecords: object[], turnBoundaries: { turnIdx, recIdx }[], totalTurns: number }}
export async function readAllWithTurns(sid, opts = {}) {
  const jsonlPath = pathFor(sid);
  if (!existsSync(jsonlPath)) return { allRecords: [], turnBoundaries: [], totalTurns: 0 };

  const idxPath = idxPathFor(sid);

  // --- idx 로드 및 검증 ---
  let idxEntries = null;
  if (existsSync(idxPath)) {
    try {
      const idxText = await fs.readFile(idxPath, 'utf8');
      const parsed = parseIdx(idxText);
      // corrupt 판정: 파일에 non-empty 줄이 있는데 파싱 결과가 0이면 corrupt.
      const hasNonEmptyLines = idxText.split('\n').some((l) => l.trim().length > 0);
      if (hasNonEmptyLines && parsed.length === 0) {
        console.warn(`[event-log] idx corrupt (unparseable), rebuilding sid=${sid}`);
        try { await fs.unlink(idxPath); } catch { /* */ }
      } else {
        const valid = await validateIdx(parsed, jsonlPath);
        if (valid) {
          idxEntries = parsed;
        } else {
          console.warn(`[event-log] idx invalid, rebuilding sid=${sid}`);
          try { await fs.unlink(idxPath); } catch { /* */ }
        }
      }
    } catch {
      idxEntries = null;
    }
  }

  // --- lazy 백필: idx 없으면 full-scan 으로 생성 ---
  if (idxEntries === null) {
    idxEntries = await buildIdxFromFullScan(sid);
  }

  const totalTurns = idxEntries.length;

  // --- 오프셋 구간 계산 ---
  // lastNTurns 가 있으면 fromTurnIdx 자동 계산.
  let resolvedFrom = opts.fromTurnIdx ?? 0;
  if (opts.lastNTurns != null && opts.lastNTurns >= 0) {
    // lastNTurns=0 도 포함: totalTurns - 0 = totalTurns → BUG 2 조기 반환에서 빈 결과 처리.
    resolvedFrom = Math.max(0, totalTurns - opts.lastNTurns);
  }
  resolvedFrom = Math.min(resolvedFrom, totalTurns);

  const resolvedTo = (opts.toTurnIdx != null)
    ? Math.min(opts.toTurnIdx, totalTurns)
    : null; // null = EOF

  // BUG 2 FIX: resolvedFrom >= idxEntries.length 이면 요청 범위가 파일 끝 이후 → 빈 결과.
  // (lastNTurns=0 → resolvedFrom===totalTurns, 또는 fromTurnIdx>=totalTurns 모두 해당)
  if (resolvedFrom >= idxEntries.length && totalTurns > 0) {
    return { allRecords: [], turnBoundaries: [], totalTurns };
  }

  const startOffset = (resolvedFrom > 0 && resolvedFrom < idxEntries.length)
    ? idxEntries[resolvedFrom].byteOffset
    : 0;
  const endOffset = (resolvedTo !== null && resolvedTo < idxEntries.length)
    ? idxEntries[resolvedTo].byteOffset
    : null; // null = EOF

  // --- 빠른 경로: idx 기반 부분 pread ---
  try {
    const result = await readWithIdxFast(sid, jsonlPath, idxEntries, startOffset, endOffset);

    // #76 fix: lastNTurns 슬라이싱으로 startOffset 앞이 잘릴 때 winter3.injected 레코드 복구.
    // startOffset > 0 이고 lastNTurns 경로일 때만 앞부분을 injected 전용으로 재스캔.
    // prepend 후 turnBoundaries recIdx 를 injected 수만큼 shift.
    if (startOffset > 0 && opts.lastNTurns != null) {
      const injected = await readInjectedBefore(jsonlPath, startOffset);
      if (injected.length > 0) {
        const shifted = result.turnBoundaries.map((b) => ({
          turnIdx: b.turnIdx,
          recIdx: b.recIdx + injected.length,
        }));
        return {
          allRecords: [...injected, ...result.allRecords],
          turnBoundaries: shifted,
          totalTurns: result.totalTurns,
        };
      }
    }

    return result;
  } catch (e) {
    console.warn(`[event-log] fast path failed, falling back to full-scan sid=${sid}: ${e.message}`);
  }

  // --- full-scan fallback (opts 무시하고 전체 반환) ---
  const text = await fs.readFile(jsonlPath, 'utf8');
  const lines = text.split('\n').filter((l) => l.length > 0);
  const allRecords = [];
  for (const line of lines) {
    try { allRecords.push(JSON.parse(line)); } catch { /* skip */ }
  }
  const turnBoundaries = findTurnBoundaries(allRecords);
  return { allRecords, turnBoundaries, totalTurns: turnBoundaries.length };
}

// idx 만 읽어 totalTurns 반환. 파일 전체 미읽음 → 빠름.
// idx 없으면 lazy 백필 (full scan 1회). handleHistory 에서 구간 계산용.
export async function readTotalTurns(sid) {
  const jsonlPath = pathFor(sid);
  if (!existsSync(jsonlPath)) return 0;
  const idxPath = idxPathFor(sid);
  if (existsSync(idxPath)) {
    try {
      const idxText = await fs.readFile(idxPath, 'utf8');
      const parsed = parseIdx(idxText);
      const hasNonEmptyLines = idxText.split('\n').some((l) => l.trim().length > 0);
      if (!hasNonEmptyLines || parsed.length > 0) {
        const valid = await validateIdx(parsed, jsonlPath);
        if (valid) return parsed.length;
      }
    } catch { /* fall through to scan */ }
  }
  // idx 없거나 무효 → full scan (부산물로 idx 생성됨)
  const entries = await buildIdxFromFullScan(sid);
  return entries.length;
}

// --- readInjectedSincePrevTurn: 직전 turn 이후 도착한 winter3.injected 수집 (#82) ---
//
// startTurn 이 현재 turn 의 user_prompt 를 append 한 **직후** 호출하는 전제.
// 스캔 윈도우 = [직전 user_prompt 오프셋 (idx[len-2]), EOF).
//   - idx 마지막 항목 = 방금 append 된 현재 turn → len-2 가 직전 turn 시작.
//   - len < 2 (첫 turn / 신규 세션) → 오프셋 0 부터 전체 스캔. inject 가 첫 레코드인 케이스 커버.
// consume-once 보장: turn N 에서 소비된 injected 는 turn N 의 user_prompt 보다 앞에 있으므로
// turn N+1 의 윈도우 (idx[N] 오프셋~) 에 다시 안 잡힘. 별도 마커 불필요.
// #76 의 readInjectedBefore 와 반대 방향 (그건 startOffset **이전** 전체 — 여기 쓰면 과거 injected 재소비 버그).
// idx invalid 시 full read fallback — injected 유실보다 한 번의 full read 가 낫다.
//
// @param {string} sid
// @returns {Promise<object[]>} envelope records ({id, ts, raw}) — raw.type === 'winter3.injected' 만
export async function readInjectedSincePrevTurn(sid) {
  const jsonlPath = pathFor(sid);
  if (!existsSync(jsonlPath)) return [];

  let startOffset = 0;
  try {
    const idxText = await fs.readFile(idxPathFor(sid), 'utf8');
    const parsed = parseIdx(idxText);
    if (parsed.length >= 2 && await validateIdx(parsed, jsonlPath)) {
      startOffset = parsed[parsed.length - 2].byteOffset;
    }
  } catch { /* idx 없음/무효 → full read */ }

  let text;
  if (startOffset > 0) {
    const fh = await fs.open(jsonlPath, 'r');
    try {
      const st = await fh.stat();
      const len = st.size - startOffset;
      if (len <= 0) return [];
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, startOffset);
      text = buf.toString('utf8');
    } finally {
      await fh.close();
    }
  } else {
    text = await fs.readFile(jsonlPath, 'utf8');
  }

  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const rec = JSON.parse(line);
      if (rec?.raw?.type === 'winter3.injected') out.push(rec);
    } catch { /* partial/corrupt line skip */ }
  }
  return out;
}

// @export — QA 스크립트에서 직접 테스트용.
export { buildIdxFromFullScan, parseIdx, validateIdx, idxPathFor };
