export function evaluateExperiment(experiment, base, candidate) {
  const runnable = x => !x.timedOut && typeof x.exitCode === 'number';
  const normalized = x => ({exitCode:x.exitCode,stdout:x.stdout.replace(/\r\n/g,'\n'),stderr:x.stderr.replace(/\r\n/g,'\n')});
  const status = !runnable(base)||!runnable(candidate) ? 'unverified' :
    JSON.stringify(normalized(base))===JSON.stringify(normalized(candidate)) ? 'no-difference' : 'behavioral-difference';
  // A behavioral difference is NOT a confirmed defect without an independent oracle.
  return {id:experiment.id,status,command:experiment.command,base,candidate};
}
