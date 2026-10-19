// server/rea.js — 축 5 REA (Reverse Engineering Analyzer) 파이프라인 본체.
// REA = 리버싱 분석기만 (원격 실행 분리).
//
// 파이프라인 5단 (§5-3(c)): hash → identify(magic) → unpack(격리) → mechanical → LLM.
// 5단 LLM (M1 통합 2026-10-18): 내부 POST /dispatch 경유 (단일 진입점, #26 직렬) — 백그라운드,
// 결과는 result.md "## LLM 분석" 섹션 + meta.llmStatus('pending'|'ok'|'failed') / llmAt / llmError.
//
// 저장 2원화 (결정 19 — ext4):
//   data/rea/<sha256>/           meta.json + result.md + mechanical/ (meta·요약물 — 영구, drvfs OK)
//   $WINTER3_REA_CACHE_DIR/<sha256>/   raw/ + content/ (실 unpack 결과 — ext4, LRU rotate 대상)
//   기본 cache root = ~/.winter/rea-cache (절대경로 하드코딩 금지 #78/#11 — env override 가능)
//
// 격리 수칙 (기계 강제, §5-5 최상위 함정):
//   1. 모든 외부 도구는 cwd=os.tmpdir() (cache 밖) 에서 호출 + cache 경로는 인자로만 전달.
//   2. interpreter (node/python/sh/…) 에 cache 내부 경로를 인자로 넘기는 spawn = throw (planted module 방어).
//      예외 1곳 (QA S3 문서화): beautifyJs 의 npx js-beautify 는 의도적 runTool bypass —
//      npx 가 INTERPRETER_PREFIXES 가드에 걸리지만 js-beautify 는 대상을 read-only 로만 접근.
//      완화책: --no-install + cwd=SAFE_CWD + 60s timeout. 새 execFile 직접 호출 추가 금지.
//   3. python 류 호출은 -I 필수 (현재 python 미사용 — 가드만 상비).
//   4. 지원 포맷 whitelist 외 = status 'unsupported' + magic hex 명시 보고 (silent skip 금지 #34/#35).
//
// 캐시 LRU (결정 16): index.json {hash: {lastAccess, sizeBytes}} 트래킹, 총 2GB 초과 시
// oldest → <cacheRoot>/.trash/<hash>-<ts>/ 이동 (파괴 방지 — rm 아님). 7일 지난 trash 만 실삭제.
//
// jsonl 금지 (#71, contact 계약 6): 세션엔 winter3.rea_meta {hash, size, name, projectId?} ref 만.

import { fileURLToPath } from 'node:url';
import {
  promises as fs, existsSync, readFileSync, readdirSync, statSync,
  mkdirSync, createReadStream, openSync, readSync, closeSync,
  lstatSync, readlinkSync, unlinkSync,
} from 'node:fs';
import { join, resolve, sep, basename, dirname, extname } from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readSince, lastId } from './event-log.js';

const execFileP = promisify(execFile);

const HOME = process.env.WINTER3_HOME || fileURLToPath(new URL('..', import.meta.url));
export const META_ROOT = join(HOME, 'data', 'rea');
export const CACHE_ROOT = process.env.WINTER3_REA_CACHE_DIR || join(os.homedir(), '.winter', 'rea-cache');
const INDEX_PATH = join(META_ROOT, 'index.json');
const META_TRASH = join(META_ROOT, '.trash');
const CACHE_TRASH = join(CACHE_ROOT, '.trash');
const NODE_NAME = process.platform === 'darwin' ? 'mac' : 'wsl';
const SAFE_CWD = os.tmpdir(); // 외부 도구 cwd — cache 밖 고정 (격리 수칙 1)

// ── caps ────────────────────────────────────────────────────────────────────
const MAX_INPUT_BYTES = 512 * 1024 * 1024;   // 입력 파일 상한
const MAX_UNPACK_BYTES = 2 * 1024 * 1024 * 1024; // 압축폭탄 가드 (§5-5)
const CACHE_CAP_BYTES = 2 * 1024 * 1024 * 1024;  // LRU 총량 (결정 16)
const TRASH_TTL_MS = 7 * 24 * 3600 * 1000;   // trash 7일 후 실삭제
const STRINGS_MIN_LEN = 8;
const STRINGS_MAX_OUT = 10 * 1024 * 1024;    // strings.txt 상한
const TREE_MAX_DEPTH = 3;
const TREE_MAX_LINES = 4000;
const BEAUTIFY_MAX_BYTES = 2 * 1024 * 1024;  // 2MB+ 번들 skip (§5-3(c))
const BEAUTIFY_MAX_FILES = 20;
const GREP_MAX_FILES = 300;
const GREP_MAX_FILE_BYTES = 512 * 1024;
const GREP_SAMPLES_PER_TOKEN = 5;

export const SHA256_RE = /^[0-9a-f]{64}$/;
export function isSha256(v) { return typeof v === 'string' && SHA256_RE.test(v); }

// ── 격리 기계 강제 ──────────────────────────────────────────────────────────
// prefix 매칭 (QA B3-2): python3.11 / node22 / bash5 같은 버전 suffix 변종 전부 커버.
// exact-match Set 폐기 — suffix 는 숫자/./- 로 시작할 때만 매칭 (sha256sum 이 'sh' 에 안 걸리게).
// env / npx 포함 (QA B3-3): `env python <cache경로>` / `npx <cache경로>` 우회 차단.
const INTERPRETER_PREFIXES = [
  'node', 'nodejs', 'deno', 'bun', 'python', 'pypy',
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'ruby', 'perl', 'php', 'lua',
  'env', 'npx',
];

function matchInterpreter(base) {
  for (const name of INTERPRETER_PREFIXES) {
    if (base === name) return name;
    if (base.startsWith(name) && /^[0-9.-]/.test(base.slice(name.length))) return name;
  }
  return null;
}

function isInsideCache(p) {
  try {
    const r = resolve(String(p));
    return r === CACHE_ROOT || r.startsWith(CACHE_ROOT + sep);
  } catch { return false; }
}

/** interpreter 가 분석 대상(캐시 내부 경로)을 인자로 받는 spawn 을 기계 차단 (planted module 방어).
 *  export 는 unit 테스트용 — 런타임 호출 경로는 runTool 단일 + beautifyJs 의 npx 1곳만
 *  의도적 bypass (QA S3 — 헤더 격리 수칙 2 예외 참조). */
export function assertNoTargetExecution(cmd, args) {
  // QA B3-1: cmd 자체가 cache 내부 = 추출물을 실행 바이너리/interpreter 로 쓰려는 시도 — 무조건 차단.
  if (isInsideCache(cmd)) {
    throw new Error(`REA 격리 위반: cache 내부 경로를 실행 커맨드로 사용 — ${cmd} (추출물 실행 절대 금지)`);
  }
  const base = basename(String(cmd)).toLowerCase();
  const hit = matchInterpreter(base);
  if (!hit) return;
  for (const a of args) {
    if (isInsideCache(a)) {
      throw new Error(`REA 격리 위반: interpreter "${base}" 에 분석 대상 경로 인자 — ${a} (대상 코드 실행 절대 금지)`);
    }
  }
  if (hit === 'python' || hit === 'pypy') {
    if (!args.includes('-I')) throw new Error('REA 격리: python 호출은 -I 필수 (planted module 방어)');
  }
}

