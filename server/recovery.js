// server/recovery.js — crash recovery. On startup, any session whose log ended
// mid-turn (no winter3.turn_end after a winter3.user_prompt) gets a synthetic
// `turn_end reason=interrupted` appended so UI doesn't render a forever-running turn.
// Race guard: listen 먼저 뜨고 recovery 나중 실행 → startup 직후 dispatch 가 들어오면
// 새 user_prompt 를 dangling 으로 오판할 수 있음. append 직전 isRunning() 으로 차단.

import { fileURLToPath } from 'node:url';
import { promises as fs, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as log from './event-log.js';
import { isRunning } from './runner.js';

const HOME = process.env.WINTER3_HOME || fileURLToPath(new URL('..', import.meta.url));
const EVENTS_DIR = join(HOME, 'data', 'events');

export async function reconcileDanglingTurns() {
  if (!existsSync(EVENTS_DIR)) return { scanned: 0, repaired: 0 };
  const files = readdirSync(EVENTS_DIR).filter((f) => f.endsWith('.jsonl'));
  let scanned = 0, repaired = 0;
  for (const f of files) {
    scanned++;
    const sid = f.replace(/\.jsonl$/, '');
    try {
      const text = await fs.readFile(join(EVENTS_DIR, f), 'utf8');
      const lines = text.split('\n').filter((l) => l);
      let lastUserPromptId = -1;
      let lastTurnEndId = -1;
      for (const line of lines) {
        try {
          const rec = JSON.parse(line);
          const t = rec.raw?.type;
          if (t === 'winter3.user_prompt') lastUserPromptId = rec.id;
          else if (t === 'winter3.turn_end') lastTurnEndId = rec.id;
        } catch { /* skip */ }
      }
      // #29 V5 (audit P1 B): idempotent guard.
      // 옛 동작은 user_prompt id > turn_end id 만 체크 → 같은 sid 매 startup 마다 false-positive
      // (실측: jsonl 의 last_up=28082 < last_te=28168 인데도 repair 발화). 원인 미상이지만
      // 방어: 마지막 record 가 이미 turn_end 면 dangling 아님. 추가 append skip.
      const lastRec = lines.length > 0 ? lines[lines.length - 1] : null;
      let lastIsTurnEnd = false;
      try {
        if (lastRec) {
          const parsed = JSON.parse(lastRec);
          lastIsTurnEnd = parsed?.raw?.type === 'winter3.turn_end';
        }
      } catch { /* skip */ }
      if (lastUserPromptId > lastTurnEndId && !lastIsTurnEnd) {
        if (isRunning(sid)) {
          process.stderr.write(`[recovery] ${sid}: skipped (turn in-flight)\n`);
          continue;
        }
        await log.append(sid, {
          type: 'winter3.turn_end',
          reason: 'interrupted',
          recovered: true,
        });
        repaired++;
        process.stderr.write(`[recovery] ${sid}: dangling turn closed (interrupted)\n`);
      }
    } catch (err) {
      process.stderr.write(`[recovery] ${sid}: skipped (${err.message})\n`);
    }
  }
  return { scanned, repaired };
}
