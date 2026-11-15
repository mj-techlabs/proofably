import { execFileSync } from 'node:child_process';
import { posix, resolve } from 'node:path';
import { parse } from 'acorn';
import { validateExperiment } from '../contracts.js';
import { stringifyJson } from '../json-data.mjs';
import { CONTRACT_ID, PlannerError, digest } from './core.js';

export function planningContext({ repository, base, head, experiment, deadline = performance.now() + 180000 }) {
  validateExperiment(experiment);
  if (experiment.contract.id !== CONTRACT_ID) throw new PlannerError('unsupported-contract');
  if (Buffer.byteLength(stringifyJson(experiment.contract)) > 4096) throw new PlannerError('contract-context-too-large');
  repository = resolve(repository);
  const module = posix.normalize(experiment.target.module);
  if (!['.js', '.mjs'].includes(posix.extname(module))) throw new PlannerError('unsupported-target');
  function git(args, maxBuffer = 65536) {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) throw new PlannerError('overall-budget-exhausted');
    try { return execFileSync('git', ['--literal-pathspecs', ...args], { cwd: repository, encoding: 'utf8',
      timeout: Math.min(8000, remaining), maxBuffer, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { throw new PlannerError('source-unavailable-or-too-large'); }
  }
  const revisions = { base: git(['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`]).trim(),
    candidate: git(['rev-parse', '--verify', '--end-of-options', `${head}^{commit}`]).trim() };
  function source(sha) {
    const entry = git(['ls-tree', '-z', sha, '--', module]);
    const match = /^(100644|100755) blob ([a-f0-9]+)\t([^\0]+)\0$/.exec(entry);
    if (!match || match[3] !== module) throw new PlannerError('target-not-regular-file');
    const text = git(['cat-file', 'blob', match[2]]);
    let ast;
    try { ast = parse(text, { ecmaVersion: 'latest', sourceType: 'module' }); }
    catch { throw new PlannerError('unsupported-javascript'); }
    let localName = experiment.target.export;
    let node;
    for (const item of ast.body) {
      if (item.type !== 'ExportNamedDeclaration' || item.source) continue;
      const specifier = item.specifiers.find(s => (s.exported.name || s.exported.value) === experiment.target.export);
      if (specifier) localName = specifier.local.name;
    }
    const exported = ast.body.some(item => item.type === 'ExportNamedDeclaration' && !item.source &&
      (item.specifiers.some(s => (s.exported.name || s.exported.value) === experiment.target.export) ||
       item.declaration?.id?.name === experiment.target.export || item.declaration?.declarations?.some(d => d.id.name === experiment.target.export)));
    if (!exported) throw new PlannerError('target-export-unavailable');
    for (const item of ast.body) {
      const declaration = item.type === 'ExportNamedDeclaration' ? item.declaration : item;
      if (declaration?.type === 'FunctionDeclaration' && declaration.id.name === localName) node = declaration;
      if (declaration?.type === 'VariableDeclaration') {
        const found = declaration.declarations.find(d => d.id.type === 'Identifier' && d.id.name === localName);
        if (found && ['FunctionExpression', 'ArrowFunctionExpression'].includes(found.init?.type)) node = found;
      }
    }
    const fn = node?.type === 'VariableDeclarator' ? node.init : node;
    if (!fn || fn.async || fn.generator) throw new PlannerError('unsupported-target');
    const selected = text.slice(node.start, node.end);
    if (Buffer.byteLength(selected) > 4096) throw new PlannerError('selected-function-too-large');
    return selected;
  }
  const sources = { base: source(revisions.base), candidate: source(revisions.candidate) };
  // Diff only the extracted function, never a full-file Git diff with unrelated hunks.
  const diff = sources.base === sources.candidate ? '' :
    '--- base selected function\n+++ candidate selected function\n' +
    sources.base.split('\n').map(s => '-' + s).join('\n') + '\n' + sources.candidate.split('\n').map(s => '+' + s).join('\n');
  const context = { target: { module, export: experiment.target.export }, contract: {
    id: experiment.contract.id, provenance: { source: experiment.contract.provenance.source, statement: experiment.contract.provenance.statement } },
    revisions, sources, diff };
  const encoded = stringifyJson(context);
  if (Buffer.byteLength(encoded) > 16384) throw new PlannerError('planning-context-too-large');
  return { context, contextSha256: digest(encoded) };
}