/** 외부 도구 실행 단일 경로 — cwd 는 항상 cache 밖, 대상 경로는 인자로만. */
async function runTool(cmd, args, { timeoutMs = 120_000 } = {}) {
  assertNoTargetExecution(cmd, args);
  return execFileP(cmd, args, {
    cwd: SAFE_CWD,
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
}

// ── identify — magic bytes 우선, 확장자 불신 (§5-3(b)) ─────────────────────
// 지원 포맷 whitelist. kind: archive(전체 unpack) | native(strings-only) | routed(타 노드)
const FORMAT_TABLE = {
  zip:   { kind: 'archive', mime: 'application/zip' },
  asar:  { kind: 'archive', mime: 'application/octet-stream' },
  tar:   { kind: 'archive', mime: 'application/x-tar' },
  tgz:   { kind: 'archive', mime: 'application/gzip' },
  pe:    { kind: 'native',  mime: 'application/vnd.microsoft.portable-executable' },
  elf:   { kind: 'native',  mime: 'application/x-elf' },
  macho: { kind: 'native',  mime: 'application/x-mach-binary' },
  class: { kind: 'native',  mime: 'application/java-vm' },
  dmg:   { kind: 'routed',  mime: 'application/x-apple-diskimage', requires: 'mac' },
  vhdx:  { kind: 'routed',  mime: 'application/octet-stream',      requires: 'windows-host' },
};
// 확장자 교차용 (불신 — mismatch 기록만, magic 이 항상 이김)
const EXT_HINT = {
  zip: ['zip', 'apk', 'jar', 'ipa', 'dxt', 'mcpb'], asar: ['asar'],
  tar: ['tar'], tgz: ['gz', 'tgz'],
  pe: ['exe', 'dll'], elf: ['so', 'node', 'bin'], macho: ['dylib'],
  class: ['class'], dmg: ['dmg'], vhdx: ['vhdx'],
};

function readHeadTail(filePath) {
  const fd = openSync(filePath, 'r');
  try {
    const size = statSync(filePath).size;
    const head = Buffer.alloc(Math.min(4100, size));
    readSync(fd, head, 0, head.length, 0);
    const tail = Buffer.alloc(Math.min(512, size));
    readSync(fd, tail, 0, tail.length, Math.max(0, size - tail.length));
    return { head, tail, size };
  } finally { closeSync(fd); }
}

/** @returns {{format:string|null, subformat?:string, magicHex:string, extMismatch:boolean}} */
export function identify(filePath, origName = '') {
  const { head, tail } = readHeadTail(filePath);
  const magicHex = head.slice(0, 8).toString('hex');
  const ext = extname(origName || filePath).slice(1).toLowerCase();
  let format = null;

  if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && [3, 5, 7].includes(head[2])) format = 'zip';
  else if (head.length >= 17 && head.readUInt32LE(0) === 4 && head[16] === 0x7b /* '{' */) format = 'asar';
  else if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) format = 'tgz';
  else if (head.length >= 262 && head.slice(257, 262).toString('latin1') === 'ustar') format = 'tar';
  else if (head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a) format = 'pe';
  else if (head.length >= 4 && head[0] === 0x7f && head.slice(1, 4).toString('latin1') === 'ELF') format = 'elf';
  else if (head.length >= 4) {
    const be = head.readUInt32BE(0);
    if (be === 0xfeedface || be === 0xfeedfacf || be === 0xcefaedfe || be === 0xcffaedfe) format = 'macho';
    else if (be === 0xcafebabe || be === 0xcafebabf) {
      // CAFEBABE 중의성: fat Mach-O (nfat_arch 소수) vs java class (minor/major version)
      format = head.length >= 8 && head.readUInt32BE(4) < 0x40 ? 'macho' : 'class';
    }
  }
  // dmg: koly trailer = 파일 끝 512B 블록의 선두 4B (tail 버퍼가 그 블록)
  if (!format && tail.length === 512 && tail.slice(0, 4).toString('latin1') === 'koly') format = 'dmg';
  if (!format && head.length >= 8 && head.slice(0, 8).toString('latin1') === 'vhdxfile') format = 'vhdx';

  // zip 세분 (라벨링용 — 처리는 동일 zip unpack)
  let subformat;
  if (format === 'zip' && ['apk', 'jar', 'ipa', 'dxt', 'mcpb'].includes(ext)) subformat = ext;

  const extMismatch = Boolean(format && ext && !(EXT_HINT[format] || []).includes(ext));
  return { format, subformat, magicHex, extMismatch };
}

// ── index.json (LRU 트래킹) ─────────────────────────────────────────────────
function loadIndex() {
  if (!existsSync(INDEX_PATH)) return { version: 1, entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
    if (parsed && typeof parsed.entries === 'object') return parsed;
  } catch (err) {
    console.error(`[rea] index.json parse 실패 (빈 인덱스로 재구축): ${err.message}`);
  }
  return { version: 1, entries: {} };
}

