import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { validateExperiment, evaluateVerification } from './contracts.js';
import { isolationOptions } from './docker-options.js';

const LIMIT = 1024 * 1024;
const dockerCommand = (args, options) => spawnSync('docker', args, options);
const controlOptions = { encoding: 'utf8', timeout: 8000, maxBuffer: LIMIT };
const failure = (kind, detail, timedOut = false) => ({ kind, exitCode: null, timedOut, detail });
const successful = result => !result.error && result.status === 0;
const detail = result => String(result.error?.message || [result.stderr, result.stdout].filter(Boolean).join('\n') || `exit ${result.status}`).slice(0, 4096);

export function dockerAvailability() {
  const result = dockerCommand(['info'], controlOptions);
  return successful(result) ? null : `Docker unavailable: ${detail(result)}`;
}

export function decodeObservation(result) {
  if (result.error?.code === 'ETIMEDOUT') return failure('timeout', detail(result), true);
  if (result.error?.code === 'ENOBUFS') return failure('output-limit', detail(result));
  if (!successful(result)) return failure('infrastructure-error', detail(result));
  try {
    const data = JSON.parse(result.stdout);
    const outcomes = ['returned', 'function-exception', 'invalid-output', 'target-error', 'execution-error'];
    if (data.protocolVersion !== 1 || !outcomes.includes(data.outcome) ||
        (data.outcome === 'returned' && !Object.hasOwn(data, 'value'))) throw new Error('Invalid harness envelope');
    return { kind: data.outcome, exitCode: 0, timedOut: false,
      ...(data.outcome === 'returned' ? { value: data.value } : {}),
      ...(typeof data.error === 'string' ? { detail: data.error } : {}), runtime: data.runtime };
  } catch (error) {
    return failure('protocol-error', String(error));
  }
}

function runRevision(repository, revision, experiment, image, harness, docker) {
  const directory = mkdtempSync(join(tmpdir(), 'proofably-function-'));
  const name = `proofably-${randomUUID()}`;
  let observation;
  let cleanup;
  try {
    const archive = execFileSync('git', ['archive', '--format=tar', revision], {
      cwd: repository, maxBuffer: 64 * LIMIT, timeout: 8000,
    });
    // Only these disposable, read-only inputs are exposed to the container.
    chmodSync(directory, 0o755);
    for (const [file, contents] of Object.entries({ 'source.tar': archive, 'function-harness.mjs': harness,
      'experiment.json': JSON.stringify(experiment) })) {
      writeFileSync(join(directory, file), contents, { mode: 0o444 });
    }
    const created = docker(['create', '--name', name, '--pull=never', ...isolationOptions(),
      '--memory-swap', '512m', '--ulimit', 'nofile=256:256', '--log-driver', 'none',
      '--mount', `type=bind,src=${directory},dst=/proofably,readonly`,
      '--entrypoint', '/bin/sh', image, '-c',
      'tar -xf /proofably/source.tar -C /work && cd /work && exec node /proofably/function-harness.mjs'], controlOptions);
    if (!successful(created)) observation = failure('infrastructure-error', detail(created));
    else {
      const result = docker(['start', '--attach', name], { encoding: 'utf8',
        timeout: experiment.expectedExecution.timeoutMs, maxBuffer: LIMIT, killSignal: 'SIGKILL' });
      observation = decodeObservation(result);
      observation.stdout = (result.stdout || '').slice(0, LIMIT);
      observation.stderr = (result.stderr || '').slice(0, LIMIT);
    }
  } catch (error) {
    observation = failure('infrastructure-error', String(error));
  } finally {
    // Killing the attached Docker client alone does not stop the container.
    try {
      cleanup = docker(['rm', '--force', name], controlOptions);
    } catch (error) {
      cleanup = { status: null, error };
    }
    rmSync(directory, { recursive: true, force: true });
  }
  // A failed cleanup makes even a valid observation ineligible for confirmation.
  const removed = successful(cleanup) || /No such container/i.test(cleanup.stderr || '');
  if (!removed) return { ...failure('infrastructure-error', `Container cleanup failed: ${detail(cleanup)}`),
    cleanup: { removed: false, name }, priorKind: observation.kind };
  return { ...observation, cleanup: { removed: true, name } };
}

// Internal dependency seam allows lifecycle/failure tests without requiring Docker.
export function verifyFunctionExperiment({ repository = process.cwd(), base, candidate, experiment,
  image = 'node:22-alpine' }, { docker = dockerCommand } = {}) {
  validateExperiment(experiment);
  repository = resolve(repository);
  const revision = ref => execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
    { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 8000, maxBuffer: LIMIT }).trim();
  // Resolve both before running either; branch movement cannot change the source snapshot.
  const revisions = { base: revision(base), candidate: revision(candidate) };
  const harness = readFileSync(new URL('./function-harness.mjs', import.meta.url));
  const inspected = docker(['image', 'inspect', '--format', '{{.Id}}', image], controlOptions);
  const imageId = successful(inspected) ? inspected.stdout.trim() : '';
  let before, after;
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) {
    before = after = failure('infrastructure-error', `Local runner image unavailable: ${detail(inspected)}`);
  } else {
    before = runRevision(repository, revisions.base, experiment, imageId, harness, docker);
    after = runRevision(repository, revisions.candidate, experiment, imageId, harness, docker);
  }
  return { ...evaluateVerification(experiment, before, after), revisions, experiment,
    execution: { requestedImage: image, imageId: imageId || null,
      harnessSha256: createHash('sha256').update(harness).digest('hex') } };
}
