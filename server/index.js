// server/index.js — HTTP server: static + /dispatch + /events SSE + /sessions.
// Stateless glue. All persistence in event-log. All UI logic in client.

import http from 'node:http';
import { promises as fs, existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import * as log from './event-log.js';
import * as session from './session.js';
import * as projects from './projects.js';
import * as rea from './rea.js';
import * as runner from './runner.js';
import { reconcileDanglingTurns } from './recovery.js';
import { readCanaryAlert } from './canary-alert.js';
import { scheduleRestart } from './restart-exec.js';
import { listJobs, killJob } from './jobs.js';
import { initScheduler } from './jobs-scheduler.js';
import { getUsage } from './usage.js';
import { quarantineLastTurn, resolveTranscriptPath, detectRefusalInTranscript } from './transcript-quarantine.js';

const execFileP = promisify(execFile);

const HOME = process.env.WINTER3_HOME || fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.WINTER3_PORT || 7979);
const WEB_DIR = join(HOME, 'web');
let _claudeVersionCache = null;  // /settings 응답 캐시 (1회 exec 후 재사용)

// ── 인증 토큰 주입 ─────────────────────────────────────────────────────────
// data/.auth-token 이 존재하면 CLAUDE_CODE_OAUTH_TOKEN 으로 주입 (SDK child 가 env 상속).
// 없으면 로컬 claude CLI 자격증명 (keychain / ~/.claude) fallback — SDK 기본 동작.
try {
  const tokenPath = join(HOME, 'data', '.auth-token');
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && existsSync(tokenPath)) {
    const tok = readFileSync(tokenPath, 'utf8').trim();
    if (tok) {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = tok;
      console.log('[winter] auth: data/.auth-token 주입 완료');
    }
  }
} catch (err) {
  console.error('[winter] auth token read failed:', err.message);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.wav':  'audio/wav',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif':  'image/gif',
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
  '.m4a':  'audio/mp4',
  '.mp3':  'audio/mpeg',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > limit) { reject(Object.assign(new Error('body too large'), { statusCode: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (err) { reject(Object.assign(new Error(`bad json: ${err.message}`), { statusCode: 400 })); }
    });
    req.on('error', reject);
  });
}

// isLocalReq — /dispatch, /api/inject, /api/jobs*, /api/projects*, /api/rea* 공통 가드.
// localhost 전용. 신규 가드는 inline 복붙 금지 — 반드시 이 함수 사용.
function isLocalReq(req) {
  const remote = req.socket?.remoteAddress || '';
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1' || remote === '';
}

// ── Claude OAuth PKCE 온보딩 (boin-standalone server/index.js 104-358 이식) ──
// 모듈 스코프 인메모리 state — single user, TTL 10분.
let _claudeOAuthPending = null;
const CLAUDE_OAUTH_TTL_MS = 10 * 60 * 1000;
const CLAUDE_CALLBACK_PORT = 54545;
let _callbackListener = null;      // 임시 54545 HTTP 리스너
let _callbackListenerTimer = null; // TTL 자동 close 타이머
const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CLAUDE_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLAUDE_TOKEN_URL_FALLBACK = 'https://console.anthropic.com/v1/oauth/token';

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function pkceChallenge(verifier) {
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256').update(verifier).digest();
  return base64url(hash);
}

async function saveClaudeToken(token) {
  const tokenPath = join(HOME, 'data', '.auth-token');
  writeFileSync(tokenPath, token, 'utf8');
  try { chmodSync(tokenPath, 0o600); } catch { /* Windows no-op */ }
  process.env.CLAUDE_CODE_OAUTH_TOKEN = token;
  console.log(`[winter] claude-oauth: token saved, suffix=...${token.slice(-4)}`);
}

async function exchangeClaudeCode({ code, redirectUri, verifier, state }) {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    state,
    client_id: CLAUDE_CLIENT_ID,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    expires_in: '31536000',
  });
  const bodyStr = params.toString();
  const opts = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': String(Buffer.byteLength(bodyStr)),
    },
    body: bodyStr,
    signal: AbortSignal.timeout(120_000),
  };
  let resp = await fetch(CLAUDE_TOKEN_URL, opts);
  if (!resp.ok && resp.status >= 500) {
    console.log('[winter] claude-oauth: primary token URL failed, trying fallback');
    resp = await fetch(CLAUDE_TOKEN_URL_FALLBACK, { ...opts, body: bodyStr, signal: AbortSignal.timeout(120_000) });
  }
  const data = await resp.json();
  if (!resp.ok) {
    throw Object.assign(
      new Error(data?.error_description || data?.error || `HTTP ${resp.status}`),
      { statusCode: resp.status },
    );
  }
  const token = data?.access_token;
  if (!token || !String(token).startsWith('sk-ant-oat')) {
    throw new Error('unexpected token format — expected sk-ant-oat prefix');
  }
  return token;
}

