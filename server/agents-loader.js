// server/agents-loader.js — 1.0 (gyuwul/) config/agents/*.md 를 winter3 SDK sub-agent 로 흡수.
//
// SDK 설계 검토 결론: SDK options.agents 가 정확히 이 use case 용 1급 인터페이스.
// 1.0 의 agent-parser.js 패턴을 winter3 로 포팅 (frontmatter / Korean fallback 둘 다 지원).
//
// 호출:
//   import { loadCharacterAgents } from './agents-loader.js';
//   const { agents, names } = loadCharacterAgents(GYUWUL_HOME);
//   queryOptions.agents = agents;
//
// 결과:
//   agents = { hawk: AgentDefinition, hermes: ..., oracle: ..., ... }
//   names  = ['hawk', 'hermes', 'oracle', ...]   (시스템 프롬프트 노출용)
//
// 각 AgentDefinition 은 SDK 타입 (sdk.d.ts:38) 에 맞춰:
//   { description, prompt, tools, model, disallowedTools }
//
// 원칙 P0: Winter context 가볍게. 캐릭터 본문은 sub-agent prompt 안에 격리되어 메인 컨텍스트 오염 X.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

// ─── 1.0 agent-parser.js 포팅 (env.js 의존 제거) ─────────────────────

function extractYamlFrontmatter(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return null;
  const result = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)/);
    if (kv) result[kv[1]] = kv[2].trim();
  }
  return result;
}

// SDK 자체가 'opus' / 'sonnet' / 'haiku' 별칭 인식 (sdk.d.ts:56 — "Model alias (e.g. 'sonnet',
// 'opus', 'haiku') or full model ID"). 풀네임으로 강제 변환하면 오히려 access 검사가
// 엄격해져 dispatch fail (실측: 'claude-opus-4-7' literal 강제 시 sub-agent
// dispatch 가 'claude-sonnet-4-6' fallback 시도 → access denied).
// 별칭 그대로 SDK 에 넘긴다. provider 형식 (provider/model) 만 split.
function normalizeModelId(raw) {
  return raw.includes('/') ? raw.split('/').pop() : raw;
}

function parseModelFromContent(content) {
  const fm = extractYamlFrontmatter(content);
  if (fm?.model) return normalizeModelId(fm.model);
  const m = content.match(/\*\*모델\*\*:\s*(.+)/);
  return m ? normalizeModelId(m[1].trim()) : null;
}

// description 길이 cap — Winter system prompt 에 노출되는 부분이라 P0 (lean context) 보호.
// 200자 = 한국어 약 100-120 자 + 영문 키워드. 그 이상은 Winter dispatch 판단에 잉여.
const DESCRIPTION_MAX_LEN = 200;

function clipDescription(text) {
  if (!text) return text;
  const t = text.trim();
  if (t.length <= DESCRIPTION_MAX_LEN) return t;
  return t.slice(0, DESCRIPTION_MAX_LEN - 1) + '…';
}

function parseRoleFromContent(content) {
  const fm = extractYamlFrontmatter(content);
  // frontmatter 우선순위: description (SDK 표준) → role (1.0 호환)
  if (fm?.description) return clipDescription(fm.description);
  if (fm?.role) return clipDescription(fm.role);
  // 본문 marker 다단 fallback (17-oracle audit 2026-05-03):
  // 이전엔 `**역할**:` 만 매칭 → 누락 시 "X 캐릭터 에이전트" 라는 정보 0 fallback 으로 빠져
  // Winter 가 sub-agent 선택 못 하는 domain confusion 발생.
  const markers = [
    /\*\*역할\*\*:\s*(.+)/,
    /\*\*담당\*\*:\s*(.+)/,
    /\*\*전문\*\*:\s*(.+)/,
    /\*\*Role\*\*:\s*(.+)/i,
  ];
  for (const re of markers) {
    const m = content.match(re);
    if (m) return clipDescription(m[1]);
  }
  return null;
}

// Fable 5 effort 파싱 (2026-08-12) — frontmatter `effort:` 또는 본문 `**effort**:` 마커.
// 유효값: low / medium / high / xhigh / max (SDK sdk.d.ts:465 EffortLevel).
// 제약: dispatch 시점 고정. 대화 중간 변경 시 prompt cache prefix 무효화 — 런타임 변경 로직 만들지 말 것.
// 미지정/파싱 실패 시 fallback = 'medium'.
const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const DEFAULT_EFFORT = 'medium';