async function saveIndex(idx) {
  mkdirSync(META_ROOT, { recursive: true });
  const tmp = `${INDEX_PATH}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(idx, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, INDEX_PATH);
}

function dirSizeBytes(dir) {
  let total = 0;
  const walk = (d) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      try {
        if (e.isDirectory()) walk(p);
        else if (e.isFile()) total += statSync(p).size;
      } catch { /* race — skip entry */ }
    }
  };
  if (existsSync(dir)) walk(dir);
  return total;
}

/** 총량 2GB 초과 시 oldest-lastAccess 부터 .trash 이동 (결정 16 — 삭제 아님). */
async function enforceLru() {
  const idx = loadIndex();
  const entries = Object.entries(idx.entries);
  let total = entries.reduce((s, [, v]) => s + (v.sizeBytes || 0), 0);
  if (total <= CACHE_CAP_BYTES) return { evicted: [] };
  entries.sort((a, b) => (a[1].lastAccess || 0) - (b[1].lastAccess || 0));
  const evicted = [];
  for (const [hash, v] of entries) {
    if (total <= CACHE_CAP_BYTES) break;
    const src = join(CACHE_ROOT, hash);
    if (existsSync(src)) {
      mkdirSync(CACHE_TRASH, { recursive: true });
      const dest = join(CACHE_TRASH, `${hash}-${Date.now()}`);
      await fs.rename(src, dest);
      console.error(`[rea] LRU evict → trash: ${hash} (${v.sizeBytes}B, lastAccess=${v.lastAccess})`);
    }
    delete idx.entries[hash];
    total -= v.sizeBytes || 0;
    evicted.push(hash);
    // meta 는 영구 — evictedAt 만 기록
    try {
      const meta = readMeta(hash);
      if (meta) { meta.evictedAt = Date.now(); await writeMeta(meta); }
    } catch (err) { console.error(`[rea] evict meta 갱신 실패 ${hash}: ${err.message}`); }
  }
  await saveIndex(idx);
  return { evicted };
}

async function touchIndex(hash, sizeBytes) {
  const idx = loadIndex();
  idx.entries[hash] = { lastAccess: Date.now(), sizeBytes: sizeBytes ?? idx.entries[hash]?.sizeBytes ?? 0 };
  await saveIndex(idx);
}

/** 7일 지난 trash 실삭제 (meta/cache 양쪽). trash 밖은 절대 안 건드림. */
export async function sweepTrash() {
  const removed = [];
  for (const root of [META_TRASH, CACHE_TRASH]) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      const p = join(root, name);
      try {
        const st = statSync(p);
        if (Date.now() - st.mtimeMs > TRASH_TTL_MS) {
          await fs.rm(p, { recursive: true, force: true });
          removed.push(p);
        }
      } catch (err) { console.error(`[rea] trash sweep 실패 ${p}: ${err.message}`); }
    }
  }
  if (removed.length) console.error(`[rea] trash sweep: ${removed.length}건 실삭제 (7일 경과)`);
  return removed;
}

/** .trash 전부 즉시 비우기 (clear-trash CLI 전용 — 명시 호출만). */
export async function clearTrash() {
  const removed = [];
  for (const root of [META_TRASH, CACHE_TRASH]) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      const p = join(root, name);
      await fs.rm(p, { recursive: true, force: true });
      removed.push(p);
    }
  }
  return removed;
}

// ── meta I/O ────────────────────────────────────────────────────────────────
function metaDir(hash) { return join(META_ROOT, hash); }
function metaPath(hash) { return join(META_ROOT, hash, 'meta.json'); }
function cacheDirOf(hash) { return join(CACHE_ROOT, hash); }

export function readMeta(hash) {
  if (!isSha256(hash)) return null;
  const p = metaPath(hash);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); }
  catch (err) { throw new Error(`meta.json parse 실패 (${hash}): ${err.message}`); }
}

async function writeMeta(meta) {
  const dir = metaDir(meta.hash);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `meta.json.tmp.${process.pid}`);
  await fs.writeFile(tmp, JSON.stringify(meta, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, metaPath(meta.hash));
}

// ── 1단: hash ───────────────────────────────────────────────────────────────
export function sha256File(filePath) {
  return new Promise((res, rej) => {
    const h = createHash('sha256');
    createReadStream(filePath)
      .on('data', (c) => h.update(c))
      .on('end', () => res(h.digest('hex')))
      .on('error', rej);
  });
}

// ── 3단: unpack (포맷별 격리) ───────────────────────────────────────────────
/** zip-slip symlink 변종 방어 (QA B2): 추출 직후 destDir 전수 스캔 → symlink 전부 제거.
 *  lstat 로 link 자체를 보고, symlink 디렉터리는 재귀 진입 안 함 (follow 금지).
 *  cache 밖을 가리키면 escape 로 라벨 — 제거 전 로그 + warning. */
function stripSymlinks(destDir, warnings) {
  let removed = 0;
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      let st;
      try { st = lstatSync(p); } catch { continue; }
      if (st.isSymbolicLink()) {
        let target = '';
        try { target = readlinkSync(p); } catch { /* 깨진 링크 — target 불명이어도 제거 */ }
        const resolvedTarget = resolve(dir, target);
        const escape = !isInsideCache(resolvedTarget);
        const rel = p.slice(destDir.length + 1);
        const msg = `symlink 제거${escape ? ' (cache 밖 — zip-slip 변종)' : ''}: ${rel} → ${target || '(readlink 실패)'}`;
        if (escape) console.error(`[rea] ${msg}`);
        warnings.push(msg);
        try { unlinkSync(p); removed += 1; }
        catch (err) { warnings.push(`symlink 제거 실패 ${rel}: ${err.message}`); }
      } else if (st.isDirectory()) {
        walk(p);
      }
    }
  };
  if (existsSync(destDir)) walk(destDir);
  return removed;
}

function assertDestInside(destDir, rel) {
  const r = resolve(destDir, rel);
  if (r !== destDir && !r.startsWith(destDir + sep)) {
    throw new Error(`unpack 경로 이탈 차단: ${rel}`);
  }
  return r;
}

/** asar — node 내장 구현 (대상 코드 비실행). header pickle: u32(4) | u32(pickleSize) | u32 | u32(jsonLen) | json */
async function unpackAsar(srcPath, destDir, warnings) {
  const buf = await fs.readFile(srcPath);
  if (buf.length < 17 || buf.readUInt32LE(0) !== 4) throw new Error('asar header 불량');
  const jsonLen = buf.readUInt32LE(12);
  const header = JSON.parse(buf.slice(16, 16 + jsonLen).toString('utf8'));
  const base = 8 + buf.readUInt32LE(4);
  let total = 0, files = 0;
  const walk = async (node, rel) => {
    for (const [name, entry] of Object.entries(node.files || {})) {
      if (name.includes('..') || name.includes('/') || name.includes('\\')) {
        warnings.push(`asar entry 거부 (경로 위험): ${name}`); continue;
      }
      const r = rel ? `${rel}/${name}` : name;
      const abs = assertDestInside(destDir, r);
      if (entry.files) { mkdirSync(abs, { recursive: true }); await walk(entry, r); }
      else if (entry.unpacked) { warnings.push(`asar unpacked 외부 파일 skip: ${r}`); }
      else {
        const off = Number(entry.offset), size = Number(entry.size);
        if (!Number.isFinite(off) || !Number.isFinite(size) || size < 0) { warnings.push(`asar entry 불량: ${r}`); continue; }
        total += size;
        if (total > MAX_UNPACK_BYTES) throw Object.assign(new Error(`압축폭탄 가드: asar 해제 총량 ${total}B > cap`), { bombGuard: true });
        mkdirSync(dirname(abs), { recursive: true });
        await fs.writeFile(abs, buf.slice(base + off, base + off + size));
        files += 1;
      }
    }
  };
  mkdirSync(destDir, { recursive: true });
  await walk(header, '');
  return { files, bytes: total };
}

/** QA S2 — UnZip 6.00 (2009) TOCTOU: 아카이브 내 선행 symlink entry 를 후속 entry 쓰기에서
 *  따라감 → `link→cache밖` + `link/payload` 순서 zip 이면 추출 "도중" cache 밖 파일 쓰기 가능.
 *  stripSymlinks 는 추출 "후" 라 이걸 못 막음 — unpack 전 zipinfo 로 entry 목록을 검사해
 *  symlink entry 가 하나라도 있으면 unpack 자체를 거부 (fail-closed).
 *  REA 는 분석 목적 — symlink 없는 아카이브가 정상이므로 거부가 안전 디폴트.
 *  zipinfo 우선, ENOENT 시 unzip -Z fallback (동일 Info-ZIP listing). entry line 첫 글자 'l' = symlink. */
async function assertNoZipSymlinkEntries(srcPath) {
  let listing;
  try {
    const { stdout } = await runTool('zipinfo', [srcPath], { timeoutMs: 120_000 });
    listing = stdout;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw Object.assign(new Error(`zip entry 사전 검사 실패 (zipinfo: ${String(err.message).slice(0, 120)}) — fail-closed 거부`), { symlinkReject: true });
    }
    try {
      const { stdout } = await runTool('unzip', ['-Z', srcPath], { timeoutMs: 120_000 });
      listing = stdout;
    } catch (err2) {
      throw Object.assign(new Error(`zip entry 사전 검사 실패 (unzip -Z: ${String(err2.message).slice(0, 120)}) — fail-closed 거부`), { symlinkReject: true });
    }
  }
  const links = listing.split('\n').filter((l) => l.startsWith('l'));
  if (links.length) {
    throw Object.assign(
      new Error(`symlink entry in zip (REA refuses adversarial symlinks) — ${links.length}개, 예: ${links[0].trim().slice(0, 120)}`),
      { symlinkReject: true },
    );
  }
}

/** zip — 사전 symlink entry 거부 (QA S2) + 사전 bomb 체크 (unzip -l 합계) 후 unzip. 실패 시 post-measure 로 이중 가드. */
async function unpackZip(srcPath, destDir, warnings) {
  await assertNoZipSymlinkEntries(srcPath); // QA S2 — UnZip 6.00 TOCTOU: unpack 전 fail-closed 거부
  try {
    const { stdout } = await runTool('unzip', ['-l', srcPath]);
    const mTotal = stdout.trim().split('\n').pop()?.match(/^\s*(\d+)\s+\d+\s+files?/);
    if (mTotal && Number(mTotal[1]) > MAX_UNPACK_BYTES) {
      throw Object.assign(new Error(`압축폭탄 가드: zip 해제 예상 ${mTotal[1]}B > cap`), { bombGuard: true });
    }
    if (!mTotal) warnings.push('unzip -l 합계 parse 실패 — post-measure 가드로만 검증');
  } catch (err) {
    if (err.bombGuard) throw err;
    warnings.push(`unzip -l 사전 체크 실패 (${err.message?.slice(0, 120)}) — post-measure 가드로만 검증`);
  }
  mkdirSync(destDir, { recursive: true });
  // -n: 기존 파일 덮어쓰기 안 함. cwd 는 runTool 이 cache 밖 고정 — 경로는 인자로만.
  await runTool('unzip', ['-q', '-n', srcPath, '-d', destDir], { timeoutMs: 300_000 });
  stripSymlinks(destDir, warnings); // QA B2 — zip-slip symlink 변종 방어 (추출 직후 전수 제거)
  const bytes = dirSizeBytes(destDir);
  if (bytes > MAX_UNPACK_BYTES) {
    throw Object.assign(new Error(`압축폭탄 가드 (post-measure): ${bytes}B > cap`), { bombGuard: true });
  }
  return { bytes };
}

/** tar / tar.gz — tar 가 압축 자동 감지. 사전 합계 체크 + post-measure. */
async function unpackTar(srcPath, destDir, warnings) {
  try {
    const { stdout } = await runTool('tar', ['-tvf', srcPath], { timeoutMs: 120_000 });
    let total = 0;
    for (const line of stdout.split('\n')) {
      const mSize = line.match(/^\S+\s+\S+\s+(\d+)\s/);
      if (mSize) total += Number(mSize[1]);
    }
    if (total > MAX_UNPACK_BYTES) throw Object.assign(new Error(`압축폭탄 가드: tar 해제 예상 ${total}B > cap`), { bombGuard: true });
  } catch (err) {
    if (err.bombGuard) throw err;
    warnings.push(`tar -tvf 사전 체크 실패 (${err.message?.slice(0, 120)}) — post-measure 가드로만 검증`);
  }
  mkdirSync(destDir, { recursive: true });
  await runTool('tar', ['-xf', srcPath, '-C', destDir], { timeoutMs: 300_000 });
  stripSymlinks(destDir, warnings); // QA B2 — tar symlink entry 전수 제거 (zip-slip 변종 방어)
  const bytes = dirSizeBytes(destDir);
  if (bytes > MAX_UNPACK_BYTES) {
    throw Object.assign(new Error(`압축폭탄 가드 (post-measure): ${bytes}B > cap`), { bombGuard: true });
  }
  return { bytes };
}

// ── 4단: mechanical ─────────────────────────────────────────────────────────
/** strings — node Buffer 로 printable ASCII run (len>=8) 추출. 외부 strings(1) 불요. */
async function extractStrings(srcPath, outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  const out = await fs.open(outPath, 'w');
  let written = 0, lines = 0, truncated = false;
  let run = [];
  try {
    const stream = createReadStream(srcPath, { highWaterMark: 1024 * 1024 });
    for await (const chunk of stream) {
      for (const b of chunk) {
        if (b >= 0x20 && b <= 0x7e) { run.push(b); continue; }
        if (run.length >= STRINGS_MIN_LEN) {
          const line = Buffer.from(run).toString('latin1') + '\n';
          written += line.length; lines += 1;
          if (written > STRINGS_MAX_OUT) { truncated = true; break; }
          await out.write(line);
        }
        run = [];
      }
      if (truncated) break;
    }
    if (!truncated && run.length >= STRINGS_MIN_LEN) { await out.write(Buffer.from(run).toString('latin1') + '\n'); lines += 1; }
    if (truncated) await out.write(`\n[rea] strings 출력 ${STRINGS_MAX_OUT}B 상한 도달 — 이하 생략\n`);
  } finally { await out.close(); }
  return { lines, truncated };
}

/** tree — content/ top N depth. 깊은 디렉터리는 entry 수만 요약. */
function buildTree(contentDir, outPath, note) {
  const lines = [];
  const walk = (dir, depth, prefix) => {
    if (lines.length >= TREE_MAX_LINES) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); }
    catch (err) { lines.push(`${prefix}(readdir 실패: ${err.message})`); return; }
    for (const e of entries) {
      if (lines.length >= TREE_MAX_LINES) { lines.push(`${prefix}… (${TREE_MAX_LINES} 줄 상한)`); return; }
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth >= TREE_MAX_DEPTH) {
          let n = 0; try { n = readdirSync(p).length; } catch {}
          lines.push(`${prefix}${e.name}/ … (${n} entries, depth cap)`);
        } else {
          lines.push(`${prefix}${e.name}/`);
          walk(p, depth + 1, prefix + '  ');
        }
      } else {
        let size = 0; try { size = statSync(p).size; } catch {}
        lines.push(`${prefix}${e.name} (${size}B)`);
      }
    }
  };
  if (contentDir && existsSync(contentDir)) walk(contentDir, 1, '');
  else lines.push(note || '(unpack 산출 없음)');
  mkdirSync(dirname(outPath), { recursive: true });
  return fs.writeFile(outPath, lines.join('\n') + '\n', 'utf8').then(() => ({ lines: lines.length }));
}

function walkFiles(dir, cb) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, cb);
    else if (e.isFile()) cb(p);
  }
}

/** beautify — js 만, npx js-beautify (require 금지 제약). 미설치/실패 = warning 기록 (silent 금지). */
async function beautifyJs(contentDir, outDir, warnings) {
  if (!contentDir || !existsSync(contentDir)) return { done: 0 };
  const targets = [];
  walkFiles(contentDir, (p) => {
    if (!/\.(js|mjs|cjs)$/.test(p)) return;
    try {
      const size = statSync(p).size;
      if (size > BEAUTIFY_MAX_BYTES) { warnings.push(`beautify skip (2MB+ 번들 — grep/strings 모드): ${p.slice(contentDir.length + 1)}`); return; }
      targets.push({ p, size });
    } catch { /* */ }
  });
  targets.sort((a, b) => a.size - b.size);
  let done = 0;
  for (const { p } of targets.slice(0, BEAUTIFY_MAX_FILES)) {
    const rel = p.slice(contentDir.length + 1);
    const out = join(outDir, rel);
    mkdirSync(dirname(out), { recursive: true });
    try {
      // QA S3 — 의도적 runTool bypass (격리 수칙 2 의 유일 예외, 파일 헤더 참조).
      // npx 는 node interpreter 지만 js-beautify 는 대상을 "읽기만" — 실행 아님.
      // --no-install: 미설치 시 네트워크 fetch 로 hang 하는 대신 즉시 실패 → warning.
      await execFileP('npx', ['--no-install', 'js-beautify', '-f', p, '-o', out], {
        cwd: SAFE_CWD, timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
      });
      done += 1;
    } catch (err) {
      warnings.push(`beautify 실패 ${rel}: ${String(err.message).slice(0, 160)}`);
      if (/not found|could not determine|404/i.test(String(err.message))) {
        warnings.push('js-beautify 미설치 추정 — 이후 파일 beautify 중단 (npm i -g js-beautify 또는 npx 캐시 필요)');
        break;
      }
    }
  }
  if (targets.length > BEAUTIFY_MAX_FILES) warnings.push(`beautify 대상 ${targets.length}개 중 상위 ${BEAUTIFY_MAX_FILES}개만 처리`);
  return { done };
}

const GREP_TOKENS = [
  'http://', 'https://', 'ws://', 'wss://', 'localhost', '127.0.0.1',
  'api_key', 'apikey', 'api-key', 'secret', 'token', 'password', 'passwd',
  'bearer', 'authorization', 'private_key', 'BEGIN RSA', 'BEGIN EC',
  'eval(', 'Function(', 'child_process', 'execSync', 'spawn(',
  'require(', 'import(', 'fetch(', 'XMLHttpRequest', 'WebSocket',
  'crypto', 'base64', 'jwt', 'oauth',
  'AndroidManifest', 'Info.plist', 'entitlements', 'sqlite',
  'telemetry', 'sentry', 'amplitude', 'feature_flag', 'featureFlag',
];
const GREP_TEXT_EXTS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.json', '.html', '.htm', '.css', '.xml',
  '.txt', '.md', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf', '.plist',
  '.sh', '.py', '.rb', '.java', '.smali', '.properties', '.env',
]);

/** grep-index — 토큰 사전 매칭 (strings.txt + content 내 텍스트 파일). 읽기만 — 실행 없음. */
async function buildGrepIndex(stringsPath, contentDir, outPath) {
  const hits = Object.fromEntries(GREP_TOKENS.map((t) => [t, { count: 0, samples: [] }]));
  const lowerTokens = GREP_TOKENS.map((t) => [t, t.toLowerCase()]);
  const scanText = (text, fileLabel) => {
    const lns = text.split('\n');
    for (let i = 0; i < lns.length; i++) {
      const lower = lns[i].toLowerCase();
      for (const [tok, lt] of lowerTokens) {
        if (!lower.includes(lt)) continue;
        const h = hits[tok];
        h.count += 1;
        if (h.samples.length < GREP_SAMPLES_PER_TOKEN) {
          h.samples.push({ file: fileLabel, line: i + 1, text: lns[i].trim().slice(0, 200) });
        }
      }
    }
  };
  if (existsSync(stringsPath)) {
    try { scanText(readFileSync(stringsPath, 'latin1'), 'mechanical/strings.txt'); } catch { /* */ }
  }
  let scanned = 0;
  if (contentDir && existsSync(contentDir)) {
    const files = [];
    walkFiles(contentDir, (p) => { if (GREP_TEXT_EXTS.has(extname(p).toLowerCase())) files.push(p); });
    for (const p of files.slice(0, GREP_MAX_FILES)) {
      try {
        if (statSync(p).size > GREP_MAX_FILE_BYTES) continue;
        scanText(readFileSync(p, 'utf8'), p.slice(contentDir.length + 1));
        scanned += 1;
      } catch { /* 읽기 실패 — 바이너리 등, skip */ }
    }
  }
  const compact = Object.fromEntries(Object.entries(hits).filter(([, v]) => v.count > 0));
  mkdirSync(dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify({ tokens: compact, scannedFiles: scanned, ts: Date.now() }, null, 2) + '\n', 'utf8');
  return { tokens: Object.keys(compact).length, scanned };
}

// ── 5단: LLM — 내부 POST /dispatch 경유 (M1 통합) ───────────────────────────
// 계약 (contact 7): POST /dispatch 단일 진입점 — 격리 OK, 세션 분리(`rea-<hash12>`), #26 직렬.
// mechanical 산출만 넘기고 번들 덤프 메인 컨텍스트 반입 금지 (P0/#30) — tree/grep/strings 슬라이스만.
// 응답 수집: data/events/<sid>.jsonl 을 event-log.readSince 로 폴링 (dispatch 는 202 즉시 반환).
const PORT = Number(process.env.WINTER3_PORT || 7979);
const DISPATCH_URL = `http://127.0.0.1:${PORT}/dispatch`;
const LLM_TIMEOUT_MS = { quick: 5 * 60_000, deep: 10 * 60_000 };
const LLM_POLL_MS = 2000;
const LLM_STRINGS_LINES = { quick: 200, deep: 1000 }; // 결정 15: quick 기본
const LLM_TREE_MAX = 400 * 1024;      // /dispatch readBody 4MB 안쪽으로 슬라이스 cap
const LLM_GREP_MAX = 300 * 1024;
const LLM_STRINGS_MAX = 300 * 1024;

function readTextCapped(p, cap) {
  try {
    if (!existsSync(p)) return null;
    const text = readFileSync(p, 'utf8');
    return text.length > cap ? `${text.slice(0, cap)}\n…(${text.length}B 중 ${cap}B 로 절단)` : text;
  } catch (err) { return `(읽기 실패: ${err.message})`; }
}

function buildLLMPrompt(meta, { tree, grepIndex, stringsHead, lineCap }) {
  return [
    `[REA 자동 분석 ${meta.hash.slice(0, 12)}] 다음 mechanical 수확 자료 보고 이 파일이 뭐 하는지 사람이 읽을 수 있게 요약 (200 라인 안쪽).`,
    'REA 파이프라인의 기계 호출 — sub-agent 위임/도구 사용 없이 아래 자료만 근거로 요약만 출력. 서론/마무리/질문 금지. 자료에 없는 건 추측 말고 "자료 부족" 표기.',
    '',
    `파일: ${meta.origName || meta.hash.slice(0, 12)} (${meta.size}B, ${meta.format}${meta.subformat ? `/${meta.subformat}` : ''})`,
    '',
    '섹션:',
    '1) **이 파일의 정체** — 뭐 하는 프로그램/라이브러리인지 1-2 줄',
    '2) **사용 기술/라이브러리** — strings/grep 에서 보이는 프레임워크, SDK, 런타임',
    '3) **네트워크 endpoint** — URL, 도메인, 포트 (grep-index 참조)',
    '4) **보안/권한 특징** — 코드 서명, 패킹, 암호화, 디버그 심볼',
    '5) **특이점** — 눈에 띄는 플래그, 디버그 메시지, 내장 스크립트 등',
    '',
    'mechanical 자료:',
    '--- tree ---',
    tree || '(없음)',
    '--- grep-index ---',
    grepIndex || '(없음)',
    `--- strings 샘플 (${lineCap} 라인) ---`,
    stringsHead || '(없음)',
  ].join('\n');
}

// #26 — fan-out 금지: LLM dispatch 는 모듈 레벨 체인으로 직렬화 (동시 다건 투입돼도 1개씩).
let _llmChain = Promise.resolve();

/**
 * LLM 분석 — 내부 POST /dispatch → 세션 `rea-<hash12>` → events jsonl 폴링으로 응답 수집.
 * throw 하지 않음 — 항상 {ok, text?|reason} 반환 (호출측이 result.md/meta 에 명시 기록, silent no-op 금지).
 * @param {{hash:string, depth:'quick'|'deep', mechanical?:object}} _ mechanical 은 구 시그니처 호환용 (무시 — 파일에서 직접 읽음)
 */
export function invokeLLM({ hash, depth = 'quick' }) {
  const run = () => invokeLLMInner({ hash, depth })
    .catch((err) => ({ ok: false, hash, depth, reason: `invokeLLM 내부 예외: ${err.message}` }));
  const p = _llmChain.then(run, run);
  _llmChain = p.then(() => {}, () => {});
  return p;
}

async function invokeLLMInner({ hash, depth }) {
  const meta = readMeta(hash);
  if (!meta) return { ok: false, hash, depth, reason: `분석 이력 없음: ${hash}` };
  const mech = join(metaDir(hash), 'mechanical');
  const tree = readTextCapped(join(mech, 'tree.txt'), LLM_TREE_MAX);
  const grepIndex = readTextCapped(join(mech, 'grep-index.json'), LLM_GREP_MAX);
  const lineCap = LLM_STRINGS_LINES[depth] || LLM_STRINGS_LINES.quick;
  const stringsRaw = readTextCapped(join(mech, 'strings.txt'), 2 * 1024 * 1024);
  let stringsHead = stringsRaw ? stringsRaw.split('\n').slice(0, lineCap).join('\n') : null;
  if (stringsHead && stringsHead.length > LLM_STRINGS_MAX) stringsHead = `${stringsHead.slice(0, LLM_STRINGS_MAX)}\n…(절단)`;
  if (!tree && !grepIndex && !stringsHead) {
    return { ok: false, hash, depth, reason: 'mechanical 산출 없음 — analyze 먼저 (strings/tree/grep-index 전부 부재)' };
  }

  const sessionId = `rea-${hash.slice(0, 12)}`;
  const startId = await lastId(sessionId); // retry 재사용 시 과거 턴 레코드 제외 anchor (#96 교훈 — cursor 먼저)
  const userText = buildLLMPrompt(meta, { tree, grepIndex, stringsHead, lineCap });

  let resp;
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 30_000);
    resp = await fetch(DISPATCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, userText }),
      signal: ac.signal,
    });
    clearTimeout(t);
  } catch (err) {
    return { ok: false, hash, depth, sessionId, reason: `POST /dispatch 연결 실패 (${err.message}) — 서버(:${PORT}) 기동 확인 후 rea-ctl retry ${hash}` };
  }
  if (resp.status !== 202) {
    const bodyText = await resp.text().catch(() => '');
    return { ok: false, hash, depth, sessionId, reason: `POST /dispatch ${resp.status} — ${bodyText.slice(0, 200)}` };
  }

  const timeoutMs = LLM_TIMEOUT_MS[depth] || LLM_TIMEOUT_MS.quick;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, LLM_POLL_MS));
    let recs;
    try { recs = await readSince(sessionId, startId); } catch (err) {
      return { ok: false, hash, depth, sessionId, reason: `events 로그 read 실패: ${err.message}` };
    }
    const end = recs.find((r) => r.raw?.type === 'winter3.turn_end');
    if (!end) continue;
    if (end.raw.reason !== 'completed') {
      return { ok: false, hash, depth, sessionId, reason: `turn_end:${end.raw.reason}${end.raw.error ? ` — ${String(end.raw.error).slice(0, 200)}` : ''}` };
    }
    const texts = [];
    for (const r of recs) {
      if (r.id > end.id) break; // 이번 턴까지만
      if (r.raw?.type !== 'assistant') continue;
      for (const b of r.raw.message?.content || []) {
        if (b?.type === 'text' && b.text) texts.push(b.text);
      }
    }
    const text = texts.join('\n\n').trim();
    if (!text) return { ok: false, hash, depth, sessionId, reason: 'turn_end:completed 인데 assistant text 0 — events jsonl 확인' };
    return { ok: true, hash, depth, sessionId, text };
  }
  return { ok: false, hash, depth, sessionId, reason: `LLM 응답 timeout ${timeoutMs}ms — 세션 ${sessionId} 로그 확인 후 rea-ctl retry ${hash}` };
}

