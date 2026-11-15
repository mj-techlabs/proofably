import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { verifyFunctionExperiment } from '../src/function-runner.js';
import { replayEvidence, validateEvidence, serializeEvidence, readJsonFile } from '../src/evidence-bundle.js';
import { stringifyJson } from '../src/json-data.mjs';
import { functionRepository } from './helpers/function-repository.js';
import { fakeDocker, IMAGE_ID } from './helpers/fake-docker.js';
const digest = text => createHash('sha256').update(text).digest('hex');

function report(t, options = {}, settings = {}) {
  const input = { ...functionRepository(t), ...settings };
  const fake = fakeDocker(options);
  return { bundle: verifyFunctionExperiment(input, fake), input, fake };
}

test('default repetition confirms a stable violation only across all three fresh runs', t => {
  const { bundle, fake } = report(t);
  assert.deepEqual(bundle.attempts.base.map(a => a.value), [8, 8, 8]);
  assert.deepEqual(bundle.attempts.candidate.map(a => a.value), [16, 16, 16]);
  assert.equal(bundle.contracts.base.status, 'satisfied');
  assert.equal(bundle.contracts.candidate.status, 'confirmed-contract-violation');
  assert.equal(bundle.reproduction.candidate.consistency, 'stable');
  assert.equal(bundle.classification, 'confirmed-contract-violation');
  assert.equal(new Set(fake.calls.filter(c => c.args[0] === 'create').map(c => c.args[2])).size, 6);
  assert.equal(validateEvidence(bundle), bundle);
});

test('stable matching results remain no-difference, with independent contract verdicts', t => {
  const { bundle } = report(t, { values: [8] });
  assert.equal(bundle.comparison, 'no-difference');
  assert.equal(bundle.classification, 'no-difference');
  assert.equal(bundle.contracts.candidate.status, 'satisfied');
});

test('conflicting and type-distinct results are unverified', t => {
  for (const values of [[8, 8, 8, 16, 8, 16], [8, 8, 8, 16, '16', 16], [8, 8, 8, 0, -0, 0]]) {
    const { bundle } = report(t, { values });
    assert.equal(bundle.contracts.candidate.status, 'unverified');
    assert.equal(bundle.reproduction.candidate.reason, 'inconsistent-results');
    assert.equal(bundle.contracts.base.status, 'satisfied');
    assert.equal(bundle.comparison, 'unverified');
    assert.equal(bundle.attempts.candidate.length, 3);
  }
});

test('diagnostic differences are retained and make repetition inconsistent', t => {
  const { bundle } = report(t, { result: index => ({ status: 0, stdout: '{"protocolVersion":1,"outcome":"returned","value":8}',
    stderr: index === 4 ? 'different log' : 'log' }) });
  assert.equal(bundle.reproduction.candidate.reason, 'inconsistent-logs');
  assert.equal(bundle.attempts.candidate[1].stderr, 'different log');
});

test('exceptions, timeouts and Docker failures cannot confirm, while candidate evidence stays independent', t => {
  for (const failure of [
    { status: 0, stdout: '{"protocolVersion":1,"outcome":"function-exception","error":"boom"}' },
    { status: null, error: { code: 'ETIMEDOUT', message: 'timeout' } },
    { status: 125, stderr: 'Docker infrastructure failed' },
  ]) {
    const { bundle } = report(t, { result: index => index === 1 ? failure :
      { status: 0, stdout: '{"protocolVersion":1,"outcome":"returned","value":16}' } });
    assert.equal(bundle.contracts.base.status, 'unverified');
    assert.equal(bundle.contracts.candidate.status, 'confirmed-contract-violation');
    assert.equal(bundle.comparison, 'unverified');
    assert.equal(bundle.classification, 'confirmed-contract-violation');
    assert.match(bundle.reproduction.base.reason, /^execution-failed:/);
    assert.equal(bundle.attempts.base.length, 3);
    assert.equal(validateEvidence(bundle), bundle);
  }
});

test('cleanup failure retains original results and cleanup errors, and invalidates confirmation', t => {
  const { bundle } = report(t, { cleanupFailure: true });
  assert.equal(bundle.attempts.candidate[0].value, 16);
  assert.equal(bundle.attempts.candidate[0].kind, 'returned');
  assert.equal(bundle.attempts.candidate[0].cleanup.removed, false);
  assert.match(bundle.attempts.candidate[0].cleanup.removal.stderr, /daemon unavailable/);
  assert.equal(bundle.reproduction.candidate.reason, 'cleanup-not-verified');
  assert.equal(bundle.contracts.candidate.status, 'unverified');
  assert.equal(validateEvidence(bundle), bundle);
});