// 임시 54545 리스너 정리 유틸
function _closeCallbackListener(reason) {
  if (_callbackListenerTimer) { clearTimeout(_callbackListenerTimer); _callbackListenerTimer = null; }
  if (_callbackListener) {
    try { _callbackListener.close(); } catch { /* 이미 닫힘 */ }
    _callbackListener = null;
    console.log(`[winter] claude-oauth: callback listener closed (${reason})`);
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 공용 OAuth 콜백 처리 — 메인 라우트(/claude/callback)와 54545 리스너 양쪽에서 재사용.
// res: node:http ServerResponse. url: WHATWG URL 객체.
async function _handleOAuthCallback(res, url) {
  const code = url.searchParams.get('code') || '';
  const stateParam = url.searchParams.get('state') || '';

  const htmlPage = (ok, msg) => {
    const accent = ok ? '#2B2F6E' : '#dc2626';
    const html = `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><title>Winter</title>`
      + `<style>body{margin:0;display:flex;align-items:center;justify-content:center;`
      + `min-height:100vh;background:#F4F9FD;font-family:system-ui,sans-serif;color:#111827;}`
      + `div{text-align:center;padding:2rem;}h2{color:${accent};margin-bottom:.5rem;}`
      + `p{color:#6b7280;font-size:.9rem;}</style></head><body>`
      + `<div><h2>${ok ? '연결 완료' : '연결 실패'}</h2><p>${escapeHtml(msg)}</p></div></body></html>`;
    res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  };

  if (!_claudeOAuthPending || Date.now() > _claudeOAuthPending.expiresAt) {
    return htmlPage(false, 'OAuth 세션이 만료됐거나 없어요. 다시 연결해 주세요.');
  }
  if (stateParam !== _claudeOAuthPending.state) {
    console.error(`[winter] claude-oauth: state mismatch expected=...${_claudeOAuthPending.state.slice(-6)} got=...${stateParam.slice(-6)}`);
    _claudeOAuthPending = null;
    return htmlPage(false, 'State 불일치 — 다시 시도해 주세요.');
  }
  if (!code) {
    return htmlPage(false, '인증 코드가 없어요. 다시 시도해 주세요.');
  }

  const { verifier, redirectUri, state } = _claudeOAuthPending;
  _claudeOAuthPending = null; // 단발 소비

  // 54545 리스너는 콜백 1회 처리 후 즉시 close
  _closeCallbackListener('callback received');

  try {
    const token = await exchangeClaudeCode({ code, redirectUri, verifier, state });
    await saveClaudeToken(token);
    return htmlPage(true, '이 창은 닫아도 돼요.');
  } catch (err) {
    console.error('[winter] claude-oauth callback exchange error:', err.message);
    return htmlPage(false, `토큰 교환 실패: ${err.message}`);
  }
}

// 메인 서버 /claude/callback 라우트 — 54545 를 쓰지 못한 경우 fallback 으로 잔존.
async function handleClaudeCallback(req, res, url) {
  return _handleOAuthCallback(res, url);
}

async function handleClaudeConnectStart(req, res) {
  try {
    const body = await readBody(req).catch(() => ({}));
    const mode = body?.mode === 'paste' ? 'paste' : 'auto';
    const { randomBytes } = await import('node:crypto');

    const verifier = base64url(randomBytes(32));
    const state = base64url(randomBytes(32));
    const challenge = await pkceChallenge(verifier);

    // redirect_uri: paste 모드 = platform.claude.com headless callback
    //               auto 모드 = 고정 포트 54545/callback (Anthropic allowlist 조합)
    const redirectUri = mode === 'paste'
      ? 'https://platform.claude.com/oauth/code/callback'
      : `http://localhost:${CLAUDE_CALLBACK_PORT}/callback`;

    _claudeOAuthPending = { verifier, challenge, state, redirectUri, mode, expiresAt: Date.now() + CLAUDE_OAUTH_TTL_MS };

    // auto 모드: 임시 54545 리스너 기동
    if (mode === 'auto') {
      // 기존 리스너 있으면 먼저 close 후 재기동
      _closeCallbackListener('restart on new start');

      const listenerReady = await new Promise((resolve) => {
        const srv = http.createServer(async (cReq, cRes) => {
          const cUrl = new URL(cReq.url, `http://127.0.0.1:${CLAUDE_CALLBACK_PORT}`);
          if (cReq.method === 'GET' && cUrl.pathname === '/callback') {
            await _handleOAuthCallback(cRes, cUrl);
          } else {
            cRes.writeHead(404); cRes.end('not found');
          }
        });
        srv.on('error', (err) => {
          if (err.code === 'EADDRINUSE') {
            console.error(`[winter] claude-oauth: port ${CLAUDE_CALLBACK_PORT} in use by another process`);
            resolve(null); // degrade 신호
          } else {
            console.error('[winter] claude-oauth callback listener error:', err.message);
            resolve(null);
          }
        });
        srv.listen(CLAUDE_CALLBACK_PORT, '127.0.0.1', () => {
          _callbackListener = srv;
          // TTL 10분 후 자동 close (pending TTL 과 동기)
          _callbackListenerTimer = setTimeout(() => {
            _closeCallbackListener('TTL expired');
          }, CLAUDE_OAUTH_TTL_MS);
          console.log(`[winter] claude-oauth: callback listener ready on 127.0.0.1:${CLAUDE_CALLBACK_PORT}`);
          resolve(srv);
        });
      });

      // EADDRINUSE — pending 정리 후 degrade 응답
      if (!listenerReady) {
        _claudeOAuthPending = null;
        return sendJson(res, 503, { ok: false, error: `포트 ${CLAUDE_CALLBACK_PORT} 사용 중 — 코드 붙여넣기 방식을 사용하세요` });
      }
    }

    const qp = new URLSearchParams({
      client_id: CLAUDE_CLIENT_ID,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: 'user:inference',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    });
    if (mode === 'paste') qp.set('code', 'true');

    const authUrl = `https://claude.ai/oauth/authorize?${qp.toString()}`;
    console.log(`[winter] claude-oauth: start mode=${mode} state=...${state.slice(-6)}`);
    return sendJson(res, 200, { ok: true, authUrl, mode });
  } catch (err) {
    console.error('[winter] claude-oauth start error:', err.message);
    return sendJson(res, 500, { ok: false, error: err.message });
  }
}

async function handleClaudeConnectFinish(req, res) {
  try {
    const body = await readBody(req);
    const raw = String(body?.code || '').trim();
    if (!raw) return sendJson(res, 400, { ok: false, error: 'code required' });

    // code 는 "actualcode#state" 형태일 수 있음 — split
    let codeVal = raw;
    let stateVal = '';
    if (raw.includes('#')) {
      const idx = raw.indexOf('#');
      codeVal = raw.slice(0, idx).trim();
      stateVal = raw.slice(idx + 1).trim();
    }

    if (!_claudeOAuthPending || Date.now() > _claudeOAuthPending.expiresAt) {
      return sendJson(res, 400, { ok: false, error: 'no pending oauth session (expired or not started)' });
    }
    // auto 모드에서 state 없으면 거부 — paste 모드일 때만 state 생략 허용.
    if (!stateVal && _claudeOAuthPending.mode !== 'paste') {
      _claudeOAuthPending = null;
      return sendJson(res, 400, { ok: false, error: 'state required for auto mode' });
    }
    if (stateVal && stateVal !== _claudeOAuthPending.state) {
      _claudeOAuthPending = null;
      return sendJson(res, 400, { ok: false, error: 'state mismatch' });
    }

    const { verifier, redirectUri, state } = _claudeOAuthPending;
    _claudeOAuthPending = null;

    const token = await exchangeClaudeCode({ code: codeVal, redirectUri, verifier, state: stateVal || state });
    await saveClaudeToken(token);
    return sendJson(res, 200, { ok: true, suffix: token.slice(-4) });
  } catch (err) {
    console.error('[winter] claude-oauth finish error:', err.message);
    return sendJson(res, err.statusCode || 500, { ok: false, error: err.message });
  }
}

async function serveStatic(req, res, urlPath) {
  const safe = urlPath.replace(/\.\./g, '').replace(/\/+$/, '') || '/index.html';
  const fp = join(WEB_DIR, safe);
  if (!existsSync(fp) || !fp.startsWith(WEB_DIR)) {
    res.writeHead(404); res.end('not found'); return;
  }
  const stat = await fs.stat(fp);
  if (stat.isDirectory()) {
    return serveStatic(req, res, join(urlPath, 'index.html'));
  }
  // ES module 강캐시 구멍 근본 차단 (#48).
  // index.html 의 app.js?v=N 수동 버전쿼리는 정적 import 하위 모듈을 못 막아서
  // 브라우저가 render.js/soliloquy.js 등을 immutable 처럼 강캐시 → 하드리프레시 강요.
  // 해법: no-cache(캐시하되 ETag 재검증 강제) + If-None-Match → 304.
  //   - no-store(매번 풀 다운로드)보다 lean: 미변경 파일은 바디 0(304), 디스크 read 도 스킵.
  //   - 한 곳만 고치면 app.js + 모든 정적 import 모듈에 일괄 적용 = 수동 버전업 불필요.
  const ext = extname(fp);
  const etag = `"${stat.mtimeMs}"`;
  const ifNoneMatch = req.headers['if-none-match'];
  if (ifNoneMatch && ifNoneMatch === etag) {
    res.writeHead(304, { 'Cache-Control': 'no-cache', 'ETag': etag });
    res.end();
    return;
  }
  const contentType = MIME[ext] || 'application/octet-stream';
  const rangeHeader = req.headers['range'];
  if (rangeHeader) {
    const size = stat.size;
    const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
    if (!match) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end(); return;
    }
    let start, end;
    if (match[1] === '' && match[2] !== '') {
      // suffix-range: bytes=-500 → 마지막 N bytes
      start = Math.max(0, size - parseInt(match[2], 10));
      end   = size - 1;
    } else if (match[1] !== '') {
      // normal: bytes=start-end
      start = parseInt(match[1], 10);
      end   = match[2] !== '' ? parseInt(match[2], 10) : size - 1;
    } else {
      // bytes=- 등 파싱 불가
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end(); return;
    }
    if (start > end || end >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end(); return;
    }
    res.writeHead(206, {
      'Content-Type':   contentType,
      'Content-Range':  `bytes ${start}-${end}/${size}`,
      'Accept-Ranges':  'bytes',
      'Content-Length': String(end - start + 1),
    });
    const stream = createReadStream(fp, { start, end });
    stream.on('error', () => { try { res.destroy(); } catch {} });
    stream.pipe(res);
    return;
  }
  const buf = await fs.readFile(fp);
  res.writeHead(200, {
    'Content-Type':  contentType,
    'Cache-Control': 'no-cache',
    'ETag':          etag,
    'Accept-Ranges': 'bytes',
  });
  res.end(buf);
}

// POST /api/inject — 외부 프로세스(cron / heartbeat 등) 가 세션 대화창에 Winter 발화를 꽂는 경로.
// body: { text: string, source: string, session_id?: string, new_session?: boolean }
//   text        — 주입 문자열 (assistant 발화로 렌더)
//   source      — "heartbeat" 같은 발신처 태그 (UI 뱃지 + raw 에 기록)
//   session_id  — 생략 시 가장 최근 updatedAt 세션 사용 (new_session:true 와 동시 사용 불가 → 400)
//   new_session — true 면 신규 세션 생성 후 그 세션에 inject. 기존 대화 오염 방지.
//                 세션 제목: "[{source}] MM-DD HH:mm" 형식으로 세션 리스트에서 알림 세션 식별 가능.
// 응답: { ok:true, session_id } / 에러 { ok:false, error }
// 보안: localhost + trusted peer (isLocalReq, #98). LLM 호출 없음 — 텍스트를 그대로 events jsonl 에 append.
// raw=truth 원칙 준수: 새 winter3.injected 레코드로 append → SSE 자동 발송 → UI 가 winter3.injected
// 를 잡아 assistant 버블로 렌더. SDK 대화 transcript (claudeSessionId 별도 관리) 에는 안 들어감.
async function handleInject(req, res) {
  if (shuttingDown) return sendJson(res, 503, { ok: false, error: 'server shutting down' });
  // localhost + trusted peer 가드 — 서버가 0.0.0.0 bind 라 socket peer 로 확인 (isLocalReq 공통, #98).
  if (!isLocalReq(req)) return sendJson(res, 403, { ok: false, error: 'localhost only' });

  let body;
  try { body = await readBody(req, 512 * 1024); }
  catch (err) { return sendJson(res, err.statusCode || 400, { ok: false, error: err.message }); }

  const text = typeof body?.text === 'string' ? body.text : '';
  const source = typeof body?.source === 'string' ? body.source.trim() : '';
  const requestedSid = typeof body?.session_id === 'string' ? body.session_id.trim() : '';
  const newSession = body?.new_session === true;

  if (!text) return sendJson(res, 400, { ok: false, error: 'text (string) required' });
  if (!source) return sendJson(res, 400, { ok: false, error: 'source (string) required' });
  // new_session 과 session_id 동시 사용 금지
  if (newSession && requestedSid) {
    return sendJson(res, 400, { ok: false, error: 'new_session and session_id are mutually exclusive' });
  }
  // sid 화이트리스트 (기타 라우팅과 동일 문자 집합)
  if (requestedSid && !/^[a-zA-Z0-9_-]+$/.test(requestedSid)) {
    return sendJson(res, 400, { ok: false, error: 'invalid session_id' });
  }

  let sid;
  if (newSession) {
    // 신규 세션 생성 — 제목에 source 와 시각 반영 (사이드바에서 알림 세션 식별용).
    const now = new Date();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const mn = String(now.getMinutes()).padStart(2, '0');
    const title = `[${source}] ${mm}-${dd} ${hh}:${mn}`;
    try {
      const meta = await session.create(title);
      sid = meta.id;
      console.log(`[inject] new_session created sid=${sid} title="${title}"`);
    } catch (err) {
      console.error(`[inject] session.create failed: ${err.message}`);
      return sendJson(res, 500, { ok: false, error: `session create failed: ${err.message}` });
    }
  } else if (requestedSid) {
    const meta = await session.load(requestedSid);
    if (!meta) return sendJson(res, 404, { ok: false, error: 'session not found' });
    sid = requestedSid;
  } else {
    // 가장 최근 활성 세션 = session.list()[0] (updatedAt desc 정렬).
    const list = await session.list();
    if (!list.length) return sendJson(res, 404, { ok: false, error: 'no session available' });
    sid = list[0].id;
  }

  if (!newSession) {
    // 기존 세션 updatedAt 갱신 (사이드바 정렬 반영) — best-effort. 신규 세션은 create() 시 이미 최신.
    try {
      const meta = await session.load(sid);
      if (meta) await session.save(meta);
    } catch { /* */ }
  }

  // raw record — synthetic winter3.injected type. render.js 가 assistant 버블 + source 뱃지로 렌더.
  const raw = {
    type: 'winter3.injected',
    text,
    source,
  };
  try {
    await log.append(sid, raw);
    return sendJson(res, 200, { ok: true, session_id: sid });
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: err.message });
  }
}

