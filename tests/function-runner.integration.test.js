import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dockerAvailability, verifyFunctionExperiment } from '../src/function-runner.js';
import { functionRepository } from './helpers/function-repository.js';
import { serializeEvidence, readJsonFile, replayEvidence } from '../src/evidence-bundle.js';

const unavailable = dockerAvailability();
const image = process.env.PROOFABLY_TEST_IMAGE || 'node:22-alpine';
// A running daemon with a missing image is a failure, not a skipped test.
const options = { skip: unavailable || false, timeout: 120000 };
function verify(t, source, changeExperiment, repetitions = 1) {
  const input = functionRepository(t, source);
  input.experiment.expectedExecution.timeoutMs = 10000;
  changeExperiment?.(input.experiment);
  const report = verifyFunctionExperiment({ ...input, image, repetitions });
  t.after(() => {
    for (const observation of Object.values(report.attempts).flat()) {
      if (!observation.cleanup) continue;
      assert.equal(observation.cleanup.removed, true);
      const inspection = spawnSync('docker', ['container', 'inspect', observation.cleanup.name], { encoding: 'utf8', timeout: 8000 });
      assert.notEqual(inspection.status, 0, 'container must have been removed');
      assert.match(inspection.stderr, /No such (object|container)/i);
    }
  });
  return { ...report, fixtureRepository: input.repository };
}

function checkFailure(report, kind) {
  assert.equal(report.observations.candidate.kind, kind, JSON.stringify({ kind: report.observations.candidate.kind, detail: report.observations.candidate.detail }));
  assert.equal(report.contracts.candidate.status, 'unverified');
  assert.equal(report.comparison, 'unverified');
}

test('Docker: nextPowerOfTwo base=8 and candidate=16 with independent verdicts', options, t => {
  const { fixtureRepository, ...report } = verify(t, undefined, undefined, 3);
  assert.deepEqual(report.attempts.base.map(a => a.value), [8, 8, 8]);
  assert.deepEqual(report.attempts.candidate.map(a => a.value), [16, 16, 16]);
  assert.equal(new Set([...report.attempts.base, ...report.attempts.candidate].map(a => a.cleanup.name)).size, 6);
  assert.equal(report.observations.base.value, 8, JSON.stringify(report.observations.base));
  assert.equal(report.observations.candidate.value, 16);
  assert.equal(report.contracts.base.status, 'satisfied');
  assert.equal(report.contracts.candidate.status, 'confirmed-contract-violation');
  assert.equal(report.comparison, 'behavioral-difference');
  assert.match(report.revisions.base, /^[a-f0-9]{40,64}$/);
  assert.notEqual(report.observations.base.cleanup.name, report.observations.candidate.cleanup.name);
  const original = join(fixtureRepository, 'evidence.json');
  const output = join(fixtureRepository, 'replay.json');
  const saved = serializeEvidence(report);
  writeFileSync(original, saved);
  const replay = spawnSync(process.execPath, [new URL('../src/function-cli.js', import.meta.url).pathname,
    'replay', '--bundle', original, '--repository', fixtureRepository, '--output', output],
  { encoding: 'utf8', timeout: 110000 });
  assert.equal(replay.status, 0, replay.stderr);
  const replayed = readJsonFile(output);
  assert.equal(replayed.mode, 'execution-replay');
  assert.equal(replayed.status, 'match');
  assert.deepEqual(replayed.evidence.attempts.base.map(a => a.value), [8, 8, 8]);
  assert.deepEqual(replayed.evidence.attempts.candidate.map(a => a.value), [16, 16, 16]);
  assert.equal(replayed.evidence.contracts.candidate.status, 'confirmed-contract-violation');
  assert.equal(readFileSync(original, 'utf8'), saved);
  const oldNames = new Set(Object.values(report.attempts).flat().map(a => a.cleanup.name));
  assert.ok(Object.values(replayed.evidence.attempts).flat().every(a => a.cleanup.verified && !oldNames.has(a.cleanup.name)));
});

test('Docker: function exception is unverified', options, t => {
  checkFailure(verify(t, 'export function nextPowerOfTwo() { throw new Error("boom"); }'), 'function-exception');
});