test('repetition and overall runtime settings are bounded before Docker use', t => {
  const input = functionRepository(t);
  const docker = () => assert.fail('Docker must not run');
  for (const repetitions of [0, 6, 1.5, '3']) assert.throws(() => verifyFunctionExperiment({ ...input, repetitions }, { docker }), TypeError);
  for (const overallTimeoutMs of [0, 999, 300001, NaN]) assert.throws(() => verifyFunctionExperiment({ ...input, overallTimeoutMs }, { docker }), TypeError);
});

test('overall deadline clamps commands, reserves cleanup, and records unexecuted requirements', t => {
  const input = functionRepository(t);
  input.experiment.expectedExecution.timeoutMs = 300000;
  let clock = 0;
  const fake = fakeDocker({ result: (_index, options) => {
    assert.ok(options.timeout <= 2000);
    clock += options.timeout;
    return { status: null, error: { code: 'ETIMEDOUT', message: 'timeout' } };
  } });
  const bundle = verifyFunctionExperiment({ ...input, overallTimeoutMs: 10000 }, { ...fake, now: () => clock });
  assert.equal(bundle.attempts.base[0].kind, 'timeout');
  assert.equal(bundle.attempts.candidate[0].kind, 'budget-exhausted');
  assert.equal(bundle.attempts.base[0].cleanup.verified, true);
  assert.equal(bundle.attempts.candidate[0].cleanup.removed, null);
  assert.equal(bundle.contracts.candidate.status, 'unverified');
  assert.equal(fake.calls.filter(c => c.args[0] === 'create').length, 1);
});

test('evidence round trip preserves JSON types, negative zero and all outcomes without runtime objects', t => {
  const { bundle } = report(t, { values: [-0] });
  const text = serializeEvidence(bundle);
  const decoded = JSON.parse(text);
  assert.ok(Object.is(decoded.attempts.base[0].value, -0));
  assert.deepEqual(decoded, bundle);
  assert.equal(validateEvidence(decoded), decoded);
  assert.throws(() => stringifyJson({ a: undefined }), TypeError);
});

test('unknown experiment metadata and host environment credentials are not copied into evidence', t => {
  const input = functionRepository(t);
  input.experiment.environment = { SECRET: 'do-not-copy-this-value' };
  input.experiment.contract.provenance.unrelatedSource = 'do-not-copy-source';
  const bundle = verifyFunctionExperiment(input, fakeDocker());
  const text = serializeEvidence(bundle);
  assert.doesNotMatch(text, /do-not-copy/);
  assert.equal(Object.hasOwn(bundle, 'environment'), false);
});

test('bounded logs retain full captured-output hashes so differing tails are detectable', t => {
  const prefix = 'x'.repeat(70000);
  const { bundle } = report(t, { result: index => ({ status: 0, stdout: '{"protocolVersion":1,"outcome":"returned","value":8}', stderr: prefix + index }) });
  assert.equal(bundle.attempts.base[0].stderrTruncated, true);
  assert.ok(Buffer.byteLength(bundle.attempts.base[0].stderr) <= 65536);
  assert.notEqual(bundle.attempts.base[0].stderrSha256, bundle.attempts.base[1].stderrSha256);
  assert.equal(bundle.reproduction.base.reason, 'inconsistent-logs');
});

test('execution replay runs six new containers using only recorded immutable inputs', t => {
  const { bundle, input } = report(t);
  const fake = fakeDocker();
  const result = replayEvidence(JSON.parse(serializeEvidence(bundle)), { repository: input.repository }, fake);
  assert.equal(result.mode, 'execution-replay');
  assert.equal(result.status, 'match');
  assert.equal(result.checks.candidate.verdict, 'match');
  assert.equal(result.evidence.contracts.candidate.status, 'confirmed-contract-violation');
  assert.equal(fake.calls.filter(c => c.args[0] === 'start').length, 6);
  assert.equal(fake.calls.find(c => c.args[0] === 'image').args.at(-1), IMAGE_ID);
  const oldNames = new Set(Object.values(bundle.attempts).flat().map(a => a.cleanup.name));
  assert.ok(Object.values(result.evidence.attempts).flat().every(a => !oldNames.has(a.cleanup.name)));
});

test('replay detects changed execution and tampered original observations/verdicts', t => {
  const { bundle, input } = report(t);
  assert.equal(replayEvidence(bundle, { repository: input.repository }, fakeDocker({ values: [8] })).status, 'mismatch');
  const tampered = structuredClone(bundle);
  tampered.attempts.candidate[1].value = 32;
  const result = replayEvidence(tampered, { repository: input.repository }, fakeDocker());
  assert.equal(result.status, 'mismatch');
  assert.equal(result.checks.candidate.observations, 'mismatch');
  assert.equal(result.checks.storedSummary, 'mismatch');
  const representative = structuredClone(bundle);
  representative.observations.candidate.value = 64;
  assert.equal(replayEvidence(representative, { repository: input.repository }, fakeDocker()).status, 'mismatch');
});

