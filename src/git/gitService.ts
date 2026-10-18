/**
 * gitService — thin, promise-based wrapper around the local `git` binary.
 * No external git library: we shell out for maximum fidelity and zero deps.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string = '',
  ) {
    super(message);
    this.name = 'GitError';
  }
}

async function git(
  cwd: string,
  args: string[],
  maxBuffer = 32 * 1024 * 1024,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      maxBuffer,
      windowsHide: true,
    });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new GitError(
      `git ${args.join(' ')} failed: ${e.message ?? 'unknown error'}`,
      e.stderr ?? '',
    );
  }
}

export async function isRepo(cwd: string): Promise<boolean> {
  try {
    const out = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
    return out.trim() === 'true';
  } catch {
    return false;
  }
}

export async function stagedDiff(cwd: string, paths?: string[]): Promise<string> {
  const args = ['diff', '--cached', '--no-color', '--find-renames'];
  if (paths?.length) args.push('--', ...paths);
  return git(cwd, args);
}

export async function unstagedDiff(cwd: string, paths?: string[]): Promise<string> {
  const args = ['diff', '--no-color', '--find-renames'];
  if (paths?.length) args.push('--', ...paths);
  return git(cwd, args);
}

export async function diffAgainstRef(
  cwd: string,
  ref: string,
  paths?: string[],
): Promise<string> {
  const args = ['diff', '--no-color', '--find-renames', ref];
  if (paths?.length) args.push('--', ...paths);
  return git(cwd, args);
}

export async function stageAll(cwd: string): Promise<void> {
  await git(cwd, ['add', '-A']);
}

export async function commit(cwd: string, message: string): Promise<string> {
  return git(cwd, ['commit', '-m', message]);
}

export async function statusPorcelain(cwd: string): Promise<string> {
  return git(cwd, ['status', '--porcelain']);
}

export async function currentBranch(cwd: string): Promise<string> {
  try {
    return (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  } catch {
    return '(no branch)';
  }
}

export async function lastCommits(cwd: string, count = 15): Promise<string[]> {
  try {
    const out = await git(cwd, [
      'log',
      `-${count}`,
      '--pretty=%s',
    ]);
    return out.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

export async function repoRoot(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
}