async function handleDispatch(req, res) {
  if (shuttingDown) return sendJson(res, 503, { error: 'server shutting down' });
  const body = await readBody(req);
  const { sessionId, userText } = body;
  // researchMode: 1회성 플래그. UI 토글 상태에서만 true. 누락/undefined 시 완전 하위호환 (false).
  // 원칙 P1: raw=truth — userText 는 변조하지 않고, 플래그는 별도 필드로만 runner 에 전달.
  const researchMode = body.researchMode === true;
  if (!sessionId || !userText) return sendJson(res, 400, { error: 'sessionId + userText required' });
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) return sendJson(res, 400, { error: 'invalid sessionId' });
  // Ensure meta exists. If it has default title ("새 대화"), replace with first prompt.
  let meta = await session.load(sessionId);
  if (!meta) {
    meta = {
      id: sessionId,
      title: userText.slice(0, 40) || '새 대화',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      claudeSessionId: null,
      titleAuto: true, // 첫 turn 종료 후 LLM 자동제목 생성 대상 (session-title.maybeAutoTitle).
    };
    await session.save(meta);
  } else if (meta.title === '새 대화') {
    meta.title = userText.slice(0, 40);
    meta.titleAuto = true;
    await session.save(meta);
  }
  try {
    await runner.startTurn({ sessionId, userText, researchMode });
    sendJson(res, 202, { status: 'accepted', sessionId });
  } catch (err) {
    sendJson(res, err.statusCode || 500, { error: err.message });
  }
}

async function handleKill(req, res, sid) {
  const ok = runner.killTurn(sid);
  sendJson(res, ok ? 200 : 404, { killed: ok });
}

async function handleEventsSSE(req, res, sid, afterIdParam, url) {
  // Spec: Last-Event-ID header is authoritative on browser-native reconnect.
  // Fall back to ?last= query param for fresh opens.
  const headerLast = req.headers['last-event-id'];
  let after;
  const isReconnect = headerLast !== undefined && headerLast !== '';
  if (isReconnect) {
    const n = Number(headerLast);
    after = Number.isFinite(n) ? n : -1;
  } else {
    after = Number.isFinite(Number(afterIdParam)) ? Number(afterIdParam) : -1;
  }

  // ?turns=N — 최근 N턴만 catchup. 재연결(Last-Event-ID)이면 무시 (끊긴 지점부터).
  const turnsParam = url ? url.searchParams.get('turns') : null;
  const turnsN = (!isReconnect && turnsParam !== null) ? Number(turnsParam) : null;
  const useTurnsLimit = Number.isFinite(turnsN) && turnsN > 0;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  // Catchup.
  // 작업 1+2: turns 제한 있으면 readAllWithTurns 로 슬라이싱, 없으면 기존 readSince.
  // 두 경로 모두 catchup 구간에 filterCatchupRecords 적용.
  // #50 의존 사항: winter3.catchup_done marker 와 Last-Event-ID 재연결 동작 보존.
  let catchupMeta = null; // turns 제한 시 메타 이벤트용

  if (useTurnsLimit && after === -1) {
    // turns=N + 새 연결(after=-1): 최근 N턴만 전송.
    // lastNTurns 옵션 → event-log 내부에서 startTurnIdx = totalTurns - N 계산 + 부분 pread.
    // 반환된 allRecords 는 startTurnIdx 오프셋부터 EOF 까지의 레코드만.
    // turnBoundaries 는 allRecords 내 상대 recIdx (0-based) 기준.
    const { allRecords, turnBoundaries, totalTurns } = await log.readAllWithTurns(sid, { lastNTurns: turnsN });
    const N = Math.min(turnsN, totalTurns);
    const startTurnIdx = Math.max(0, totalTurns - N);
    // allRecords 는 이미 startTurnIdx 오프셋부터 시작 → sliceFrom = 0 (전체 전송).
    const filtered = log.filterCatchupRecords(allRecords);
    for (const rec of filtered) {
      try { res.write(`id: ${rec.id}\ndata: ${JSON.stringify(rec)}\n\n`); } catch { /* */ }
    }
    catchupMeta = {
      totalTurns,
      sentTurns: N,
      remainingTurns: startTurnIdx,
      oldestSentTurnIndex: startTurnIdx,
    };
  } else {
    // 기존 경로: after 기반 전체(또는 재연결).
    const catchup = await log.readSince(sid, after);
    const filtered = log.filterCatchupRecords(catchup);
    for (const rec of filtered) {
      try { res.write(`id: ${rec.id}\ndata: ${JSON.stringify(rec)}\n\n`); } catch { /* */ }
    }
  }

  // turns 제한 메타 이벤트 — catchup_done 보다 먼저 보내 프론트가 "이전 N개 더보기" 표시 가능.
  if (catchupMeta) {
    try {
      res.write(`data: ${JSON.stringify({ raw: { type: 'winter3.catchup_info', ...catchupMeta } })}\n\n`);
    } catch { /* */ }
  }

  // #39 V3: catchup 끝남 명시 marker. 큰 세션 (32MB+, 57K records) replay 중
  // 250ms idle 휴리스틱이 false-negative 로 catchup 조기 종료 → 남은 turn_end:completed 마다
  // playChime 다중 발화 (사용자 신고 2026-05-13 "삐삐삐삐 답변 완료 소리"). raw envelope 별도 마커.
  // #50 의존: sub-agent orphan 카드 처리가 이 marker 에 의존.
  try { res.write(`data: ${JSON.stringify({ raw: { type: 'winter3.catchup_done' } })}\n\n`); } catch { /* */ }

  // Live tail — 라이브 스트리밍 경로: 필터 없음. text_delta 로 타자 효과 내야 함.
  const unsub = log.subscribe(sid, (rec) => {
    try {
      res.write(`id: ${rec.id}\ndata: ${JSON.stringify(rec)}\n\n`);
    } catch { /* broken pipe */ }
  });

  // Heartbeat.
  const hb = setInterval(() => {
    try { res.write(': hb\n\n'); } catch { /* */ }
  }, 30000);

  req.on('close', () => {
    clearInterval(hb);
    try { unsub(); } catch { /* */ }
  });
}

// === GET /search?q=<text>&limit=<n> — 세션 대화 전문 검색 ==================
// 각 세션의 JSONL 이벤트를 readline 스트림으로 스캔, user + assistant text block 만 검색.
// tool_use input / tool_result 제외 (노이즈+거대). case-insensitive substring.
// 응답: { query, tookMs, results: [{ sid, title, ts, matches, snippet }] }

const EVENTS_DIR_SEARCH = join(HOME, 'data', 'events');
const SESSIONS_DIR_SEARCH = join(HOME, 'data', 'sessions');

function extractTextBlocks(rec) {
  // rec 는 event-log 의 한 레코드 (파싱된 JSON 객체).
  // 현행 포맷: { id, ts, raw: { type, message: { content }, text } }
  // 구형 archived 포맷: 동일 래핑. rec.message / rec.text 는 존재하지 않음.
  // 공통 추출 경로: rec.raw.message.content, rec.raw.text (user_prompt)
  const parts = [];

  function extractContent(content) {
    if (typeof content === 'string') {
      parts.push(content);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          parts.push(block.text);
          // tool_use / tool_result 는 의도적으로 제외
        }
      }
    }
  }

  // 1) 현행 포맷 (rec.raw.* 래핑)
  const rawInner = rec?.raw;
  if (rawInner) {
    if (typeof rawInner.text === 'string') parts.push(rawInner.text);
    extractContent(rawInner?.message?.content);
  }

  // 2) 레거시 플랫 포맷 (래핑 없이 rec.message.content 직접 노출되는 경우 대비)
  if (!rawInner) {
    if (typeof rec?.text === 'string') parts.push(rec.text);
    extractContent(rec?.message?.content);
  }

  return parts.join(' ');
}

function makeSnippet(text, query, radius = 60) {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return '';
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + query.length + radius);
  return (start > 0 ? '…' : '') +
    text.slice(start, end).replace(/\n/g, ' ') +
    (end < text.length ? '…' : '');
}

