import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { validateExperiment } from './contracts.js';
import { isolationOptions } from './docker-options.js';
import { isJsonData, stringifyJson, boundedText } from './json-data.mjs';
import { executionSettings, summarizeReproduction } from './reproduction.js';

const LIMIT = 1048576;
const BOOTSTRAP = 'tar -xf /proofably/source.tar -C /work && cd /work && exec node /proofably/function-harness.mjs';
const extraOptions = ['--memory-swap', '512m', '--ulimit', 'nofile=256:256', '--log-driver', 'none'];
const dockerCommand = (args, options) => spawnSync('docker', args, options);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const successful = result => !result.error && result.status === 0;
const detail = result => boundedText(result.error?.message || [result.stderr, result.stdout].filter(Boolean).join('\n') || `exit ${result.status}`, 4096);
const failure = (kind, message, timedOut = false) => ({ kind, exitCode: null, timedOut, detail: message });
const noCleanup = () => ({ attempted: false, removed: null, verified: false });

export function runnerArtifacts() {
  const harness = readFileSync(new URL('./function-harness.mjs', import.meta.url));
  const json = readFileSync(new URL('./json-data.mjs', import.meta.url));
  return { harness, json, identity: { harnessSha256: sha256(harness), jsonSha256: sha256(json),
    policySha256: sha256(stringifyJson({ isolation: isolationOptions(), extraOptions, bootstrap: BOOTSTRAP })),
    runnerSha256: sha256(readFileSync(new URL('./function-runner.js', import.meta.url))),
    evaluatorSha256: sha256(readFileSync(new URL('./contracts.js', import.meta.url))),
    reproductionSha256: sha256(readFileSync(new URL('./reproduction.js', import.meta.url))) } };
}

export function dockerAvailability() {
  const result = dockerCommand(['info'], { encoding: 'utf8', timeout: 8000, maxBuffer: LIMIT });
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
        (data.outcome === 'returned' && (!Object.hasOwn(data, 'value') || !isJsonData(data.value)))) throw new Error('Invalid harness envelope');
    return { kind: data.outcome, exitCode: 0, timedOut: false,
      ...(data.outcome === 'returned' ? { value: data.value } : {}),
      ...(typeof data.error === 'string' ? { detail: boundedText(data.error, 4096) } : {}),
      ...(isJsonData(data.runtime) ? { runtime: data.runtime } : {}) };
  } catch (error) {
    return failure('protocol-error', boundedText(error, 4096));
  }
}

function logs(result, settings) {
  const fields = {};
  for (const stream of ['stdout', 'stderr']) {
    const bytes = Buffer.from(result[stream] || '');
    fields[stream] = boundedText(bytes.toString('utf8'), settings.maxLogBytes);
    fields[`${stream}Sha256`] = sha256(bytes);
    fields[`${stream}Truncated`] = !Buffer.from(fields[stream]).equals(bytes);
  }
  return fields;
}
function processRecord(result, settings) {
  return { exitCode: Number.isInteger(result.status) ? result.status : null, ...logs(result, settings),
    ...(result.error ? { error: { code: String(result.error.code || 'UNKNOWN'), message: detail(result) } } : {}) };
}

