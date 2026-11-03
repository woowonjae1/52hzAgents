'use strict';

/**
 * Lossless JSONC and TOML helpers for native Agent configuration files.
 *
 * Guarantees required by AGENT_WORKBENCH_REDESIGN_PLAN.md §6.2 & §6.4:
 * - Preserves comments, indentation, line endings, unknown fields and unrelated tables.
 * - Never executes command values (`!cmd`), shell interpolations or plugins during parse/preview.
 * - Rejects mask placeholders (`••••••••`) if submitted as a replacement secret.
 */

const MASK_PLACEHOLDER = '••••••••';

const fail = (message, code = 'CONFIG_INVALID', status = 400) =>
  Object.assign(new Error(message), { code, status });

function isMaskedSecret(value) {
  if (typeof value !== 'string') return Boolean(value && typeof value === 'object' && value.__masked);
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed === MASK_PLACEHOLDER || trimmed === '[REDACTED]' || trimmed === '***') return true;
  return trimmed.length >= 4 && (/^•+$/.test(trimmed) || /^\*+$/.test(trimmed));
}

/**
 * Inspect a credential string without executing commands or exposing secrets.
 */
function redactSecretString(value) {
  if (value === undefined || value === null || value === '') {
    return { configured: false, kind: 'none', masked: null };
  }
  if (typeof value !== 'string') {
    return { configured: true, kind: 'unknown', masked: MASK_PLACEHOLDER };
  }
  if (value.startsWith('!')) {
    // Pi supports `!command` in models.json. Never execute it; disclose that it is a command reference.
    return { configured: true, kind: 'command', masked: MASK_PLACEHOLDER };
  }
  if (value.startsWith('$') || /^[A-Z][A-Z0-9_]{2,}$/.test(value)) {
    return { configured: true, kind: 'env', envVar: value.replace(/^\$/, ''), masked: value };
  }
  return { configured: true, kind: 'literal', masked: MASK_PLACEHOLDER };
}

/**
 * Strip `//` and `/* ... *\/` comments and trailing commas while keeping offsets/lines valid.
 */
function stripJsonc(text) {
  const src = String(text || '');
  let out = '';
  let i = 0;
  let inString = false;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (inString) {
      out += ch;
      if (ch === '\\' && i + 1 < src.length) {
        out += src[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === '/' && next === '/') {
      out += '  ';
      i += 2;
      while (i < src.length && src[i] !== '\n') {
        out += src[i] === '\r' ? '\r' : ' ';
        i++;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' || src[i] === '\r' ? src[i] : ' ';
        i++;
      }
      if (i < src.length) {
        out += '  ';
        i += 2;
      }
      continue;
    }
    out += ch;
    i++;
  }
  // Remove trailing commas before `}` or `]` outside strings.
  return out.replace(/,(\s*[}\]])/g, ' $1');
}

function parseJsonc(text, label = 'JSONC') {
  const raw = String(text ?? '').trim();
  if (!raw) return {};
  try {
    return JSON.parse(stripJsonc(text));
  } catch (error) {
    throw fail(`${label} 语法解析失败: ${error.message}`, 'CONFIG_PARSE_ERROR', 400);
  }
}

/**
 * Tokenize structural spans inside a JSONC object `[objStart, objEnd]` (inclusive of `{` and `}`).
 * Returns top-level properties `{ key, keyStart, keyEnd, valueStart, valueEnd, valueType, propStart, propEnd, commaAfter }`.
 */
