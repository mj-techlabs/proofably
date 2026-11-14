#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { evaluateExperiment } from './evidence.js';

function arg(name, fallback) { const i=process.argv.indexOf(name); return i<0 ? fallback : process.argv[i+1]; }
function git(...args) { return execFileSync('git', args, {encoding:'utf8'}).trim(); }
function usage() { console.log(`Usage: proofably check --base <ref> --head <ref> --experiments <file> [--output <file>] [--timeout <seconds>]\n\nExperiments JSON: {"experiments":[{"id":"case-1","command":["node","test.js"]}]}\nCommands execute in separate, network-disabled Docker containers for base and head.`); }
function dockerReady() { const p=spawnSync('docker',['info'],{encoding:'utf8',timeout:8000}); return p.status===0; }
function run(ref, command, timeoutSeconds) {
  const revision=git('rev-parse','--verify',`${ref}^{commit}`);
  // git archive is piped to docker via a temporary archive on the host; never mount the working tree.
  const {mkdtempSync,writeFileSync,rmSync}=awaitless();
  const {tmpdir}=awaitlessOs(); const {join}=awaitlessPath();
  const temp=mkdtempSync(join(tmpdir(),'proofably-'));
  try {
    const archive=execFileSync('git',['archive','--format=tar',revision],{maxBuffer:64*1024*1024});
    writeFileSync(join(temp,'source.tar'),archive);
    const script=`mkdir -p /work && tar -xf /input/source.tar -C /work && cd /work && exec "$@"`;
    const args=['run','--rm','--network','none','--cap-drop','ALL','--security-opt','no-new-privileges',
      '--memory','512m','--cpus','1','--pids-limit','128','--read-only','--tmpfs','/tmp:rw,nosuid,nodev,size=64m',
      '--tmpfs','/work:rw,nosuid,nodev,size=128m','--mount',`type=bind,src=${join(temp,'source.tar')},dst=/input/source.tar,readonly`,
      '--user','1000:1000','node:22-alpine','sh','-c',script,'proofably',...command];
    const p=spawnSync('docker',args,{encoding:'utf8',timeout:timeoutSeconds*1000,maxBuffer:2*1024*1024});
    return {exitCode:p.status,stdout:p.stdout||'',stderr:p.stderr||'',timedOut:p.error?.code==='ETIMEDOUT'};
  } finally {rmSync(temp,{recursive:true,force:true});}
}
// Local synchronous module helpers avoid external dependencies.
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
function awaitless(){return {mkdtempSync,writeFileSync,rmSync};}
function awaitlessOs(){return {tmpdir};}
function awaitlessPath(){return {join};}
async function main() {
  if (process.argv[2]!=='check' || process.argv.includes('--help')) {usage();return;}
  const base=arg('--base'),head=arg('--head'),file=arg('--experiments'),output=arg('--output','proofably-report.json');
  const timeoutSeconds=Number(arg('--timeout','30'));
  if (!base||!head||!file||!Number.isInteger(timeoutSeconds)||timeoutSeconds<1||timeoutSeconds>300) throw new Error('Missing/invalid options; run proofably --help');
  if (!dockerReady()) throw new Error('Docker daemon unavailable. This prototype requires local Docker.');
  const spec=JSON.parse(await readFile(resolve(file),'utf8'));
  if (!Array.isArray(spec.experiments)||spec.experiments.length>100) throw new Error('Expected experiments array (max 100)');
  const findings=[];
  for (const experiment of spec.experiments) {
    if (!Array.isArray(experiment.command)||!experiment.command.length||experiment.command.some(x=>typeof x!=='string')) throw new Error('Invalid experiment command');
    const before=run(base,experiment.command,timeoutSeconds),after=run(head,experiment.command,timeoutSeconds);
    const result=evaluateExperiment(experiment,before,after);
    findings.push(result);
    console.log(`${result.status.padEnd(22)} ${experiment.id}`);
  }
  const report={schemaVersion:1,base:git('rev-parse',base),head:git('rev-parse',head),findings};
  await writeFile(resolve(output),JSON.stringify(report,null,2)+'\n');
  console.log(`Report: ${output}`);
}
main().catch(e=>{console.error('Error:',e.message);process.exitCode=1;});
