// server/image-utils.js
// 이미지 dimension 파싱 공용 유틸.
// runner.js 에서 추출 — hook 파일이 runner.js 를 import 하면 순환 import 가 생기므로 분리.
// (runner → hooks/index → image-dimension-gate → runner 순환 회피)
//
// 참조: #39 V2 (1568px cap 근거), V5 (hook 순환 회피 목적으로 분리).

// #39 V2: Anthropic Vision many-image 한도 = 2000px dimension.
//   안전마진 1568px (Anthropic recommended single-image edge).
export const IMAGE_MAX_LONG_EDGE = 1568;

// JPEG/PNG/GIF/WebP header 만 파싱해서 dimension 추출. 외부 라이브러리 회피.
// 실패 (corrupted, unknown variant) 시 null — caller 가 size cap 으로 fallback.
export function imageDimensionsFromHeader(buf, ext) {
  try {
    if (ext === 'jpg' || ext === 'jpeg') {
      // JPEG: SOI (FFD8) + segments. SOF0/2/etc marker 안에 height/width.
      let i = 2;
      while (i < buf.length - 1) {
        if (buf[i] !== 0xFF) return null;
        // (a) fill byte skip: marker byte 앞에 0xFF padding 이 여러 개 올 수 있음.
        while (i + 1 < buf.length && buf[i + 1] === 0xFF) i++;
        if (i + 1 >= buf.length) return null;
        const marker = buf[i + 1];
        // (b) SOS(0xDA)/EOI(0xD9) 만나면 entropy-coded 데이터 시작 — walk 무의미.
        if (marker === 0xDA || marker === 0xD9) return null;
        // SOF 마커: dimension 추출.
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
          if (i + 9 > buf.length) return null;
          const h = buf.readUInt16BE(i + 5);
          const w = buf.readUInt16BE(i + 7);
          return { w, h };
        }
        // (d) standalone marker (RST0-7=0xD0-0xD7, TEM=0x01) — length 필드 없음, i += 2.
        if ((marker >= 0xD0 && marker <= 0xD7) || marker === 0x01) {
          i += 2;
          continue;
        }
        // (c) segLen 검증: < 2 면 corrupted.
        if (i + 3 >= buf.length) return null;
        const segLen = buf.readUInt16BE(i + 2);
        if (segLen < 2) return null;
        i += 2 + segLen;
      }
      return null;
    }
    if (ext === 'png') {
      // PNG signature 8B + IHDR chunk: bytes 16-19 width, 20-23 height (BE32).
      if (buf.length < 24) return null;
      if (buf.readUInt32BE(0) !== 0x89504E47) return null;
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    if (ext === 'gif') {
      if (buf.length < 10) return null;
      const sig = buf.slice(0, 3).toString('ascii');
      if (sig !== 'GIF') return null;
      return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    }
    if (ext === 'webp') {
      if (buf.length < 30) return null;
      if (buf.slice(0, 4).toString('ascii') !== 'RIFF') return null;
      if (buf.slice(8, 12).toString('ascii') !== 'WEBP') return null;
      const fourcc = buf.slice(12, 16).toString('ascii');
      if (fourcc === 'VP8 ') {
        const w = buf.readUInt16LE(26) & 0x3FFF;
        const h = buf.readUInt16LE(28) & 0x3FFF;
        return { w, h };
      }
      if (fourcc === 'VP8L') {
        const b1 = buf[22], b2 = buf[23], b3 = buf[24], b4 = buf[25];
        const w = 1 + (((b2 & 0x3F) << 8) | b1);
        const h = 1 + (((b4 & 0x0F) << 10) | (b3 << 2) | (b2 >> 6));
        return { w, h };
      }
      if (fourcc === 'VP8X') {
        const w = 1 + buf.readUIntLE(24, 3);
        const h = 1 + buf.readUIntLE(27, 3);
        return { w, h };
      }
      return null;
    }
  } catch { /* */ }
  return null;
}
