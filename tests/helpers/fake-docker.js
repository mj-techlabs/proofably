import { stringifyJson } from '../../src/json-data.mjs';

export const IMAGE_ID = `sha256:${'a'.repeat(64)}`;
export function fakeDocker({ values = [8, 8, 8, 16, 16, 16], result, missingImage = false, cleanupFailure = false } = {}) {
  const calls = [];
  let index = 0;
  const docker = (args, options) => {
    calls.push({ args, options });
    if (args[0] === 'image') return missingImage ? { status: 1, stderr: 'No such image' } : { status: 0, stdout: IMAGE_ID };
    if (args[0] === 'create') return { status: 0, stdout: 'container' };
    if (args[0] === 'rm') return cleanupFailure ? { status: 1, stderr: 'daemon unavailable' } : { status: 0, stdout: args[2] };
    if (args[0] === 'container') return cleanupFailure ? { status: 1, stderr: 'daemon unavailable' } :
      { status: 1, stderr: `Error: No such object: ${args[2]}` };
    if (args[0] === 'start') {
      const attempt = index++;
      return result ? result(attempt, options) : { status: 0, stderr: '', stdout: stringifyJson({ protocolVersion: 1,
        outcome: 'returned', value: values[attempt % values.length], runtime: { node: 'v22.0.0', arch: 'x64', platform: 'linux' } }) };
    }
    throw new Error(`Unexpected Docker invocation ${args}`);
  };
  return { docker, calls };
}
