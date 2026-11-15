import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const experiment = JSON.parse(readFileSync(new URL('../fixtures/power-of-two/experiment.json', import.meta.url), 'utf8'));

export function functionRepository(t, candidateSource, { preserve = false } = {}) {
  const repository = mkdtempSync(join(tmpdir(), 'proofably-fixture-'));
  if (!preserve) t.after(() => rmSync(repository, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Proofably fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
  { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 8000 }).trim();
  git('init');
  writeFileSync(join(repository, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(repository, 'index.js'), readFileSync(new URL('../fixtures/power-of-two/base.js', import.meta.url)));
  git('add', '.');
  git('commit', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(repository, 'index.js'), candidateSource ?? readFileSync(new URL('../fixtures/power-of-two/candidate.js', import.meta.url)));
  // A fixture for testing module-path containment after symlink resolution.
  symlinkSync('/etc/passwd', join(repository, 'outside.js'));
  git('add', '.');
  git('commit', '-m', 'candidate');
  const candidate = git('rev-parse', 'HEAD');
  return { repository, base, candidate, experiment: structuredClone(experiment) };
}