test('replay never substitutes missing commits, images or installed artifacts', t => {
  const { bundle, input } = report(t);
  const noCommit = structuredClone(bundle);
  noCommit.revisions.base = '0'.repeat(40);
  const unused = { docker: () => assert.fail('Docker must not run') };
  assert.equal(replayEvidence(noCommit, { repository: input.repository }, unused).status, 'infrastructure-failure');
  const imageFailure = fakeDocker({ missingImage: true });
  const result = replayEvidence(bundle, { repository: input.repository }, imageFailure);
  assert.equal(result.status, 'infrastructure-failure');
  assert.equal(imageFailure.calls.filter(c => c.args[0] === 'create').length, 0);
  const noArtifact = structuredClone(bundle);
  noArtifact.execution.harnessSha256 = '0'.repeat(64);
  assert.equal(replayEvidence(noArtifact, { repository: input.repository }, unused).status, 'infrastructure-failure');
});

test('untrusted evidence versions, shapes, settings, log hashes and mutable identities are rejected', t => {
  const { bundle } = report(t);
  for (const mutate of [b => { b.bundleVersion = 99; }, b => { b.revisions.base = 'HEAD'; },
    b => { b.execution.imageId = 'node:22-alpine'; }, b => { b.execution.settings.repetitions = 100; },
    b => { b.execution.settings.maxOutputBytes = 999999999; }, b => { b.attempts.base = []; },
    b => { b.attempts.base[0].stderr = 'tampered log'; }, b => { b.attempts.base[0].cleanup.verified = false; },
    b => { b.experiment.arguments = [undefined]; }]) {
    const bad = structuredClone(bundle);
    mutate(bad);
    assert.throws(() => replayEvidence(bad, {}, { docker: () => assert.fail('must not execute') }), TypeError);
  }
  assert.throws(() => validateEvidence(null), TypeError);
});

test('JSON file reading is bounded and malformed JSON is rejected', t => {
  const directory = mkdtempSync(join(tmpdir(), 'proofably-json-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'input.json');
  writeFileSync(path, '"too large"');
  assert.throws(() => readJsonFile(path, 4), /size limit/);
  writeFileSync(path, '{');
  assert.throws(() => readJsonFile(path), SyntaxError);
});

test('replay CLI rejects malformed input and never overwrites originals or aliases', t => {
  const { bundle, input } = report(t);
  const original = join(input.repository, 'original.json');
  writeFileSync(original, serializeEvidence(bundle));
  const before = readFileSync(original, 'utf8');
  // Missing installed harness prevents Docker access, but still produces a report.
  const unavailable = structuredClone(bundle);
  unavailable.execution.harnessSha256 = '0'.repeat(64);
  const source = join(input.repository, 'unavailable.json');
  writeFileSync(source, serializeEvidence(unavailable));
  const aliases = [source, join(input.repository, 'symbolic.json'), join(input.repository, 'hard.json')];
  symlinkSync(source, aliases[1]);
  linkSync(source, aliases[2]);
  for (const output of aliases) {
    const result = spawnSync(process.execPath, ['src/function-cli.js', 'replay', '--bundle', source, '--output', output], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /EEXIST/);
  }
  assert.equal(readFileSync(original, 'utf8'), before);
  assert.equal(digest(readFileSync(source)), digest(serializeEvidence(unavailable)));
  const output = join(input.repository, 'new-replay.json');
  const result = spawnSync(process.execPath, ['src/function-cli.js', 'replay', '--bundle', source, '--output', output], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(readJsonFile(output).status, 'infrastructure-failure');
});


test('different non-UTF8 log bytes remain distinct even when readable previews match', t => {
  const { bundle } = report(t, { result: index => ({ status: 0,
    stdout: '{"protocolVersion":1,"outcome":"returned","value":8}', stderr: Buffer.from([index === 4 ? 254 : 255]) }) });
  assert.equal(bundle.attempts.candidate[0].stderr, bundle.attempts.candidate[1].stderr);
  assert.notEqual(bundle.attempts.candidate[0].stderrSha256, bundle.attempts.candidate[1].stderrSha256);
  assert.equal(bundle.reproduction.candidate.reason, 'inconsistent-logs');
  assert.equal(validateEvidence(bundle), bundle);
});
