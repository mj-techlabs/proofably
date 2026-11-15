import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { verifyWithPlanner } from '../src/ai-verification.js';
import { dockerAvailability } from '../src/function-runner.js';
import { functionRepository } from './helpers/function-repository.js';

const enabled = process.env.PROOFABLY_LIVE_API_TEST === '1';
const keyAvailable = Boolean(process.env.OPENAI_API_KEY);
const skip = !enabled ? 'Live API test disabled: set PROOFABLY_LIVE_API_TEST=1 explicitly' :
  !keyAvailable ? 'OPENAI_API_KEY unavailable; live demonstration not run' : dockerAvailability() || false;

test('LIVE OpenAI: discover adversarial inputs and reproduce the nextPowerOfTwo violation', { skip, timeout: 240000 }, async t => {
  // Intentionally retained: its exact Git objects are needed for subsequent replay.
  const input = functionRepository(t, undefined, { preserve: true });
  input.experiment.expectedExecution.timeoutMs = 10000;
  const outputDirectory = process.env.PROOFABLY_LIVE_OUTPUT_DIR || join(process.cwd(), `proofably-ai-live-${randomUUID()}`);
  const result = await verifyWithPlanner({ repository: input.repository, base: input.base, head: input.candidate,
    experiment: input.experiment, outputDirectory, budget: { maxCases: 5, maxCostUSD: 0.02 } });
  t.diagnostic(JSON.stringify({ manifest: join(result.directory, 'manifest.json'), replayRepository: input.repository,
    model: result.manifest.planner?.model, usage: result.manifest.planner?.usage,
    generatedInputs: result.manifest.cases.map(c => c.arguments), summary: result.manifest.summary }));
  assert.equal(result.manifest.status, 'completed', JSON.stringify(result.manifest));
  // No hardcoded triggering input or fallback proposal is supplied to the model.
  assert.ok(result.manifest.cases.some(c => c.contracts?.base.status === 'satisfied' &&
    c.contracts?.candidate.status === 'confirmed-contract-violation'), 'The single model request did not discover a reproducing input');
});