function parseEffortFromContent(content) {
  const fm = extractYamlFrontmatter(content);
  if (fm?.effort) {
    const v = fm.effort.trim().toLowerCase().replace(/^["']|["']$/g, '');
    if (VALID_EFFORTS.has(v)) return v;
  }
  const markers = [
    /\*\*effort\*\*:\s*(\w+)/i,
    /\*\*Effort\*\*:\s*(\w+)/,
  ];
  for (const re of markers) {
    const m = content.match(re);
    if (m) {
      const v = m[1].trim().toLowerCase();
      if (VALID_EFFORTS.has(v)) return v;
    }
  }
  return null;
}

function parseToolsFromContent(content) {
  const fm = extractYamlFrontmatter(content);
  if (fm?.tools) {
    const raw = fm.tools.replace(/^\[/, '').replace(/\]$/, '');
    const t = raw.split(',').map(x => x.trim()).filter(Boolean);
    return t.length ? t : null;
  }
  const m = content.match(/\*\*도구\*\*:\s*(.+)/);
  if (!m) return null;
  const t = m[1].split(',').map(x => x.trim()).filter(Boolean);
  return t.length ? t : null;
}

function loadCoreRules(gyuwulHome) {
  const corePath = join(gyuwulHome, 'config', 'rules', 'core.md');
  if (!existsSync(corePath)) return '';
  try { return readFileSync(corePath, 'utf-8'); } catch { return ''; }
}

// ─── Public API ──────────────────────────────────────────────────

// 기본값 — frontmatter 없는 캐릭터에도 안전한 sane default.
const DEFAULT_TOOLS = ['Read', 'Glob', 'Grep', 'Bash'];
const DEFAULT_MODEL = 'claude-fable-5';

// SDK 내장 sub-agent 이름과 충돌 방지. 동일 이름이면 1.0 캐릭터 무시.
const RESERVED = new Set(['Explore', 'Plan', 'general-purpose', 'statusline-setup']);

// 1.0 dispatch 시 메인이 호출하는 orchestrator 캐릭터 ('gyuwul') — winter3 에서는 Winter 자체가
// 그 역할이라 등록 제외. STATUS.md 등 메타 파일도 제외.
const SKIP_FILES = new Set(['STATUS.md', 'gyuwul.md']);

/**
 * 1.0 config/agents/*.md (top-level only, _archive/ 등 서브디렉터리 제외) 를 SDK AgentDefinition
 * 맵으로 변환.
 *
 * @param {string} gyuwulHome - 1.0 루트 (e.g. /Users/.../gyuwul)
 * @param {object} opts
 * @param {string[]} opts.disallowedTools - 각 agent 에도 적용할 deferred-tool blocklist
 * @returns {{ agents: Record<string, AgentDefinition>, names: string[], summary: Array<{name, description}> }}
 */
export function loadCharacterAgents(gyuwulHome, { disallowedTools = [] } = {}) {
  const empty = { agents: {}, names: [], summary: [] };
  if (!gyuwulHome || !existsSync(gyuwulHome)) return empty;

  const dir = join(gyuwulHome, 'config', 'agents');
  if (!existsSync(dir)) return empty;

  const rules = loadCoreRules(gyuwulHome);
  const agents = {};
  const summary = [];

  let entries;
  try { entries = readdirSync(dir); } catch { return empty; }

  for (const f of entries) {
    if (!f.endsWith('.md')) continue;
    if (SKIP_FILES.has(f)) continue;
    const full = join(dir, f);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (!st.isFile()) continue;

    const name = f.slice(0, -3);
    if (RESERVED.has(name)) continue;

    let content;
    try { content = readFileSync(full, 'utf-8'); } catch { continue; }
    if (!content.trim()) continue;

    // description 누락 시 부실 fallback 대신 명시적 warn — Winter dispatch 정확도 보호.
    // (17-oracle audit 2026-05-03: agents-loader.js fallback 부실로 mangjong vs soseo, cheoseo vs chubun
    // 같은 동영역 agent 들 description 균질 → Winter 가 dispatch 시 구분 못 함.)
    let description = parseRoleFromContent(content);
    if (!description) {
      console.warn(`[agents-loader] ${f}: description 누락 — frontmatter 'description:' 또는 본문 '**역할**:' 추가 필요. fallback 사용 중.`);
      description = `${name} (description 누락 — config/agents/${f} 갱신 필요)`;
    }
    const tools = parseToolsFromContent(content) || DEFAULT_TOOLS;
    const model = parseModelFromContent(content) || DEFAULT_MODEL;
    // Fable 5 effort (2026-08-12) — dispatch 시점 고정. sub-agent 대화 중간 변경 금지 (prompt cache prefix 무효화).
    const effort = parseEffortFromContent(content) || DEFAULT_EFFORT;

    // 17-oracle audit 2026-05-03 (#42 Phase 3): core.md (~9.8KB destruction prevention) 무조건 prepend
    // = 17 agent × 9.8KB = 168KB contamination → P0 lean context 위반.
    // selective prepend: write-capable agent (Edit/Write/MultiEdit/NotebookEdit) 만 core.md 박음.
    // R/O agent (Read/Glob/Grep/Bash 만) 는 destruction risk 낮아 core.md skip — context 절약.
    // Bash 단독 agent (cheongmyeong/cheoseo/sanggang/chubun/hermes/minerva/oracle/soman) 는 정찰·검증용
    // — rm 호출 가능성 낮음. 만약 dangerous bash 가능성 차단 필요하면 disallowedTools 로 별도.
    const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
    const isWriteCapable = tools.some((t) => WRITE_TOOLS.has(t));
    const prompt = (rules && isWriteCapable) ? `${rules}\n\n${content}` : content;

    agents[name] = {
      description,
      prompt,
      tools,
      model,
      effort,
      ...(disallowedTools.length ? { disallowedTools } : {}),
    };
    summary.push({ name, description, effort });
  }

  return { agents, names: Object.keys(agents), summary };
}
