import { spawn } from 'child_process';

export interface GitFileStatus {
  path: string;
  status: string; // M, A, D, R, C, U, ?? etc.
  staged: boolean;
  oldPath?: string; // for renames
}

export interface GitStatus {
  branch: string;
  upstream: string;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
  isRepo: boolean;
}

export interface GitLogEntry {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  date: string;
  subject: string;
  refs: string;
}

export interface GitBranch {
  name: string;
  current: boolean;
  remote?: string;
}

export interface GitDiff {
  filePath: string;
  hunks: string;
  additions: number;
  deletions: number;
}

function runGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const env = {
      ...process.env as Record<string, string>,
      GIT_TERMINAL_PROMPT: '0',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
    };

    const child = spawn('git', args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

    child.on('close', (code) => {
      resolve({ stdout, stderr, code: code ?? 1 });
    });

    child.on('error', () => {
      resolve({ stdout: '', stderr: 'git not found', code: 1 });
    });
  });
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  const result = await runGit(['rev-parse', '--is-inside-work-tree'], cwd);
  return result.code === 0 && result.stdout.trim() === 'true';
}

export async function getStatus(cwd: string): Promise<GitStatus> {
  const repoCheck = await isGitRepo(cwd);
  if (!repoCheck) {
    return { branch: '', upstream: '', ahead: 0, behind: 0, files: [], isRepo: false };
  }

  // Get branch info
  const branchResult = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const branch = branchResult.code === 0 ? branchResult.stdout.trim() : '';

  // Get upstream
  const upstreamResult = await runGit(['rev-parse', '--abbrev-ref', '@{upstream}'], cwd);
  const upstream = upstreamResult.code === 0 ? upstreamResult.stdout.trim() : '';

  // Get ahead/behind counts
  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const countResult = await runGit(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], cwd);
    if (countResult.code === 0) {
      const parts = countResult.stdout.trim().split(/\s+/);
      ahead = parseInt(parts[0] || '0', 10);
      behind = parseInt(parts[1] || '0', 10);
    }
  }

  // Get file statuses
  const statusResult = await runGit(['status', '--porcelain=v1', '-u'], cwd);
  const files: GitFileStatus[] = [];
  if (statusResult.code === 0) {
    const lines = statusResult.stdout.split('\n').filter(l => l.length > 0);
    for (const line of lines) {
      const indexStatus = line[0];
      const workTreeStatus = line[1];
      const filePath = line.substring(3).trim();

      // Handle renamed files (R status)
      if (indexStatus === 'R' || indexStatus === 'C') {
        const parts = filePath.split(' -> ');
        if (parts.length === 2) {
          files.push({
            path: parts[1],
            status: indexStatus,
            staged: true,
            oldPath: parts[0],
          });
          continue;
        }
      }

      // Index (staged) changes
      if (indexStatus !== ' ' && indexStatus !== '?') {
        files.push({
          path: filePath,
          status: indexStatus,
          staged: true,
        });
      }

      // Working tree (unstaged) changes
      if (workTreeStatus !== ' ') {
        files.push({
          path: filePath,
          status: workTreeStatus,
          staged: false,
        });
      }
    }
  }

  return { branch, upstream, ahead, behind, files, isRepo: true };
}

export async function getDiff(cwd: string, filePath?: string, staged: boolean = false): Promise<string> {
  const args = ['diff'];
  if (staged) args.push('--cached');
  if (filePath) args.push('--', filePath);
  const result = await runGit(args, cwd);
  return result.code === 0 ? result.stdout : '';
}

export async function getFileDiff(cwd: string, filePath: string, staged: boolean = false): Promise<GitDiff> {
  const diff = await getDiff(cwd, filePath, staged);
  const lines = diff.split('\n');
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { filePath, hunks: diff, additions, deletions };
}

export async function stageFile(cwd: string, filePath: string): Promise<boolean> {
  const result = await runGit(['add', '--', filePath], cwd);
  return result.code === 0;
}

export async function unstageFile(cwd: string, filePath: string): Promise<boolean> {
  const result = await runGit(['reset', 'HEAD', '--', filePath], cwd);
  return result.code === 0;
}

export async function stageAll(cwd: string): Promise<{ success: boolean; error?: string }> {
  const result = await runGit(['add', '-A'], cwd);
  console.log('[stageAll] cwd:', cwd, 'code:', result.code, 'stdout:', result.stdout, 'stderr:', result.stderr);
  if (result.code === 0) return { success: true };
  return { success: false, error: result.stderr || result.stdout || `exit code ${result.code}` };
}

