const POLICY_KEYS = ['instructions', 'defaultMode', 'maxMode', 'modelResource', 'permissions', 'limits'];
const PERMISSIONS = ['readFiles', 'writeFiles', 'executeCommands', 'mcp', 'delegate', 'knowledge'];
const MODES = ['chat', 'plan', 'agent'];
const LIMIT_MAX = { maxTokensPerRun: 1e9, maxStepsPerRun: 1000, maxDurationSeconds: 86400, maxCostPerRun: 1e6 };
const invalid = message => Object.assign(new Error(message), { status: 400 });

function legacyPolicy() {
  return { instructions: '', defaultMode: 'chat', maxMode: 'agent', modelResource: null,
    permissions: Object.fromEntries(PERMISSIONS.map(key => [key, true])), limits: {} };
}
function newPolicy() {
  return { instructions: '', defaultMode: 'plan', maxMode: 'plan', modelResource: null,
    permissions: { readFiles: true, writeFiles: false, executeCommands: false, mcp: false, delegate: false, knowledge: true }, limits: {} };
}
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(`Invalid Agent ${label}.`);
}
function knownKeys(value, keys, label) {
  object(value, label);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw invalid(`Unsupported Agent ${label}: ${key}`);
}
function validatePolicyPatch(input, previous = newPolicy()) {
  const next = structuredClone(previous);
  if (input.instructions !== undefined) {
    if (typeof input.instructions !== 'string' || input.instructions.length > 16000) throw invalid('Agent instructions must be at most 16000 characters.');
    next.instructions = input.instructions;
  }
  for (const key of ['defaultMode', 'maxMode']) {
    if (input[key] === undefined) continue;
    if (!MODES.includes(input[key])) throw invalid(`Invalid Agent ${key}.`);
    next[key] = input[key];
  }
  if (MODES.indexOf(next.defaultMode) > MODES.indexOf(next.maxMode)) throw invalid('Agent defaultMode exceeds maxMode.');
  if (input.modelResource !== undefined) {
    if (input.modelResource === null) next.modelResource = null;
    else {
      knownKeys(input.modelResource, ['connectionId', 'modelId', 'maxOutputTokens'], 'model resource');
      const resource = input.modelResource;
      for (const key of ['connectionId', 'modelId']) {
        if (typeof resource[key] !== 'string' || !resource[key].trim() || resource[key].length > 200 || /[\r\n\0]/.test(resource[key])) throw invalid(`Invalid Agent model resource ${key}.`);
      }
      next.modelResource = { connectionId: resource.connectionId.trim(), modelId: resource.modelId.trim() };
      if (resource.maxOutputTokens !== undefined) {
        if (!Number.isInteger(resource.maxOutputTokens) || resource.maxOutputTokens < 1 || resource.maxOutputTokens > 1000000) throw invalid('Invalid Agent maxOutputTokens.');
        next.modelResource.maxOutputTokens = resource.maxOutputTokens;
      }
    }
  }
  if (input.permissions !== undefined) {
    knownKeys(input.permissions, PERMISSIONS, 'permission');
    for (const [key, value] of Object.entries(input.permissions)) {
      if (typeof value !== 'boolean') throw invalid(`Agent permission ${key} must be boolean.`);
      next.permissions[key] = value;
    }
  }
  if (input.limits !== undefined) {
    knownKeys(input.limits, Object.keys(LIMIT_MAX), 'limit');
    for (const [key, value] of Object.entries(input.limits)) {
      if (value === null) { delete next.limits[key]; continue; }
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > LIMIT_MAX[key] || (key !== 'maxCostPerRun' && !Number.isInteger(value))) throw invalid(`Invalid Agent limit ${key}.`);
      next.limits[key] = value;
    }
  }
  return next;
}
function policyOf(agent) {
  return validatePolicyPatch(agent, legacyPolicy());
}
function restrictMode(requested, maximum) {
  return MODES[Math.min(MODES.indexOf(requested), MODES.indexOf(maximum))];
}
function toolAllowed(name, permissions) {
  if (['read', 'ls', 'find', 'grep', 'search'].includes(name)) return permissions.readFiles === true;
  if (['edit', 'write'].includes(name)) return permissions.writeFiles === true;
  if (['bash', 'powershell'].includes(name)) return permissions.executeCommands === true;
  if (name.startsWith('mcp__')) return permissions.mcp === true;
  if (name === 'search_knowledge') return permissions.knowledge === true;
  if (['workspace_delegate', 'workspace_list_profiles'].includes(name)) return permissions.delegate === true;
  return false;
}
function checkAgentBudget(limits, { tokens = 0, steps = 0, elapsedMs = 0, cost = 0, costKnown = true } = {}) {
  const checks = [
    ['maxTokensPerRun', tokens], ['maxStepsPerRun', steps],
    ['maxDurationSeconds', elapsedMs / 1000], ['maxCostPerRun', cost],
  ];
  if (limits.maxCostPerRun && !costKnown) return { allowed: false, reason: 'agent_cost_unknown', message: 'Agent has a USD cost limit, but this request has no confirmed USD price.' };
  for (const [key, current] of checks) {
    if (limits[key] && current >= limits[key]) return { allowed: false, reason: `agent_${key}`, message: `Agent ${key} reached (${current} >= ${limits[key]}).` };
  }
  return { allowed: true };
}
module.exports = { POLICY_KEYS, legacyPolicy, newPolicy, validatePolicyPatch, policyOf, restrictMode, toolAllowed, checkAgentBudget };
