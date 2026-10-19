// web/js/stream.js — SSE client. Full replay on fresh open; EventSource native
// reconnect handles transient drops via Last-Event-ID header (server respects it).

let es = null;
let currentSid = null;

// 초기 로드 시 최근 N턴만 catchup. Last-Event-ID 재연결은 turns 무시(서버 보장).
const INITIAL_TURNS = 20;

export function openStream(sid, onRecord) {
  closeStream();
  currentSid = sid;
  const url = `/events/${encodeURIComponent(sid)}?last=-1&turns=${INITIAL_TURNS}`;
  es = new EventSource(url);
  es.addEventListener('message', (e) => {
    if (sid !== currentSid) return;
    let rec;
    try { rec = JSON.parse(e.data); } catch { return; }
    try { onRecord(rec); } catch (err) { console.error('[render]', err, rec); }
  });
  // No manual reconnect — browser EventSource auto-reconnects + sends
  // Last-Event-ID header. Server uses it for dedup-free catchup.
}

export function closeStream() {
  if (es) { try { es.close(); } catch {} es = null; }
  currentSid = null;
}