function scanJsoncObject(src, objStart, objEnd) {
  const props = [];
  let i = objStart + 1;
  const limit = objEnd;

  const skipTrivia = () => {
    while (i < limit) {
      const ch = src[i];
      const next = src[i + 1];
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { i++; continue; }
      if (ch === '/' && next === '/') {
        i += 2;
        while (i < limit && src[i] !== '\n') i++;
        continue;
      }
      if (ch === '/' && next === '*') {
        i += 2;
        while (i < limit && !(src[i] === '*' && src[i + 1] === '/')) i++;
        if (i < limit) i += 2;
        continue;
      }
      break;
    }
  };

  const readString = () => {
    const start = i;
    i++; // skip opening "
    while (i < limit) {
      if (src[i] === '\\') { i += 2; continue; }
      if (src[i] === '"') { i++; break; }
      i++;
    }
    return { start, end: i, value: JSON.parse(src.slice(start, i)) };
  };

  const readValue = () => {
    skipTrivia();
    const start = i;
    const ch = src[i];
    if (ch === '"') {
      readString();
      return { start, end: i, type: 'string' };
    }
    if (ch === '{' || ch === '[') {
      const open = ch;
      const close = ch === '{' ? '}' : ']';
      let depth = 0;
      let inStr = false;
      while (i < limit) {
        const c = src[i];
        const n = src[i + 1];
        if (inStr) {
          if (c === '\\') { i += 2; continue; }
          if (c === '"') inStr = false;
          i++;
          continue;
        }
        if (c === '"') { inStr = true; i++; continue; }
        if (c === '/' && n === '/') { i += 2; while (i < limit && src[i] !== '\n') i++; continue; }
        if (c === '/' && n === '*') { i += 2; while (i < limit && !(src[i] === '*' && src[i + 1] === '/')) i++; if (i < limit) i += 2; continue; }
        if (c === open) depth++;
        else if (c === close) {
          depth--;
          if (depth === 0) { i++; break; }
        }
        i++;
      }
      return { start, end: i, type: open === '{' ? 'object' : 'array' };
    }
    while (i < limit && !/[,\s}\]/]/.test(src[i])) i++;
    return { start, end: i, type: 'primitive' };
  };

  while (i < limit) {
    skipTrivia();
    if (i >= limit || src[i] === '}') break;
    if (src[i] === ',') { i++; continue; }
    if (src[i] !== '"') break;
    const keyTok = readString();
    skipTrivia();
    if (src[i] !== ':') break;
    i++; // skip ':'
    const valTok = readValue();
    const afterVal = i;
    skipTrivia();
    let commaPos = null;
    if (src[i] === ',') {
      commaPos = i;
      i++;
    }
    props.push({
      key: keyTok.value,
      keyStart: keyTok.start,
      keyEnd: keyTok.end,
      valueStart: valTok.start,
      valueEnd: valTok.end,
      valueType: valTok.type,
      propEnd: commaPos !== null ? commaPos + 1 : afterVal,
      commaPos,
    });
  }
  return props;
}

function findRootObjectSpan(src) {
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { i++; continue; }
    if (ch === '/' && next === '/') { i += 2; while (i < src.length && src[i] !== '\n') i++; continue; }
    if (ch === '/' && next === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; if (i < src.length) i += 2; continue; }
    break;
  }
  if (src[i] !== '{') return null;
  const start = i;
  let depth = 0;
  let inStr = false;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (inStr) {
      if (c === '\\') { i += 2; continue; }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') { inStr = true; i++; continue; }
    if (c === '/' && n === '/') { i += 2; while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; if (i < src.length) i += 2; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return { start, end: i };
    }
    i++;
  }
  return null;
}