export async function unstageAll(cwd: string): Promise<boolean> {
  const result = await runGit(['reset', 'HEAD'], cwd);
  return result.code === 0;
}

export async function commit(cwd: string, message: string): Promise<{ success: boolean; output: string }> {
  const result = await runGit(['commit', '-m', message], cwd);
  return { success: result.code === 0, output: result.stdout + result.stderr };
}

export async function push(cwd: string, remote?: string, branch?: string): Promise<{ success: boolean; output: string }> {
  const args = ['push'];
  if (remote) args.push(remote);
  if (branch) args.push(branch);
  const result = await runGit(args, cwd);
  return { success: result.code === 0, output: result.stdout + result.stderr };
}

export async function pull(cwd: string, remote?: string, branch?: string): Promise<{ success: boolean; output: string }> {
  const args = ['pull'];
  if (remote) args.push(remote);
  if (branch) args.push(branch);
  const result = await runGit(args, cwd);
  return { success: result.code === 0, output: result.stdout + result.stderr };
}

export async function fetch(cwd: string, remote?: string): Promise<{ success: boolean; output: string }> {
  const args = ['fetch'];
  if (remote) args.push(remote);
  const result = await runGit(args, cwd);
  return { success: result.code === 0, output: result.stdout + result.stderr };
}

export async function getLog(cwd: string, maxCount: number = 50): Promise<GitLogEntry[]> {
  const result = await runGit([
    'log', `--max-count=${maxCount}`, '--all', '--decorate',
    '--pretty=format:%H|%h|%an|%ae|%aI|%D|%s',
  ], cwd);

  if (result.code !== 0) return [];

  return result.stdout.split('\n').filter(l => l.length > 0).map(line => {
    const [hash, shortHash, author, email, date, refs, ...subjectParts] = line.split('|');
    return {
      hash,
      shortHash,
      author,
      email,
      date,
      subject: subjectParts.join('|'),
      refs: refs || '',
    };
  });
}

export async function getBranches(cwd: string): Promise<GitBranch[]> {
  const result = await runGit(['branch', '-a', '--format=%(refname:short)|%(HEAD)'], cwd);
  if (result.code !== 0) return [];

  return result.stdout.split('\n').filter(l => l.length > 0).map(line => {
    const [name, isCurrent] = line.split('|');
    return {
      name: name.trim(),
      current: isCurrent === '*',
    };
  });
}

export async function checkoutBranch(cwd: string, branchName: string): Promise<{ success: boolean; output: string }> {
  const result = await runGit(['checkout', branchName], cwd);
  return { success: result.code === 0, output: result.stdout + result.stderr };
}

export async function createBranch(cwd: string, branchName: string): Promise<{ success: boolean; output: string }> {
  const result = await runGit(['checkout', '-b', branchName], cwd);
  return { success: result.code === 0, output: result.stdout + result.stderr };
}

export async function discardChanges(cwd: string, filePath: string): Promise<{ success: boolean; output: string }> {
  const result = await runGit(['checkout', 'HEAD', '--', filePath], cwd);
  return { success: result.code === 0, output: result.stdout + result.stderr };
}

export async function discardAllChanges(cwd: string): Promise<{ success: boolean; output: string }> {
  const result = await runGit(['checkout', 'HEAD', '--', '.'], cwd);
  return { success: result.code === 0, output: result.stdout + result.stderr };
}

export async function getRemoteUrl(cwd: string): Promise<string> {
  const result = await runGit(['remote', 'get-url', 'origin'], cwd);
  return result.code === 0 ? result.stdout.trim() : '';
}

export async function deleteBranch(cwd: string, branchName: string, force: boolean = false): Promise<{ success: boolean; output: string }> {
  const args = ['branch', force ? '-D' : '-d', branchName];
  const result = await runGit(args, cwd);
  return { success: result.code === 0, output: result.stdout + result.stderr };
}

export async function mergeBranch(cwd: string, branchName: string): Promise<{ success: boolean; output: string }> {
  const result = await runGit(['merge', branchName], cwd);
  return { success: result.code === 0, output: result.stdout + result.stderr };
}

export async function stash(cwd: string, message?: string): Promise<{ success: boolean; output: string }> {
  const args = ['stash', 'push'];
  if (message) args.push('-m', message);
  const result = await runGit(args, cwd);
  return { success: result.code === 0, output: result.stdout + result.stderr };
}

