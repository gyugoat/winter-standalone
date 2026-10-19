# Winter

개인 AI 에이전트 서버. Claude Agent SDK 위에서 돌아가고, 웹 UI 로 대화한다.
Winter 본체가 오케스트레이터로 동작하며, 17개 캐릭터 sub-agent (탐색/리서치/QA/인프라/프론트 등) 에 작업을 위임한다.

## 요구사항
- **본인 Claude 구독 계정 (Pro / Max)** — API 키가 아니라 구독 로그인 (`claude setup-token`)
- **Node.js >= 20**
- macOS 또는 Windows (Linux 도 mac 절차와 동일하게 동작)

## 설치

### macOS / Linux
```bash
./install-mac.command
```
Node/claude CLI 확인·설치 → npm install → Claude 로그인 (setup-token) → 서버 시작까지 자동.

**Linux 유저**: install-mac.command 는 Homebrew 가 없으면 Node.js 자동 설치를 못 한다. nodejs.org 또는 배포판 패키지 매니저 (`sudo apt install nodejs npm` / `sudo dnf install nodejs` 등) 로 Node.js 20+ 를 먼저 수동 설치한 뒤, 같은 스크립트를 다시 실행하면 2단계 (claude CLI) 부터 자동 진행된다.

### Windows
`install-windows.bat` 더블클릭. 로그온 시 자동 시작하는 WinterWatchdog 작업까지 등록된다.
zip 은 `C:\Winter` 같은 짧은 경로에 풀 것 (MAX_PATH 260 제한).

## 인증
토큰은 배포물에 포함되지 않는다. 우선순위:
1. **웹 UI 계정 연결 (권장)** — 서버 켜고 브라우저(localhost 포트)에서 설정 → Claude 계정 연결 버튼 클릭 → 브라우저에서 로그인하면 자동 연결 (OAuth PKCE, `POST /claude/connect/start` → `localhost:54545/callback`)
2. 폴백 — 콜백 창이 안 뜨거나 54545 포트가 막혀 있으면: 로그인 후 표시되는 인증 코드를 설정 입력란에 붙여넣기 (`POST /claude/connect/finish`)
3. 최후 — 터미널 `claude setup-token` 실행 후 나온 `sk-ant-oat...` 토큰을 웹 UI 토큰 입력란 (`POST /auth-token`) 또는 `data/.auth-token` 파일에 직접 입력

기존에 쓰다 만료된 Claude 로그인이 컴퓨터에 남아 있어도 계정 연결만 하면 됨 — 서버가 주입하는 `CLAUDE_CODE_OAUTH_TOKEN` 이 구 자격증명보다 우선한다.
로컬 `claude` CLI 에 이미 유효하게 로그인돼 있으면 그 자격증명을 그대로 쓸 수도 있다 (토큰 미설정 시 SDK 기본 동작).

## 시작 / 종료 / 재시작
| | macOS/Linux | Windows |
|---|---|---|
| 시작 | `./start.sh` | `start.bat` |
| 종료 | `./stop.sh` | 작업 관리자에서 node 종료 (watchdog 이 자동 재기동하니 영구 종료는 WinterWatchdog 작업 비활성화) |
| 재시작 | `./restart.sh` 또는 웹 UI 설정 → 재시작 버튼 | 웹 UI 재시작 버튼 또는 `restart.ps1` |

## 포트
기본 **7979**. 변경: 환경변수 `WINTER3_PORT`.
서버 API 는 localhost 전용 가드 — 외부 IP 에서 호출 불가.

## 유저 설정
- `data/user-config.json` — `{"name": "..."}` Winter 가 부를 호칭
- `data/USER.md` — 유저 컨텍스트 (hawk sub-agent 가 관리, 직접 편집도 가능)
- `config/agents/*.md` — 17 캐릭터 sub-agent 프롬프트 (자유롭게 수정 가능)

## 배포 패키징 (개발자용)
```bash
scripts/package.sh   # dist/Winter-mac.zip + dist/Winter-windows.zip 생성 + secret 스캔 내장
```
