// Trusted harness. Experiments contain data only; target code runs in a worker.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readFile, realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve, extname } from 'node:path';

function jsonValue(value, ancestors = new Set()) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) return false;
  const next = new Set(ancestors).add(value);
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) return false;
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) return false;
    }
  }
  // Reject accessors/symbols rather than running getters again during cloning.
  return Reflect.ownKeys(value).every(key => {
    if (Array.isArray(value) && key === 'length') return true;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === 'string' && descriptor.enumerable && Object.hasOwn(descriptor, 'value') &&
      jsonValue(descriptor.value, next);
  });
}

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
    process.stdout.write(JSON.stringify({ protocolVersion: 1, ...result,
      runtime: { node: process.version, arch: process.arch, platform: process.platform } }) + '\n');
  }
  worker.once('message', result => finish(result));
  worker.once('error', error => finish({ outcome: 'execution-error', error: String(error).slice(0, 4096) }));
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
    parentPort.postMessage({ outcome: 'target-error', error: String(error).slice(0, 4096) });
  }
  if (fn) {
    try {
      const value = fn(...workerData.arguments);
      if (!jsonValue(value)) parentPort.postMessage({ outcome: 'invalid-output' });
      else parentPort.postMessage({ outcome: 'returned', value });
    } catch (error) {
      parentPort.postMessage({ outcome: 'function-exception', error: String(error).slice(0, 4096) });
    }
  }
}
