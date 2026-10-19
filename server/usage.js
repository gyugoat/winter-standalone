/**
 * server/usage.js
 * Anthropic OAuth 사용량 조회 — GET /usage 백엔드.
 *
 * 응답 계약:
 *   성공/stale: { five_hour, seven_day, seven_day_opus, seven_day_sonnet, fetchedAt, stale }
 *     각 창 = { utilization: <0-100 정수>, resets_at: "<ISO8601>" } 또는 null
 *   데이터 전무: { data: null, error: "rate_limited" | "no_credentials" | "fetch_failed" }
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CREDS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');

// 캐시
let _cache = null; // { data: <성공 응답>, fetchedAt: <Date> }

// 지수 백오프 상태
let _nextRetryAt = null;  // Date — 이 시각 이전이면 upstream fetch 시도 안 함
const BACKOFF_STEPS_MS = [60_000, 5 * 60_000, 30 * 60_000];
let _backoffIdx = 0;

/** credentials 파일에서 accessToken 추출. 실패 시 null 반환 (throw 금지). */
async function _readAccessToken() {
  try {
    const raw = await fs.readFile(CREDS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const token = parsed?.claudeAiOauth?.accessToken;
    if (typeof token !== 'string' || token.length === 0) return null;
    return token;
  } catch {
    return null;
  }
}

/** 업스트림 1회 호출. 성공 시 가공된 data 반환, 실패 시 { _status, _error } 반환. */
async function _fetchFromUpstream(token) {
  let resp;
  try {
    resp = await fetch(USAGE_URL, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'claude-cli/2.1.80 (external, cli)',
        'Content-Type': 'application/json',
      },
    });
  } catch (err) {
    console.error(`[usage] network error fetching upstream: ${err.message}`);
    return { _status: 0, _error: 'network' };
  }

  if (resp.status === 429) {
    console.warn('[usage] upstream 429 — backing off');
    return { _status: 429, _error: 'rate_limited' };
  }

  if (!resp.ok) {
    console.error(`[usage] upstream returned HTTP ${resp.status}`);
    return { _status: resp.status, _error: 'fetch_failed' };
  }

  let body;
  try {
    body = await resp.json();
  } catch (err) {
    console.error(`[usage] upstream JSON parse error: ${err.message}`);
    return { _status: resp.status, _error: 'fetch_failed' };
  }

  // 창 정규화 — utilization float → 정수, null 창은 그대로
  const normalizeWindow = (w) => {
    if (w === null || w === undefined) return null;
    if (typeof w !== 'object') return null;
    const u = w.utilization;
    return {
      utilization: typeof u === 'number' ? Math.round(u) : null,
      resets_at: w.resets_at ?? null,
    };
  };

  return {
    five_hour: normalizeWindow(body.five_hour),
    seven_day: normalizeWindow(body.seven_day),
    seven_day_opus: normalizeWindow(body.seven_day_opus),
    seven_day_sonnet: normalizeWindow(body.seven_day_sonnet),
  };
}

/**
 * getUsage() — 응답 계약 준수 진입점.
 * - TTL(10분) 내 캐시 있으면 캐시 반환 (stale: false).
 * - 백오프 중이면서 캐시 있으면 stale: true 반환.
 * - 백오프 중 캐시도 없으면 { data: null, error } 반환.
 */
export async function getUsage() {
  const now = new Date();
  const TTL_MS = 10 * 60 * 1000;

  // 캐시 신선하면 즉시 반환
  if (_cache && (now - _cache.fetchedAt) < TTL_MS) {
    return { ..._cache.data, fetchedAt: _cache.fetchedAt.toISOString(), stale: false };
  }

  // 백오프 중 → 캐시 있으면 stale, 없으면 에러
  if (_nextRetryAt && now < _nextRetryAt) {
    if (_cache) {
      return { ..._cache.data, fetchedAt: _cache.fetchedAt.toISOString(), stale: true };
    }
    return { data: null, error: 'rate_limited' };
  }

  // credentials 읽기
  const token = await _readAccessToken();
  if (!token) {
    console.warn('[usage] no credentials found at', CREDS_PATH);
    if (_cache) {
      return { ..._cache.data, fetchedAt: _cache.fetchedAt.toISOString(), stale: true };
    }
    return { data: null, error: 'no_credentials' };
  }

  // 업스트림 호출
  const result = await _fetchFromUpstream(token);

  if (result._error) {
    // 백오프 진행
    const stepMs = BACKOFF_STEPS_MS[Math.min(_backoffIdx, BACKOFF_STEPS_MS.length - 1)];
    _backoffIdx = Math.min(_backoffIdx + 1, BACKOFF_STEPS_MS.length - 1);
    _nextRetryAt = new Date(now.getTime() + stepMs);
    console.warn(`[usage] fetch failed (${result._error}), next retry in ${stepMs / 1000}s`);

    if (_cache) {
      return { ..._cache.data, fetchedAt: _cache.fetchedAt.toISOString(), stale: true };
    }
    const errorKey = result._status === 429 ? 'rate_limited' : 'fetch_failed';
    return { data: null, error: errorKey };
  }

  // 성공 — 캐시 갱신, 백오프 리셋
  _cache = { data: result, fetchedAt: now };
  _backoffIdx = 0;
  _nextRetryAt = null;

  return { ...result, fetchedAt: now.toISOString(), stale: false };
}
