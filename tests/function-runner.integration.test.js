import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dockerAvailability, verifyFunctionExperiment } from '../src/function-runner.js';
import { functionRepository } from './helpers/function-repository.js';

const unavailable = dockerAvailability();
const image = process.env.PROOFABLY_TEST_IMAGE || 'node:22-alpine';
// A running daemon with a missing image is a failure, not a skipped test.
const options = { skip: unavailable || false, timeout: 120000 };
function verify(t, source, changeExperiment) {
  const input = functionRepository(t, source);
  input.experiment.expectedExecution.timeoutMs = 10000;
  changeExperiment?.(input.experiment);
  const report = verifyFunctionExperiment({ ...input, image });
  t.after(() => {
    for (const observation of Object.values(report.observations)) {
      if (!observation.cleanup) continue;
      assert.equal(observation.cleanup.removed, true);
      const inspection = spawnSync('docker', ['container', 'inspect', observation.cleanup.name], { encoding: 'utf8', timeout: 8000 });
      assert.notEqual(inspection.status, 0, 'container must have been removed');
      assert.match(inspection.stderr, /No such (object|container)/i);
    }
  });
  return report;
}

function checkFailure(report, kind) {
  assert.equal(report.observations.candidate.kind, kind, JSON.stringify({ kind: report.observations.candidate.kind, detail: report.observations.candidate.detail }));
  assert.equal(report.contracts.candidate.status, 'unverified');
  assert.equal(report.comparison, 'unverified');
}

test('Docker: nextPowerOfTwo base=8 and candidate=16 with independent verdicts', options, t => {
  const report = verify(t);
  assert.equal(report.observations.base.value, 8, JSON.stringify(report.observations.base));
  assert.equal(report.observations.candidate.value, 16);
  assert.equal(report.contracts.base.status, 'satisfied');
  assert.equal(report.contracts.candidate.status, 'confirmed-contract-violation');
  assert.equal(report.comparison, 'behavioral-difference');
  assert.match(report.revisions.base, /^[a-f0-9]{40,64}$/);
  assert.notEqual(report.observations.base.cleanup.name, report.observations.candidate.cleanup.name);
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
