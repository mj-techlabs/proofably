import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { planningContext } from '../src/planners/context.js';
import { fixturePlanner, CONTRACT_ID, PlannerError } from '../src/planners/core.js';
import { verifyWithPlanner } from '../src/ai-verification.js';
import { replayEvidence, readJsonFile, validateEvidence } from '../src/evidence-bundle.js';
import { functionRepository } from './helpers/function-repository.js';
import { fakeDocker, IMAGE_ID } from './helpers/fake-docker.js';
const generated = { cases: [{ arguments: [4], contractId: CONTRACT_ID, rationale: 'Boundary input.' },
  { arguments: [5], contractId: CONTRACT_ID, rationale: 'Adjacent input.' }] };
function parameters(t, source) {
  const repo = functionRepository(t, source);
  return { repository: repo.repository, base: repo.base, head: repo.candidate,
    experiment: repo.experiment, outputDirectory: join(repo.repository, 'ai-evidence') };
}

test('context resolves commits and selects only the explicit function; no seed arguments, unrelated source, or working-tree changes', t => {
  const input = parameters(t, 'const unrelatedSecret = "do-not-disclose";\nexport function nextPowerOfTwo(n) { return n; }\nexport function unrelated() { return unrelatedSecret; }');
  input.experiment.arguments = [919191];
  input.experiment.id = 'known-regression-do-not-send';
  writeFileSync(join(input.repository, 'index.js'), 'export function nextPowerOfTwo() { return "uncommitted-do-not-send"; }');
  writeFileSync(join(input.repository, 'secret.txt'), 'unrelated-file-secret');
  const { context } = planningContext(input);
  const text = JSON.stringify(context);
  assert.doesNotMatch(text, /do-not-disclose|uncommitted-do-not-send|unrelated-file-secret|919191|known-regression/);
  assert.equal(context.revisions.base, input.base);
  assert.equal(context.revisions.candidate, input.head);
  assert.match(context.sources.candidate, /function nextPowerOfTwo/);
  assert.match(context.diff, /candidate selected function/);
});

test('context accepts direct function exports, arrow exports and local export aliases', t => {
  for (const source of ['export const nextPowerOfTwo = n => n;', 'function local(n) { return n; } export { local as nextPowerOfTwo };']) {
    const input = parameters(t, source);
    assert.match(planningContext(input).context.sources.candidate, /=>|function local/);
  }
});

test('context rejects symlinks, missing exports, async functions, unsupported contracts and excessive context', t => {
  for (const source of ['export const unrelated = 8;', 'export async function nextPowerOfTwo(n) { return n; }',
    'export function nextPowerOfTwo(n) { /*' + 'x'.repeat(5000) + '*/ return n; }']) {
    assert.throws(() => planningContext(parameters(t, source)), PlannerError);
  }
  const input = parameters(t);
  input.experiment.target.module = 'outside.js';
  assert.throws(() => planningContext(input), /target-not-regular-file/);
  input.experiment.target.module = 'index.js';
  input.experiment.contract.id = 'model-defined-rule';
  assert.throws(() => planningContext(input), /unsupported-contract/);
});

test('fixture orchestration writes ordinary replayable bundles and separate planner provenance without an API', async t => {
  const input = parameters(t);
  const fake = fakeDocker();
  const result = await verifyWithPlanner(input, { planner: fixturePlanner(generated), ...fake });
  assert.equal(result.manifest.status, 'completed');
  assert.equal(result.manifest.planner.provider, 'fixture');
  assert.equal(result.manifest.planner.requestCount, 0);
  assert.equal(result.manifest.cases.length, 2);
  const plan = readJsonFile(join(result.directory, 'planning.json'));
  assert.deepEqual(plan.cases.map(c => c.arguments), [[4], [5]]);
  assert.match(plan.contextSha256, /^[a-f0-9]{64}$/);
  for (const entry of result.manifest.cases) {
    const bundle = readJsonFile(join(result.directory, entry.evidence.file));
    assert.equal(validateEvidence(bundle), bundle);
    assert.equal(bundle.bundleVersion, 1);
    assert.equal(bundle.execution.imageId, IMAGE_ID);
    assert.equal(bundle.execution.settings.repetitions, 3);
    assert.deepEqual(bundle.experiment.arguments, entry.arguments);
  }
  assert.equal(fake.calls.filter(c => c.args[0] === 'start').length, 12);
  const first = readJsonFile(join(result.directory, 'case-001.json'));
  assert.equal(replayEvidence(first, { repository: input.repository }, fakeDocker()).status, 'match');
});

test('invalid provider proposals never reach Docker execution or a confirmed verdict', async t => {
  const input = parameters(t);
  const fake = fakeDocker();
  const planner = { async proposeExperiments() { return { cases: [{ arguments: [4], contractId: CONTRACT_ID, expected: 4 }], provenance: { provider: 'fixture' } }; } };
  const { manifest } = await verifyWithPlanner(input, { planner, ...fake });
  assert.equal(manifest.error, 'invalid-case');
  assert.equal(manifest.summary.confirmedViolations, 0);
  assert.equal(fake.calls.filter(c => c.args[0] === 'start').length, 0);
});