function grepSummaryOf(hash) {
  try {
    const g = JSON.parse(readFileSync(join(metaDir(hash), 'mechanical', 'grep-index.json'), 'utf8'));
    return { tokens: Object.keys(g?.tokens || {}).length, scanned: g?.scannedFiles };
  } catch { return { tokens: 0, scanned: 0 }; }
}

/** LLM 결과를 meta + result.md 에 반영 — 실패도 명시 기록 (silent no-op 금지). */
async function applyLLMResult(hash, llm) {
  const meta = readMeta(hash);
  if (!meta) { console.error(`[rea] LLM 결과 기록 불가 — meta 소실: ${hash}`); return null; }
  meta.llmStatus = llm.ok ? 'ok' : 'failed';
  meta.llmAt = Date.now();
  if (llm.ok) delete meta.llmError; else meta.llmError = llm.reason;
  await writeResultStub(hash, meta, grepSummaryOf(hash), llm);
  await writeMeta(meta);
  console.error(`[rea] LLM ${meta.llmStatus}: ${hash.slice(0, 12)}${llm.ok ? '' : ` — ${llm.reason}`}`);
  return meta;
}

/** analyze 후 백그라운드 LLM (UI 블록 금지) — 실패도 result.md/meta 에 기록. */
function scheduleBackgroundLLM(hash, depth) {
  setImmediate(async () => {
    try {
      const llm = await invokeLLM({ hash, depth });
      await applyLLMResult(hash, llm);
    } catch (err) {
      console.error(`[rea] LLM 백그라운드 예외 ${hash}: ${err.message}`);
      try { await applyLLMResult(hash, { ok: false, reason: `백그라운드 예외: ${err.message}` }); }
      catch (e2) { console.error(`[rea] LLM 결과 기록 실패 ${hash}: ${e2.message}`); }
    }
  });
}

