// web/js/tool-diff.js — Edit/Write/MultiEdit diff DOM 빌더.
// render.js (채팅 내 tool 카드) 와 activity.js (모달) 양쪽에서 import.
// XSS 규칙: textContent/createElement 만. innerHTML 금지.

const DIFF_LINE_LIMIT = 60;

// single edit block { old_string?, new_string?, content? } → .tool-diff-block div.
// isWrite=true 이면 old 없이 content 전체를 + 로 표시.
export function mkDiffBlock(filePath, oldStr, newStr, isWrite) {
  const block = document.createElement('div');
  block.className = 'tool-diff-block';

  if (filePath) {
    const hdr = document.createElement('div');
    hdr.className = 'tool-diff-header';
    hdr.textContent = filePath;
    block.appendChild(hdr);
  }

  function appendLines(lines, prefix, cssClass, container) {
    const shown = lines.slice(0, DIFF_LINE_LIMIT);
    for (const line of shown) {
      const row = document.createElement('div');
      row.className = `tool-diff-line ${cssClass}`;
      const pre = document.createElement('span');
      pre.className = 'tool-diff-prefix';
      pre.textContent = prefix;
      const code = document.createElement('span');
      code.className = 'tool-diff-code';
      code.textContent = line;
      row.appendChild(pre);
      row.appendChild(code);
      container.appendChild(row);
    }
    if (lines.length > DIFF_LINE_LIMIT) {
      const more = document.createElement('div');
      more.className = 'tool-diff-more';
      more.textContent = `… ${lines.length - DIFF_LINE_LIMIT}줄 더`;
      container.appendChild(more);
    }
  }

  const body = document.createElement('div');
  body.className = 'tool-diff-body';

  if (!isWrite && typeof oldStr === 'string' && oldStr.length > 0) {
    appendLines(oldStr.split('\n'), '-', 'removed', body);
  }
  if (typeof newStr === 'string' && newStr.length > 0) {
    appendLines(newStr.split('\n'), '+', 'added', body);
  } else if (isWrite && (!newStr || newStr.length === 0)) {
    const empty = document.createElement('div');
    empty.className = 'tool-diff-line added';
    const pre = document.createElement('span'); pre.className = 'tool-diff-prefix'; pre.textContent = '+';
    const code = document.createElement('span'); code.className = 'tool-diff-code'; code.textContent = '(빈 파일)';
    empty.appendChild(pre); empty.appendChild(code);
    body.appendChild(empty);
  }

  block.appendChild(body);
  return block;
}

// Edit/Write/MultiEdit input → .tool-diff 컨테이너 div 반환.
// 해당 tool 이 아니거나 input 부족/실패 시 null 반환 → 호출자가 fallback 처리.
export function buildToolDiffDOM(toolName, input) {
  try {
    if (!input || typeof input !== 'object') return null;

    if (toolName === 'Edit') {
      const fp = typeof input.file_path === 'string' ? input.file_path : '';
      const oldS = typeof input.old_string === 'string' ? input.old_string : '';
      const newS = typeof input.new_string === 'string' ? input.new_string : '';
      if (oldS.length === 0 && newS.length === 0) return null; // partial
      const wrap = document.createElement('div');
      wrap.className = 'tool-diff';
      wrap.appendChild(mkDiffBlock(fp, oldS, newS, false));
      return wrap;
    }

    if (toolName === 'MultiEdit') {
      const fp = typeof input.file_path === 'string' ? input.file_path : '';
      const edits = Array.isArray(input.edits) ? input.edits : [];
      if (edits.length === 0) return null;
      const wrap = document.createElement('div');
      wrap.className = 'tool-diff';
      for (let i = 0; i < edits.length; i++) {
        const e = edits[i];
        const oldS = typeof e?.old_string === 'string' ? e.old_string : '';
        const newS = typeof e?.new_string === 'string' ? e.new_string : '';
        wrap.appendChild(mkDiffBlock(i === 0 ? fp : '', oldS, newS, false));
      }
      return wrap;
    }

    if (toolName === 'Write') {
      const fp = typeof input.file_path === 'string' ? input.file_path : '';
      const content = typeof input.content === 'string' ? input.content : '';
      const wrap = document.createElement('div');
      wrap.className = 'tool-diff';
      wrap.appendChild(mkDiffBlock(fp, '', content, true));
      return wrap;
    }

    return null;
  } catch { return null; }
}
