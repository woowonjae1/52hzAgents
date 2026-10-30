const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { createStorage } = require('./index');
const { startServer } = require('../index');

function makeTempDir(prefix = '52hz-budget-test-') {
  const dir = path.join(process.cwd(), '.tmp', `${prefix}${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('Context, Tokens, Pricing & Budgets (Package G & F1)', async (t) => {
  const tempDir = makeTempDir();
  const staticDir = path.join(__dirname, '..', '..', 'resources', 'public');
  const storage = createStorage({ dbPath: path.join(tempDir, 'budget-test.sqlite') });

  t.after(() => {
    storage.close();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {}
  });

  // Seed project and session for FK integrity
  storage.projects.create({ id: 'proj_bg_test', name: 'Budget Test', path: tempDir });
  storage.sessions.create({ id: 'sess_bg_test', projectId: 'proj_bg_test', title: 'Budget Session' });
  storage.runs.create({ id: 'run_bg_1', sessionId: 'sess_bg_test' });

  await t.test('G1: Request-Level Accounting & Model Invocations', () => {
    const req1 = storage.usage.recordModelRequest({
      id: 'req_call_1',
      runId: 'run_bg_1',
      sessionId: 'sess_bg_test',
      provider: 'openai',
      modelId: 'gpt-4o',
      purpose: 'generate',
      promptTokens: 1000,
      completionTokens: 200,
      cacheReadTokens: 500,
      estimatedCost: 0.005125,
      currency: 'USD',
      pricingVersion: 'preset:openai:gpt-4o',
      rawUsageJson: { prompt_tokens: 1000, completion_tokens: 200, cache_read_tokens: 500 },
      latencyMs: 1250,
      status: 'completed',
    });

    assert.equal(req1.id, 'req_call_1');
    assert.equal(req1.purpose, 'generate');
    assert.equal(req1.totalTokens, 1700);
    assert.equal(req1.promptTokens, 1000);
    assert.equal(req1.cacheReadTokens, 500);
    assert.equal(req1.estimatedCost, 0.005125);
    assert.deepEqual(req1.rawUsage, { prompt_tokens: 1000, completion_tokens: 200, cache_read_tokens: 500 });

    const requests = storage.usage.listModelRequestsByRun('run_bg_1');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].id, 'req_call_1');
  });

  await t.test('G2: Pricing Catalog, Calculation & Missing Price Protection', () => {
    // 1. Preset pricing lookup
    const gpt4oPricing = storage.pricing.get('openai', 'gpt-4o');
    assert.ok(gpt4oPricing);
    assert.equal(gpt4oPricing.inputCostPerMillion, 2.50);
    assert.equal(gpt4oPricing.outputCostPerMillion, 10.00);
    assert.equal(gpt4oPricing.cacheReadCostPerMillion, 1.25);

    // 2. Accurate cost calculation (uncached prompt tokens + cached prompt tokens + completion tokens)
    // 100,000 prompt tokens with 40,000 cacheRead -> 60,000 uncached ($0.15) + 40,000 cached ($0.05) + 20,000 completion ($0.20) = $0.40
    const calc = storage.pricing.calculateCost({
      provider: 'openai',
      modelId: 'gpt-4o',
      promptTokens: 100_000,
      completionTokens: 20_000,
      cacheReadTokens: 40_000,
    });
    assert.equal(calc.isCostKnown, true);
    assert.equal(calc.estimatedCost, 0.40);
    assert.equal(calc.currency, 'USD');

    // 3. DeepSeek CNY/USD pricing
    const deepseekCalc = storage.pricing.calculateCost({
      provider: 'deepseek',
      modelId: 'deepseek-chat',
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
    });
    assert.equal(deepseekCalc.isCostKnown, true);
    assert.equal(deepseekCalc.estimatedCost, 0.42);

    // 4. Custom pricing override
    storage.pricing.setCustomPrice({
      provider: 'my-proxy',
      modelId: 'custom-llama-3',
      inputCostPerMillion: 0.50,
      outputCostPerMillion: 1.50,
      currency: 'USD',
    });
    const customCalc = storage.pricing.calculateCost({
      provider: 'my-proxy',
      modelId: 'custom-llama-3',
      promptTokens: 2_000_000,
      completionTokens: 1_000_000,
    });
    assert.equal(customCalc.isCostKnown, true);
    assert.equal(customCalc.estimatedCost, 2.50);

    // 5. Missing price protection: NEVER return zero when price is unknown!
    const unknownCalc = storage.pricing.calculateCost({
      provider: 'mystery-provider',
      modelId: 'unlisted-model-v99',
      promptTokens: 10_000,
      completionTokens: 2_000,
    });
    assert.equal(unknownCalc.isCostKnown, false);
    assert.equal(unknownCalc.estimatedCost, null);

    // 6. Usage recording with and without cost
    storage.usage.recordUsage({
      sessionId: 'sess_bg_test',
      model: 'gpt-4o',
      promptTokens: 100_000,
      completionTokens: 20_000,
      estimatedCost: 0.50,
    });

    const summaryKnown = storage.usage.getSummaryForSession('sess_bg_test');
    assert.equal(summaryKnown.hasUnknownCost, false);
    assert.equal(summaryKnown.estimatedCost, 0.50);

    // Record usage for unknown model
    storage.usage.recordUsage({
      sessionId: 'sess_bg_test',
      model: 'unlisted-model-v99',
      promptTokens: 50_000,
      completionTokens: 10_000,
      estimatedCost: null, // Unknown price!
    });

    const summaryWithUnknown = storage.usage.getSummaryForSession('sess_bg_test');
    assert.equal(summaryWithUnknown.hasUnknownCost, true);
    assert.equal(summaryWithUnknown.estimatedCost, null, 'Expected estimatedCost to be null when any price is missing');
  });

  await t.test('G3: Budget Limits Preflight & Threshold Enforcement', () => {
    // 1. Check default global budget passes normal run
    const preflightOk = storage.budgets.checkPreflight({
      sessionId: 'sess_bg_test',
      currentStepCount: 5,
      elapsedMs: 20_000,
      runTokens: 10_000,
    });
    assert.equal(preflightOk.allowed, true);

    // 2. Step limit exceeded
    const stepExceeded = storage.budgets.checkPreflight({
      sessionId: 'sess_bg_test',
      currentStepCount: 35, // default max is 30
    });
    assert.equal(stepExceeded.allowed, false);
    assert.equal(stepExceeded.reason, 'step_limit_exceeded');

    // 3. Time duration exceeded
    const timeExceeded = storage.budgets.checkPreflight({
      sessionId: 'sess_bg_test',
      elapsedMs: 650_000, // default max is 600s
    });
    assert.equal(timeExceeded.allowed, false);
    assert.equal(timeExceeded.reason, 'duration_exceeded');

    // 4. Custom session budget threshold
    storage.budgets.setForSession('sess_bg_test', {
      maxTokensPerRun: 50_000,
      maxStepsPerRun: 10,
      maxCostPerSession: 2.00,
    });

    const sessionBudget = storage.budgets.getForSession('sess_bg_test');
    assert.equal(sessionBudget.maxTokensPerRun, 50_000);
    assert.equal(sessionBudget.maxStepsPerRun, 10);
    assert.equal(sessionBudget.maxCostPerSession, 2.00);

    // Cost budget threshold exceeded
    const costExceeded = storage.budgets.checkPreflight({
      sessionId: 'sess_bg_test',
      sessionCost: 2.50, // exceeds $2.00 limit
    });
    assert.equal(costExceeded.allowed, false);
    assert.equal(costExceeded.reason, 'cost_limit_exceeded');
  });

  await t.test('F1: Model Capabilities Catalog & Declarations', () => {
    // 1. Preset capabilities lookup
    const gpt4oCap = storage.capabilities.get('openai', 'gpt-4o');
    assert.ok(gpt4oCap);
    assert.equal(gpt4oCap.contextWindow, 128000);
    assert.equal(gpt4oCap.supportsTools, true);
    assert.equal(gpt4oCap.supportsVision, true);
    assert.equal(gpt4oCap.supportsReasoning, false);
    assert.equal(gpt4oCap.capabilityStatus, 'declared');

    // 2. DeepSeek R1 reasoning without tool support
    const r1Cap = storage.capabilities.get('deepseek', 'deepseek-reasoner');
    assert.ok(r1Cap);
    assert.equal(r1Cap.supportsTools, false);
    assert.equal(r1Cap.supportsReasoning, true);

    // 3. Set custom capability and mark as verified
    storage.capabilities.set('my-conn', 'my-fine-tuned-model', {
      contextWindow: 65536,
      maxOutputTokens: 8192,
      supportsTools: true,
      capabilityStatus: 'verified',
    });

    const customCap = storage.capabilities.get('my-conn', 'my-fine-tuned-model');
    assert.equal(customCap.contextWindow, 65536);
    assert.equal(customCap.capabilityStatus, 'verified');
    assert.ok(customCap.verifiedAt);
  });

  await t.test('HTTP API Endpoints for Pricing, Budgets & Capabilities', async () => {
    const { server, port } = await startServer({
      port: 0,
      userDataPath: tempDir,
      staticDir,
    });

    try {
      // 1. GET /v1/settings/pricing
      const pricingRes = await new Promise((resolve) => {
        http.get(`http://127.0.0.1:${port}/v1/settings/pricing?provider=openai`, (res) => {
          let body = '';
          res.on('data', chunk => body += chunk);
          res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(body) }));
        });
      });
      assert.equal(pricingRes.status, 200);
      assert.ok(pricingRes.data.pricing.length > 0);

      // 2. GET /v1/settings/budgets
      const budgetRes = await new Promise((resolve) => {
        http.get(`http://127.0.0.1:${port}/v1/settings/budgets?sessionId=sess_bg_test`, (res) => {
          let body = '';
          res.on('data', chunk => body += chunk);
          res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(body) }));
        });
      });
      assert.equal(budgetRes.status, 200);
      assert.ok(budgetRes.data.budget);
      assert.ok(budgetRes.data.budget.maxStepsPerRun > 0);

      // 3. GET /v1/settings/capabilities
      const capRes = await new Promise((resolve) => {
        http.get(`http://127.0.0.1:${port}/v1/settings/capabilities?connectionId=openai`, (res) => {
          let body = '';
          res.on('data', chunk => body += chunk);
          res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(body) }));
        });
      });
      assert.equal(capRes.status, 200);
      assert.ok(capRes.data.capabilities.length > 0);

      // 4. GET /v1/usage/summary
      const usageRes = await new Promise((resolve) => {
        http.get(`http://127.0.0.1:${port}/v1/usage/summary?channel=sess_bg_test`, (res) => {
          let body = '';
          res.on('data', chunk => body += chunk);
          res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(body) }));
        });
      });
      assert.equal(usageRes.status, 200);
      assert.ok('totalTokens' in usageRes.data);
      assert.ok('hasUnknownCost' in usageRes.data);
    } finally {
      await server.shutdown();
    }
  });
});
