import { isDeepStrictEqual } from 'node:util';

const text = value => typeof value === 'string' && value.trim().length > 0;
function isJson(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) return false;
  const next = new Set(ancestors).add(value);
  if (Array.isArray(value)) {
    return Object.keys(value).length === value.length && Array.from(value).every(item => isJson(item, next));
  }
  return Object.values(value).every(item => isJson(item, next));
}

// Validate data only: never import the target or execute a contract expression.
export function validateExperiment(experiment) {
  const e = experiment;
  if (!e || e.schemaVersion !== 1 || !text(e.id)) throw new TypeError('Invalid experiment version or id');
  const target = e.target;
  if (!target || !text(target.module) || target.module.startsWith('/') || target.module.includes('\\') ||
      target.module.split('/').some(part => part === '..' || part === '') || !text(target.export)) {
    throw new TypeError('Expected a repository-relative module and named export');
  }
  if (!Array.isArray(e.arguments) || !isJson(e.arguments)) throw new TypeError('Arguments must be JSON values');
  if (!text(e.contract?.id) || !text(e.contract?.provenance?.source) || !text(e.contract?.provenance?.statement)) {
    throw new TypeError('Expected contract id and provenance source/statement');
  }
  const execution = e.expectedExecution;
  if (!execution || execution.runtime !== 'node' || execution.expectedExitCode !== 0 ||
      !Number.isSafeInteger(execution.timeoutMs) || execution.timeoutMs < 1 || execution.timeoutMs > 300000) {
    throw new TypeError('Invalid expected execution metadata');
  }
  return e;
}

function validObservation(run) {
  return run?.exitCode === 0 && run.timedOut === false && Object.hasOwn(run, 'value') && isJson(run.value);
}

export function evaluateContract(experiment, observation) {
  validateExperiment(experiment);
  if (experiment.contract.id !== 'smallest-power-of-two-gte') return { status: 'unsupported-contract' };
  const [n] = experiment.arguments;
  if (experiment.arguments.length !== 1 || !Number.isSafeInteger(n) || n <= 0) return { status: 'invalid-input' };
  if (!validObservation(observation)) return { status: 'unverified' };
  // Avoid 32-bit bitwise operators and floating-point logarithm boundary errors.
  let expected = 1;
  while (expected < n) expected *= 2;
  return {
    status: observation.value === expected ? 'satisfied' : 'confirmed-contract-violation',
    expected,
    actual: observation.value,
  };
}

export function evaluateVerification(experiment, base, candidate) {
  validateExperiment(experiment);
  const comparison = !validObservation(base) || !validObservation(candidate) ? 'unverified' :
    isDeepStrictEqual(base.value, candidate.value) ? 'no-difference' : 'behavioral-difference';
  return {
    schemaVersion: 1,
    id: experiment.id,
    comparison,
    contracts: { base: evaluateContract(experiment, base), candidate: evaluateContract(experiment, candidate) },
    observations: { base, candidate },
  };
}
