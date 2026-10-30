/**
 * Privacy & Log Redaction Utility (Package E5).
 * Masks API keys, bearer tokens, passwords, cookies, and confidential values.
 */

const SECRET_PATTERNS = [
  // OpenAI, Anthropic, Gemini, Groq, DeepSeek style keys
  /\b(sk-[a-zA-Z0-9_\-]{20,})\b/gi,
  /\b(AIzaSy[a-zA-Z0-9_\-]{33})\b/gi,
  /\b(xai-[a-zA-Z0-9_\-]{20,})\b/gi,
  // Bearer tokens
  /\b(Bearer\s+)[a-zA-Z0-9_\-\.]{25,}\b/gi,
  // Generic header or query param credentials
  /(["']?(?:password|api_?key|access_?token|auth(?:orization)?|secret)["']?\s*[:=]\s*["']?)([^"'\s,;]{8,})(["']?)/gi,
];

function redactSecrets(text, knownSecrets = []) {
  if (typeof text !== 'string') return text;
  let result = text;

  // 1. Redact explicit caller-provided secrets
  for (const secret of knownSecrets) {
    if (typeof secret === 'string' && secret.trim().length >= 6) {
      result = result.replaceAll(secret, '[REDACTED]');
    }
  }

  // 2. Redact common API keys
  result = result.replace(/\b(?:sk|xai)-[a-zA-Z0-9_\-]{20,}\b/gi, 'sk-***[REDACTED]');
  result = result.replace(/\bAIzaSy[a-zA-Z0-9_\-]{33}\b/gi, 'AIzaSy***[REDACTED]');

  // 3. Redact Bearer tokens
  result = result.replace(/\bBearer\s+[a-zA-Z0-9_\-\.]{20,}\b/gi, 'Bearer [REDACTED_TOKEN]');

  // 4. Redact key-value pairs (e.g. password="...", apiKey: "...")
  result = result.replace(
    /(["']?(?:password|api_?key|access_?token|auth(?:orization)?|secret)["']?\s*[:=]\s*["']?)([^"'\s,;]{8,})(["']?)/gi,
    (match, prefix, secretVal, suffix) => `${prefix}[REDACTED]${suffix}`
  );

  return result;
}

function redactObject(obj, knownSecrets = [], depth = 0) {
  if (depth > 6) return '[MAX_DEPTH]';
  if (obj === null || typeof obj !== 'object') {
    return typeof obj === 'string' ? redactSecrets(obj, knownSecrets) : obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => redactObject(item, knownSecrets, depth + 1));
  }

  const sanitized = {};
  const sensitiveKeys = new Set(['key', 'apiKey', 'api_key', 'password', 'secret', 'token', 'authorization', 'credential', 'credentialValue']);

  for (const [k, v] of Object.entries(obj)) {
    if (sensitiveKeys.has(k) && typeof v === 'string') {
      sanitized[k] = '[REDACTED]';
    } else {
      sanitized[k] = redactObject(v, knownSecrets, depth + 1);
    }
  }
  return sanitized;
}

module.exports = {
  redactSecrets,
  redactObject,
};
