# Winter 설치 안내

Winter 는 본인 Claude 구독 계정 (Pro / Max) 으로 돌아가는 개인 AI 에이전트 서버입니다.
웹 브라우저 (기본 http://localhost:7979) 로 대화합니다.

## 요구사항
- 본인 Claude 구독 계정 (Pro 또는 Max) — API 키 아님, 구독 로그인
- Node.js 20 이상 (설치 스크립트가 자동 설치 시도)
- 인터넷 연결

## Windows 설치
1. 이 zip 을 C:\Winter 처럼 **짧은 경로**에 압축 해제 (경로가 길면 설치 실패 가능)
2. install-windows.bat 더블클릭
3. 중간에 Claude 로그인 창이 뜨면 본인 계정으로 로그인 → 표시되는 sk-ant-oat... 토큰을 복사해 붙여넣기
4. 끝나면 브라우저에서 http://localhost:7979 자동 오픈
- 이후에는 로그온 시 자동 시작. 안 떠 있으면 start.bat 더블클릭.

## macOS 설치
1. zip 압축 해제 후 install-mac.command 더블클릭
   (실행 안 되면: 터미널에서 `chmod +x install-mac.command` 후 재시도)
2. Claude 로그인 안내를 따라 진행
3. 브라우저에서 http://localhost:7979 접속

## 시작 / 종료
- Windows: start.bat (시작) / 작업 스케줄러 WinterWatchdog 가 자동 재시작 관리
- macOS: ./start.sh (시작), ./stop.sh (종료)

## 인증 (계정 연결)
1. **권장**: 서버 켜고 브라우저(localhost 포트)에서 설정 → **Claude 계정 연결** 버튼 클릭 → 로그인하면 자동 연결
2. 폴백: 연결 창이 안 뜨면 로그인 후 표시되는 인증 코드를 설정의 코드 입력란에 붙여넣기
3. 최후: 터미널에서 `claude setup-token` 실행 → 나온 sk-ant-oat... 토큰을 웹 UI 설정의 토큰 입력란 (또는 data/.auth-token 파일) 에 직접 입력

기존에 쓰다 만료된 Claude 로그인이 컴퓨터에 남아 있어도 계정 연결만 하면 됩니다.

## 인증이 만료됐을 때
위 "인증 (계정 연결)" 과 동일 — 설정 → Claude 계정 연결 버튼으로 다시 연결하면 됩니다.

## 포트 변경
환경변수 WINTER3_PORT 설정 (기본 7979)
