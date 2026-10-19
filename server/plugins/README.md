# winter3 플러그인 interface 동결 문서 (축 3)

> **이 문서 = 축 1/2 구현 전 게이트.** 축 1 job-handler / 축 2 voice-provider 는 처음부터 이 shape 로 작성한다 (로더 실체화 시 이동만, 재작업 0).
> 로더 (`server/plugins-loader.js`) 실체화는 축 1/2 완료 후. 그 전까지 이 디렉터리는 README 만 존재.

---

## 1. 디렉터리 구조

```
server/plugins/
  hooks/<name>.js    # SDK hook (gate / observer)
  jobs/<name>.js     # scheduler kind:"handler" job 의 handler 본체
  voice/<name>.js    # STT/TTS provider (sidecar 가 로더 모듈 공유 import)
```

- 유형별 디렉터리 스캔 (§3-3(a) 옵션 A 확정). manifest 없음, npm package 스타일 없음 (1st-party 전제).
- `<name>.js` 파일명 = plugin `name` 필드와 일치해야 함 (kebab-case). 불일치 = shape 오류 → 소리 내고 skip.
- 하위 디렉터리 스캔 안 함 (1 depth). `_` 로 시작하는 파일은 스캔 제외 (공용 util 파일 자리).
- 기존 `server/hooks/*.js` 레거시는 1차에서 이동하지 않음 — 로더는 신규분만. 점진 이동 (1개씩 + qa-hooks 회귀).

## 2. 공통 export shape

모든 플러그인은 named export `plugin` 1개:

```js
export const plugin = {
  type: 'hook' | 'job' | 'voice',  // 필수. 디렉터리와 일치해야 함 (불일치 = shape 오류)
  name: 'my-plugin',               // 필수. kebab-case, 파일명과 일치
  enabled: true,                   // 선택. default true. false = 로드 skip (단, skip 사실은 stderr 1줄 — silent 금지)
  order: 50,                       // 선택. default 50. 낮을수록 먼저 (의미는 §5)
  async init(ctx) {},              // 선택. 로드 시 1회. throw = 해당 플러그인 로드 실패 처리 (§6)
};
```