/** result.md 의 "## LLM 분석" 본문 — 상태별 명시 (pending/ok/failed, silent no-op 금지). */
function llmSectionText(llm, hash) {
  if (!llm) return '_(없음)_';
  if (llm.pending) return '_(LLM 분석 중 — 리스트 ↻ 또는 모달 재오픈으로 갱신)_';
  if (llm.todo) return `_(미통합 placeholder — ${llm.reason})_`;
  if (llm.ok) return llm.text || '_(없음)_';
  return `**LLM 호출 실패 — ${llm.reason}**\n\n\`node scripts/rea-ctl.mjs retry ${hash}\` 로 재시도.`;
}

function writeResultStub(hash, meta, grepSummary, llm) {
  const lines = [
    `# REA result — ${meta.origName || hash.slice(0, 12)}`,
    '',
    `- hash: \`${hash}\``,
    `- format: ${meta.format}${meta.subformat ? ` (${meta.subformat})` : ''} / size: ${meta.size}B / node: ${meta.node}`,
    meta.extMismatch ? `- ⚠ 확장자-magic 불일치 (magic 우선 적용)` : null,
    meta.requires ? `- ⚠ 이 노드에서 unpack 불가 — requires: ${meta.requires}` : null,
    '',
    '## LLM 분석',
    llmSectionText(llm, hash),
    '',
    '## mechanical 요약',
    `- strings: mechanical/strings.txt (${meta.counts?.stringsLines ?? 0} lines${meta.counts?.stringsTruncated ? ', truncated' : ''})`,
    `- tree: mechanical/tree.txt (${meta.counts?.treeLines ?? 0} lines)`,
    `- beautified: ${meta.counts?.beautified ?? 0} js files`,
    `- grep-index: ${grepSummary?.tokens ?? 0} tokens hit / ${grepSummary?.scanned ?? 0} files scanned`,
    meta.warnings?.length ? `\n## warnings\n${meta.warnings.map((w) => `- ${w}`).join('\n')}` : null,
    '',
  ].filter((l) => l !== null);
  return fs.writeFile(join(metaDir(hash), 'result.md'), lines.join('\n'), 'utf8');
}

