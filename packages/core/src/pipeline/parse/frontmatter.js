/**
 * 极简 YAML 子集解析器。只支持文章 front-matter 真正会用到的东西：
 * 标量、数组（行内 [a, b] 与块状 - a）、一层嵌套对象、多行字符串（| 与 >）。
 * 刻意不引入 js-yaml —— 一个依赖换不来这里多出来的能力。
 */
export function parseFrontmatter(raw) {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) return { data: {}, content: raw, hasFrontmatter: false };
  return { data: parseYaml(match[1]), content: raw.slice(match[0].length), hasFrontmatter: true };
}

export function parseYaml(text) {
  const lines = text.split(/\r?\n/);
  const { value } = parseBlock(lines, 0, 0);
  return value;
}

function parseBlock(lines, start, indent) {
  const result = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith('#')) { i += 1; continue; }
    const currentIndent = line.length - line.trimStart().length;
    if (currentIndent < indent) break;
    if (currentIndent > indent) { i += 1; continue; }

    const body = line.trim();
    const colon = body.indexOf(':');
    if (colon === -1) { i += 1; continue; }
    const key = body.slice(0, colon).trim();
    const rest = body.slice(colon + 1).trim();

    if (rest === '|' || rest === '>') {
      const { text: block, next } = readMultiline(lines, i + 1, indent, rest === '|');
      result[key] = block;
      i = next;
      continue;
    }
    if (rest === '') {
      const nextLine = lines[i + 1] ?? '';
      const nextIndent = nextLine.trim() ? nextLine.length - nextLine.trimStart().length : 0;
      if (nextLine.trim().startsWith('- ')) {
        const { value, next } = readList(lines, i + 1, nextIndent);
        result[key] = value;
        i = next;
        continue;
      }
      if (nextLine.trim() && nextIndent > indent) {
        const { value, next } = parseBlock(lines, i + 1, nextIndent);
        result[key] = value;
        i = next;
        continue;
      }
      result[key] = '';
      i += 1;
      continue;
    }
    result[key] = parseScalar(rest);
    i += 1;
  }
  return { value: result, next: i };
}

function readList(lines, start, indent) {
  const items = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i += 1; continue; }
    const currentIndent = line.length - line.trimStart().length;
    if (currentIndent < indent || !line.trim().startsWith('- ')) break;
    items.push(parseScalar(line.trim().slice(2).trim()));
    i += 1;
  }
  return { value: items, next: i };
}

function readMultiline(lines, start, parentIndent, keepNewlines) {
  const collected = [];
  let i = start;
  let blockIndent = null;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { collected.push(''); i += 1; continue; }
    const currentIndent = line.length - line.trimStart().length;
    if (currentIndent <= parentIndent) break;
    if (blockIndent === null) blockIndent = currentIndent;
    collected.push(line.slice(blockIndent));
    i += 1;
  }
  while (collected.length && collected[collected.length - 1] === '') collected.pop();
  return { text: keepNewlines ? `${collected.join('\n')}\n` : `${collected.join(' ')}\n`, next: i };
}

function parseScalar(raw) {
  const value = raw.trim();
  if (!value) return '';
  if (value.startsWith('[') && value.endsWith(']')) {
    return value.slice(1, -1).split(',').map((v) => parseScalar(v)).filter((v) => v !== '');
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}