test('Docker: non-JSON and asynchronous outputs are invalid', options, t => {
  for (const expression of ['undefined', 'NaN', '1n', 'Promise.resolve(8)', '({ toJSON() { return 8; } })', '({ get value() { return 8; } })', '(() => { const a = {}; a.a = a; return a; })()']) {
    checkFailure(verify(t, `export function nextPowerOfTwo() { return ${expression}; }`), 'invalid-output');
  }
});

test('Docker: infinite function times out and container is removed', options, t => {
  checkFailure(verify(t, 'export function nextPowerOfTwo() { while (true) {} }', e => {
    e.expectedExecution.timeoutMs = 3000;
  }), 'timeout');
});

test('Docker: output flooding is bounded and unverified', options, t => {
  checkFailure(verify(t, 'import { writeSync } from "node:fs"; export function nextPowerOfTwo() { while (true) { try { writeSync(2, "x".repeat(65536)); } catch (error) { if (error.code !== "EAGAIN") throw error; } } }', e => {
    e.expectedExecution.timeoutMs = 10000;
  }), 'output-limit');
});

test('Docker: target logs cannot corrupt the result channel', options, t => {
  const report = verify(t, 'export function nextPowerOfTwo() { console.log("not JSON"); console.error("diagnostic"); return 8; }');
  assert.equal(report.observations.candidate.value, 8);
  assert.equal(report.contracts.candidate.status, 'satisfied');
  assert.match(report.observations.candidate.stderr, /not JSON/);
});

test('Docker: missing export, escaping symlink, and abrupt worker exit are unverified', options, t => {
  checkFailure(verify(t, 'export const other = 8;'), 'target-error');
  checkFailure(verify(t, undefined, e => { e.target.module = 'outside.js'; }), 'target-error');
  checkFailure(verify(t, 'export function nextPowerOfTwo() { process.exit(0); }'), 'execution-error');
});

test('Docker: missing image is infrastructure failure, never a violation', options, t => {
  const input = functionRepository(t);
  const report = verifyFunctionExperiment({ ...input, image: 'proofably-intentionally-missing:task2' });
  checkFailure(report, 'infrastructure-error');
});


test('Docker: legacy command CLI retains comparison and report behavior', options, t => {
  const input = functionRepository(t);
  const spec = join(input.repository, 'commands.json');
  const output = join(input.repository, 'legacy-report.json');
  writeFileSync(spec, JSON.stringify({ experiments: [{ id: 'boundary', command: ['node', '--input-type=module', '-e',
    'import { nextPowerOfTwo } from "./index.js"; console.log(nextPowerOfTwo(8));'] }] }));
  const result = spawnSync(process.execPath, [new URL('../src/cli.js', import.meta.url).pathname,
    'check', '--base', input.base, '--head', input.candidate, '--experiments', spec, '--output', output],
  { cwd: input.repository, encoding: 'utf8', timeout: 90000 });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.findings[0].status, 'behavioral-difference');
  assert.equal(report.findings[0].base.stdout.trim(), '8');
  assert.equal(report.findings[0].candidate.stdout.trim(), '16');
});


test('Docker: stable matching results reproduce across three containers per revision', options, t => {
  const source = readFileSync(new URL('./fixtures/power-of-two/base.js', import.meta.url), 'utf8');
  const report = verify(t, source, undefined, 3);
  assert.equal(report.comparison, 'no-difference');
  assert.equal(report.contracts.base.status, 'satisfied');
  assert.equal(report.contracts.candidate.status, 'satisfied');
});

test('Docker: conflicting container-dependent outputs never confirm a violation', options, t => {
  const report = verify(t, 'export function nextPowerOfTwo() { return process.env.HOSTNAME; }', undefined, 3);
  assert.equal(report.reproduction.candidate.reason, 'inconsistent-results');
  assert.equal(report.contracts.candidate.status, 'unverified');
  assert.equal(report.contracts.base.status, 'satisfied');
  assert.equal(report.comparison, 'unverified');
});

test('Docker: negative zero survives harness, serialized evidence and execution replay', options, t => {
  const { fixtureRepository, ...report } = verify(t, 'export function nextPowerOfTwo() { return -0; }');
  assert.ok(Object.is(report.attempts.candidate[0].value, -0));
  const saved = JSON.parse(serializeEvidence(report));
  assert.ok(Object.is(saved.attempts.candidate[0].value, -0));
  const replay = replayEvidence(saved, { repository: fixtureRepository });
  assert.equal(replay.status, 'match');
  assert.ok(Object.is(replay.evidence.attempts.candidate[0].value, -0));
});