// ── 파이프라인 orchestration ────────────────────────────────────────────────
/**
 * analyze — 파일 1개 투입 → data/rea/<hash>/ 산출. 캐시 hit 시 unpack/mechanical skip.
 * @param {string} srcPath 분석 대상 (명시 경로만 — 디렉터리 스캔 금지, §5-3(g))
 * @param {{depth?:'quick'|'deep', projectId?:string|null, origName?:string, force?:boolean}} opts
 */
export async function analyze(srcPath, opts = {}) {
  const depth = opts.depth === 'deep' ? 'deep' : 'quick'; // 결정 15: quick 기본
  const abs = resolve(srcPath);
  if (!existsSync(abs)) throw Object.assign(new Error(`파일 없음: ${abs}`), { statusCode: 400 });
  const st = statSync(abs);
  if (!st.isFile()) throw Object.assign(new Error(`파일이 아님 (디렉터리 통째 분석 금지 §5-3(g)): ${abs}`), { statusCode: 400 });
  if (st.size > MAX_INPUT_BYTES) throw Object.assign(new Error(`입력 상한 초과: ${st.size}B > ${MAX_INPUT_BYTES}B`), { statusCode: 413 });

  const origName = opts.origName || basename(abs);
  const hash = await sha256File(abs);

  // 캐시 hit — meta 존재 + 에러 아님 → 즉답 (§5-2 metric)
  const prev = readMeta(hash);
  if (prev && !opts.force && prev.status !== 'error') {
    prev.lastAccess = Date.now();
    if (opts.projectId !== undefined) prev.projectId = opts.projectId || undefined;
    await writeMeta(prev);
    await touchIndex(hash);
    return { ...prev, cacheHit: true };
  }

  const warnings = [];
  const { format, subformat, magicHex, extMismatch } = identify(abs, origName);
  const spec = format ? FORMAT_TABLE[format] : null;

  const meta = {
    hash, origName, size: st.size,
    format: format || 'unknown', subformat, mime: spec?.mime || 'application/octet-stream',
    magicHex, extMismatch,
    createdAt: prev?.createdAt || Date.now(), lastAccess: Date.now(),
    projectId: opts.projectId || prev?.projectId || undefined,
    node: NODE_NAME, depth, status: 'pending', warnings,
    srcRef: abs, counts: {},
  };

  // whitelist 외 = 명시 거부 (#34/#35 — silent 금지). meta 는 남겨서 재투입 시 즉답.
  if (!spec) {
    meta.status = 'unsupported';
    warnings.push(`unsupported format — magic ${magicHex} (whitelist: ${Object.keys(FORMAT_TABLE).join(', ')})`);
    await writeMeta(meta);
    await fs.writeFile(join(metaDir(hash), 'result.md'),
      `# REA — unsupported\n\nmagic \`${magicHex}\` 은 지원 포맷 아님. (zip/asar/tar/tgz/pe/elf/macho/class/dmg/vhdx)\n`, 'utf8');
    return meta;
  }

  const cacheDir = cacheDirOf(hash);
  const contentDir = join(cacheDir, 'content');
  const rawDir = join(cacheDir, 'raw');
  const mechDir = join(metaDir(hash), 'mechanical');
  mkdirSync(rawDir, { recursive: true });
  mkdirSync(mechDir, { recursive: true });

  // 원본 보존 (재분석/분쟁 대비) — cache 쪽 (LRU 대상)
  const safeName = (origName.replace(/[^A-Za-z0-9._-]/g, '_').slice(-80)) || 'input.bin';
  const rawCopy = join(rawDir, safeName);
  if (!existsSync(rawCopy)) await fs.copyFile(abs, rawCopy);

  // unpack — 포맷별 격리
  try {
    if (spec.kind === 'archive') {
      if (format === 'asar') await unpackAsar(rawCopy, contentDir, warnings);
      else if (format === 'zip') await unpackZip(rawCopy, contentDir, warnings);
      else await unpackTar(rawCopy, contentDir, warnings); // tar | tgz
    } else if (spec.kind === 'routed') {
      meta.requires = spec.requires;
      warnings.push(`노드 라우팅: ${format} 은 ${spec.requires} 에서 unpack — 이 노드(${NODE_NAME})는 strings 만`);
    }
    // native: unpack 없음 — strings-only
  } catch (err) {
    if (err.bombGuard) {
      meta.status = 'bomb_guard';
      warnings.push(err.message);
      // 부분 해제물은 trash 로 (cap 발동도 소리 내고 부분 결과 보고 — §5-5)
      if (existsSync(contentDir)) {
        mkdirSync(CACHE_TRASH, { recursive: true });
        await fs.rename(contentDir, join(CACHE_TRASH, `${hash}-bomb-${Date.now()}`));
      }
    } else if (err.symlinkReject) {
      // QA S2 — unpack 전 거부 (fail-closed): 해제물 자체가 없음. strings/tree 는 raw 로 계속.
      meta.status = 'rejected';
      warnings.push(err.message);
    } else {
      meta.status = 'error';
      warnings.push(`unpack 실패: ${err.message}`);
      await writeMeta(meta);
      throw err;
    }
  }

  // mechanical — strings / tree / beautify / grep-index
  const stringsPath = join(mechDir, 'strings.txt');
  const sres = await extractStrings(rawCopy, stringsPath);
  meta.counts.stringsLines = sres.lines;
  meta.counts.stringsTruncated = sres.truncated || undefined;

  const hasContent = existsSync(contentDir);
  const tres = await buildTree(hasContent ? contentDir : null, join(mechDir, 'tree.txt'),
    spec.kind === 'native' ? '(native binary — strings-only, unpack 없음)' :
    meta.requires ? `(requires ${meta.requires} — 이 노드 unpack skip)` :
    meta.status === 'bomb_guard' ? '(압축폭탄 가드 발동 — 해제물 trash 이동)' :
    meta.status === 'rejected' ? '(symlink entry in zip — unpack 거부, QA S2)' : '(unpack 산출 없음)');
  meta.counts.treeLines = tres.lines;

  const bres = await beautifyJs(hasContent ? contentDir : null, join(mechDir, 'beautified'), warnings);
  meta.counts.beautified = bres.done;

  const gres = await buildGrepIndex(stringsPath, hasContent ? contentDir : null, join(mechDir, 'grep-index.json'));

  // 5단: LLM — 분석 완료 후 백그라운드 (UI 블록 금지). pending 상태 명시 후 즉시 반환.
  if (meta.status === 'pending') meta.status = meta.requires ? 'routed' : 'mechanical';
  meta.llmStatus = 'pending';

  await writeResultStub(hash, meta, gres, { pending: true });
  await writeMeta(meta);

  // LRU 갱신 + enforce + trash sweep
  await touchIndex(hash, dirSizeBytes(cacheDir));
  await enforceLru();
  await sweepTrash().catch((err) => console.error(`[rea] sweep 실패: ${err.message}`));

  scheduleBackgroundLLM(hash, depth);
  return meta;
}

