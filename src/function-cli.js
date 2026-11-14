#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { verifyFunctionExperiment } from './function-runner.js';

async function main() {
  const options = {};
  const allowed = new Set(['--base', '--head', '--experiment', '--repository', '--image', '--output']);
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: node src/function-cli.js --base <ref> --head <ref> --experiment <json> [--repository <path>] [--image <local-image>] [--output <json>]');
    return;
  }
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.has(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || Object.hasOwn(options, args[i])) {
      throw new Error('Invalid options; use --help');
    }
    options[args[i]] = args[i + 1];
  }
  if (!options['--base'] || !options['--head'] || !options['--experiment']) throw new Error('Missing options; use --help');
  const experiment = JSON.parse(await readFile(options['--experiment'], 'utf8'));
  const report = verifyFunctionExperiment({ repository: options['--repository'], base: options['--base'],
    candidate: options['--head'], experiment, image: options['--image'] });
  const output = options['--output'] || 'proofably-function-report.json';
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(`${report.comparison}: base=${report.contracts.base.status}, candidate=${report.contracts.candidate.status}`);
  console.log(`Report: ${output}`);
}
main().catch(error => { console.error('Error:', error.message); process.exitCode = 1; });
