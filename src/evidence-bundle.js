import { createHash } from 'node:crypto';
import { openSync, readSync, closeSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { validateExperiment } from './contracts.js';
import { isJsonData, stringifyJson, boundedText } from './json-data.mjs';
import { executionSettings, summarizeReproduction, observationSignature } from './reproduction.js';
import { runnerArtifacts, verifyFunctionExperiment } from './function-runner.js';

export const MAX_BUNDLE_BYTES = 32 * 1048576;
const digest = value => createHash('sha256').update(value).digest('hex');
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const image = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const commit = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const kinds = new Set(['returned', 'function-exception', 'invalid-output', 'target-error', 'execution-error',
  'timeout', 'output-limit', 'infrastructure-error', 'protocol-error', 'budget-exhausted']);
const verdicts = new Set(['satisfied', 'confirmed-contract-violation', 'unsupported-contract', 'invalid-input', 'unverified']);
const comparisons = new Set(['no-difference', 'behavioral-difference', 'unverified']);
function require(condition, message) { if (!condition) throw new TypeError(`Invalid evidence: ${message}`); }
function text(value, maximum) { return typeof value === 'string' && Buffer.byteLength(value) <= maximum; }
function exitCode(value) { return value === null || (Number.isInteger(value) && value >= 0 && value <= 255); }
function checkLogs(record, settings) {
  for (const stream of ['stdout', 'stderr']) {
    require(text(record[stream], settings.maxLogBytes), `${stream} log size`);
    require(hash(record[`${stream}Sha256`]) && typeof record[`${stream}Truncated`] === 'boolean', `${stream} log metadata`);
    if (!record[`${stream}Truncated`]) require(digest(record[stream]) === record[`${stream}Sha256`], `${stream} log hash`);
  }
}
function checkProcess(record, settings) {
  require(record && exitCode(record.exitCode), 'process exit code');
  checkLogs(record, settings);
  if (record.error) require(text(record.error.code, 128) && text(record.error.message, 4096), 'process error');
}
function checkAttempt(a, settings) {
  require(a && kinds.has(a.kind) && exitCode(a.exitCode) && typeof a.timedOut === 'boolean', 'attempt outcome');
  if (Object.hasOwn(a, 'value')) require(a.kind === 'returned' && isJsonData(a.value) && Buffer.byteLength(stringifyJson(a.value)) <= settings.maxOutputBytes, 'return value');
  if (a.kind === 'returned') require(Object.hasOwn(a, 'value') && a.exitCode === 0 && !a.timedOut, 'successful return');
  if (a.sourceArchiveSha256 !== undefined) require(hash(a.sourceArchiveSha256), 'source archive hash');
  if (a.detail !== undefined) require(text(a.detail, 4096), 'attempt detail');
  if (a.stdout !== undefined || a.stderr !== undefined) checkLogs(a, settings);
  if (a.processExitCode !== undefined) require(exitCode(a.processExitCode), 'Docker exit code');
  if (a.signal !== undefined) require(a.signal === null || text(a.signal, 128), 'signal');
  if (a.errorCode !== undefined) require(text(a.errorCode, 128), 'error code');
  if (a.runtime !== undefined) require(a.runtime && ['node', 'arch', 'platform'].every(k => text(a.runtime[k], 128)), 'runtime metadata');
  if (a.create) checkProcess(a.create, settings);
  if (a.imageInspection) checkProcess(a.imageInspection, settings);
  const c = a.cleanup;
  require(c && typeof c.attempted === 'boolean' && typeof c.verified === 'boolean' &&
    (c.removed === null || typeof c.removed === 'boolean'), 'cleanup status');
  if (c.attempted) {
    require(typeof c.name === 'string' && /^proofably-[a-f0-9-]{36}$/.test(c.name), 'container name');
    checkProcess(c.removal, settings);
    checkProcess(c.inspection, settings);
    const verified = !c.inspection.error && c.inspection.exitCode === 1 && /No such (object|container)/i.test(c.inspection.stderr);
    require(c.removed === verified && c.verified === verified, 'cleanup verification');
  } else require(c.removed === null && !c.verified, 'unattempted cleanup');
}

export function validateEvidence(bundle) {
  require(bundle && typeof bundle === 'object' && !Array.isArray(bundle) && isJsonData(bundle), 'JSON object only');
  require(Buffer.byteLength(stringifyJson(bundle)) <= MAX_BUNDLE_BYTES, 'bundle exceeds 32 MiB');
  require(bundle.bundleVersion === 1 && bundle.kind === 'proofably-evidence' && bundle.schemaVersion === 1, 'unsupported version or kind');
  validateExperiment(bundle.experiment);
  require(Buffer.byteLength(stringifyJson(bundle.experiment)) <= 1048576, 'experiment exceeds 1 MiB');
  require(bundle.id === bundle.experiment.id, 'experiment identity');
  require(commit(bundle.revisions?.base) && commit(bundle.revisions?.candidate), 'immutable commit SHAs');
  const e = bundle.execution;
  require(e && (e.imageId === null || image(e.imageId)) && text(e.requestedImage, 512), 'image identity');
  require(['harnessSha256', 'jsonSha256', 'policySha256', 'runnerSha256', 'evaluatorSha256', 'reproductionSha256'].every(k => hash(e[k])), 'required artifact hashes');
  require(e.settings && isDeepStrictEqual(e.settings, executionSettings(e.settings.repetitions, e.settings.overallTimeoutMs)), 'execution settings');
  for (const side of ['base', 'candidate']) {
    require(Array.isArray(bundle.attempts?.[side]) && bundle.attempts[side].length === e.settings.repetitions, 'attempt count');
    for (const attempt of bundle.attempts[side]) checkAttempt(attempt, e.settings);
    require(verdicts.has(bundle.contracts?.[side]?.status), 'contract verdict');
    const summary = bundle.reproduction?.[side];
    require(summary && ['stable', 'unverified'].includes(summary.consistency) && verdicts.has(summary.verdict?.status) &&
      Number.isInteger(summary.required) && Number.isInteger(summary.completed), 'reproduction summary');
  }
  require(comparisons.has(bundle.comparison) && [...comparisons, 'confirmed-contract-violation'].includes(bundle.classification), 'classification');
  return bundle;
}

export function serializeEvidence(bundle) {
  validateEvidence(bundle);
  const output = stringifyJson(bundle, true) + '\n';
  require(Buffer.byteLength(output) <= MAX_BUNDLE_BYTES, 'formatted bundle exceeds 32 MiB');
  return output;
}

export function readJsonFile(path, maximum = MAX_BUNDLE_BYTES) {
  const fd = openSync(path, 'r');
  try {
    const chunks = [];
    let size = 0;
    while (size <= maximum) {
      const buffer = Buffer.alloc(Math.min(65536, maximum + 1 - size));
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      chunks.push(buffer.subarray(0, count));
      size += count;
    }
    if (size > maximum) throw new TypeError('JSON file exceeds size limit');
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { closeSync(fd); }
}

function replaySignature(attempt) {
  return { ...observationSignature(attempt), cleanup: { attempted: attempt.cleanup.attempted,
    removed: attempt.cleanup.removed, verified: attempt.cleanup.verified } };
}
export function replayEvidence(bundle, { repository = process.cwd() } = {}, dependencies = {}) {
  validateEvidence(bundle);
  const report = { replayVersion: 1, mode: 'execution-replay', originalSha256: digest(stringifyJson(bundle)),
    status: 'infrastructure-failure', checks: {}, evidence: null };
  let identity;
  try { identity = runnerArtifacts().identity; }
  catch (error) { return { ...report, error: boundedText(error, 4096) }; }
  if (Object.keys(identity).some(k => bundle.execution[k] !== identity[k])) return { ...report, error: 'Required installed harness or runner policy does not match recorded artifact hashes' };
  if (!image(bundle.execution.imageId)) return { ...report, error: 'Recorded immutable runner image is unavailable' };
  let evidence;
  try {
    evidence = verifyFunctionExperiment({ repository, base: bundle.revisions.base, candidate: bundle.revisions.candidate,
      experiment: bundle.experiment, image: bundle.execution.imageId,
      repetitions: bundle.execution.settings.repetitions, overallTimeoutMs: bundle.execution.settings.overallTimeoutMs }, dependencies);
    if (!isDeepStrictEqual(evidence.revisions, bundle.revisions)) throw new Error('Resolved revisions do not match recorded SHAs');
  } catch (error) { return { ...report, error: boundedText(error, 4096) }; }
  const originalSummary = summarizeReproduction(bundle.experiment, bundle.attempts, bundle.execution.settings);
  const storedSummaryMatches = Object.keys(originalSummary).every(key => isDeepStrictEqual(originalSummary[key], bundle[key]));
  for (const side of ['base', 'candidate']) {
    const infrastructureFailure = evidence.attempts[side].some(a => ['infrastructure-error', 'budget-exhausted', 'protocol-error'].includes(a.kind) ||
      (a.cleanup.attempted && !a.cleanup.verified));
    report.checks[side] = {
      execution: infrastructureFailure ? 'infrastructure-failure' : evidence.reproduction[side].consistency === 'stable' ? 'completed' : 'unverified',
      observations: isDeepStrictEqual(bundle.attempts[side].map(replaySignature), evidence.attempts[side].map(replaySignature)) ? 'match' : 'mismatch',
      verdict: isDeepStrictEqual(bundle.contracts[side], evidence.contracts[side]) ? 'match' : 'mismatch',
      consistency: isDeepStrictEqual(bundle.reproduction[side], evidence.reproduction[side]) ? 'match' : 'mismatch',
    };
  }
  report.checks.storedSummary = storedSummaryMatches ? 'match' : 'mismatch';
  report.checks.comparison = bundle.comparison === evidence.comparison ? 'match' : 'mismatch';
  report.checks.classification = bundle.classification === evidence.classification ? 'match' : 'mismatch';
  const infrastructure = Object.values(evidence.attempts).flat().some(a => ['infrastructure-error', 'budget-exhausted', 'protocol-error'].includes(a.kind) ||
    (a.cleanup.attempted && !a.cleanup.verified));
  const mismatch = !storedSummaryMatches || ['base', 'candidate'].some(side => Object.values(report.checks[side]).includes('mismatch')) ||
    report.checks.comparison === 'mismatch' || report.checks.classification === 'mismatch';
  return { ...report, evidence, status: infrastructure ? 'infrastructure-failure' : mismatch ? 'mismatch' : 'match' };
}