async function scanSessionForQuery(evtPath, query) {
  return new Promise((resolve) => {
    let matchCount = 0;
    let firstSnippet = '';
    let latestTs = null;
    let lineStream;
    try {
      lineStream = readline.createInterface({
        input: createReadStream(evtPath, { encoding: 'utf8' }),
        crlfDelay: Infinity,
      });
    } catch {
      return resolve({ matchCount: 0, snippet: '', latestTs: null });
    }
    lineStream.on('line', (line) => {
      if (!line.trim()) return;
      let rec;
      try { rec = JSON.parse(line); } catch { return; }
      if (rec?.ts) {
        if (latestTs === null || rec.ts > latestTs) latestTs = rec.ts;
      }
      const text = extractTextBlocks(rec);
      if (!text) return;
      const lText = text.toLowerCase();
      const lQuery = query.toLowerCase();
      let pos = 0, found = 0;
      while ((pos = lText.indexOf(lQuery, pos)) !== -1) { found++; pos += lQuery.length; }
      if (found > 0) {
        matchCount += found;
        if (!firstSnippet) firstSnippet = makeSnippet(text, query);
      }
    });
    lineStream.on('close', () => resolve({ matchCount, snippet: firstSnippet, latestTs }));
    lineStream.on('error', () => resolve({ matchCount, snippet: firstSnippet, latestTs }));
  });
}

async function handleSearch(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const rawQ = url.searchParams.get('q') ?? '';
  const q = rawQ.trim();
  if (Buffer.byteLength(q, 'utf8') < 2) {
    return sendJson(res, 400, { error: 'q must be at least 2 characters' });
  }
  const limitParam = Number(url.searchParams.get('limit') ?? 20);
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(1, limitParam), 50) : 20;

  const t0 = Date.now();

  // 세션 메타 로드 (title)
  let sessionMeta = {};
  try {
    const metaFiles = (await fs.readdir(SESSIONS_DIR_SEARCH)).filter((f) => f.endsWith('.json'));
    await Promise.all(metaFiles.map(async (f) => {
      const sid = f.replace(/\.json$/, '');
      try {
        const m = JSON.parse(await fs.readFile(join(SESSIONS_DIR_SEARCH, f), 'utf8'));
        sessionMeta[sid] = m;
      } catch { /* skip */ }
    }));
  } catch { /* sessions dir 없으면 빈 객체 */ }

  // 이벤트 JSONL 목록 — 현행 + archived 서브디렉토리
  const EVENTS_ARCHIVED_DIR = join(EVENTS_DIR_SEARCH, 'archived');
  // archived 파일명: <uuid>.events.<epoch>.jsonl → sid = <uuid> (첫 세그먼트)
  const archivedSidFromName = (f) => f.split('.')[0];

  let evtEntries = []; // { path, sid, archived }
  try {
    const files = (await fs.readdir(EVENTS_DIR_SEARCH)).filter((f) => f.endsWith('.jsonl'));
    for (const f of files) {
      evtEntries.push({ path: join(EVENTS_DIR_SEARCH, f), sid: f.replace(/\.jsonl$/, ''), archived: false });
    }
  } catch { /* events dir 없으면 skip */ }
  try {
    const archivedFiles = (await fs.readdir(EVENTS_ARCHIVED_DIR)).filter((f) => f.endsWith('.jsonl'));
    for (const f of archivedFiles) {
      evtEntries.push({ path: join(EVENTS_ARCHIVED_DIR, f), sid: archivedSidFromName(f), archived: true });
    }
  } catch { /* archived dir 없으면 skip */ }

  // 파일당 스캔 — 파일별 예외는 skip
  const raw = await Promise.all(evtEntries.map(async ({ path: evtPath, sid, archived }) => {
    try {
      const { matchCount, snippet, latestTs } = await scanSessionForQuery(evtPath, q);
      if (matchCount === 0) return null;
      const meta = sessionMeta[sid];
      const ts = latestTs ?? meta?.updatedAt ?? meta?.createdAt ?? null;
      return { sid, title: meta?.title ?? sid, ts, matches: matchCount, snippet, archived };
    } catch { return null; }
  }));

  const results = raw
    .filter(Boolean)
    .sort((a, b) => {
      if (b.matches !== a.matches) return b.matches - a.matches;
      return (b.ts ?? 0) > (a.ts ?? 0) ? 1 : -1;
    })
    .slice(0, limit);

  sendJson(res, 200, { query: q, tookMs: Date.now() - t0, results });
}

// 작업 3: /history/:sid — "이전 N개 더보기" 버튼용 JSON GET 엔드포인트.
// SSE 가 아니라 일반 JSON GET. catchup 과 동일한 filterCatchupRecords 적용.
//
// 쿼리:
//   ?beforeTurn=<턴인덱스> — 이 인덱스보다 앞쪽 턴을 반환 (미지정 시 0 = 파일 처음부터)
//   ?turns=<개수>          — 최대 몇 턴 반환 (미지정 시 20)
//
// 응답: { records, totalTurns, oldestTurnIndex, remainingTurns, hasMore }
//   records         — 해당 구간의 필터링된 record 배열
//   totalTurns      — 세션 전체 턴 수
//   oldestTurnIndex — 반환된 구간의 가장 오래된 턴 인덱스 (0-based)
//   remainingTurns  — oldestTurnIndex 보다 앞쪽에 남은 턴 수 (프론트 "이전 N개 더보기" 레이블)
//   hasMore         — remainingTurns > 0
async function handleHistory(req, res, sid) {
  // sid 는 라우트 regex /^[a-zA-Z0-9_-]+$/ 를 이미 통과했으므로 path traversal 안전.
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const beforeTurnParam = url.searchParams.get('beforeTurn');
  const turnsParam = url.searchParams.get('turns');

  const beforeTurn = (beforeTurnParam !== null && Number.isFinite(Number(beforeTurnParam)))
    ? Math.max(0, Number(beforeTurnParam))
    : null; // null = 맨 끝
  const requestedTurns = (turnsParam !== null && Number.isFinite(Number(turnsParam)))
    ? Math.max(1, Math.min(200, Number(turnsParam)))
    : 20;

  try {
    // 1단계: idx 만 읽어 totalTurns 빠르게 확인 (파일 전체 안 읽음).
    const totalTurns = await log.readTotalTurns(sid);
    if (totalTurns === 0) {
      return sendJson(res, 200, {
        records: [],
        totalTurns: 0,
        oldestTurnIndex: 0,
        remainingTurns: 0,
        hasMore: false,
      });
    }

    // beforeTurn 이 null 이면 전체 끝 → 마지막 턴 이후 = totalTurns
    const upperTurnIdx = beforeTurn !== null ? Math.min(beforeTurn, totalTurns) : totalTurns;
    // 반환할 구간: [startTurnIdx, upperTurnIdx) 턴
    const startTurnIdx = Math.max(0, upperTurnIdx - requestedTurns);
    const sentTurns = upperTurnIdx - startTurnIdx;

    // 2단계: 구간만 부분 pread.
    // readAllWithTurns 가 [startTurnIdx, upperTurnIdx) 구간 레코드만 반환.
    // allRecords 는 그 구간 전체 — slice(0, allRecords.length) = 전체 사용.
    const { allRecords } = await log.readAllWithTurns(sid, {
      fromTurnIdx: startTurnIdx,
      toTurnIdx: upperTurnIdx,
    });
    const filtered = log.filterCatchupRecords(allRecords);

    const remainingTurns = startTurnIdx;
    return sendJson(res, 200, {
      records: filtered,
      totalTurns,
      oldestTurnIndex: startTurnIdx,
      remainingTurns,
      hasMore: remainingTurns > 0,
    });
  } catch (err) {
    console.error(`[handleHistory] sid=${sid} error:`, err);
    return sendJson(res, 500, { error: err.message });
  }
}

async function handleSessionsList(req, res) {
  const list = await session.list();
  sendJson(res, 200, list);
}

// #20 — Multi-Session PiP Monitor: in-flight sid 목록.
// Oracle 5/5 합의 — runner.runningTurns (in-memory truth) ∪ jsonl tail dangling.
// 서버 재시작 직후 race window 보강 + recovery.js 가 startup 에 닫기 전에도 표시.
async function handleSessionsActive(req, res) {
  const inMem = runner.runningTurnIds();
  const all = await session.list();
  const active = new Set(inMem);
  // jsonl tail 에서 dangling (user_prompt 후 turn_end 없음) 도 union.
  // recovery.js (#6) 가 startup 에 닫지만 1~2 초 race window 보강.
  await Promise.all(all.map(async (s) => {
    if (active.has(s.id)) return;
    if (await log.isDangling(s.id)) active.add(s.id);
  }));
  // Active 세션의 메타 (title 등) 함께 반환 — PiP 가 추가 fetch 안 하게.
  const result = all
    .filter((s) => active.has(s.id))
    .map((s) => ({ id: s.id, title: s.title, inMemory: inMem.includes(s.id) }));
  sendJson(res, 200, result);
}

