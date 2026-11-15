#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { verifyFunctionExperiment } from './function-runner.js';
import { readJsonFile, replayEvidence, serializeEvidence } from './evidence-bundle.js';
import { stringifyJson } from './json-data.mjs';

async function main() {
  const options = {};
  const args = process.argv.slice(2);
  const replay = args[0] === 'replay';
  const ai = args[0] === 'ai';
  if (replay || ai) args.shift();
  const allowed = new Set(ai ? ['--base', '--head', '--experiment', '--repository', '--image', '--output-dir',
    '--model', '--max-cases', '--max-cost-usd', '--max-input-tokens', '--max-output-tokens', '--max-total-tokens',
    '--request-timeout-ms', '--repetitions', '--overall-timeout-ms'] : replay ? ['--bundle', '--repository', '--output'] :
    ['--base', '--head', '--experiment', '--repository', '--image', '--output', '--repetitions', '--overall-timeout-ms']);
  if (args.includes('--help')) {
    if (ai) { console.log('Usage: node src/function-cli.js ai --base <ref> --head <ref> --experiment <json> [--repository <path>] [--output-dir <new-directory>] [--model <model>] [--max-cases <1-8>] [--max-cost-usd <USD>] [--max-input-tokens <n>] [--max-output-tokens <n>] [--max-total-tokens <n>] [--request-timeout-ms <ms>] [--repetitions <1-5>] [--overall-timeout-ms <ms>] [--image <local-image>]'); return; }
    console.log('Usage: node src/function-cli.js --base <ref> --head <ref> --experiment <json> [--repository <path>] [--image <local-image>] [--output <json>] [--repetitions <1-5>] [--overall-timeout-ms <1000-300000>]\n       node src/function-cli.js replay --bundle <json> [--repository <path>] [--output <new-json>]');
    return;
  }
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.has(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || Object.hasOwn(options, args[i])) {
      throw new Error('Invalid options; use --help');
    }
    options[args[i]] = args[i + 1];
  }
  if (replay) {
    if (!options['--bundle']) throw new Error('Missing --bundle; use --help');
    const original = readJsonFile(options['--bundle']);
    const report = replayEvidence(original, { repository: options['--repository'] });
    const output = options['--output'] || `proofably-replay-${randomUUID()}.json`;
    // Exclusive creation protects originals, including symlinks/hardlinks/aliases.
    await writeFile(output, stringifyJson(report, true) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(`Execution replay: ${report.status}\nReport: ${output}`);
    if (report.status !== 'match') process.exitCode = 1;
    return;
  }
  if (!options['--base'] || !options['--head'] || !options['--experiment']) throw new Error('Missing options; use --help');
  const experiment = readJsonFile(options['--experiment'], 1048576);
  if (ai) {
    const { verifyWithPlanner } = await import('./ai-verification.js');
    const budget = {};
    for (const [flag, key] of Object.entries({ '--max-cases': 'maxCases', '--max-cost-usd': 'maxCostUSD',
      '--max-input-tokens': 'maxInputTokens', '--max-output-tokens': 'maxOutputTokens', '--max-total-tokens': 'maxTotalTokens',
      '--request-timeout-ms': 'timeoutMs' })) {
      if (options[flag] !== undefined) budget[key] = Number(options[flag]);
    }
    const { directory, manifest } = await verifyWithPlanner({ repository: options['--repository'],
      base: options['--base'], head: options['--head'], experiment, outputDirectory: options['--output-dir'],
      model: options['--model'], image: options['--image'], budget,
      repetitions: options['--repetitions'] === undefined ? 3 : Number(options['--repetitions']),
      overallTimeoutMs: options['--overall-timeout-ms'] === undefined ? 180000 : Number(options['--overall-timeout-ms']) });
    console.log(`AI verification: ${manifest.status}`);
    console.log(`Confirmed violations: ${manifest.summary.confirmedViolations}; behavioral differences: ${manifest.summary.behavioralDifferences}; unverified: ${manifest.summary.unverified}; no difference: ${manifest.summary.noDifference}`);
    if (manifest.error) console.log(`Reason: ${manifest.error}`);
    console.log(`Manifest: ${directory}/manifest.json`);
    if (manifest.status !== 'completed') process.exitCode = 1;
    return;
  }
  const report = verifyFunctionExperiment({ repository: options['--repository'], base: options['--base'],
    candidate: options['--head'], experiment, image: options['--image'],
    repetitions: options['--repetitions'] === undefined ? 3 : Number(options['--repetitions']),
    overallTimeoutMs: options['--overall-timeout-ms'] === undefined ? 180000 : Number(options['--overall-timeout-ms']) });
  const output = options['--output'] || 'proofably-function-report.json';
  await writeFile(output, serializeEvidence(report), { mode: 0o600 });
  console.log(`${report.comparison}: base=${report.contracts.base.status}, candidate=${report.contracts.candidate.status}`);
  console.log(`Report: ${output}`);
}
main().catch(error => { console.error('Error:', error.message); process.exitCode = 1; });
