// web/js/terminal.js — hidden xterm fallback view. Raw stream, always correct.
// Parser bug doesn't affect this. Toggle with Cmd+Shift+R or the raw button.

let term = null;

export function mountRaw() {
  if (!window.Terminal) return; // CDN failed, graceful skip
  term = new window.Terminal({
    fontFamily: '"JetBrains Mono", Menlo, monospace',
    fontSize: 12,
    cursorBlink: false,
    convertEol: true,
    theme: { background: '#0a0a10', foreground: '#9090A8' },
    scrollback: 5000,
  });
  const mount = document.getElementById('xterm-mount');
  term.open(mount);
}

export function pushRaw(rec) {
  if (!term) return;
  try {
    const line = `[${rec.id}] ${JSON.stringify(rec.raw)}`;
    term.writeln(line);
  } catch {
    term.writeln('<unserializable>');
  }
}

export function toggleRaw() {
  const el = document.getElementById('raw-view');
  el.classList.toggle('hidden');
}
