// server/skills-loader.js — #30 follow-up (Oracle a98ec40567747b607).
//
// 2-phase Skill loading: phase 1 = frontmatter manifest 만 systemPrompt 에 박는다.
// phase 2 = Winter 가 트리거 감지 후 SKILL.md 본문을 직접 Read.
//
// 기존 (#30) 은 minerva 한테 "skill 'X' 추출" 위임 → minerva 가 INDEX.md grep → SKILL.md read
// → 본문 return 의 2-hop. 새 패턴은 Winter 가 frontmatter description/whenToUse 만 보고
// 직접 Read $GYUWUL_HOME/skills/<name>/SKILL.md 로 1-hop.
//
// 핵심 boundary (#30 반복 회피):
// - SKILL **본문** 은 systemPrompt 에 절대 안 박는다. frontmatter 만.
// - frontmatter 누락된 SKILL.md = silently skip + stderr warning. 다른 skill 영향 0.
// - INDEX.md 는 그대로 둔다 (사람이 보는 카탈로그). minerva 의 기존 grep 패턴도 그대로.
//   두 source 공존 OK — frontmatter 가 systemPrompt 의 source, INDEX 가 사람의 source.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

// ─── frontmatter parser ─────────────────────────────────────────────
// agents-loader.js:25 의 함수와 동일 패턴. 두 모듈이 같은 시그니처 공유.
// 별도 utils 모듈로 빼지 않은 이유: dependency 단방향 유지 + 호출 비용 0.

export function extractYamlFrontmatter(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return null;
  const result = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)/);
    if (kv) result[kv[1]] = kv[2].trim();
  }
  return result;
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * `${gyuwulHome}/skills/` 의 top-level dir 들을 scan, 각 dir 의 SKILL.md 의 frontmatter
 * 만 읽어서 manifest 배열 + systemPrompt block 을 반환.
 *
 * @param {string} gyuwulHome - gyuwul 루트
 * @returns {{
 *   manifests: Array<{name: string, description: string, whenToUse: string, path: string}>,
 *   systemPromptBlock: string
 * }}
 */
export function loadSkillManifests(gyuwulHome) {
  const empty = { manifests: [], systemPromptBlock: '' };
  if (!gyuwulHome) return empty;

  const skillsDir = join(gyuwulHome, 'skills');
  if (!existsSync(skillsDir)) return empty;

  let entries;
  try { entries = readdirSync(skillsDir); } catch { return empty; }

  const manifests = [];

  for (const name of entries) {
    const skillDir = join(skillsDir, name);
    let st;
    try { st = statSync(skillDir); } catch { continue; }
    if (!st.isDirectory()) continue;

    const skillPath = join(skillDir, 'SKILL.md');
    if (!existsSync(skillPath)) continue;

    let content;
    try { content = readFileSync(skillPath, 'utf-8'); } catch { continue; }
    if (!content.trim()) continue;

    const fm = extractYamlFrontmatter(content);
    if (!fm || !fm.name || !fm.description || !fm.whenToUse) {
      process.stderr.write(`[skills-loader] frontmatter 없음: ${skillPath}\n`);
      continue;
    }

    manifests.push({
      name: fm.name,
      description: fm.description,
      whenToUse: fm.whenToUse,
      path: skillPath,
    });
  }

  manifests.sort((a, b) => a.name.localeCompare(b.name));

  const lines = manifests.map(
    (m) => `- ${m.name}: ${m.description} (when: ${m.whenToUse})`
  );
  const SKILLS_DIR = `${gyuwulHome}/skills`;
  const systemPromptBlock = manifests.length
    ? `## 스킬 카탈로그 (frontmatter — 본문은 invoke 시 read)
${lines.join('\n')}

본문 필요 시 Read ${SKILLS_DIR}/<name>/SKILL.md`
    : '';

  return { manifests, systemPromptBlock };
}
