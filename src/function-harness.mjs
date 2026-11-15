// Trusted harness. Experiments contain data only; target code runs in a worker.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readFile, realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve, extname } from 'node:path';

import { isJsonData, stringifyJson, boundedText } from './json-data.mjs';

if (isMainThread) {
  const experiment = JSON.parse(await readFile('/proofably/experiment.json', 'utf8'));
  const worker = new Worker(new URL(import.meta.url), { workerData: experiment, stdout: true, stderr: true });
  // Target logs never share the structured-result channel. Host output limits apply.
  worker.stdout.pipe(process.stderr);
  worker.stderr.pipe(process.stderr);
  let finished = false;
  async function finish(result) {
    if (finished) return;
    finished = true;
    await worker.terminate();
    process.stdout.write(stringifyJson({ protocolVersion: 1, ...result,
      runtime: { node: process.version, arch: process.arch, platform: process.platform } }) + '\n');
  }
  worker.once('message', result => finish(result));
  worker.once('error', error => finish({ outcome: 'execution-error', error: boundedText(error, 4096) }));
  worker.once('exit', code => finish({ outcome: 'execution-error', error: `Worker exited without a result (${code})` }));
} else {
  let fn;
  try {
    const target = await realpath(resolve('/work', workerData.target.module));
    if (!target.startsWith('/work/') || !['.js', '.mjs'].includes(extname(target))) {
      throw new Error('Target must be a JavaScript module inside the revision');
    }
    const module = await import(pathToFileURL(target).href);
    if (!Object.hasOwn(module, workerData.target.export) || typeof module[workerData.target.export] !== 'function') {
      throw new Error('Target export is not a function');
    }
    fn = module[workerData.target.export];
  } catch (error) {
    parentPort.postMessage({ outcome: 'target-error', error: boundedText(error, 4096) });
  }
  if (fn) {
    try {
      const value = fn(...workerData.arguments);
      if (!isJsonData(value)) parentPort.postMessage({ outcome: 'invalid-output' });
      else parentPort.postMessage({ outcome: 'returned', value });
    } catch (error) {
      parentPort.postMessage({ outcome: 'function-exception', error: boundedText(error, 4096) });
    }
  }
}
