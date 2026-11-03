'use strict';

const { StringDecoder } = require('node:string_decoder');

const DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024;

/**
 * Serialize a single strict JSONL record (LF-only).
 * Payload strings may contain U+2028 / U+2029 without breaking framing.
 */
function serializeJsonLine(value) {
  return `${JSON.stringify(value)}\n`;
}

/**
 * Attach an LF-only JSONL reader to a Node Readable stream.
 *
 * Intentionally avoids Node `readline` which splits on U+2028 and U+2029
 * (valid characters inside JSON strings per Pi RPC spec).
 *
 * @param {import('node:stream').Readable} stream
 * @param {(line: string) => void} onLine
 * @param {{ maxLineBytes?: number, onError?: (err: Error) => void }} [options]
 * @returns {() => void} detach function
 */
function attachJsonlLineReader(stream, onLine, options = {}) {
  const maxLineBytes = options.maxLineBytes || DEFAULT_MAX_LINE_BYTES;
  const onError = options.onError || null;
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let closed = false;

  const detach = () => {
    if (closed) return;
    closed = true;
    stream.off('data', onData);
    stream.off('end', onEnd);
  };

  const failOversized = () => {
    detach();
    buffer = '';
    const err = Object.assign(
      new Error(`JSONL protocol line exceeds maximum length (${maxLineBytes} bytes).`),
      { code: 'JSONL_LINE_TOO_LONG', status: 409 }
    );
    if (onError) onError(err);
  };

  const emitLine = rawLine => {
    if (closed) return;
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (Buffer.byteLength(line, 'utf8') > maxLineBytes) {
      failOversized();
      return;
    }
    if (line.length > 0) {
      onLine(line);
    }
  };

  const onData = chunk => {
    if (closed) return;
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);

    while (!closed) {
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) {
        if (Buffer.byteLength(buffer, 'utf8') > maxLineBytes) {
          failOversized();
        }
        return;
      }

      const rawLine = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      emitLine(rawLine);
    }
  };

  const onEnd = () => {
    if (closed) return;
    buffer += decoder.end();
    if (buffer.length > 0) {
      const remaining = buffer;
      buffer = '';
      emitLine(remaining);
    }
    detach();
  };

  stream.on('data', onData);
  stream.on('end', onEnd);

  return detach;
}

module.exports = {
  DEFAULT_MAX_LINE_BYTES,
  serializeJsonLine,
  attachJsonlLineReader,
};
