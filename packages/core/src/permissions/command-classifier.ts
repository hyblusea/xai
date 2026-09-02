export type CommandClassification = 'auto' | 'confirm' | 'deny';

const AUTO_COMMANDS = new Set([
  'ls',
  'cat',
  'git',
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'echo',
  'pwd',
  'which',
  'node',
  'type',
  'dir',
  'find',
  'grep',
  'head',
  'tail',
  'wc',
  'cd',
  'mkdir',
  'cp',
  'mv',
  'touch',
  'python',
  'python3',
  'pip',
  'pip3',
  'cargo',
  'rustc',
  'go',
  'dotnet',
  'make',
  'cmake',
  'vite',
  'webpack',
  'tsc',
  'eslint',
  'prettier',
]);

const AUTO_GIT_SUBCOMMANDS = new Set(['status', 'log', 'diff', 'branch']);
const AUTO_NPM_SUBCOMMANDS = new Set(['test', 'run', 'start', 'build', 'dev']);
const AUTO_BUILD_TOOLS = new Set([
  'vite',
  'webpack',
  'tsc',
  'eslint',
  'prettier',
  'babel',
  'jest',
  'vitest',
  'mocha',
  'rollup',
  'esbuild',
  'turbo',
  'nx',
]);
const AUTO_PNPM_SUBCOMMANDS = new Set(['test', 'run', 'start', 'build', 'dev']);

const CONFIRM_COMMANDS = new Set([
  'npm',
  'git',
  'docker',
  'rm',
  'del',
  'rmdir',
  'mkfs',
  'format',
  'curl',
  'wget',
  'apt',
  'yum',
  'brew',
  'ssh',
]);

const CONFIRM_GIT_SUBCOMMANDS = new Set(['push', 'merge']);
const CONFIRM_NPM_SUBCOMMANDS = new Set(['install', 'publish']);
const CONFIRM_NPX_SUBCOMMANDS = new Set(['install', 'publish']);
const CONFIRM_PNPM_SUBCOMMANDS = new Set(['install', 'publish']);
const CONFIRM_DOCKER_SUBCOMMANDS = new Set(['build', 'run']);

const DENY_PATTERNS: RegExp[] = [
  /^rm\s+(-\w*r\w*f\w*|--force)\s+\//,
  /^rm\s+(-\w*f\w*r\w*|--force)\s+\//,
  /^rm\s+-\w*[rf]\w*\s+[Cc]:\/?/,
  /^format\s+[Cc]:/,
  /^mkfs/,
  /^dd\s+if=/,
  /^shutdown/,
  /^reboot/,
];

function extractBaseCommand(segment: string): string {
  const trimmed = segment.trim();
  if (!trimmed) return '';
  const tokens = trimmed.split(/\s+/);
  return tokens[0].toLowerCase();
}

function extractSubcommand(segment: string): string | null {
  const trimmed = segment.trim();
  if (!trimmed) return null;
  const tokens = trimmed.split(/\s+/);
  if (tokens.length < 2) return null;
  return tokens[1].toLowerCase();
}

function hasPipeToRm(segment: string): boolean {
  const pipeSegments = segment.split(/\|/);
  for (let i = 1; i < pipeSegments.length; i++) {
    const base = extractBaseCommand(pipeSegments[i]);
    if (base === 'rm') return true;
  }
  return false;
}

function hasCurlWgetWrite(segment: string): boolean {
  const base = extractBaseCommand(segment);
  if (base !== 'curl' && base !== 'wget') return false;
  return /(-o\s+|--output\s+|-O\s)/.test(segment);
}

function classifySegment(segment: string): CommandClassification {
  const trimmed = segment.trim();
  if (!trimmed) return 'auto';

  for (const pattern of DENY_PATTERNS) {
    if (pattern.test(trimmed)) return 'deny';
  }

  const base = extractBaseCommand(trimmed);
  const sub = extractSubcommand(trimmed);

  if (base === 'rm' && /-[a-zA-Z]*r[a-zA-Z]*f/.test(trimmed.split(/\s+/)[0] || '')) {
    if (/\s+\//.test(trimmed) || /\s+[Cc]:\/?/.test(trimmed)) return 'deny';
  }

  if (hasPipeToRm(trimmed)) return 'confirm';

  if (AUTO_COMMANDS.has(base)) {
    if (base === 'git') {
      if (sub && AUTO_GIT_SUBCOMMANDS.has(sub)) return 'auto';
      if (sub && CONFIRM_GIT_SUBCOMMANDS.has(sub)) return 'confirm';
      if (sub) return 'confirm';
      return 'auto';
    }
    if (base === 'npm') {
      if (sub && AUTO_NPM_SUBCOMMANDS.has(sub)) return 'auto';
      if (sub && CONFIRM_NPM_SUBCOMMANDS.has(sub)) return 'confirm';
      if (!sub) return 'auto';
      return 'confirm';
    }
    if (base === 'npx') {
      if (sub && CONFIRM_NPX_SUBCOMMANDS.has(sub)) return 'confirm';
      if (sub && AUTO_BUILD_TOOLS.has(sub)) return 'auto';
      return 'auto';
    }
    if (base === 'pnpm') {
      if (sub && AUTO_PNPM_SUBCOMMANDS.has(sub)) return 'auto';
      if (sub && CONFIRM_PNPM_SUBCOMMANDS.has(sub)) return 'confirm';
      if (!sub) return 'auto';
      return 'confirm';
    }
    if (base === 'node') {
      if (sub === '--version') return 'auto';
      return 'confirm';
    }
    return 'auto';
  }

  if (CONFIRM_COMMANDS.has(base)) {
    if (base === 'docker') {
      if (sub && CONFIRM_DOCKER_SUBCOMMANDS.has(sub)) return 'confirm';
      if (sub) return 'confirm';
      return 'confirm';
    }
    if (hasCurlWgetWrite(trimmed)) return 'confirm';
    if (base === 'curl' || base === 'wget') return 'auto';
    if (base === 'apt' || base === 'yum' || base === 'brew') {
      if (sub === 'install') return 'confirm';
      return 'auto';
    }
    return 'confirm';
  }

  return 'confirm';
}

export function classifyCommand(command: string): CommandClassification {
  const segments = command.split(/\||&&|;/);

  for (const segment of segments) {
    const result = classifySegment(segment);
    if (result === 'deny') return 'deny';
  }

  for (const segment of segments) {
    const result = classifySegment(segment);
    if (result === 'confirm') return 'confirm';
  }

  return 'auto';
}
