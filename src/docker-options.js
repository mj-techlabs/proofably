// Shared development-isolation policy for legacy commands and function experiments.
export function isolationOptions() {
  return ['--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--memory', '512m', '--cpus', '1', '--pids-limit', '128', '--read-only',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m',
    '--tmpfs', '/work:rw,nosuid,nodev,size=128m,uid=1000,gid=1000,mode=0700',
    '--user', '1000:1000'];
}
