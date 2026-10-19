// server/canary-alert.js — CANARY_ALERT 플래그 파일 read 헬퍼.
// scripts/canary-*.mjs 가 이상 감지 시 data/logs/CANARY_ALERT 생성, 정상 복귀 시 삭제.
// 파일 존재 = 미해소 알림. /settings 가 canaryAlert 필드로 노출 → UI 배너.
// 어떤 에러든 null 반환 — /settings 를 500 으로 만들지 않는다.
import { existsSync, readFileSync } from 'node:fs';

export function readCanaryAlert(path) {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
}
