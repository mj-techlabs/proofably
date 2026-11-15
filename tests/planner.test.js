import test from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { openAIPlanner, limitedFetch } from '../src/planners/openai.js';
import { plannerBudget, fixturePlanner, validateCases, buildRequest, preflight, usageRecord, CONTRACT_ID, INSTRUCTIONS } from '../src/planners/core.js';
const context = { target: { module: 'index.js', export: 'nextPowerOfTwo' }, contract: { id: CONTRACT_ID,
  provenance: { source: 'requirements', statement: 'Return the smallest power of two at least n for a positive safe integer n.' } },
  revisions: { base: '1'.repeat(40), candidate: '2'.repeat(40) }, sources: { base: 'function example(n) { return n; }', candidate: 'function example(n) { return n; }' }, diff: '' };
const cases = { cases: [{ arguments: [4], contractId: CONTRACT_ID, rationale: 'Check a boundary.' }] };
function response(text = JSON.stringify(cases)) {
  return { id: 'resp_offline', model: 'gpt-6-luna', status: 'completed', usage: { input_tokens: 100, output_tokens: 200,
    input_tokens_details: { cached_tokens: 10 }, output_tokens_details: { reasoning_tokens: 20 } },
  output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] }] };
}
function mocked(value = response()) {
  const requests = [];
  return { requests, client: { responses: { async create(body, options) { requests.push({ body, options }); return value; } } } };
}

test('OpenAI planner uses one strict Responses request and records usage and estimated cost', async () => {
  const mock = mocked();
  const result = await openAIPlanner(mock).proposeExperiments(context, {});
  assert.deepEqual(result.cases, cases.cases);
  assert.equal(mock.requests.length, 1);
  const { body, options } = mock.requests[0];
  assert.equal(body.model, 'gpt-6-luna');
  assert.equal(body.store, false);
  assert.equal(body.service_tier, 'default');
  assert.deepEqual(body.tools, []);
  assert.equal(body.text.format.strict, true);
  assert.equal(body.text.format.schema.additionalProperties, false);
  assert.equal(options.maxRetries, 0);
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(result.provenance.usage.inputTokens, 100);
  assert.equal(result.provenance.usage.outputTokens, 200);
  assert.ok(result.provenance.usage.estimatedCostUSD > 0);
  assert.equal(result.provenance.requestCount, 1);
});

test('official SDK works offline with mocked HTTP and retries disabled', async () => {
  let requests = 0;
  const client = new OpenAI({ apiKey: 'offline-test-only', logLevel: 'off', maxRetries: 0,
    fetch: limitedFetch(async () => { requests++; return new Response(JSON.stringify(response()), { headers: { 'content-type': 'application/json' } }); }) });
  const result = await openAIPlanner({ client }).proposeExperiments(context);
  assert.equal(result.cases[0].arguments[0], 4);
  assert.equal(requests, 1);
});

test('budget preflight rejects unknown pricing, input/output token estimates and cost before API access', async () => {
  const mock = mocked();
  await assert.rejects(openAIPlanner({ ...mock, model: 'unpriced-model' }).proposeExperiments(context), /unknown-pricing/);
  for (const budget of [{ maxCostUSD: 0.00000001 }, { maxInputTokens: 1024 }, { maxTotalTokens: 1152 }]) {
    await assert.rejects(openAIPlanner(mock).proposeExperiments(context, budget), /preflight-budget/);
  }
  assert.equal(mock.requests.length, 0);
  for (const budget of [{ maxCases: 9 }, { maxCases: 0 }, { timeoutMs: 60001 }, { maxOutputTokens: 100000 }, { maxCostUSD: NaN }]) {
    assert.throws(() => plannerBudget(budget), /invalid-budget/);
  }
});

test('cost reservation uses conservative input rates and includes output/reasoning tokens', () => {
  const budget = plannerBudget();
  const estimate = preflight(buildRequest(context, budget, 'gpt-6-luna'), budget);
  assert.ok(estimate.inputTokenUpperEstimate > Buffer.byteLength(JSON.stringify(context)));
  assert.equal(estimate.totalTokenUpperEstimate, estimate.inputTokenUpperEstimate + budget.maxOutputTokens);
  assert.equal(estimate.pricing.conservativeInputPerMillion, 0.25);
  assert.equal(usageRecord(null, estimate.pricing), null);
  const cost = usageRecord({ input_tokens: 1000000, output_tokens: 1000000 }, estimate.pricing);
  assert.equal(cost.estimatedCostUSD, 0.75);
  assert.equal(cost.standardTokenCostUSD, 0.60);
});

test('malformed JSON, refusal, incomplete responses and unexpected tool output are rejected with available usage', async () => {
  const refused = response();
  refused.output[0].content = [{ type: 'refusal', refusal: 'Cannot comply' }];
  const incomplete = { ...response(), status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } };
  const tool = { ...response(), output: [{ type: 'function_call', name: 'execute' }] };
  for (const [value, code] of [[response('not json'), 'malformed-json'], [refused, 'refusal'], [incomplete, 'incomplete-response'], [tool, 'unexpected-response-item']]) {
    await assert.rejects(openAIPlanner(mocked(value)).proposeExperiments(context), error => {
      assert.equal(error.code, code);
      assert.equal(error.metadata.usage.inputTokens, 100);
      return true;
    });
  }
});

