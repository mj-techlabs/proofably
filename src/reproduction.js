import { isDeepStrictEqual } from 'node:util';
import { evaluateContract } from './contracts.js';
import { isJsonData } from './json-data.mjs';

export const DEFAULT_SETTINGS = Object.freeze({ repetitions: 3, overallTimeoutMs: 180000,
  controlTimeoutMs: 8000, cleanupTimeoutMs: 4000, maxOutputBytes: 1048576, maxLogBytes: 65536, policyVersion: 1 });
export function executionSettings(repetitions = 3, overallTimeoutMs = 180000) {
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 5) throw new TypeError('Repetitions must be 1–5');
  if (!Number.isInteger(overallTimeoutMs) || overallTimeoutMs < 1000 || overallTimeoutMs > 300000) {
    throw new TypeError('Overall timeout must be 1000–300000 ms');
  }
  return { ...DEFAULT_SETTINGS, repetitions, overallTimeoutMs };
}

export function observationSignature(attempt) {
  // Container names and elapsed time are deliberately not semantic observations.
  return Object.fromEntries(['kind', 'exitCode', 'timedOut', 'value', 'detail', 'runtime', 'stderrSha256',
    'processExitCode', 'signal', 'errorCode', 'sourceArchiveSha256'].filter(key => Object.hasOwn(attempt, key)).map(key => [key, attempt[key]]));
}

export function summarizeRevision(experiment, attempts, required) {
  let reason;
  if (attempts.length !== required) reason = 'missing-executions';
  else if (attempts.some(a => a.kind !== 'returned' || a.exitCode !== 0 || a.timedOut || !Object.hasOwn(a, 'value') || !isJsonData(a.value))) {
    reason = `execution-failed:${attempts.find(a => a.kind !== 'returned' || a.exitCode !== 0 || a.timedOut || !Object.hasOwn(a, 'value') || !isJsonData(a.value))?.kind || 'invalid-result'}`;
  } else if (attempts.some(a => a.cleanup?.removed !== true || a.cleanup?.verified !== true)) reason = 'cleanup-not-verified';
  else if (!attempts.every(a => isDeepStrictEqual(a.value, attempts[0].value))) reason = 'inconsistent-results';
  else if (!attempts.every(a => a.stderrSha256 === attempts[0].stderrSha256)) reason = 'inconsistent-logs';
  else if (!attempts.every(a => a.sourceArchiveSha256 === attempts[0].sourceArchiveSha256)) reason = 'inconsistent-source';
  else if (!attempts.every(a => isDeepStrictEqual(a.runtime, attempts[0].runtime))) reason = 'inconsistent-runtime';
  if (reason) return { consistency: 'unverified', reason, required, completed: attempts.filter(a => a.kind === 'returned').length,
    verdict: { status: 'unverified', reason } };
  return { consistency: 'stable', required, completed: required, verdict: evaluateContract(experiment, attempts[0]) };
}

export function summarizeReproduction(experiment, attempts, settings) {
  const base = summarizeRevision(experiment, attempts.base, settings.repetitions);
  const candidate = summarizeRevision(experiment, attempts.candidate, settings.repetitions);
  const comparison = base.consistency !== 'stable' || candidate.consistency !== 'stable' ? 'unverified' :
    isDeepStrictEqual(attempts.base[0].value, attempts.candidate[0].value) &&
      attempts.base[0].stderrSha256 === attempts.candidate[0].stderrSha256 ? 'no-difference' : 'behavioral-difference';
  const contracts = { base: base.verdict, candidate: candidate.verdict };
  const classification = Object.values(contracts).some(v => v.status === 'confirmed-contract-violation') ? 'confirmed-contract-violation' :
    Object.values(contracts).some(v => v.status === 'unverified') ? 'unverified' : comparison;
  const reproduction = { base, candidate };
  const observations = Object.fromEntries(['base', 'candidate'].map(side => [side,
    reproduction[side].consistency === 'stable' ? attempts[side][0] :
      attempts[side].find(a => a.kind !== 'returned') || { kind: 'infrastructure-error', exitCode: null,
        timedOut: false, detail: reproduction[side].reason }]));
  return { reproduction, contracts, comparison, classification, observations };
}
