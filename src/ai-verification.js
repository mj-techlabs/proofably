import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { planningContext } from './planners/context.js';
import { openAIPlanner } from './planners/openai.js';
import { PlannerError, plannerBudget, validateCases, digest, DEFAULT_MODEL } from './planners/core.js';
import { verifyFunctionExperiment, dockerCommand } from './function-runner.js';
import { executionSettings } from './reproduction.js';
import { serializeEvidence } from './evidence-bundle.js';
import { stringifyJson } from './json-data.mjs';

// New manifest/sidecar format; per-case evidence remains bundleVersion 1.
export async function verifyWithPlanner({ repository = process.cwd(), base, head, experiment,
  outputDirectory = `proofably-ai-${randomUUID()}`, model = process.env.PROOFABLY_MODEL || DEFAULT_MODEL,
  budget: budgetOptions = {}, image = 'node:22-alpine', repetitions = 3, overallTimeoutMs = 180000 },
  { planner = openAIPlanner({ model }), docker = dockerCommand, now = () => performance.now(), verify = verifyFunctionExperiment } = {}) {
  const settings = executionSettings(repetitions, overallTimeoutMs);
  const budget = plannerBudget(budgetOptions);
  const deadline = now() + settings.overallTimeoutMs;
  const directory = resolve(outputDirectory);
  // Exclusive directory creation rejects existing artifacts and symlink aliases.
  mkdirSync(directory, { mode: 0o700 });
  const manifest = { aiRunVersion: 1, kind: 'proofably-ai-run', status: 'unverified', cases: [],
    summary: { confirmedViolations: 0, behavioralDifferences: 0, unverified: 0, noDifference: 0 } };
  function write(name, text) { writeFileSync(join(directory, name), text, { flag: 'wx', mode: 0o600 }); }
  try {
    const prepared = planningContext({ repository, base, head, experiment, deadline });
    const { context, contextSha256 } = prepared;
    manifest.revisions = context.revisions;
    const remaining = () => Math.floor(deadline - now());
    if (remaining() < 1000) throw new PlannerError('overall-budget-exhausted');
    const inspection = docker(['image', 'inspect', '--format', '{{.Id}}', image], { encoding: 'utf8',
      timeout: Math.min(8000, remaining()), maxBuffer: 1048576, killSignal: 'SIGKILL' });
    const imageId = inspection.status === 0 && !inspection.error ? inspection.stdout.trim() : '';
    if (!/^sha256:[a-f0-9]{64}$/.test(imageId) || (/^sha256:/.test(image) && image !== imageId)) throw new PlannerError('runner-image-unavailable');
    const requestBudget = { ...budget, timeoutMs: Math.min(budget.timeoutMs, remaining()) };
    if (requestBudget.timeoutMs < 1) throw new PlannerError('overall-budget-exhausted');
    let timer;
    let proposed;
    try {
      proposed = await Promise.race([planner.proposeExperiments(context, requestBudget), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new PlannerError('request-timeout')), requestBudget.timeoutMs + (requestBudget.timeoutMs < remaining() ? 10 : 0));
      })]);
    } finally { clearTimeout(timer); }
    // Revalidate at the provider-neutral boundary, including fixture/custom planners.
    const cases = validateCases({ cases: proposed.cases }, context, budget);
    const provenance = proposed.provenance;
    if (!provenance || !['fixture', 'openai'].includes(provenance.provider) ||
        Buffer.byteLength(stringifyJson(provenance)) > 16384) throw new PlannerError('invalid-provenance');
    const planning = { planningVersion: 1, contextSha256, target: context.target, contract: context.contract,
      revisions: context.revisions, provenance, cases };
    const planningText = stringifyJson(planning, true) + '\n';
    write('planning.json', planningText);
    manifest.planning = { file: 'planning.json', sha256: digest(planningText) };
    manifest.planner = provenance;
    for (let index = 0; index < cases.length; index++) {
      const generated = cases[index];
      const id = `case-${String(index + 1).padStart(3, '0')}`;
      const entry = { id, arguments: generated.arguments, contractId: generated.contractId,
        rationale: generated.rationale, planningFile: 'planning.json', planningSha256: digest(planningText), classification: 'unverified' };
      manifest.cases.push(entry);
      if (remaining() < 1000) { entry.reason = 'overall-budget-exhausted'; continue; }
      try {
        const result = verify({ repository, base: context.revisions.base, candidate: context.revisions.candidate,
          experiment: { schemaVersion: 1, id, target: context.target, arguments: generated.arguments,
            contract: context.contract, expectedExecution: experiment.expectedExecution },
          image: imageId, repetitions, overallTimeoutMs: Math.min(settings.overallTimeoutMs, remaining()) }, { docker, now });
        const text = serializeEvidence(result);
        const file = `${id}.json`;
        write(file, text);
        Object.assign(entry, { evidence: { file, sha256: digest(text) }, classification: result.classification,
          comparison: result.comparison, contracts: result.contracts,
          hasUnverifiedRevision: Object.values(result.contracts).some(v => v.status === 'unverified') });
      } catch { entry.reason = 'case-execution-or-evidence-failed'; }
    }
    manifest.status = manifest.cases.some(c => c.classification === 'unverified' || c.hasUnverifiedRevision) ? 'partial' : 'completed';
  } catch (error) {
    manifest.error = error instanceof PlannerError ? error.code : 'verification-setup-failed';
    if (error instanceof PlannerError && error.metadata && Object.keys(error.metadata).length) manifest.planner = error.metadata;
  }
  for (const entry of manifest.cases) {
    const key = { 'confirmed-contract-violation': 'confirmedViolations', 'behavioral-difference': 'behavioralDifferences',
      'no-difference': 'noDifference', unverified: 'unverified' }[entry.classification];
    manifest.summary[key]++;
    if (entry.hasUnverifiedRevision && entry.classification !== 'unverified') manifest.summary.unverified++;
  }
  write('manifest.json', stringifyJson(manifest, true) + '\n');
  return { directory, manifest };
}