function runRevision(repository, revision, experiment, image, artifacts, docker, settings, deadline, now) {
  const reserve = settings.cleanupTimeoutMs * 2;
  if (deadline - now() <= reserve) return { ...failure('budget-exhausted', 'Overall runtime budget exhausted'), cleanup: noCleanup() };
  const directory = mkdtempSync(join(tmpdir(), 'proofably-function-'));
  const name = `proofably-${randomUUID()}`;
  let observation;
  let created = false;
  let sourceArchiveSha256;
  const command = (args, timeout, cleanup = false) => {
    const remaining = Math.floor(deadline - now() - (cleanup ? 0 : reserve));
    if (remaining <= 0) return { status: null, error: { code: 'ETIMEDOUT', message: 'Overall runtime budget exhausted' } };
    try {
      return docker(args, { encoding: args[0] === 'start' ? null : 'utf8', timeout: Math.max(1, Math.min(timeout, remaining)),
        maxBuffer: settings.maxOutputBytes, killSignal: 'SIGKILL' });
    } catch (error) { return { status: null, error }; }
  };
  let cleanup = noCleanup();
  try {
    const archive = execFileSync('git', ['archive', '--format=tar', revision], { cwd: repository, maxBuffer: 64 * LIMIT,
      timeout: Math.max(1, Math.min(settings.controlTimeoutMs, Math.floor(deadline - now() - reserve))), stdio: ['ignore', 'pipe', 'pipe'] });
    sourceArchiveSha256 = sha256(archive);
    chmodSync(directory, 0o755);
    for (const [file, contents] of Object.entries({ 'source.tar': archive, 'function-harness.mjs': artifacts.harness,
      'json-data.mjs': artifacts.json, 'experiment.json': stringifyJson(experiment) })) {
      writeFileSync(join(directory, file), contents, { mode: 0o444 });
    }
    // Even an interrupted create can leave a named container; always clean it up.
    created = true;
    const result = command(['create', '--name', name, '--pull=never', ...isolationOptions(), ...extraOptions,
      '--mount', `type=bind,src=${directory},dst=/proofably,readonly`, '--entrypoint', '/bin/sh', image, '-c', BOOTSTRAP], settings.controlTimeoutMs);
    if (!successful(result)) observation = { ...failure('infrastructure-error', detail(result)), create: processRecord(result, settings) };
    else {
      const run = command(['start', '--attach', name], experiment.expectedExecution.timeoutMs);
      observation = { ...decodeObservation(run), ...logs(run, settings),
        processExitCode: Number.isInteger(run.status) ? run.status : null, signal: run.signal || null,
        ...(run.error ? { errorCode: String(run.error.code || 'UNKNOWN') } : {}) };
    }
  } catch (error) { observation = failure('infrastructure-error', boundedText(error, 4096)); }
  finally {
    if (created) {
      const removal = command(['rm', '--force', name], settings.cleanupTimeoutMs, true);
      const inspection = command(['container', 'inspect', name], settings.cleanupTimeoutMs, true);
      const absent = !inspection.error && inspection.status === 1 && /No such (object|container)/i.test(inspection.stderr || '');
      cleanup = { attempted: true, name, removed: absent, verified: absent,
        removal: processRecord(removal, settings), inspection: processRecord(inspection, settings) };
    }
    rmSync(directory, { recursive: true, force: true });
  }
  return { ...observation, ...(sourceArchiveSha256 ? { sourceArchiveSha256 } : {}), cleanup };
}

// Project only defined experiment fields: unknown metadata/environment fields never enter evidence.
function experimentData(input) {
  validateExperiment(input);
  const e = { schemaVersion: input.schemaVersion, id: input.id, target: { module: input.target.module, export: input.target.export },
    arguments: input.arguments, contract: { id: input.contract.id, provenance: {
      source: input.contract.provenance.source, statement: input.contract.provenance.statement } },
    expectedExecution: { runtime: input.expectedExecution.runtime, timeoutMs: input.expectedExecution.timeoutMs,
      expectedExitCode: input.expectedExecution.expectedExitCode } };
  const encoded = stringifyJson(e);
  if (Buffer.byteLength(encoded) > LIMIT) throw new TypeError('Experiment exceeds 1 MiB');
  return JSON.parse(encoded);
}

export function verifyFunctionExperiment({ repository = process.cwd(), base, candidate, experiment,
  image = 'node:22-alpine', repetitions = 3, overallTimeoutMs = 180000 }, { docker = dockerCommand, now = () => performance.now() } = {}) {
  experiment = experimentData(experiment);
  const settings = executionSettings(repetitions, overallTimeoutMs);
  const deadline = now() + settings.overallTimeoutMs;
  repository = resolve(repository);
  const revision = ref => execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
    { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      timeout: Math.max(1, Math.min(settings.controlTimeoutMs, Math.floor(deadline - now()))), maxBuffer: LIMIT }).trim();
  const revisions = { base: revision(base), candidate: revision(candidate) };
  const artifacts = runnerArtifacts();
  let inspected;
  try {
    inspected = deadline <= now() ? { status: null, error: { message: 'Overall runtime budget exhausted' } } :
      docker(['image', 'inspect', '--format', '{{.Id}}', image], { encoding: 'utf8',
        timeout: Math.max(1, Math.min(settings.controlTimeoutMs, Math.floor(deadline - now()))), maxBuffer: LIMIT, killSignal: 'SIGKILL' });
  } catch (error) { inspected = { status: null, error }; }
  const imageId = successful(inspected) ? inspected.stdout.trim() : '';
  const exactImage = /^sha256:[a-f0-9]{64}$/.test(image);
  const validImage = /^sha256:[a-f0-9]{64}$/.test(imageId) && (!exactImage || image === imageId);
  const attempts = { base: [], candidate: [] };
  for (const side of ['base', 'candidate']) {
    for (let i = 0; i < settings.repetitions; i++) {
      attempts[side].push(validImage ? runRevision(repository, revisions[side], experiment, imageId, artifacts, docker, settings, deadline, now) :
        { ...failure('infrastructure-error', `Local runner image unavailable or identity mismatch: ${detail(inspected)}`),
          imageInspection: processRecord(inspected, settings), cleanup: noCleanup() });
    }
  }
  const summary = summarizeReproduction(experiment, attempts, settings);
  return { bundleVersion: 1, kind: 'proofably-evidence', schemaVersion: 1, id: experiment.id, ...summary,
    attempts, revisions, experiment, execution: { requestedImage: image, imageId: validImage ? imageId : null,
      ...artifacts.identity, settings } };
}