// #20 — Multi-Session SSE fan-in.
// envelope: `{sid, id, ts, raw}` (rec 자체에 sid 만 추가, raw 무손상 — P1 raw=truth 안 깸).
// SSE event id: `${sid}:${id}` — Last-Event-ID resume 시 sid 별 cursor 분리.
//   query: ?sids=A,B,C (필수) + ?since=A:42,B:17,C:9 (선택, fresh open 의 cursor map)
//   header: Last-Event-ID = "A:42,B:17,C:9" (네이티브 reconnect)
// dedup key (클라 측): `${sid}:${id}` — sid 별 namespace 분리.
async function handleEventsMultiSSE(req, res, url) {
  const sidsParam = url.searchParams.get('sids') || '';
  const sids = sidsParam.split(',').map((s) => s.trim()).filter((s) => /^[a-zA-Z0-9_-]+$/.test(s));
  if (sids.length === 0) return sendJson(res, 400, { error: 'sids query required' });
  if (sids.length > 12) return sendJson(res, 400, { error: 'max 12 sids per stream' });

  // Cursor map 파싱 — header 우선, 없으면 query.
  const headerLast = req.headers['last-event-id'];
  const sinceParam = headerLast || url.searchParams.get('since') || '';
  const cursors = new Map(); // sid → afterId
  if (sinceParam) {
    for (const part of sinceParam.split(',')) {
      const [sid, idStr] = part.split(':');
      const n = Number(idStr);
      if (sid && Number.isFinite(n)) cursors.set(sid, n);
    }
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected (multi)\n\n');

  // Catchup — sid 별 readSince. PiP 는 "지금 진행 중" 만 보면 되니 cursor 기반 partial.
  for (const sid of sids) {
    const after = cursors.has(sid) ? cursors.get(sid) : -1;
    const catchup = await log.readSince(sid, after);
    for (const rec of catchup) {
      const env = { sid, ...rec };
      try { res.write(`id: ${sid}:${rec.id}\ndata: ${JSON.stringify(env)}\n\n`); } catch { /* */ }
    }
  }
  // #39 V3: multi-SSE 도 catchup 끝남 marker. sid 없는 글로벌 marker — PiP 는 무시 OK.
  try { res.write(`data: ${JSON.stringify({ raw: { type: 'winter3.catchup_done' } })}\n\n`); } catch { /* */ }

  // Live tail — N sid 동시 subscribe.
  const unsubs = sids.map((sid) => log.subscribe(sid, (rec) => {
    const env = { sid, ...rec };
    try { res.write(`id: ${sid}:${rec.id}\ndata: ${JSON.stringify(env)}\n\n`); } catch { /* broken pipe */ }
  }));

  // Heartbeat.
  const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch { /* */ } }, 30000);

  req.on('close', () => {
    clearInterval(hb);
    for (const u of unsubs) { try { u(); } catch { /* */ } }
  });
}

async function handleSessionCreate(req, res) {
  if (shuttingDown) return sendJson(res, 503, { error: 'shutting_down' });
  const body = await readBody(req).catch(() => ({}));
  const meta = await session.create(body.title);
  sendJson(res, 201, meta);
}

async function handleSessionInfo(req, res, sid) {
  const meta = await session.load(sid);
  if (!meta) return sendJson(res, 404, { error: 'not found' });
  const last = await log.lastId(sid);
  // 2026-08-19: effective model / 허용 목록 / default model 함께 노출 → 프론트 popover 가 별도 fetch 없이 렌더.
  sendJson(res, 200, {
    ...meta,
    lastEventId: last,
    running: runner.isRunning(sid),
    effectiveModel: runner.getEffectiveModel(meta),
    defaultModel: runner.DEFAULT_MODEL,
    modelAllowlist: runner.MODEL_ALLOWLIST,
  });
}

