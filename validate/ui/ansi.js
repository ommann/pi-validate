const palette = [
  '#222222', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#abb2bf',
  '#636d83', '#ff8b93', '#b8e994', '#ffe49a', '#8bc8ff', '#e4a1ff', '#89e5ee', '#ffffff',
];

function indexedColor(index) {
  if (!Number.isInteger(index) || index < 0 || index > 255) return undefined;
  if (index < 16) return palette[index];
  if (index >= 232) {
    const gray = 8 + (index - 232) * 10;
    return `rgb(${gray}, ${gray}, ${gray})`;
  }
  const n = index - 16;
  const component = value => value === 0 ? 0 : 55 + value * 40;
  return `rgb(${component(Math.floor(n / 36))}, ${component(Math.floor(n / 6) % 6)}, ${component(n % 6)})`;
}

// Interpret SGR only. Other terminal commands (including OSC links) are discarded.
// Output is always text, never HTML.
export function ansiParts(text) {
  const parts = [];
  let state = {}, offset = 0;
  function append(value) {
    if (!value) return;
    const style = {};
    if (state.bold) style.fontWeight = 'bold';
    if (state.dim) style.opacity = '0.65';
    if (state.italic) style.fontStyle = 'italic';
    if (state.underline || state.strike) style.textDecoration = [state.underline && 'underline', state.strike && 'line-through'].filter(Boolean).join(' ');
    if (state.hidden) style.visibility = 'hidden';
    const foreground = state.inverse ? state.background || '#0d121b' : state.foreground;
    const background = state.inverse ? state.foreground || '#e5eaf3' : state.background;
    if (foreground) style.color = foreground;
    if (background) style.backgroundColor = background;
    parts.push({ text: value, style });
  }
  const escapes = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
  for (const match of text.matchAll(escapes)) {
    append(text.slice(offset, match.index));
    offset = match.index + match[0].length;
    if (!/^\x1b\[[\d;]*m$/.test(match[0])) continue;
    const codes = match[0].slice(2, -1).split(';').map(value => Number(value || 0));
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      if (code === 0) state = {};
      else if (code === 1) state.bold = true;
      else if (code === 2) state.dim = true;
      else if (code === 3) state.italic = true;
      else if (code === 4) state.underline = true;
      else if (code === 7) state.inverse = true;
      else if (code === 8) state.hidden = true;
      else if (code === 9) state.strike = true;
      else if (code === 22) { state.bold = false; state.dim = false; }
      else if (code === 23) state.italic = false;
      else if (code === 24) state.underline = false;
      else if (code === 27) state.inverse = false;
      else if (code === 28) state.hidden = false;
      else if (code === 29) state.strike = false;
      else if (code === 39) delete state.foreground;
      else if (code === 49) delete state.background;
      else if (code >= 30 && code <= 37) state.foreground = palette[code - 30];
      else if (code >= 40 && code <= 47) state.background = palette[code - 40];
      else if (code >= 90 && code <= 97) state.foreground = palette[code - 90 + 8];
      else if (code >= 100 && code <= 107) state.background = palette[code - 100 + 8];
      else if (code === 38 || code === 48) {
        const key = code === 38 ? 'foreground' : 'background';
        const mode = codes[++i];
        if (mode === 5) {
          const color = indexedColor(codes[++i]);
          if (color) state[key] = color;
        } else if (mode === 2) {
          const rgb = codes.slice(i + 1, i + 4);
          i += 3;
          if (rgb.length === 3 && rgb.every(value => Number.isInteger(value) && value >= 0 && value <= 255)) state[key] = `rgb(${rgb.join(', ')})`;
        }
      }
    }
  }
  append(text.slice(offset));
  return parts;
}

export function renderAnsi(element, text) {
  const fragment = element.ownerDocument.createDocumentFragment();
  for (const part of ansiParts(text)) {
    const span = element.ownerDocument.createElement('span');
    span.textContent = part.text;
    Object.assign(span.style, part.style);
    fragment.append(span);
  }
  element.replaceChildren(fragment);
}
