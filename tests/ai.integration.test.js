import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { verifyWithPlanner } from '../src/ai-verification.js';
import { fixturePlanner, CONTRACT_ID } from '../src/planners/core.js';
import { readJsonFile, replayEvidence } from '../src/evidence-bundle.js';
import { dockerAvailability } from '../src/function-runner.js';
import { functionRepository } from './helpers/function-repository.js';
const unavailable = dockerAvailability();
const options = { skip: unavailable || false, timeout: 120000 };
const proposals = { cases: [{ arguments: [4], contractId: CONTRACT_ID, rationale: 'Boundary input.' },
  { arguments: [5], contractId: CONTRACT_ID, rationale: 'Adjacent input.' }] };

test('Docker AI pipeline: fixture planner generates cases, reproduces a violation, and replays without a model', options, async t => {
  const input = functionRepository(t);
  input.experiment.expectedExecution.timeoutMs = 10000;
  const { manifest, directory } = await verifyWithPlanner({ repository: input.repository, base: input.base,
    head: input.candidate, experiment: input.experiment, outputDirectory: join(input.repository, 'ai-run'),
    image: process.env.PROOFABLY_TEST_IMAGE || 'node:22-alpine' }, { planner: fixturePlanner(proposals) });
  assert.equal(manifest.status, 'completed', JSON.stringify(manifest));
  assert.deepEqual(manifest.summary, { confirmedViolations: 1, behavioralDifferences: 0, unverified: 0, noDifference: 1 });
  assert.equal(manifest.planner.requestCount, 0);
  const boundary = readJsonFile(join(directory, 'case-001.json'));
  assert.deepEqual(boundary.attempts.base.map(a => a.value), [4, 4, 4]);
  assert.deepEqual(boundary.attempts.candidate.map(a => a.value), [8, 8, 8]);
  assert.equal(boundary.contracts.base.status, 'satisfied');
  assert.equal(boundary.contracts.candidate.status, 'confirmed-contract-violation');
  assert.ok(Object.values(boundary.attempts).flat().every(a => a.cleanup.verified));
  const replay = replayEvidence(boundary, { repository: input.repository });
  assert.equal(replay.status, 'match');
  const adjacent = readJsonFile(join(directory, 'case-002.json'));
  assert.deepEqual(adjacent.attempts.candidate.map(a => a.value), [8, 8, 8]);
  assert.equal(adjacent.comparison, 'no-difference');
  t.diagnostic(JSON.stringify({ provider: 'fixture', inputs: proposals.cases.map(c => c.arguments), summary: manifest.summary, replay: replay.status }));
});

test('Docker AI pipeline: generated cases with function exceptions remain unverified', options, async t => {
  const input = functionRepository(t, 'export function nextPowerOfTwo() { throw new Error("fixture failure"); }');
  input.experiment.expectedExecution.timeoutMs = 10000;
  const { manifest, directory } = await verifyWithPlanner({ repository: input.repository, base: input.base,
    head: input.candidate, experiment: input.experiment, outputDirectory: join(input.repository, 'ai-failure'),
    image: process.env.PROOFABLY_TEST_IMAGE || 'node:22-alpine' }, { planner: fixturePlanner(proposals) });
  assert.equal(manifest.status, 'partial');
  assert.equal(manifest.summary.confirmedViolations, 0);
  assert.equal(manifest.summary.unverified, 2);
  for (const c of manifest.cases) {
    const evidence = readJsonFile(join(directory, c.evidence.file));
    assert.ok(evidence.attempts.candidate.every(a => a.kind === 'function-exception' && a.cleanup.verified));
    assert.equal(evidence.contracts.candidate.status, 'unverified');
  }
});