function detectIndent(src) {
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const match = src.match(/\n([ \t]+)"/);
  return { indent: match ? match[1] : '  ', eol };
}

function formatJsonValue(value, unitIndent, currentIndent, eol) {
  const raw = JSON.stringify(value, null, unitIndent);
  const lines = raw.split('\n');
  if (lines.length === 1) return raw;
  return lines.map((line, idx) => (idx === 0 ? line : currentIndent + line)).join(eol);
}

function patchJsoncObjectSpan(src, objStart, objEnd, patchObj, unitIndent, eol, depth = 1) {
  let current = src;
  let spanStart = objStart;
  let spanEnd = objEnd;
  const childIndent = unitIndent.repeat(depth);
  const parentIndent = unitIndent.repeat(Math.max(0, depth - 1));

  for (const [key, nextVal] of Object.entries(patchObj)) {
    const props = scanJsoncObject(current, spanStart, spanEnd);
    const existing = props.find(p => p.key === key);

    if (nextVal === undefined) {
      if (!existing) continue;
      // Remove property line or span cleanly.
      let removeStart = existing.keyStart;
      while (removeStart > spanStart + 1 && (current[removeStart - 1] === ' ' || current[removeStart - 1] === '\t')) {
        removeStart--;
      }
      let removeEnd = existing.propEnd;
      if (current[removeEnd] === '\r' && current[removeEnd + 1] === '\n') removeEnd += 2;
      else if (current[removeEnd] === '\n') removeEnd += 1;
      const delta = removeEnd - removeStart;
      current = current.slice(0, removeStart) + current.slice(removeEnd);
      spanEnd -= delta;
      continue;
    }

    if (existing) {
      if (
        existing.valueType === 'object' &&
        nextVal !== null &&
        typeof nextVal === 'object' &&
        !Array.isArray(nextVal)
      ) {
        const beforeLen = current.length;
        current = patchJsoncObjectSpan(current, existing.valueStart, existing.valueEnd - 1, nextVal, unitIndent, eol, depth + 1);
        spanEnd += current.length - beforeLen;
      } else {
        const formatted = formatJsonValue(nextVal, unitIndent, childIndent, eol);
        const beforeLen = existing.valueEnd - existing.valueStart;
        current = current.slice(0, existing.valueStart) + formatted + current.slice(existing.valueEnd);
        spanEnd += formatted.length - beforeLen;
      }
      continue;
    }

    // Insert new property before closing brace `spanEnd`.
    const formatted = formatJsonValue(nextVal, unitIndent, childIndent, eol);
    const entryText = `${childIndent}${JSON.stringify(key)}: ${formatted}`;
    if (props.length === 0) {
      const inner = current.slice(spanStart + 1, spanEnd);
      const hasComments = inner.includes('//') || inner.includes('/*');
      const replacement = hasComments
        ? `${inner.replace(/\s*$/, '')}${eol}${entryText}${eol}${parentIndent}`
        : `${eol}${entryText}${eol}${parentIndent}`;
      const beforeLen = spanEnd - (spanStart + 1);
      current = current.slice(0, spanStart + 1) + replacement + current.slice(spanEnd);
      spanEnd += replacement.length - beforeLen;
    } else {
      const last = props[props.length - 1];
      let insertAt = last.valueEnd;
      let prefix = '';
      if (last.commaPos !== null) {
        insertAt = last.commaPos + 1;
      } else {
        prefix = ',';
      }
      const addition = `${prefix}${eol}${entryText}`;
      current = current.slice(0, insertAt) + addition + current.slice(insertAt);
      spanEnd += addition.length;
    }
  }
  return current;
}

/**
 * Apply a field-level patch to a JSON/JSONC document while preserving comments and unknown keys.
 */
function applyJsoncPatch(rawText, patchObj, label = 'JSONC') {
  const existingText = String(rawText ?? '');
  if (!existingText.trim()) {
    const clean = {};
    for (const [k, v] of Object.entries(patchObj || {})) {
      if (v !== undefined) clean[k] = v;
    }
    return JSON.stringify(clean, null, 2) + '\n';
  }
  // Ensure existing document parses before patching.
  parseJsonc(existingText, label);
  const rootSpan = findRootObjectSpan(existingText);
  if (!rootSpan) throw fail(`${label} 根节点必须是 JSON 对象。`, 'CONFIG_PARSE_ERROR', 400);
  const { indent, eol } = detectIndent(existingText);
  const updated = patchJsoncObjectSpan(existingText, rootSpan.start, rootSpan.end, patchObj || {}, indent, eol, 1);
  // Verify the updated document is valid JSONC.
  parseJsonc(updated, label);
  return updated;
}

function parseTomlScalar(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  if (/^-?\d+\.\d+$/.test(trimmed)) return Number.parseFloat(trimmed);
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    if (trimmed.startsWith('"')) {
      try { return JSON.parse(trimmed); } catch { return trimmed.slice(1, -1); }
    }
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function splitTomlValueAndComment(rhs) {
  let inDouble = false;
  let inSingle = false;
  for (let i = 0; i < rhs.length; i++) {
    const ch = rhs[i];
    if (inDouble) {
      if (ch === '\\') { i++; continue; }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (ch === '"') { inDouble = true; continue; }
    if (ch === "'") { inSingle = true; continue; }
    if (ch === '#') {
      return { valuePart: rhs.slice(0, i).trimEnd(), commentPart: rhs.slice(i) };
    }
  }
  return { valuePart: rhs.trimEnd(), commentPart: '' };
}

/**
 * Parse top-level scalars and table headers from a TOML document without executing anything.
 */
function parseTomlDocument(rawText) {
  const src = String(rawText ?? '');
  const lines = src.split(/\r?\n/);
  const topLevel = {};
  const tables = [];
  let currentTable = null;
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const tableMatch = trimmed.match(/^\[([^\]]+)\]\s*(?:#.*)?$/);
    if (tableMatch) {
      currentTable = tableMatch[1].trim();
      tables.push(currentTable);
      continue;
    }
    const kvMatch = line.match(/^(\s*)([A-Za-z0-9_-]+)(\s*=\s*)(.+)$/);
    if (!kvMatch) continue;
    const key = kvMatch[2];
    const { valuePart } = splitTomlValueAndComment(kvMatch[4]);
    const parsedVal = parseTomlScalar(valuePart);
    if (!currentTable) {
      topLevel[key] = parsedVal;
    }
  }
  return { topLevel, tables };
}

function formatTomlScalar(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  throw fail(`不支持的 TOML 标量类型: ${typeof value}`);
}

/**
 * Apply top-level key updates to a TOML file while preserving comments, blank lines and all `[table]` sections.
 */
function applyTomlTopLevelPatch(rawText, patchObj) {
  const src = String(rawText ?? '');
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const lines = src ? src.split(/\r?\n/) : [];
  let firstTableIdx = lines.findIndex(line => /^\s*\[[^\]]+\]/.test(line));
  if (firstTableIdx === -1) firstTableIdx = lines.length;

  const remaining = new Map(Object.entries(patchObj || {}));
  const updatedTop = [];

  for (let i = 0; i < firstTableIdx; i++) {
    const line = lines[i];
    const kvMatch = line.match(/^(\s*)([A-Za-z0-9_-]+)(\s*=\s*)(.+)$/);
    if (!kvMatch || line.trim().startsWith('#')) {
      updatedTop.push(line);
      continue;
    }
    const [, leading, key, eq, rhs] = kvMatch;
    if (!remaining.has(key)) {
      updatedTop.push(line);
      continue;
    }
    const nextVal = remaining.get(key);
    remaining.delete(key);
    if (nextVal === undefined || nextVal === null || nextVal === '') {
      // Remove top-level key when cleared.
      continue;
    }
    const { commentPart } = splitTomlValueAndComment(rhs);
    const suffix = commentPart ? ` ${commentPart}` : '';
    updatedTop.push(`${leading}${key}${eq}${formatTomlScalar(nextVal)}${suffix}`);
  }

  // Insert any new top-level keys before the first table (and before trailing blank lines preceding the table).
  let insertPos = updatedTop.length;
  while (insertPos > 0 && updatedTop[insertPos - 1].trim() === '') insertPos--;
  const additions = [];
  for (const [key, nextVal] of remaining.entries()) {
    if (nextVal === undefined || nextVal === null || nextVal === '') continue;
    additions.push(`${key} = ${formatTomlScalar(nextVal)}`);
  }
  if (additions.length) {
    updatedTop.splice(insertPos, 0, ...additions);
  }

  const tail = lines.slice(firstTableIdx);
  const result = [...updatedTop, ...tail].join(eol);
  return result.endsWith(eol) || !result ? result : result + eol;
}

module.exports = {
  MASK_PLACEHOLDER,
  isMaskedSecret,
  redactSecretString,
  stripJsonc,
  parseJsonc,
  applyJsoncPatch,
  parseTomlDocument,
  applyTomlTopLevelPatch,
};
