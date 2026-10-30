const fs = require('fs');
const path = require('path');
const os = require('os');

// Called only by the trusted desktop IPC bridge. Never returns credentials.
function importPiConnections(manager, filename = path.join(os.homedir(), '.pi', 'agent', 'models.json')) {
  let source;
  try {
    source = JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch {
    throw new Error('Pi models.json could not be read or parsed.');
  }
  const imported = [], skipped = [];
  const pending = [];

  for (const [id, p] of Object.entries(source.providers || {})) {
    const protocol = p.api === 'anthropic-messages' ? 'anthropic' : p.api === 'openai-completions' ? 'openai' : null;
    if (!protocol || !p.baseUrl || Object.keys(p.headers || {}).length) {
      skipped.push(id);
      continue;
    }
    const reference = typeof p.apiKey === 'string' ? p.apiKey : '';
    const secret = process.env[reference] || (/^[A-Z_][A-Z0-9_]*$/.test(reference) ? '' : reference);
    if (!secret || secret.startsWith('!')) {
      skipped.push(id);
      continue;
    }
    const models = (p.models || []).filter(m => typeof m.id === 'string').map(m => ({
      id: m.id,
      name: m.name || m.id,
      confirmedContextWindow: Number.isSafeInteger(m.contextWindow) ? m.contextWindow : undefined,
      maxTokens: m.maxTokens,
    }));
    if (!models.length) {
      skipped.push(id);
      continue;
    }

    const res = manager.saveConnection({
      id: `pi-${id}`,
      name: `Pi · ${id}`,
      protocol,
      baseUrl: p.baseUrl,
      defaultModel: models[0].id,
      models,
      confirmedContextWindow: models[0].confirmedContextWindow,
      credentialAction: 'replace',
      credentialValue: secret,
    });

    if (res && typeof res.then === 'function') {
      pending.push(
        res.then(saved => {
          imported.push({ id: saved.id, name: saved.name, model: saved.defaultModel });
        })
      );
    } else {
      imported.push({ id: res.id, name: res.name, model: res.defaultModel });
    }
  }

  if (pending.length > 0) {
    return Promise.all(pending).then(() => ({ imported, skipped }));
  }
  return { imported, skipped };
}

module.exports = { importPiConnections };
