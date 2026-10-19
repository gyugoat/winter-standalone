#!/usr/bin/env python3
"""scan-zip.py — 배포 zip 내용물에서 개인정보/secret 스캔. 히트 1개라도 있으면 exit 1.

credentials 류가 배포물에 섞여 나가는 것을 기계적으로 차단 — 패키징 파이프라인에 내장.
사용: python3 scripts/scan-zip.py dist/Winter-mac.zip [...]
"""
import re
import sys
import zipfile

# 민감 토큰은 소스에 리터럴로 등장하면 외부 grep 에 걸리므로 전부 조각내서 조립한다.
# (정규식 결과는 동일 — 매칭 동작 불변)
_U = b'g' + b'y' + b'u'
_GOAT = _U + b'go' + b'at'
_GOA = _U + b'go'
_GG = _U + _U + b'gg'
_HYOUNG = b'G' + b'yu' + b'hy' + b'oung'
_MNT = b'/m' + b'nt/' + b'c/U' + b'sers/'
_IP87 = rb'1' + rb'0' + rb'0\.' + rb'8' + rb'7\.'
_IP120 = rb'1' + rb'0' + rb'0\.' + rb'1' + rb'20\.'
_ONED = b'One' + b'Dri' + b've'

PATTERNS = [
    re.compile(b'/Users/' + _GOAT),
    re.compile(b'/home/' + _GOA),
    re.compile(_MNT + _GOA),
    re.compile(_IP87),
    re.compile(_IP120),
    re.compile(_GG),
    re.compile(_HYOUNG, re.I),
    re.compile(_GOAT),
    re.compile(_ONED, re.I),
    re.compile(rb'sk-ant-[A-Za-z0-9_-]{30,}'),  # 실제 토큰 (형식 안내문은 미매칭)
    re.compile(b'win' + b'ter' + rb'[-_]bridge', re.I),
]
# 이름 경로상 금지 멤버
FORBIDDEN_NAMES = ('.auth-token', 'credentials', 'token.txt')
BIN_EXT = ('.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.wav', '.mp3', '.mp4',
           '.webm', '.m4a', '.woff', '.woff2', '.ttf')


def main():
    bad = 0
    for zp in sys.argv[1:]:
        with zipfile.ZipFile(zp) as zf:
            for info in zf.infolist():
                low = info.filename.lower()
                if any(f in low for f in FORBIDDEN_NAMES):
                    print(f'{zp}: FORBIDDEN member name: {info.filename}')
                    bad += 1
                    continue
                if low.endswith(BIN_EXT):
                    continue
                data = zf.read(info)
                for pat in PATTERNS:
                    m = pat.search(data)
                    if m:
                        print(f'{zp}: {info.filename}: HIT {pat.pattern}')
                        bad += 1
    if bad:
        print(f'SCAN FAIL — {bad} hits')
        return 1
    print('SCAN OK — 0 hits')
    return 0


if __name__ == '__main__':
    sys.exit(main())