/** LLM 재분석 (retry) — mechanical 재사용, dispatch 재호출 + result.md 갱신. CLI 경로라 동기 대기. */
export async function retryLLM(hash, depth = 'quick') {
  const meta = readMeta(hash);
  if (!meta) throw Object.assign(new Error(`분석 이력 없음: ${hash}`), { statusCode: 404 });
  meta.depth = depth === 'deep' ? 'deep' : 'quick';
  meta.lastAccess = Date.now();
  meta.llmStatus = 'pending';
  await writeResultStub(hash, meta, grepSummaryOf(hash), { pending: true });
  await writeMeta(meta);
  const llm = await invokeLLM({ hash, depth: meta.depth });
  const applied = await applyLLMResult(hash, llm); // 실패도 result.md/meta 에 명시
  await touchIndex(hash);
  return { meta: applied || meta, llm };
}

// ── 조회 / 변경 ─────────────────────────────────────────────────────────────
export function listRea(projectId = null) {
  if (!existsSync(META_ROOT)) return [];
  const out = [];
  for (const name of readdirSync(META_ROOT)) {
    if (!isSha256(name)) continue; // index.json / .trash 제외
    try {
      const meta = readMeta(name);
      if (!meta) continue;
      if (projectId && meta.projectId !== projectId) continue;
      out.push(meta);
    } catch (err) { console.error(`[rea] list: ${name} meta 불량 — ${err.message}`); }
  }
  out.sort((a, b) => (b.lastAccess || 0) - (a.lastAccess || 0));
  return out;
}

