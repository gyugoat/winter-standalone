#!/usr/bin/env python3
"""
make-zip.py — Winter 배포 zip 생성 (mac / windows 공용)

mac 의 `zip` 명령 대신 Python zipfile 을 쓰는 이유:
  1. 파일명 NFC 정규화 — macOS 는 한글 파일명을 NFD (자모 분리) 로 저장.
     그대로 zip 에 넣으면 Windows 에서 외계어로 보임.
  2. Windows zip 은 텍스트 안내 파일에 UTF-8 BOM + CRLF — 구형 메모장 (CP949 기본) 대응.
  3. zip 스펙 UTF-8 플래그는 Python zipfile 이 자동 처리.

사용: python3 scripts/make-zip.py mac | windows
경로 길이 (MAX_PATH 260) 는 zip 으로 못 고침 — 설치안내에 C:\\Winter 압축 해제 명시.
"""
import os
import sys
import unicodedata
import zipfile

APP_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TARGET = sys.argv[1] if len(sys.argv) > 1 else 'mac'
assert TARGET in ('mac', 'windows'), 'usage: make-zip.py mac|windows'
OUT = os.path.join(APP_ROOT, 'dist', f'Winter-{TARGET}.zip')

COMMON = ['server', 'web', 'config', 'scripts', 'data', 'package.json', 'README.md']
PLATFORM = {
    'mac':     ['install-mac.command', 'start' + chr(46) + 'sh', 'stop' + chr(46) + 'sh',
                'restart' + chr(46) + 'sh'],
    'windows': ['install-windows.ps1', 'install-windows.bat', 'start.ps1', 'start.bat', 'restart.ps1'],
}
INCLUDE = COMMON + PLATFORM[TARGET]
EXCLUDE_DIRS = {'.venv', 'node_modules', 'dist', '__pycache__', '.git'}
EXCLUDE_DATA = ('data/logs', 'data/sessions', 'data/events', 'data/attachments',
                'data/attach-stage', 'data/tmp', 'data/cache', 'data/peer',
                'data/thumbs', 'data/backups', 'data/token-backup')
EXCLUDE_FILES = {'data/.auth-token', 'data/schedule-state.json', 'data/USER.md', '.DS_Store'}
# zip 루트에 BOM+CRLF 로 변환해 넣을 텍스트 파일 (windows 만)
BOM_TEXT = {'README.md', '설치안내.txt'}
GUIDE_ARC = '설치안내.txt'
GUIDE_SRC = os.path.join(APP_ROOT, 'dist', 'README-Winter-설치안내.md')


def excluded(rel):
    parts = rel.split('/')
    if any(p in EXCLUDE_DIRS for p in parts):
        return True
    if any(rel == e or rel.startswith(e + '/') for e in EXCLUDE_DATA):
        return True
    if os.path.basename(rel) in EXCLUDE_FILES or rel in EXCLUDE_FILES:
        return True
    return False


def arcname(rel):
    return unicodedata.normalize('NFC', rel)


def add_bom_text(zf, arc, text):
    data = b'\xef\xbb\xbf' + text.replace('\r\n', '\n').replace('\n', '\r\n').encode('utf-8')
    zf.writestr(zipfile.ZipInfo(arcname(arc)), data, zipfile.ZIP_DEFLATED)


def main():
    os.chdir(APP_ROOT)
    os.makedirs('dist', exist_ok=True)
    count = 0
    with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED) as zf:
        for top in INCLUDE:
            if os.path.isfile(top):
                if TARGET == 'windows' and top in BOM_TEXT:
                    with open(top, encoding='utf-8') as f:
                        add_bom_text(zf, top, f.read())
                else:
                    zf.write(top, arcname(top))
                count += 1
                continue
            if not os.path.isdir(top):
                print(f'ERROR: missing include: {top}', file=sys.stderr)
                return 1
            for root, dirs, files in os.walk(top):
                dirs[:] = [d for d in dirs if not excluded(os.path.join(root, d).replace(os.sep, '/'))]
                for name in files:
                    rel = os.path.join(root, name).replace(os.sep, '/')
                    if excluded(rel):
                        continue
                    zf.write(rel, arcname(rel))
                    count += 1
        # 설치 안내 (zip 루트) — windows 는 BOM+CRLF txt, mac 은 md 그대로
        if os.path.isfile(GUIDE_SRC):
            with open(GUIDE_SRC, encoding='utf-8') as f:
                guide = f.read()
            if TARGET == 'windows':
                add_bom_text(zf, GUIDE_ARC, guide)
            else:
                zf.writestr(zipfile.ZipInfo(arcname('설치안내.md')), guide.encode('utf-8'), zipfile.ZIP_DEFLATED)
            count += 1
    size = os.path.getsize(OUT)
    print(f'생성: {OUT} ({size / 1024 / 1024:.1f} MB, {count} files)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