- 유형별 추가 필드는 §3. 미지 필드는 로더가 warn (typo 탐지 — #34/#35 계열 방어), 단 `x-` prefix 필드는 자유 (실험용).
- 필드명은 `enabled` 로 통일 (schedule.json 의 `enabled` 와 동일 vocab — `enable` 아님). **[이 문서에서 확정]**

## 3. 유형별 export 명세

### 3-1. hooks/<name>.js

```js
export const plugin = {
  type: 'hook', name: 'my-gate',
  role: 'gate' | 'observer',   // 필수. gate = deny 가능 / observer = block 절대 금지 (기록 전용, 항상 {} 계열 반환)
  event: 'PreToolUse',         // 필수. SDK hook event enum (아래)
  matcher: 'Bash',             // PreToolUse/PostToolUse 만 유효 (tool_name regex). 그 외 event 는 생략 또는 '*'
  order: 40,                   // §5 밴드 준수
  failMode: 'closed',          // gate 만. default 'closed' (결정 #8). observer 는 필드 자체 금지 (§7)
  make(ctx) { return async (input) => ({ /* SDK hook 반환 계약 그대로 */ }); },
};
```

- **event enum** (로더가 검증, enum 밖 = shape 오류): `UserPromptSubmit` | `PreToolUse` | `PostToolUse` | `Stop` | `SubagentStop` | `SessionStart` | `SessionEnd` | `PreCompact` | `Notification`.
  - SDK hook event 집합이 CC 와 동일함은 우라까이 대응표 (data/analysis/urakai-mapping.md, system-prompts.md §9 라인) 로 교차 확인됨 — 이 enum 이 로더 shape 검증의 근거.
  - `TeammateIdle` / `WorktreeCreate` 류 CC 확장 이벤트는 SDK 미보장 → enum 비채택. **[이 문서에서 확정]**
- **handler 반환 계약**: SDK 계약 그대로. deny/context 류는 `hookSpecificOutput` 래핑 필수 — top-level 필드는 SDK 가 조용히 무시 (#97/#45). 로더는 dev 모드에서 반환 shape warn 체크 (§3-5 안전망).
- `make(ctx)` 는 로드 시 1회 호출돼 handler 를 반환 — 레거시 `makeXxxHook()` 팩토리 패턴과 동형 (이식 시 body 재사용).

### 3-2. jobs/<name>.js

```js
export const plugin = {
  type: 'job', name: 'gmail-watch',
  async run(ctx) { /* ctx 경유만 — 서버 내부 import 금지 */ },
};
```

- **선언과 본체의 분리**: 스케줄 선언은 `data/schedule.json` 이 단일 소스. 플러그인 파일은 handler 본체만 — 플러그인이 자기 schedule 을 선언하는 필드는 두지 않는다 (선언처 2곳 = §1-1 산재 문제 재생산). **[이 문서에서 확정]**
- schedule.json 엔트리의 `kind` 4종과 플러그인의 관계:
  | kind | 실행 경로 | 플러그인 관여 |
  |---|---|---|
  | `turn` | HTTP `POST localhost:7979/dispatch` (runner 직접 import 금지) | 없음 |
  | `inject` | `POST /api/inject` → log.append(injected) | 없음 |
  | `shell` | child spawn + bg-jobs.jsonl 레지스트리 등록 | 없음 |
  | `handler` | `plugins/jobs/<handlerName>.js` 의 `run(ctx)` | **이 유형** |
- schedule 포맷 (§1-3(a) B 확정): `every: "30m"|"1h"` (interval+anchor, scheduler 가 anchor 기반 due 재계산) 또는 `dailyAt: "HH:MM"`. `cron` 필드는 자리만 예약 (미구현). `node: "mac"|"wsl"|"both"` 필수.
- `run(ctx)` 반환값: `{ ok, summary }` (선택). scheduler 가 `winter3.job_run {jobId, ok, durationMs, summary}` 레코드로 기록. throw = `ok:false` 기록, scheduler 재투입 금지 (#26 이중 retry 금지).
- state 접근: `ctx.state` (§4) — `data/schedule-state.json` 의 jobId 네임스페이스. schedule.json 에 상태 쓰기 금지 (결정 #1).

### 3-3. voice/<name>.js

```js
export const plugin = {
  type: 'voice', name: 'gpt-sovits',
  kind: 'tts',                                          // 'stt' | 'tts'
  async health(ctx) {},                                 // upstream 체크 (docker alive 등). throw/false = unavailable
  async *synthesize(text, { voice, abortSignal }) {},   // tts 전용: audio chunk async iterator
  async transcribe(pcmStream, { lang }) {},             // stt 전용: 확정 텍스트 반환
};
```

- kind 별 필수 메서드: tts = `synthesize`, stt = `transcribe`. 반대쪽 메서드 존재 = shape 오류 (한 파일 = 한 역할).
- **노드 로컬 자급자족 전제 (결정 #5)**: provider 의 upstream 은 자기 노드 로컬 (localhost docker :9880, 로컬 faster-whisper 등) 만. 크로스 노드 오디오 전송을 전제하는 provider 금지 — 오디오는 입력/출력된 노드에서 처리, 노드 간엔 텍스트만 (§2-3(b)(c)(h)).
- `voice` 파라미터: 캐릭터별 보이스 예약 (config/agents/<name>.md frontmatter `voiceRef:` 맵 — 1차 범위 밖, interface 만 선점).
- `abortSignal`: barge-in 시 sidecar 가 fire — provider 는 즉시 중단 책임 (결정 #6: 도구 실행 중엔 TTS 만 정지).
- 오디오 산출물은 jsonl 금지 — `data/voice/<sid>/…wav` 파일 + ref (#71 패턴). provider 는 chunk 만 뱉고 저장은 sidecar 책임.

## 4. ctx 주입 명세

**규율: 플러그인은 server 내부 모듈을 직접 import 하지 않는다. 로더가 넘겨주는 ctx 만 사용.** (단일 진입점 보존 — 직접 import 1건 = 로더 체계 전체 무력화)

공통 ctx:
| 필드 | 설명 |
|---|---|
| `ctx.log(level, msg, data?)` | stderr + 필요 시 `winter3.plugin_error` 가시화 경로 (§6) |
| `ctx.dataDir` | `data/` 절대경로 (GYUWUL_HOME 기반 — 절대경로 하드코딩 금지, #78/#11) |
| `ctx.node` | `'mac'` \| `'wsl'` — 현재 머신 |
| `ctx.env` | 화이트리스트된 env 서브셋 (process.env 직접 노출 안 함) |

유형별 확장:
| 유형 | 추가 필드 |
|---|---|
| hook | `ctx.cacheDir`, `ctx.stateDir` (staleness/qa-gate 류 상태 디렉터리) |
| job | `ctx.dispatch(sid, text, opts)` — 내부가 **HTTP POST localhost:7979/dispatch** (runner import 아님) / `ctx.inject(sid, payload)` — POST /api/inject / `ctx.state.get(key)` `ctx.state.set(key, val)` — jobId 스코프, schedule-state.json persist |
| voice | 추가 없음 (자급자족 — upstream 주소는 플러그인 자체 상수/env) |

- 금지 경로 명시: 플러그인에서 `restart.sh` 호출 금지 (#31 재귀), systemPrompt 주입 API 없음 (P0 + §3-3(d) — 모델 노출은 skill manifest / sub-agent / UserPromptSubmit additionalContext 3경로 한정).

## 5. 로드 순서

- 단일 축 = `order` 숫자 오름차순. 동률 = `name` 사전순. **[이 문서에서 확정]** 플러그인 간 의존성 선언 금지 (의존 필요하면 한 파일로 합쳐라).
- hook order 밴드 (#45 mechanical-deny-first 정책의 숫자 인코딩):
  | 밴드 | 역할 | 예 (레거시 대응물) |
  |---|---|---|
  | 10–29 | mechanical deny (조건 즉시 차단) | winter-never-edits, hawk-usermd-gate, forge-deny |
  | 30–49 | 검문 gate (상태 보고 판단) | qa-ship-gate, commit-policy-gate |
  | 50+ | 기록 / observer (block 금지) | dirty-recorder, refusal-sanitize, lesson-marker |
- 밴드-역할 정합 검증: `role:'gate'` 인데 order≥50, 또는 `role:'observer'` 인데 order<50 = 로더 warn (deny 아님 — 밴드는 정책이지 기계 제약 아님). **[이 문서에서 확정]**
- **레거시 merge 순서 (§3-4 step 2)**: combineHooks 는 같은 event/matcher 의 `hooks[]` 배열에서 **레거시 먼저, 플러그인을 뒤에 order 순 append**. 따라서 order<30 (mechanical-deny) 신규 hook 이 레거시 gate 보다 먼저 실행돼야 하는 경우, 해당 레거시 hook 의 플러그인 이식이 선행 조건 — interleave 로직은 만들지 않는다 (복잡도 = 버그 표면). **[이 문서에서 확정]**
- jobs/voice 의 order 는 로드(등록) 순서만 결정 — 실행 순서는 scheduler(직렬)/sidecar 가 소유.

## 6. 실패 격리

**silent no-op 절대 금지 (#34/#35 — 이 코드베이스 최악 함정 계열). 모든 실패는 소리 낸다.**

- 로드 단계: per-file `dynamic import()` try/catch. 실패 (syntax error / shape 오류 / init throw) 시:
  1. stderr 1줄 (file + error)
  2. `data/plugin-errors.jsonl` 에 `winter3.plugin_error {ts, file, name?, phase:'load', error}` append — bg-jobs.jsonl 과 동형의 전용 레지스트리 (기동 시점엔 세션이 없으므로 세션 jsonl 부적합). UI activity 가 consume (P1 — 서버는 raw append 만). **[이 문서에서 확정 — TaskInfo 의 "시스템 세션 또는 기동 로그" 미결을 전용 jsonl 로 확정]**
  3. **skip 후 계속** — 서버 기동/타 플러그인 영향 0 (§3-2 metric: 고의 syntax-error 투입 qa 로 실측)
- 런타임 단계 (hook handler throw): 로더 wrap 이 잡고 `phase:'runtime'` 으로 동일 가시화 후,
  - observer → `{}` 반환으로 degrade (턴 지속)
  - gate → §7 failMode 적용
- job `run` throw → `winter3.job_run ok:false` (§3-2). voice `health` 실패 → provider unavailable, sidecar 가 폴백/오류 발화 (silent 침묵 금지).

## 7. failMode — gate 기본값 = closed (확정)

**gate hook 의 failMode 기본값 = `'closed'`.**

- `failMode: 'closed'` (default): handler throw/로드 실패 시 해당 tool 호출 **deny** — deny reason = `"plugin <name> error — fail-closed"` (모델이 보는 유일 문구). 근거: #39 V6 fail-closed 전환 교훈 — 보안 gate 가 에러로 열리면 gate 부재와 동일.
- `failMode: 'open'`: 명시 선언 시만. 비보안 편의성 gate 용 — 선언 자체가 "이 gate 는 뚫려도 안전" 의 서면 주장.
- observer 는 `failMode` 필드 선언 금지 (shape 오류) — observer 는 정의상 항상 open (`{}` degrade). 기록용 hook 이 턴을 죽이는 구성을 기계적으로 불가능하게 함. **[이 문서에서 확정]**
- job/voice 에 failMode 없음 — 실패 의미가 §6 에서 유형별로 이미 고정.

## 8. 예시 플러그인 스켈레톤 (interface 예시 — 구현 아님)

```js
// server/plugins/hooks/example-gate.js
export const plugin = {
  type: 'hook', name: 'example-gate',
  role: 'gate', event: 'PreToolUse', matcher: 'Bash',
  order: 35, failMode: 'closed',
  make(ctx) {
    return async (input) => ({
      hookSpecificOutput: {            // #97: top-level 필드는 SDK 가 조용히 무시 — 래핑 필수
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',   // 또는 'deny' + permissionDecisionReason
      },
    });
  },
};
```

```js
// server/plugins/jobs/example-watch.js  (schedule.json: {"kind":"handler","handlerName":"example-watch", ...})
export const plugin = {
  type: 'job', name: 'example-watch',
  async run(ctx) {
    const last = await ctx.state.get('lastSeen');
    // ... 외부 폴링 (서버 내부 import 금지 — ctx 경유만) ...
    await ctx.inject(null, { text: '새 항목 N건', source: 'example-watch' });
    await ctx.state.set('lastSeen', Date.now());
    return { ok: true, summary: 'N건 처리' };
  },
};
```

```js
// server/plugins/voice/example-tts.js
export const plugin = {
  type: 'voice', name: 'example-tts', kind: 'tts',
  async health() { /* localhost upstream alive 체크 — 노드 로컬 전제 (결정 #5) */ },
  async *synthesize(text, { voice, abortSignal }) {
    // 문장 단위 chunk yield. abortSignal 수신 즉시 중단 (barge-in, 결정 #6).
    yield new Uint8Array(0);
  },
};
```

---

## 9. (예약) rea/<name>.js — REA unpacker 플러그인 (축 5 후속, TaskInfo §5-7)

> **1차 미구현 — interface 자리만 동결** (contact 계약 8: "unpacker 함수는 처음부터 ctx-주입 shape 로 작성 → 로더 실체화 후 이동만"). 현재 unpacker 본체는 `server/rea.js` 내장 (asar/zip/tar) — 그 함수들이 이 shape 와 동형이 되도록 유지한다.

```js
// server/plugins/rea/<name>.js — 포맷 1종 = 플러그인 1파일
export const plugin = {
  type: 'rea', name: 'asar',
  formats: ['asar'],                 // server/rea.js FORMAT_TABLE 의 key 와 일치
  // identify 보조 (선택): magic 테이블로 못 잡는 포맷의 추가 판별. buf = head 4100B.
  detect(buf) { return false; },
  // unpack — 격리 수칙은 로더가 ctx 로 강제:
  //   ctx.runTool(cmd, args) = cwd 가 cache 밖 고정 + interpreter-대상경로 조합 throw (rea.js runTool 과 동일)
  //   ctx.caps = { maxUnpackBytes } — 압축폭탄 가드, 초과 시 throw {bombGuard:true}
  //   대상 코드 실행/임포트 절대 금지 — 플러그인도 예외 없음 (§5-5 최상위 함정)
  async unpack(srcPath, destDir, ctx) { return { files: 0, bytes: 0 }; },
};
```

- 플러그인은 `server/rea.js` 를 직접 import 하지 않는다 — §4 규율 동일 (ctx 경유만).
- 승격 비용 (§5-7): FORMAT_TABLE 1행 + 내장 unpack 함수를 이 파일로 이동 + 로더 shape 검증 1블록 — **낮음**.

---

## Open (Winter/사용자 재판단 대상)

1. `ctx.env` 화이트리스트의 구체 목록 — 로더 구현 시점 결정 사항 (interface 는 "서브셋" 으로 동결). 소비처가 생기기 전 목록 확정은 공허 — 축 1/2 구현 중 첫 수요 발생 시 확정 권고.
2. `data/plugin-errors.jsonl` 의 rotate 정책 (크기/기간) — bg-jobs.jsonl 의 기존 관행 따를지. 운영 데이터 쌓인 뒤 결정해도 손해 없음.