// Crash diagnostics — silent SIGKILL / uncaught exceptions 까지 stderr 에 남김.
//
// EPIPE / ECONNRESET / ERR_STREAM_DESTROYED 는 expected stream-lifecycle 에러 (peer
// — SDK child stdout 또는 SSE client socket — 가 먼저 close 한 fd 에 write).
// process 죽일 사유 아님. Node default 는 uncaughtException 으로 잡혀 die 하므로
// 명시적 whitelist swallow.
//
// 결정 근거: 설계 검토 만장일치 HIGH (EPIPE-recovery query) —
// "uncaughtException 으로 process 죽이는 건 Node anti-pattern. EPIPE/ECONNRESET 등
//  swallow 가 cross-platform root-cause fix. launchd KeepAlive 단순화나 별도
//  watchdog 은 증상 치료 + lean P0 위반 + Windows 미커버."
//
// whitelist 외 진짜 fatal (TypeError 등) 은 여전히 die → launchd KeepAlive
// (`{SuccessfulExit:false, Crashed:true}`) 가 재기동.
const EXPECTED_STREAM_ERRORS = new Set(['EPIPE', 'ECONNRESET', 'ERR_STREAM_DESTROYED']);
process.on('uncaughtException', (err) => {
  const code = err?.code || err?.errno;
  if (code && EXPECTED_STREAM_ERRORS.has(String(code))) {
    console.error(`[swallow uncaughtException] ${code}: ${err.message || err}`);
    return;  // do NOT exit — peer stream end is recoverable
  }
  console.error('[FATAL uncaughtException]', err?.stack || err);
  // Node 기본 동작 그대로 — exit code 1 → launchd KeepAlive 재기동.
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  const code = reason?.code || reason?.errno;
  if (code && EXPECTED_STREAM_ERRORS.has(String(code))) {
    console.error(`[swallow unhandledRejection] ${code}: ${reason.message || reason}`);
    return;
  }
  console.error('[FATAL unhandledRejection]', reason?.stack || reason);
});
// Graceful shutdown — SIGTERM 받고 즉시 exit 하면 SDK child claude binary 도 SIGHUP 으로 죽어
// in-flight turn 손실. 대신 (1) httpServer.close() 로 새 conn 거부, (2) runningTurns drain 대기
// (max 60s), (3) cleanly exit. 이러면 사용자 turn 이 SIGTERM 와중에도 완료까지 진행.
// 함정: launchd plist 의 `ExitTimeOut` (default 20s) 안에 안 끝나면 SIGKILL 옴 →
// `ExitTimeOut: 90` 이상으로 늘려야 graceful 60s 가 작동.
let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  // #31 V2: runner.js stall path 가 auto_continue 띄울지 결정할 때 참조.
  // shutting down 중이면 startTurn 재진입 차단 → detach restart 의 stop+start 와 race 방지.
  globalThis.WINTER3_SHUTTING_DOWN = true;
  console.error(`[signal] ${signal} received — graceful shutdown begin`);
  // 1) 새 connection 거부 — 기존 connection (SSE 등) 은 살림.
  try { server.close(() => console.error('[signal] http server closed (no new conns)')); } catch {}
  // 2) #29 V5 (audit P0 A): in-flight turn 의 abortController 명시 호출.
  //    이전: drain wait 만 → child SDK alive → 60s timeout → forcing exit → orphan SDK + dangling 누적.
  //    V5: abort 후 catch 블록이 turn_end:interrupted 정상 append → drain 빠르게 0 → exit cleanly.
  const aborted = runner.abortAllTurns('shutdown');
  if (aborted > 0) console.error(`[signal] aborted ${aborted} in-flight turn(s) — drain expected fast`);
  // 3) drain wait — abort 후 catch/finally cleanup 까지. abort 했으니 60s → 10s 충분.
  const MAX_WAIT_MS = 10_000;
  const start = Date.now();
  while (runner.runningTurnCount() > 0 && Date.now() - start < MAX_WAIT_MS) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const left = runner.runningTurnCount();
  if (left > 0) {
    console.error(`[signal] timeout — ${left} turn(s) still running after ${MAX_WAIT_MS}ms, forcing exit`);
  } else {
    const elapsed = Date.now() - start;
    console.error(`[signal] all turns drained in ${elapsed}ms — exiting cleanly`);
  }
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname;

    // up = process uptime(초). 웹 UI 재시작 버튼의 poll 이 down 창(2s 간격에 안 잡힐 수 있음)을
    // 못 봐도 uptime 감소로 재기동을 판별하는 데 쓴다. 기존 소비자(ok 필드/status code)에 무해한 additive.
    if (p === '/health') return sendJson(res, 200, { ok: true, up: Math.floor(process.uptime()) });

    // /restart — 웹 UI 재시작 버튼 (LLM 안 거침). restart.sh 가 child detect → detach →
    // in-flight drain → graceful TERM→KILL → 재기동 전부 처리 (#29 V4/V5, #37).
    if (p === '/restart') {
      if (req.method !== 'POST') { res.writeHead(405); res.end('method not allowed'); return; }
      try {
        const r = scheduleRestart({ home: HOME });
        return sendJson(res, 200, { ok: true, scheduled: true, ...(r.dedup ? { dedup: true } : {}) });
      } catch (err) {
        return sendJson(res, 500, { error: 'restart spawn failed: ' + err.message });
      }
    }
    if ((p === '/settings' || p === '/about') && req.method === 'GET') {
      // UI 가 fetch — composer-hint / empty-meta / about modal 동적 갱신용.
      // **server 가 진짜 확인 가능한 정보만 노출. 모르는 거 (plan, context window) 는 표시 X.**
      let claudeVersion = _claudeVersionCache;
      if (claudeVersion === null) {
        try {
          const { execSync } = await import('node:child_process');
          claudeVersion = execSync('claude --version', { timeout: 3000, encoding: 'utf8' }).trim();
        } catch { claudeVersion = null; }
        _claudeVersionCache = claudeVersion;
      }
      const about = runner.probeAbout();
      // 토큰 상태 — env 우선, 없으면 data/.auth-token 파일 (boin 913-932 동형)
      const _tokenPath = join(HOME, 'data', '.auth-token');
      const _envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN || '';
      let tokenSet = false;
      let tokenSuffix = null;
      if (_envToken) {
        tokenSet = true;
        tokenSuffix = _envToken.slice(-4);
      } else if (existsSync(_tokenPath)) {
        const _fileTok = readFileSync(_tokenPath, 'utf8').trim();
        if (_fileTok) { tokenSet = true; tokenSuffix = _fileTok.slice(-4); }
      }
      return sendJson(res, 200, {
        model: runner.DEFAULT_MODEL,
        permissionMode: runner.PERMISSION_MODE,
        allowedTools: runner.ALLOWED_TOOLS,
        claudeVersion,
        port: PORT,
        // canary 모니터링 미해소 알림 — 플래그 존재 시 내용, 없으면 null (헬퍼가 에러도 null 처리)
        canaryAlert: readCanaryAlert(join(HOME, 'data', 'logs', 'CANARY_ALERT')),
        ...about,
        tokenSet,
        tokenSuffix,
      });
    }
    if (p === '/favicon.ico') { res.writeHead(204); res.end(); return; }

    // /attachments/:sid/:file — 영속 첨부 정적 서빙 (image/PDF/text, path traversal 방지)
    let am = p.match(/^\/attachments\/([a-zA-Z0-9_-]+)\/([^/]+)$/);
    if (am && req.method === 'GET') {
      const [, sid, file] = am;
      const safe = decodeURIComponent(file).replace(/[^A-Za-z0-9._-]/g, '_');
      const fp = join(HOME, 'data', 'attachments', sid, safe);
      const normalized = fp.normalize();
      const root = join(HOME, 'data', 'attachments', sid);
      if (!normalized.startsWith(root) || !existsSync(normalized)) {
        res.writeHead(404); res.end('not found'); return;
      }
      const ext = extname(normalized).toLowerCase();
      const STATIC_MIME = {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
        '.pdf': 'application/pdf',
        '.txt': 'text/plain; charset=utf-8',
        '.md': 'text/markdown; charset=utf-8',
        '.markdown': 'text/markdown; charset=utf-8',
        '.csv': 'text/csv; charset=utf-8',
        '.tsv': 'text/tab-separated-values; charset=utf-8',
        '.log': 'text/plain; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.xml': 'application/xml; charset=utf-8',
        '.html': 'text/html; charset=utf-8',
        '.htm': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
      };
      const TEXT_FALLBACK_EXTS = new Set([
        '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs',
        '.java', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.sh', '.bash', '.zsh',
        '.sql', '.yml', '.yaml', '.toml', '.ini', '.env', '.cfg', '.conf',
        '.scss', '.less', '.vue',
      ]);
      const mime = STATIC_MIME[ext] || (TEXT_FALLBACK_EXTS.has(ext) ? 'text/plain; charset=utf-8' : 'application/octet-stream');
      const buf = await fs.readFile(normalized);
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'private, max-age=3600' });
      res.end(buf);
      return;
    }
    if (p === '/dispatch' && req.method === 'POST') {
      // 가드 — isLocalReq 공통. localhost 전용, 외부 IP 는 403.
      if (!isLocalReq(req)) return sendJson(res, 403, { ok: false, error: 'localhost only' });
      return handleDispatch(req, res);
    }
    // POST /api/inject — 외부 프로세스가 Winter 발화를 세션 대화창에 꽂는 proactive 경로.
    if (p === '/api/inject' && req.method === 'POST') return handleInject(req, res);

    // POST /auth-token — 웹 UI 토큰 온보딩 (claude setup-token 결과 저장 + 즉시 주입)
    if (p === '/auth-token' && req.method === 'POST') {
      if (!isLocalReq(req)) return sendJson(res, 403, { error: 'localhost only' });
      const body = await readBody(req);
      const token = String(body?.token || '').trim();
      if (!/^sk-ant-oat[A-Za-z0-9_-]{10,}$/.test(token)) {
        return sendJson(res, 400, { error: 'invalid token format (sk-ant-oat...)' });
      }
      await saveClaudeToken(token); // 공용 저장 — data/.auth-token + chmod 600 + env 즉시 주입 (동작 동일)
      return sendJson(res, 200, { ok: true, suffix: token.slice(-4) });
    }

    // ── Claude OAuth PKCE 온보딩 (boin 1061-1063 이식) ───────────────────────
    // POST /claude/connect/start  — PKCE 세션 생성 + authUrl 반환
    // GET  /claude/callback       — 브라우저 리다이렉트 수신 → 토큰 교환 → HTML
    // POST /claude/connect/finish — 수동 붙여넣기 fallback → {ok, suffix|error}
    if (p === '/claude/connect/start' && req.method === 'POST') return handleClaudeConnectStart(req, res);
    if (p === '/claude/callback' && req.method === 'GET') return handleClaudeCallback(req, res, url);
    if (p === '/claude/connect/finish' && req.method === 'POST') return handleClaudeConnectFinish(req, res);

    // GET /api/jobs — 백그라운드 job 레지스트리 read-only 관측 (isLocalReq 가드, #98)
    if (p === '/api/jobs' && req.method === 'GET') {
      if (!isLocalReq(req)) return sendJson(res, 403, { ok: false, error: 'localhost only' });
      try {
        return sendJson(res, 200, { jobs: listJobs() });
      } catch (err) {
        console.error(`[api/jobs] listJobs failed: ${err.message}`);
        return sendJson(res, 500, { ok: false, error: err.message });
      }
    }

    // POST /api/jobs/kill — 백그라운드 job SIGTERM (isLocalReq 가드, #98)
    // body: { id: string }
    if (p === '/api/jobs/kill' && req.method === 'POST') {
      if (!isLocalReq(req)) return sendJson(res, 403, { ok: false, error: 'localhost only' });
      let _body;
      try { _body = await readBody(req, 64 * 1024); }
      catch (err) { return sendJson(res, err.statusCode || 400, { ok: false, error: err.message }); }
      const _id = typeof _body?.id === 'string' ? _body.id.trim() : '';
      if (!_id) return sendJson(res, 400, { ok: false, error: 'id (string) required' });
      try {
        const result = killJob(_id);
        return sendJson(res, result.ok ? 200 : 404, result);
      } catch (err) {
        console.error(`[api/jobs/kill] killJob failed: ${err.message}`);
        return sendJson(res, 500, { ok: false, error: err.message });
      }
    }

    // GET /usage — Anthropic 구독 사용량 (app.js 10분 폴링)
    if (p === '/usage' && req.method === 'GET') {
      try {
        const data = await getUsage();
        return sendJson(res, 200, data);
      } catch (err) {
        console.error(`[usage] unhandled error: ${err.message}`);
        return sendJson(res, 200, { data: null, error: 'internal' });
      }
    }

    // === 축 4 Projects (TaskInfo §4) — scope UUID tag. 저장 본체는 server/projects.js. ========
    // list/상세는 조회 시 derive (P1) — 저장된 멤버 리스트/상태 파일 없음. hard delete 라우트 없음 (§4-3(f)).
    // 가드 (QA B1 → #98, isLocalReq 공통) — 서버가 0.0.0.0 bind 라 socket peer 로 확인. localhost + trusted peer 외 403.
    if (p === '/api/projects' || p.startsWith('/api/projects/')) {
      if (!isLocalReq(req)) return sendJson(res, 403, { ok: false, error: 'localhost only' });
    }
    if (p === '/api/projects' && req.method === 'GET') {
      try {
        return sendJson(res, 200, await projects.listProjects());
      } catch (err) {
        console.error(`[api/projects] list 실패: ${err.message}`);
        return sendJson(res, 500, { error: err.message });
      }
    }
    if (p === '/api/projects' && req.method === 'POST') {
      try {
        const body = await readBody(req, 64 * 1024);
        const proj = await projects.createProject(body?.name);
        return sendJson(res, 201, proj);
      } catch (err) {
        console.error(`[api/projects] create 실패: ${err.message}`);
        return sendJson(res, err.statusCode || 500, { error: err.message });
      }
    }
    {
      const pm = p.match(/^\/api\/projects\/([0-9a-fA-F-]{36})$/);
      if (pm && req.method === 'GET') {
        try {
          const proj = await projects.getProject(pm[1]);
          if (!proj) return sendJson(res, 404, { error: 'project not found' });
          return sendJson(res, 200, proj);
        } catch (err) {
          console.error(`[api/projects] get 실패: ${err.message}`);
          return sendJson(res, 500, { error: err.message });
        }
      }
      if (pm && req.method === 'PATCH') {
        // body: { name? } rename / { archived?: boolean } archive 토글. 둘 다 없으면 400 (silent no-op 금지 #34/#35).
        try {
          const body = await readBody(req, 64 * 1024);
          let updated = null;
          if (typeof body?.name === 'string') updated = await projects.renameProject(pm[1], body.name);
          if (typeof body?.archived === 'boolean') updated = await projects.setArchived(pm[1], body.archived);
          if (!updated) return sendJson(res, 400, { error: 'name (string) 또는 archived (boolean) 필요 — hard delete 없음 (archive 만, §4-3(f))' });
          return sendJson(res, 200, updated);
        } catch (err) {
          console.error(`[api/projects] patch 실패: ${err.message}`);
          return sendJson(res, err.statusCode || 500, { error: err.message });
        }
      }
    }

    // === 축 5 REA (TaskInfo §5, 결정 14-19) — 파이프라인 본체는 server/rea.js. =================
    // 업로드는 기존 attach 와 동형의 JSON base64 (서버 전체에 multipart parser 없음 — 진입점 증설 최소).
    // jsonl 엔 winter3.rea_meta ref 만 (#71, contact 계약 6). 삭제는 .trash 이동만 (결정 16).
    // 가드 (QA B1 → #98, isLocalReq 공통) — 임의 로컬 경로 투입/삭제 가능한 표면. localhost + trusted peer 외 403.
    if (p === '/api/rea' || p.startsWith('/api/rea/')) {
      if (!isLocalReq(req)) return sendJson(res, 403, { ok: false, error: 'localhost only' });
    }
    if (p === '/api/rea' && req.method === 'GET') {
      try {
        const pid = url.searchParams.get('projectId');
        return sendJson(res, 200, { items: rea.listRea(pid || null) });
      } catch (err) {
        console.error(`[api/rea] list 실패: ${err.message}`);
        return sendJson(res, 500, { error: err.message });
      }
    }
    if (p === '/api/rea' && req.method === 'POST') {
      // body: { path } (로컬 경로) 또는 { dataBase64, name } (업로드). 옵션: depth, projectId, sid.
      // sid 지정 시 분석 후 세션 jsonl 에 winter3.rea_meta ref append (content 저장 X).
      try {
        const body = await readBody(req, 80 * 1024 * 1024); // base64 팽창 감안 (~60MB 원본)
        const depth = body?.depth === 'deep' ? 'deep' : 'quick';
        const projectId = typeof body?.projectId === 'string' && body.projectId ? body.projectId : null;
        if (projectId) {
          if (!projects.isUuid(projectId)) return sendJson(res, 400, { error: 'projectId: uuid v4 아님' });
          if (!projects.getProjectRaw(projectId)) return sendJson(res, 404, { error: `project not found: ${projectId}` });
        }
        let srcPath = null, origName = null, staged = null;
        if (typeof body?.path === 'string' && body.path) {
          srcPath = body.path; // 명시 경로 인자만 — 디렉터리 스캔 금지 (analyze 가 isFile 검증)
        } else if (typeof body?.dataBase64 === 'string' && body.dataBase64) {
          origName = typeof body?.name === 'string' ? body.name : 'upload.bin';
          const stageDir = join(HOME, 'data', 'rea', '.upload');
          await fs.mkdir(stageDir, { recursive: true });
          staged = join(stageDir, `${Date.now()}.${origName.replace(/[^A-Za-z0-9._-]/g, '_').slice(-60) || 'upload.bin'}`);
          await fs.writeFile(staged, Buffer.from(body.dataBase64, 'base64'));
          srcPath = staged;
        } else {
          return sendJson(res, 400, { error: 'path (string) 또는 dataBase64+name 필요' });
        }
        let meta;
        try {
          meta = await rea.analyze(srcPath, { depth, projectId, origName: origName || undefined });
        } finally {
          if (staged) fs.unlink(staged).catch(() => {}); // 원본은 analyze 가 cache/raw 에 보존
        }
        // 세션 ref — content 금지, meta ref 만 (#71)
        if (typeof body?.sid === 'string' && body.sid) {
          const sessMeta = await session.load(body.sid);
          if (!sessMeta) return sendJson(res, 404, { error: 'session not found', rea: meta });
          await log.append(body.sid, {
            type: 'winter3.rea_meta',
            rea_meta: { hash: meta.hash, size: meta.size, name: meta.origName, format: meta.format, status: meta.status, ...(meta.projectId ? { projectId: meta.projectId } : {}) },
          });
        }
        return sendJson(res, meta.cacheHit ? 200 : 201, meta);
      } catch (err) {
        console.error(`[api/rea] analyze 실패: ${err.message}`);
        return sendJson(res, err.statusCode || 500, { error: err.message });
      }
    }
    {
      const rm = p.match(/^\/api\/rea\/([0-9a-f]{64})$/);
      if (rm && req.method === 'GET') {
        try {
          const d = rea.getRea(rm[1], { withContent: true });
          if (!d) return sendJson(res, 404, { error: 'rea not found' });
          return sendJson(res, 200, d);
        } catch (err) {
          console.error(`[api/rea] get 실패: ${err.message}`);
          return sendJson(res, 500, { error: err.message });
        }
      }
      if (rm && req.method === 'DELETE') {
        // hard delete 아님 — meta/cache 둘 다 .trash 이동, 7일 뒤 sweep (결정 16 + 파괴 방지).
        try {
          return sendJson(res, 200, await rea.trashRea(rm[1]));
        } catch (err) {
          return sendJson(res, err.statusCode || 500, { error: err.message });
        }
      }
      if (rm && req.method === 'PATCH') {
        // body: { projectId: uuid|null } — 축 4 통합 (contact 계약 5). silent no-op 금지.
        try {
          const body = await readBody(req, 64 * 1024);
          if (!('projectId' in body)) return sendJson(res, 400, { error: 'projectId (uuid|null) 필요' });
          const pid = body.projectId === '' ? null : body.projectId;
          if (pid !== null) {
            if (!projects.isUuid(pid)) return sendJson(res, 400, { error: 'projectId: uuid v4 문자열 또는 null' });
            if (!projects.getProjectRaw(pid)) return sendJson(res, 404, { error: `project not found: ${pid}` });
          }
          const meta = await rea.setProjectId(rm[1], pid);
          if (!meta) return sendJson(res, 404, { error: 'rea not found' });
          return sendJson(res, 200, meta);
        } catch (err) {
          console.error(`[api/rea] patch 실패: ${err.message}`);
          return sendJson(res, err.statusCode || 500, { error: err.message });
        }
      }
    }

    if (p === '/sessions' && req.method === 'GET') return handleSessionsList(req, res);
    if (p === '/sessions' && req.method === 'POST') return handleSessionCreate(req, res);
    // #20 — Multi-Session PiP Monitor endpoints.
    if (p === '/sessions/active' && req.method === 'GET') return handleSessionsActive(req, res);
    if (p === '/events-multi' && req.method === 'GET') return handleEventsMultiSSE(req, res, url);

    // /sessions/:id
    let m = p.match(/^\/sessions\/([a-zA-Z0-9_-]+)$/);
    if (m && req.method === 'GET') return handleSessionInfo(req, res, m[1]);
    if (m && req.method === 'PATCH') {
      const body = await readBody(req).catch(() => ({}));
      let updated = null;
      // 축 4: projectId 할당/해제 — body 에 projectId 키가 있을 때만 (additive, 기존 title 경로 무변경).
      // null/'' = 해제. 할당 시 project 존재 검증 — dangling 신규 생성 차단 (#34/#35 계열).
      if ('projectId' in body) {
        const pid = body.projectId === '' ? null : body.projectId;
        if (pid !== null) {
          if (!projects.isUuid(pid)) return sendJson(res, 400, { error: 'projectId: uuid v4 문자열 또는 null' });
          if (!projects.getProjectRaw(pid)) return sendJson(res, 404, { error: `project not found: ${pid}` });
        }
        updated = await session.setProjectId(m[1], pid);
        if (!updated) return sendJson(res, 404, { error: 'not found' });
      }
      if (typeof body.title === 'string' && body.title.trim()) {
        updated = await session.rename(m[1], body.title);
        if (!updated) return sendJson(res, 404, { error: 'not found' });
      }
      if (!updated) return sendJson(res, 400, { error: 'title (string) 또는 projectId (uuid|null) 필요' });
      return sendJson(res, 200, updated);
    }
    if (m && req.method === 'DELETE') {
      // 진행 중이면 먼저 kill
      if (runner.isRunning(m[1])) runner.killTurn(m[1]);
      const result = await session.remove(m[1]);
      return sendJson(res, 200, result);
    }

    // /sessions/:id/restore — undo 용
    m = p.match(/^\/sessions\/([a-zA-Z0-9_-]+)\/restore$/);
    if (m && req.method === 'POST') {
      const result = await session.restore(m[1]);
      return sendJson(res, result.restored ? 200 : 404, result);
    }

    // /sessions/:id/revive — 오염 턴 격리 + 세션 소생 (#59 소생술 실구현).
    // POST body (optional): { redactedPlaceholder?: string, dryRun?: boolean }
    //   - redactedPlaceholder: 치환 문구. 기본값은 transcript-quarantine.js 내 한국어 안내.
    //   - dryRun: true 이면 파일 쓰기 없이 분석 결과만 반환 (디버그용).
    // 동작:
    //   1. 세션 meta 에서 claudeSessionId 를 얻는다.
    //   2. transcript jsonl 경로를 resolve 한다.
    //   3. 마지막 user turn + 직후 refusal assistant turn 을 placeholder 로 치환.
    //   4. 원본은 .quarantine-bak.<ISO> 로 자동 백업.
    // 제약:
    //   - 진행 중인 세션은 409 반환 (race 방지).
    //   - claudeSessionId 없는 세션은 404 반환 (transcript 존재 불가).
    m = p.match(/^\/sessions\/([a-zA-Z0-9_-]+)\/revive$/);
    if (m && req.method === 'POST') {
      const sid = m[1];
      if (runner.isRunning(sid)) {
        // MINOR: 에러 메시지 한국어 통일
        return sendJson(res, 409, { ok: false, error: '세션 실행 중 — 먼저 종료하세요' });
      }
      const meta = await session.load(sid);
      if (!meta) return sendJson(res, 404, { ok: false, error: 'session not found' });
      if (!meta.claudeSessionId) {
        return sendJson(res, 404, { ok: false, error: 'no claudeSessionId — session never started' });
      }
      let body = {};
      try { body = await readBody(req, 64 * 1024); } catch {}
      // MAJOR-1: readBody 완료 후 isRunning 재확인 — TOCTOU race 방지.
      if (runner.isRunning(sid)) {
        return sendJson(res, 409, { ok: false, error: '세션 실행 중 — 먼저 종료하세요' });
      }
      const transcriptPath = resolveTranscriptPath(meta.claudeSessionId, HOME);
      // detect-only 경로 (detectOnly=true): 분석만, 수정 없음.
      if (body.detectOnly) {
        try {
          const detection = await detectRefusalInTranscript(transcriptPath);
          return sendJson(res, 200, {
            ok: true,
            sid,
            claudeSessionId: meta.claudeSessionId,
            transcriptPath,
            ...detection,
          });
        } catch (err) {
          console.error(`[revive/detect] ${sid}: ${err.message}`);
          return sendJson(res, 500, { ok: false, error: err.message });
        }
      }
      const result = await quarantineLastTurn({
        transcriptPath,
        redactedPlaceholder: typeof body.redactedPlaceholder === 'string' ? body.redactedPlaceholder : undefined,
        dryRun: !!body.dryRun,
      });
      if (!result.ok) {
        console.error(`[revive] ${sid}: quarantine failed — ${result.error}`);
        return sendJson(res, 500, { ok: false, error: result.error });
      }
      return sendJson(res, 200, {
        ok: true,
        sid,
        claudeSessionId: meta.claudeSessionId,
        transcriptPath,
        noop: result.noop,
        lastUserIdx: result.lastUserIdx,
        assistantRedacted: result.assistantRedacted,
        backupPath: result.backupPath || null,
        dryRun: result.dryRun || false,
      });
    }

    // /sessions/:id/model — 세션별 model override (2026-08-19).
    // body: {model: "opus"|"sonnet"|"haiku"|"claude-fable-5"|null}. null → 기본으로 복귀.
    // 다음 turn 부터 적용 (진행 중 turn 강제 전환 없음). 원칙 P1 준수: raw 무손상, meta 만 mutate.
    m = p.match(/^\/sessions\/([a-zA-Z0-9_-]+)\/model$/);
    if (m && req.method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const requested = body?.model;
      const clearing = requested === null || requested === '' || requested === undefined;
      if (!clearing && !runner.isAllowedModel(requested)) {
        return sendJson(res, 400, {
          error: 'invalid model',
          allowed: runner.MODEL_ALLOWLIST,
        });
      }
      const updated = await session.setModelOverride(m[1], clearing ? null : requested);
      if (!updated) return sendJson(res, 404, { error: 'not found' });
      return sendJson(res, 200, {
        id: updated.id,
        modelOverride: updated.modelOverride || null,
        effectiveModel: runner.getEffectiveModel(updated),
        defaultModel: runner.DEFAULT_MODEL,
        modelAllowlist: runner.MODEL_ALLOWLIST,
      });
    }

    // /sessions/:id/attach — 파일 업로드 (image / PDF / text, multipart 아니라 JSON base64)
    // 화이트리스트: mime 또는 ext 둘 중 하나가 image/* / application/pdf / text 류 매칭이어야 통과.
    // body: { dataBase64, mime, name? }. name 은 sanitize 후 staging 파일명에 보존 (충돌 방지 timestamp prefix).
    m = p.match(/^\/sessions\/([a-zA-Z0-9_-]+)\/attach$/);
    if (m && req.method === 'POST') {
      if (shuttingDown) return sendJson(res, 503, { error: 'shutting_down' });
      const body = await readBody(req, 10 * 1024 * 1024);
      if (!body?.dataBase64 || !body?.mime) {
        return sendJson(res, 400, { error: 'dataBase64 + mime required' });
      }
      const mime = String(body.mime).toLowerCase();
      const rawName = typeof body.name === 'string' ? body.name : '';
      const nameDot = rawName.lastIndexOf('.');
      const nameExt = nameDot >= 0 ? rawName.slice(nameDot + 1).toLowerCase().replace(/[^a-z0-9]/g, '') : '';

      const TEXT_EXTS = new Set([
        'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log',
        'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs',
        'java', 'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'sh', 'bash', 'zsh',
        'sql', 'yml', 'yaml', 'toml', 'ini', 'env', 'cfg', 'conf',
        'html', 'htm', 'xml', 'svg', 'css', 'scss', 'less', 'vue',
      ]);
      const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
      let kind = null;
      if (mime.startsWith('image/') || IMAGE_EXTS.has(nameExt)) kind = 'image';
      else if (mime === 'application/pdf' || nameExt === 'pdf') kind = 'pdf';
      else if (
        mime.startsWith('text/')
        || mime === 'application/json'
        || mime === 'application/xml'
        || mime === 'application/javascript'
        || mime === 'application/x-yaml'
        || mime === 'application/x-toml'
        || TEXT_EXTS.has(nameExt)
      ) kind = 'text';
      if (!kind) {
        return sendJson(res, 415, { error: 'unsupported mime/ext', mime, ext: nameExt });
      }

      // attach 자체는 메모리/디스크 저장 없이 다음 dispatch 에 즉시 전달하기 위해
      // 임시 스테이징 폴더에 한 파일로 둔다. runner 의 consumeStagedAttachments 가 이 파일을 읽어 content block 으로 변환.
      const { join: pj2 } = await import('node:path');
      const { writeFileSync } = await import('node:fs');
      const STAGE = pj2(HOME, 'data', 'attach-stage');
      const { existsSync: ex, mkdirSync } = await import('node:fs');
      if (!ex(STAGE)) mkdirSync(STAGE, { recursive: true });
      // 저장 ext 결정: 원본 name 의 ext 우선, 없으면 mime sub-type, 없으면 kind 기본값.
      let ext = nameExt;
      if (!ext) {
        if (kind === 'image') ext = (mime.split('/')[1] || 'png').replace(/[^a-z0-9]/g, '') || 'png';
        else if (kind === 'pdf') ext = 'pdf';
        else ext = 'txt';
      }
      // safe name — basename 만 + 화이트리스트 char 만, 길이 60 제한. 비면 attach.<ext>.
      const baseName = rawName.split(/[\\/]/).pop() || '';
      const safeName = (baseName.replace(/[^A-Za-z0-9._-]/g, '_').slice(-60)) || `attach.${ext}`;
      // sessionId prefix 는 runner 의 readdirSync 매칭 패턴 (`${sid}.`).
      const path = pj2(STAGE, `${m[1]}.${Date.now()}.${safeName}`);
      try {
        writeFileSync(path, Buffer.from(body.dataBase64, 'base64'));
      } catch (err) {
        return sendJson(res, 500, { error: 'write failed: ' + err.message });
      }
      return sendJson(res, 201, {
        status: 'staged', path, mime, kind, name: safeName,
        bytes: body.dataBase64.length,
      });
    }

    // /kill/:id
    m = p.match(/^\/kill\/([a-zA-Z0-9_-]+)$/);
    if (m && req.method === 'POST') return handleKill(req, res, m[1]);

    // /events/:id
    m = p.match(/^\/events\/([a-zA-Z0-9_-]+)$/);
    if (m && req.method === 'GET') {
      const after = url.searchParams.get('last');
      return handleEventsSSE(req, res, m[1], after, url);
    }

    // /search — 세션 대화 전문 검색
    if (p === '/search' && req.method === 'GET') return handleSearch(req, res);

    // /history/:id — 이전 턴 페이지네이션 JSON GET (작업 3)
    m = p.match(/^\/history\/([a-zA-Z0-9_-]+)$/);
    if (m && req.method === 'GET') return handleHistory(req, res, m[1]);

    // static
    if (req.method === 'GET') return serveStatic(req, res, p);

    res.writeHead(405); res.end('method not allowed');
  } catch (err) {
    try { sendJson(res, err.statusCode || 500, { error: err.message }); }
    catch { /* */ }
  }
});

