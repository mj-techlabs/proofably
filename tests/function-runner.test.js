import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { verifyFunctionExperiment, decodeObservation } from '../src/function-runner.js';
import { evaluateContract } from '../src/contracts.js';
import { functionRepository, experiment } from './helpers/function-repository.js';

const ok = stdout => ({ status: 0, stdout, stderr: '' });
const imageId = `sha256:${'a'.repeat(64)}`;
function fakeDocker(start, calls, cleanup = ok('')) {
  return (args, options) => {
    calls.push({ args, options });
    if (args[0] === 'image') return ok(imageId);
    if (args[0] === 'create') return ok('container-id');
    if (args[0] === 'start') return start(args);
    if (args[0] === 'rm') return cleanup;
    throw new Error(`Unexpected call ${args}`);
  };
}
const envelope = value => JSON.stringify({ protocolVersion: 1, outcome: 'returned', value });

test('runner fixes revisions, image, harness and isolation; always removes separate containers', t => {
  const input = functionRepository(t);
  const calls = [];
  let run = 0;
  const report = verifyFunctionExperiment(input, { docker: fakeDocker(() => ok(envelope(++run === 1 ? 8 : 16)), calls) });
  assert.deepEqual(report.revisions, { base: input.base, candidate: input.candidate });
  assert.equal(report.execution.imageId, imageId);
  assert.match(report.execution.harnessSha256, /^[a-f0-9]{64}$/);
  assert.equal(report.contracts.base.status, 'satisfied');
  assert.equal(report.contracts.candidate.status, 'confirmed-contract-violation');
  const creates = calls.filter(call => call.args[0] === 'create');
  assert.equal(creates.length, 2);
  assert.notEqual(creates[0].args[2], creates[1].args[2]);
  for (const { args } of creates) {
    for (const flag of ['--read-only', '--cap-drop', '--security-opt', '--memory', '--cpus', '--pids-limit', '--user', '--pull=never']) assert.ok(args.includes(flag));
    assert.equal(args[args.indexOf('--network') + 1], 'none');
    assert.ok(args.includes(imageId));
    const mount = args[args.indexOf('--mount') + 1];
    assert.match(mount, /dst=\/proofably,readonly$/);
    assert.equal(existsSync(mount.split('src=')[1].split(',')[0]), false);
  }
  assert.equal(calls.filter(call => call.args[0] === 'rm').length, 2);
  assert.equal(calls.find(call => call.args[0] === 'start').options.timeout, input.experiment.expectedExecution.timeoutMs);
});

test('runner distinguishes failures and never confirms them', t => {
  const input = functionRepository(t);
  for (const [result, kind] of [
    [{ status: null, error: { code: 'ETIMEDOUT', message: 'timeout' } }, 'timeout'],
    [{ status: null, error: { code: 'ENOBUFS', message: 'large output' } }, 'output-limit'],
    [{ status: 125, stdout: envelope(16), stderr: 'Docker failure' }, 'infrastructure-error'],
    [ok('not JSON'), 'protocol-error'],
    [ok('{"protocolVersion":1,"outcome":"returned"}'), 'protocol-error'],
    ...['function-exception', 'invalid-output', 'target-error', 'execution-error'].map(outcome =>
      [ok(JSON.stringify({ protocolVersion: 1, outcome })), outcome]),
  ]) {
    const calls = [];
    const report = verifyFunctionExperiment(input, { docker: fakeDocker(() => result, calls) });
    assert.equal(report.observations.candidate.kind, kind);
    assert.equal(report.contracts.candidate.status, 'unverified');
    assert.equal(report.contracts.base.status, 'unverified');
    assert.equal(report.comparison, 'unverified');
    assert.equal(calls.filter(call => call.args[0] === 'rm').length, 2);
  }
});

test('create, image and cleanup failures cannot confirm violations', t => {
  const input = functionRepository(t);
  for (const stage of ['create', 'image', 'rm']) {
    const calls = [];
    const docker = fakeDocker(() => ok(envelope(16)), calls);
    const report = verifyFunctionExperiment(input, { docker: (args, options) =>
      args[0] === stage ? { status: 1, stderr: 'daemon failure' } : docker(args, options) });
    assert.equal(report.observations.candidate.kind, 'infrastructure-error');
    assert.equal(report.contracts.candidate.status, 'unverified');
  }
});

test('unexpected process errors still attempt explicit cleanup', t => {
  const input = functionRepository(t);
  const calls = [];
  const report = verifyFunctionExperiment(input, { docker: fakeDocker(() => { throw new Error('process failure'); }, calls) });
  assert.equal(report.contracts.candidate.status, 'unverified');
  assert.equal(calls.filter(call => call.args[0] === 'rm').length, 2);
});

test('invalid experiment and revisions fail before Docker execution', t => {
  const input = functionRepository(t);
  const docker = () => assert.fail('Docker must not run');
  assert.throws(() => verifyFunctionExperiment({ ...input, experiment: {} }, { docker }), TypeError);
  assert.throws(() => verifyFunctionExperiment({ ...input, base: '--bad-ref' }, { docker }));
});

test('even a Docker exit zero without a harness value cannot confirm a defect', () => {
  const observation = decodeObservation(ok(''));
  assert.equal(evaluateContract(experiment, observation).status, 'unverified');
});

test('legacy CLI help and separate function CLI help remain available', () => {
  for (const file of ['src/cli.js', 'src/function-cli.js']) {
    const result = spawnSync(process.execPath, [file, '--help'], { encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage:/);
  }
});