test('planner refusal/error preserves sanitized usage and produces no case executions', async t => {
  const input = parameters(t);
  const fake = fakeDocker();
  const planner = { async proposeExperiments() { throw new PlannerError('refusal', { provider: 'openai', usage: { inputTokens: 10, outputTokens: 20, estimatedCostUSD: 0.00002 } }); } };
  const { manifest } = await verifyWithPlanner(input, { planner, ...fake });
  assert.equal(manifest.error, 'refusal');
  assert.equal(manifest.planner.usage.inputTokens, 10);
  assert.equal(fake.calls.filter(c => c.args[0] === 'create').length, 0);
});

test('partial case failures keep earlier evidence and never falsely confirm a failed case', async t => {
  const input = parameters(t);
  let calls = 0;
  const { manifest, directory } = await verifyWithPlanner(input, { planner: fixturePlanner(generated), ...fakeDocker(),
    verify: (...args) => {
      calls++;
      if (calls === 2) throw new Error('untrusted infrastructure message');
      // Use a real deterministic runner with fake Docker through its dependency seam.
      return importRunner(...args);
    } });
  assert.equal(manifest.status, 'partial');
  assert.ok(manifest.cases[0].evidence);
  assert.equal(manifest.cases[1].classification, 'unverified');
  assert.equal(manifest.cases[1].reason, 'case-execution-or-evidence-failed');
  assert.ok(readdirSync(directory).includes('case-001.json'));
});
import { verifyFunctionExperiment as importRunner } from '../src/function-runner.js';

test('overall AI deadline skips remaining cases while preserving all generated inputs', async t => {
  const input = parameters(t);
  const clockStart = performance.now();
  let clock = clockStart;
  // This fixture planner consumes the entire execution budget.
  const planner = { async proposeExperiments() { clock += 180000;
    return { cases: generated.cases, provenance: { provider: 'fixture', requestCount: 0 } };
  } };
  const { manifest } = await verifyWithPlanner(input, { planner, ...fakeDocker(), now: () => clock });
  assert.equal(manifest.status, 'partial');
  assert.deepEqual(manifest.cases.map(c => c.arguments), [[4], [5]]);
  assert.ok(manifest.cases.every(c => c.reason === 'overall-budget-exhausted' && !c.evidence));
  assert.equal(manifest.summary.unverified, 2);
});

test('a planner that ignores its budget cannot hang orchestration', async t => {
  const input = parameters(t);
  input.budget = { timeoutMs: 5 };
  const { manifest } = await verifyWithPlanner(input, { planner: { proposeExperiments: () => new Promise(() => {}) }, ...fakeDocker() });
  assert.equal(manifest.error, 'request-timeout');
});

test('AI output directories are exclusive; previous artifacts are never overwritten', async t => {
  const input = parameters(t);
  mkdirSync(input.outputDirectory);
  writeFileSync(join(input.outputDirectory, 'original.txt'), 'keep');
  await assert.rejects(verifyWithPlanner(input, { planner: fixturePlanner(generated), ...fakeDocker() }), /EEXIST/);
  assert.equal(readFileSync(join(input.outputDirectory, 'original.txt'), 'utf8'), 'keep');
});

test('AI mode is explicit and existing CLI help remains compatible', () => {
  for (const args of [['--help'], ['replay', '--help'], ['ai', '--help']]) {
    const result = spawnSync(process.execPath, ['src/function-cli.js', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage:/);
  }
});

test('Docker host subprocesses never inherit OpenAI credentials or endpoint overrides', t => {
  const input = parameters(t);
  const bin = join(input.repository, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'docker'), '#!/usr/bin/env node\nprocess.stdout.write(Object.keys(process.env).some(key => key.startsWith("OPENAI_")) ? "present" : "absent");\n', { mode: 0o755 });
  const previous = { path: process.env.PATH, key: process.env.OPENAI_API_KEY, url: process.env.OPENAI_BASE_URL };
  process.env.PATH = bin + ':' + previous.path;
  process.env.OPENAI_API_KEY = 'offline-sentinel-key';
  process.env.OPENAI_BASE_URL = 'https://offline.invalid';
  t.after(() => {
    process.env.PATH = previous.path;
    for (const [key, value] of [['OPENAI_API_KEY', previous.key], ['OPENAI_BASE_URL', previous.url]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const result = dockerCommand(['info'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'absent');
});
import { dockerCommand } from '../src/function-runner.js';

test('AI manifest exposes a failed base while preserving independently confirmed candidate evidence', async t => {
  const input = parameters(t);
  const fake = fakeDocker({ result: index => index === 1 ? { status: 125, stderr: 'daemon failure' } :
    { status: 0, stdout: '{"protocolVersion":1,"outcome":"returned","value":16}' } });
  const { manifest } = await verifyWithPlanner(input, { planner: fixturePlanner({ cases: [generated.cases[0]] }), ...fake });
  assert.equal(manifest.status, 'partial');
  assert.equal(manifest.cases[0].contracts.base.status, 'unverified');
  assert.equal(manifest.cases[0].contracts.candidate.status, 'confirmed-contract-violation');
  assert.equal(manifest.cases[0].hasUnverifiedRevision, true);
  assert.equal(manifest.summary.confirmedViolations, 1);
  assert.equal(manifest.summary.unverified, 1);
});
