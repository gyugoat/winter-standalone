// server/hooks/image-dimension-gate.js
// PreToolUse(Read) — 이미지 파일을 Read 하기 전 dimension 을 검사해 1568px 초과 시 deny.
//
// 배경 (#39 V5):
//   세션 465540ea 에서 Read tool 로 읽은 스크린샷 69장이 conversation history 에 박혀
//   Anthropic "many-image 2000px dimension" 규칙에 걸려 세션이 영구 400 됨.
//   첨부 경로는 #39 V2 가드 (consumeStagedAttachments, 1568px cap) 가 있지만
//   Read tool 이 리턴하는 이미지는 무가드 — 이 hook 이 그 경로를 막는다.
//
// 정책 (#39 V6):
//   - 이미지 확장자(png/jpg/jpeg/gif/webp) 인 경우만 검사.
//   - 파일 앞 1MB 부분 read → imageDimensionsFromHeader 로 dimension 파싱.
//     (512B 는 폰 JPEG EXIF APP1 이 수십 KB 라 SOF 를 못 읽는 케이스가 정상 케이스였음)
//   - Math.max(w, h) > IMAGE_MAX_LONG_EDGE(1568) 이면 deny + ImageMagick/ffmpeg 축소 안내.
//   - 비이미지 / 1568 이하 → 통과 ({}).
//   - 파싱 실패 (파일은 읽었으나 dimension 모름) → fail-closed deny (세션 영구 400 위험).
//   - 파일 읽기 실패 / hook 내부 에러 → fail-open (통과). 파싱 실패와 구분.
//   - main thread / sub-agent 구분 없이 전 agent 적용 (API 한도는 모두 동일).

import * as fs from 'node:fs';
import { extname } from 'node:path';
import { imageDimensionsFromHeader, IMAGE_MAX_LONG_EDGE } from '../image-utils.js';

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

function denyResult(reason) {
  return {
    decision: 'block',
    reason,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

export function makeImageDimensionGate() {
  return async function imageDimensionGate(input /*, toolUseID, options */) {
    try {
      if (input?.tool_name !== 'Read') return {};

      const fp = input?.tool_input?.file_path;
      if (!fp || typeof fp !== 'string') return {};

      const ext = extname(fp).replace(/^\./, '').toLowerCase();
      if (!IMAGE_EXTS.has(ext)) return {};

      let buf;
      let fd;
      try {
        fd = fs.openSync(fp, 'r');
        const tmp = Buffer.alloc(1024 * 1024); // 1MB — EXIF APP1 수십 KB 후 SOF 커버
        const n = fs.readSync(fd, tmp, 0, 1024 * 1024, 0);
        buf = tmp.subarray(0, n);
      } catch {
        // 파일 없음 / 읽기 실패 → fail-open (Read 자체가 에러 메시지 줄 것)
        return {};
      } finally {
        if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
      }

      const dim = imageDimensionsFromHeader(buf, ext);
      if (!dim) {
        // fail-closed: 파일은 읽었으나 dimension 파싱 실패 → 세션 영구 400 위험 방지 (#39 V6).
        const reason =
          `이미지 dimension 확인 불가 — 파싱 실패. 원본 Read 금지 (many-image 2000px 세션 영구 400 위험, #39). ` +
          `Bash 로 축소/재인코딩 후 축소본을 Read 해라. ` +
          `예: convert '${fp}' -resize ${IMAGE_MAX_LONG_EDGE}x${IMAGE_MAX_LONG_EDGE}\\> /tmp/img_small.png (ImageMagick) ` +
          `또는 ffmpeg -i '${fp}' -vf "scale='min(${IMAGE_MAX_LONG_EDGE},iw)':-2" /tmp/img_small.png`;
        return denyResult(reason);
      }

      const longEdge = Math.max(dim.w, dim.h);
      if (longEdge <= IMAGE_MAX_LONG_EDGE) return {}; // 안전 → 통과

      const reason =
        `이미지 ${dim.w}x${dim.h} — ${IMAGE_MAX_LONG_EDGE}px 초과. ` +
        `원본을 Read 하면 conversation history 에 박혀 many-image 2000px 규칙으로 세션이 영구 400 됨 (#39). ` +
        `Bash 로 축소 후 축소본을 Read 해라. ` +
        `예: convert '${fp}' -resize ${IMAGE_MAX_LONG_EDGE}x${IMAGE_MAX_LONG_EDGE}\\> /tmp/img_small.png (ImageMagick) ` +
        `또는 ffmpeg -i '${fp}' -vf "scale='min(${IMAGE_MAX_LONG_EDGE},iw)':-2" /tmp/img_small.png`;

      return denyResult(reason);
    } catch {
      // hook 내부 에러 → fail-open (통과)
      return {};
    }
  };
}