const PANEL_SLICE = 64 * 1024; // UI 패널용 본문 상한 (full 파일은 디스크에 그대로)
function readSlice(p) {
  try {
    if (!existsSync(p)) return null;
    const fd = openSync(p, 'r');
    try {
      const size = statSync(p).size;
      const buf = Buffer.alloc(Math.min(PANEL_SLICE, size));
      readSync(fd, buf, 0, buf.length, 0);
      return buf.toString('utf8') + (size > PANEL_SLICE ? `\n…(${size}B 중 ${PANEL_SLICE}B — 전체는 ${p})` : '');
    } finally { closeSync(fd); }
  } catch { return null; }
}

export function getRea(hash, { withContent = false } = {}) {
  const meta = readMeta(hash);
  if (!meta) return null;
  if (!withContent) return meta;
  const dir = metaDir(hash);
  const mech = join(dir, 'mechanical');
  let grepIndex = null;
  try { grepIndex = JSON.parse(readFileSync(join(mech, 'grep-index.json'), 'utf8')); } catch { /* */ }
  let beautified = [];
  try {
    const bdir = join(mech, 'beautified');
    if (existsSync(bdir)) walkFiles(bdir, (p) => beautified.push(p.slice(bdir.length + 1)));
  } catch { /* */ }
  return {
    ...meta,
    result: readSlice(join(dir, 'result.md')),
    mechanical: {
      strings: readSlice(join(mech, 'strings.txt')),
      tree: readSlice(join(mech, 'tree.txt')),
      grepIndex,
      beautified,
    },
  };
}

export async function setProjectId(hash, projectIdOrNull) {
  const meta = readMeta(hash);
  if (!meta) return null;
  if (projectIdOrNull) meta.projectId = projectIdOrNull;
  else delete meta.projectId;
  meta.lastAccess = Date.now();
  await writeMeta(meta);
  return meta;
}

/** DELETE — hard delete 아님. meta + cache 둘 다 .trash 이동 (7일 뒤 sweep 이 실삭제). */
export async function trashRea(hash) {
  if (!isSha256(hash)) throw Object.assign(new Error('hash: sha256 hex 아님'), { statusCode: 400 });
  const moved = [];
  const ts = Date.now();
  const mdir = metaDir(hash);
  if (existsSync(mdir)) {
    mkdirSync(META_TRASH, { recursive: true });
    await fs.rename(mdir, join(META_TRASH, `${hash}-${ts}`));
    moved.push('meta');
  }
  const cdir = cacheDirOf(hash);
  if (existsSync(cdir)) {
    mkdirSync(CACHE_TRASH, { recursive: true });
    await fs.rename(cdir, join(CACHE_TRASH, `${hash}-${ts}`));
    moved.push('cache');
  }
  if (!moved.length) throw Object.assign(new Error(`분석 이력 없음: ${hash}`), { statusCode: 404 });
  const idx = loadIndex();
  if (idx.entries[hash]) { delete idx.entries[hash]; await saveIndex(idx); }
  return { hash, trashed: moved, note: '.trash 이동 (hard delete 아님 — 7일 뒤 sweep, clear-trash 로 즉시 비움)' };
}