export async function stashList(cwd: string): Promise<Array<{ index: number; message: string; branch: string }>> {
  const result = await runGit(['stash', 'list', '--format=%gd|%s'], cwd);
  if (result.code !== 0) return [];
  return result.stdout.split('\n').filter(l => l.length > 0).map((line, idx) => {
    const [ref, ...msgParts] = line.split('|');
    const message = msgParts.join('|');
    const branchMatch = ref.match(/stash@\{(\d+)\}/);
    return {
      index: branchMatch ? parseInt(branchMatch[1], 10) : idx,
      message,
      branch: ref,
    };
  });
}

export async function stashPop(cwd: string, index?: number): Promise<{ success: boolean; output: string }> {
  const args = ['stash', 'pop'];
  if (index !== undefined) args.push(`stash@{${index}}`);
  const result = await runGit(args, cwd);
  return { success: result.code === 0, output: result.stdout + result.stderr };
}

export async function stashApply(cwd: string, index?: number): Promise<{ success: boolean; output: string }> {
  const args = ['stash', 'apply'];
  if (index !== undefined) args.push(`stash@{${index}}`);
  const result = await runGit(args, cwd);
  return { success: result.code === 0, output: result.stdout + result.stderr };
}

export async function stashDrop(cwd: string, index?: number): Promise<{ success: boolean; output: string }> {
  const args = ['stash', 'drop'];
  if (index !== undefined) args.push(`stash@{${index}}`);
  const result = await runGit(args, cwd);
  return { success: result.code === 0, output: result.stdout + result.stderr };
}

export async function getCommitDetail(cwd: string, hash: string): Promise<{
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  date: string;
  subject: string;
  body: string;
  files: Array<{ path: string; status: string }>;
}> {
  const result = await runGit([
    'log', '-1', '--format=%H|%h|%an|%ae|%aI|%s%n%n%b', hash,
  ], cwd);
  if (result.code !== 0) {
    return { hash, shortHash: hash.substring(0, 7), author: '', email: '', date: '', subject: '', body: '', files: [] };
  }
  const lines = result.stdout.split('\n');
  const firstLine = lines[0];
  const [fullHash, shortHash, author, email, date, ...subjectParts] = firstLine.split('|');
  const subject = subjectParts.join('|');
  const body = lines.slice(1).join('\n').trim();

  const statResult = await runGit(['diff-tree', '--no-commit-id', '--name-status', '-r', hash], cwd);
  const files: Array<{ path: string; status: string }> = [];
  if (statResult.code === 0) {
    for (const line of statResult.stdout.split('\n').filter(l => l.length > 0)) {
      const parts = line.split('\t');
      if (parts.length >= 2) {
        files.push({ status: parts[0].trim(), path: parts.slice(1).join('\t') });
      }
    }
  }

  return { hash: fullHash, shortHash, author, email, date, subject, body, files };
}

export async function getCommitFileDiff(cwd: string, hash: string, filePath: string): Promise<GitDiff> {
  const args = ['diff', `${hash}^..${hash}`, '--', filePath];
  const result = await runGit(args, cwd);
  let diff = result.code === 0 ? result.stdout : '';
  if (!diff && result.code !== 0) {
    const args2 = ['diff', '4b825dc642cb6eb9a060e54bf899d15363da9d8e', hash, '--', filePath];
    const result2 = await runGit(args2, cwd);
    diff = result2.code === 0 ? result2.stdout : '';
  }
  const lines = diff.split('\n');
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { filePath, hunks: diff, additions, deletions };
}

export async function addRemote(cwd: string, name: string, url: string): Promise<{ success: boolean; output: string }> {
  const result = await runGit(['remote', 'add', name, url], cwd);
  return { success: result.code === 0, output: result.stdout + result.stderr };
}

export async function setRemoteUrl(cwd: string, name: string, url: string): Promise<{ success: boolean; output: string }> {
  const result = await runGit(['remote', 'set-url', name, url], cwd);
  return { success: result.code === 0, output: result.stdout + result.stderr };
}

export async function getRemotes(cwd: string): Promise<Array<{ name: string; url: string; type: string }>> {
  const result = await runGit(['remote', '-v'], cwd);
  if (result.code !== 0) return [];
  const remotes: Array<{ name: string; url: string; type: string }> = [];
  const seen = new Set<string>();
  for (const line of result.stdout.split('\n').filter(l => l.length > 0)) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\((\w+)\)/);
    if (match) {
      const key = `${match[1]}-${match[3]}`;
      if (!seen.has(key)) {
        seen.add(key);
        remotes.push({ name: match[1], url: match[2], type: match[3] });
      }
    }
  }
  return remotes;
}