test('model output cannot change target, contract, expected output or executable harness', async () => {
  for (const mutate of [c => { c.target = 'another.js'; }, c => { c.contractId = 'unknown'; },
    c => { c.expected = 8; }, c => { c.command = ['sh']; }, c => { c.code = 'process.exit()'; },
    c => { c.arguments = ['(() => 8)()']; }, c => { c.arguments = [0]; }, c => { c.arguments = [1.5]; },
    c => { c.arguments = [Number.MAX_SAFE_INTEGER + 1]; }, c => { c.arguments = [null]; },
    c => { c.arguments = [[[[[[1]]]]]]; }, c => { c.rationale = 'x'.repeat(513); }]) {
    const invalid = structuredClone(cases);
    mutate(invalid.cases[0]);
    await assert.rejects(openAIPlanner(mocked(response(JSON.stringify(invalid)))).proposeExperiments(context), /invalid/);
  }
});

test('count, response size, duplicate cases and unsupported in-memory argument types are bounded', async () => {
  const many = { cases: Array.from({ length: 6 }, (_, i) => ({ arguments: [i + 1], contractId: CONTRACT_ID })) };
  await assert.rejects(fixturePlanner(many).proposeExperiments(context), /invalid-response/);
  const duplicate = { cases: [cases.cases[0], cases.cases[0]] };
  await assert.rejects(fixturePlanner(duplicate).proposeExperiments(context), /duplicate-case/);
  await assert.rejects(openAIPlanner(mocked(response(' '.repeat(65537)))).proposeExperiments(context), /response-too-large/);
  assert.throws(() => validateCases({ cases: [{ arguments: [1n], contractId: CONTRACT_ID }] }, context, plannerBudget()), /invalid-response/);
  const result = await fixturePlanner({ cases: [{ arguments: [3], contractId: CONTRACT_ID }] }).proposeExperiments(context);
  assert.equal(result.cases[0].rationale, null);
  assert.equal(result.provenance.requestCount, 0);
});

test('request timeout aborts the request; SDK errors are sanitized and never retried', async () => {
  let count = 0;
  let signal;
  const client = { responses: { create(_request, options) { count++; signal = options.signal; return new Promise(() => {}); } } };
  await assert.rejects(openAIPlanner({ client }).proposeExperiments(context, { timeoutMs: 5 }), /request-timeout/);
  assert.equal(signal.aborted, true);
  assert.equal(count, 1);
  const errorClient = { responses: { async create() { throw new Error('secret-key-must-never-appear'); } } };
  await assert.rejects(openAIPlanner({ client: errorClient }).proposeExperiments(context), error => {
    assert.equal(error.code, 'api-request-failed');
    assert.doesNotMatch(JSON.stringify(error), /secret-key-must-never-appear/);
    return true;
  });
});

test('HTTP buffering is bounded before SDK parsing', async () => {
  const fetch = limitedFetch(async () => new Response('x'.repeat(1024)), 128);
  const result = await fetch('https://offline.invalid');
  await assert.rejects(result.text(), /http-response-too-large/);
});

test('missing key fails without network, and no prompt supplies a known triggering argument', async t => {
  const old = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  t.after(() => { if (old !== undefined) process.env.OPENAI_API_KEY = old; });
  await assert.rejects(openAIPlanner().proposeExperiments(context), /missing-api-key/);
  assert.doesNotMatch(INSTRUCTIONS, /\b8\b|<=|known defect|regression/i);
  assert.match(INSTRUCTIONS, /untrusted data/);
});

test('reported usage exceeding application budget stops execution of proposals', async () => {
  const value = response();
  value.usage.output_tokens = 10000;
  await assert.rejects(openAIPlanner(mocked(value)).proposeExperiments(context), /reported-usage-exceeds-budget/);
});

test('documented alternative models are configurable, with their own conservative cost reservation', async () => {
  const value = response();
  value.model = 'gpt-6.1-sol';
  const mock = mocked(value);
  const result = await openAIPlanner({ ...mock, model: 'gpt-6.1-sol' }).proposeExperiments(context, { maxCostUSD: 0.10 });
  assert.equal(mock.requests[0].body.model, 'gpt-6.1-sol');
  assert.equal(result.provenance.preflight.pricing.inputPerMillion, 2);
  const budget = plannerBudget();
  assert.throws(() => preflight(buildRequest(context, budget, 'gpt-6-luna'), budget, '2027-01-01'), /pricing-review-required/);
});

test('unexpected response model fails closed and retains token counts without claiming known pricing', async () => {
  const value = response();
  value.model = 'unknown-model';
  await assert.rejects(openAIPlanner(mocked(value)).proposeExperiments(context), error => {
    assert.equal(error.code, 'unexpected-model');
    assert.equal(error.metadata.usage.inputTokens, 100);
    assert.equal(error.metadata.usage.estimatedCostUSD, null);
    return true;
  });
});