// #29 V5 (audit P0 C): EADDRINUSE 발생 시 즉시 die 하지 말고 5s 후 retry (max 3회).
// 옛 process 의 graceful shutdown 직후 TIME_WAIT 가 잡고 있으면 새 listen 이 EADDRINUSE 받음.
// 5s 후 재시도하면 OS 가 socket 정리 끝남.
let listenAttempts = 0;
const MAX_LISTEN_ATTEMPTS = 3;
function tryListen() {
  listenAttempts += 1;
  server.listen(PORT, '0.0.0.0');
}
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && listenAttempts < MAX_LISTEN_ATTEMPTS) {
    console.error(`[winter3] EADDRINUSE — port ${PORT} held by old process. retry in 5s (attempt ${listenAttempts}/${MAX_LISTEN_ATTEMPTS})`);
    setTimeout(tryListen, 5_000);
    return;
  }
  console.error(`[winter3 FATAL] server.error: ${err.code || ''} ${err.message}`);
  process.exit(1);
});
server.on('listening', async () => {
  // #29 V4 — child detection token. SDK child 가 spawn 한 sub-process (Bash tool 등) 까지
  // env inherit 되므로 restart.sh 가 이 env 보고 "child 안에서 호출됐는지" 안전 detect 가능.
  // ppid chain walk 는 SDK 의 setsid 분리로 8단계 안에 winter3 PID 못 잡는 함정 보강.
  process.env.WINTER3_OWNER_PID = String(process.pid);
  console.log(`[winter3] listening on http://0.0.0.0:${PORT}`);
  try {
    const r = await reconcileDanglingTurns();
    console.log(`[winter3] recovery: scanned=${r.scanned} repaired=${r.repaired}`);
  } catch (err) {
    console.error(`[winter3] recovery failed: ${err.message}`);
  }
  // 축 1 scheduler (TaskInfo §1) — data/schedule.json 선언 기반 주기 작업.
  // init 실패해도 서버는 산다 (#44). 선언 조작은 scripts/schedule-ctl.mjs (mtime 폴링 reload).
  try {
    initScheduler({ home: HOME, port: PORT });
  } catch (err) {
    console.error(`[winter3] scheduler init failed: ${err.message}`);
  }
});
tryListen();
