import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateExperiment, evaluateContract, evaluateVerification } from '../src/contracts.js';
import { nextPowerOfTwo as base } from './fixtures/power-of-two/base.js';
import { nextPowerOfTwo as candidate } from './fixtures/power-of-two/candidate.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/power-of-two/experiment.json', import.meta.url), 'utf8'));
const observation = value => ({ exitCode: 0, timedOut: false, value });
const experiment = () => structuredClone(fixture);

test('boundary regression violates candidate contract independently of comparison', () => {
  const e = experiment();
  const result = evaluateVerification(e, observation(base(...e.arguments)), observation(candidate(...e.arguments)));
  assert.equal(result.comparison, 'behavioral-difference');
  assert.equal(result.contracts.base.status, 'satisfied');
  assert.deepEqual(result.contracts.candidate, { status: 'confirmed-contract-violation', expected: 8, actual: 16 });
});

test('base violation does not make a correct candidate defective', () => {
  const result = evaluateVerification(experiment(), observation(16), observation(8));
  assert.equal(result.contracts.base.status, 'confirmed-contract-violation');
  assert.equal(result.contracts.candidate.status, 'satisfied');
});

test('identical results can violate the contract in both revisions', () => {
  const result = evaluateVerification(experiment(), observation(16), observation(16));
  assert.equal(result.comparison, 'no-difference');
  assert.equal(result.contracts.base.status, 'confirmed-contract-violation');
  assert.equal(result.contracts.candidate.status, 'confirmed-contract-violation');
});

test('unsupported contract preserves an unexplained behavioral difference', () => {
  const e = experiment();
  e.contract.id = 'unknown';
  const result = evaluateVerification(e, observation(8), observation(16));
  assert.equal(result.comparison, 'behavioral-difference');
  assert.deepEqual(result.contracts, { base: { status: 'unsupported-contract' }, candidate: { status: 'unsupported-contract' } });
});

test('predicate rejects inputs outside its domain without confirming defects', () => {
  for (const args of [[], [0], [-1], [1.5], ['8'], [null], [true], [8, 9], [Number.MAX_SAFE_INTEGER + 1]]) {
    const e = experiment();
    e.arguments = args;
    assert.equal(evaluateContract(e, observation(16)).status, 'invalid-input');
  }
});

test('predicate handles numeric boundaries without 32-bit truncation', () => {
  for (const [n, expected] of [[1, 1], [3, 4], [8, 8], [2 ** 32, 2 ** 32], [2 ** 32 + 1, 2 ** 33], [Number.MAX_SAFE_INTEGER, 2 ** 53]]) {
    const e = experiment();
    e.arguments = [n];
    assert.equal(evaluateContract(e, observation(expected)).status, 'satisfied');
    assert.equal(evaluateContract(e, observation(expected * 2)).status, 'confirmed-contract-violation');
  }
});

test('failed or malformed executions are unverified', () => {
  for (const run of [null, {}, { exitCode: 1, timedOut: false, value: 16 }, { ...observation(16), timedOut: true },
    { exitCode: 0, timedOut: false }, observation(NaN), observation(undefined)]) {
    const result = evaluateVerification(experiment(), observation(8), run);
    assert.equal(result.comparison, 'unverified');
    assert.equal(result.contracts.candidate.status, 'unverified');
  }
});

test('valid JSON results with the wrong return type violate the numeric contract', () => {
  for (const value of ['8', null, {}, [], true]) {
    assert.equal(evaluateContract(experiment(), observation(value)).status, 'confirmed-contract-violation');
  }
});

test('malformed experiment schemas fail explicitly', () => {
  for (const mutate of [
    e => { e.schemaVersion = 2; }, e => { e.id = ''; }, e => { e.target.module = '../escape.js'; },
    e => { e.target.module = '/absolute.js'; }, e => { e.target.export = ''; },
    e => { e.arguments = [Infinity]; }, e => { e.arguments = [undefined]; }, e => { e.arguments = [new Date()]; },
    e => { e.arguments = Array(1); }, e => { e.arguments.push(e.arguments); },
    e => { delete e.contract.provenance; }, e => { e.contract.provenance.statement = ''; },
    e => { e.expectedExecution.runtime = 'python'; }, e => { e.expectedExecution.timeoutMs = 0; },
    e => { e.expectedExecution.timeoutMs = 300001; }, e => { e.expectedExecution.expectedExitCode = 1; },
  ]) {
    const e = experiment();
    mutate(e);
    assert.throws(() => validateExperiment(e), TypeError);
  }
  assert.throws(() => validateExperiment(null), TypeError);
  assert.equal(validateExperiment(fixture), fixture);
});

test('JSON object key order does not create an unexplained difference', () => {
  const e = experiment();
  e.contract.id = 'unknown';
  assert.equal(evaluateVerification(e, observation({ a: 1, b: 2 }), observation({ b: 2, a: 1 })).comparison, 'no-difference');
});
