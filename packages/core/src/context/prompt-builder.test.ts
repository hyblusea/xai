import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from './prompt-builder.js';
import type { ToolDefinition } from '@xai/shared';

const mockTools: ToolDefinition[] = [
  {
    name: 'read_file',
    description: 'Read the contents of a file.',
    parameters: {
      path: { type: 'string', description: 'Path to the file', required: true, location: 'header' },
    },
    confirmationRequired: false,
    examples: [
      `++++ read_file path:./src/app.ts
++++ end`,
    ],
  },
  {
    name: 'write_to_file',
    description: 'Write content to a file.',
    parameters: {
      path: { type: 'string', description: 'Path to the file', required: true, location: 'header' },
      content: { type: 'string', description: 'Content to write', required: true, location: 'body' },
    },
    confirmationRequired: true,
    examples: [
      `++++ write_to_file path:./src/new.ts
entire file content here
++++ end`,
    ],
  },
  {
    name: 'replace_in_file',
    description: 'Edit a file by replacing specific lines.',
    parameters: {
      path: { type: 'string', description: 'Path to the file', required: true, location: 'header' },
      search: { type: 'string', description: 'Text to search for', location: 'body' },
      replace: { type: 'string', description: 'Text to replace with', location: 'body' },
    },
    confirmationRequired: false,
    examples: [
      `++++ replace_in_file path:./src/app.ts
old code
====
new code
++++ end`,
    ],
  },
];

describe('buildSystemPrompt', () => {
  it('should include identity section', () => {
    const prompt = buildSystemPrompt(mockTools, '/workspace');
    expect(prompt).toContain('AI coding assistant');
  });

  it('should include command block format hint', () => {
    const prompt = buildSystemPrompt(mockTools, '/workspace');
    expect(prompt).toContain('++++ command blocks');
    expect(prompt).toContain('++++ end');
  });

  it('should NOT include hardcoded tool examples in format section', () => {
    const prompt = buildSystemPrompt(mockTools, '/workspace');
    const formatSection = prompt.split('## AVAILABLE TOOL COMMANDS')[0];
    expect(formatSection).not.toContain('### write_to_file');
    expect(formatSection).not.toContain('### read_file');
    expect(formatSection).not.toContain('Examples:');
  });

  it('should NOT include hardcoded format examples', () => {
    const prompt = buildSystemPrompt(mockTools, '/workspace');
    const beforeTools = prompt.split('## AVAILABLE TOOL COMMANDS')[0];
    expect(beforeTools).not.toContain('++++ replace_in_file path:./src/app.ts');
    expect(beforeTools).not.toContain('Do NOT use JSON');
  });

  it('should include AVAILABLE TOOL COMMANDS section', () => {
    const prompt = buildSystemPrompt(mockTools, '/workspace');
    expect(prompt).toContain('## AVAILABLE TOOL COMMANDS');
  });

  it('should include Parameters section in reference section', () => {
    const prompt = buildSystemPrompt(mockTools, '/workspace');
    expect(prompt).toContain('Parameters:');
    expect(prompt).toContain('[body]');
  });

  it('should put path in params and content as body param', () => {
    const prompt = buildSystemPrompt(mockTools, '/workspace');
    const refSection = prompt.split('## AVAILABLE TOOL COMMANDS')[1];
    const writeSection = refSection?.split('### write_to_file')[1]?.split('###')[0];
    expect(writeSection).toContain('Parameters:');
    expect(writeSection).toContain('path');
    expect(writeSection).toContain('[body]');
    expect(writeSection).toContain('content');
  });

  it('should mark search/replace as body params for replace_in_file', () => {
    const prompt = buildSystemPrompt(mockTools, '/workspace');
    const refSection = prompt.split('## AVAILABLE TOOL COMMANDS')[1];
    const replaceSection = refSection?.split('### replace_in_file')[1]?.split('###')[0];
    expect(replaceSection).toContain('Parameters:');
    expect(replaceSection).toContain('path');
    expect(replaceSection).toContain('search');
    expect(replaceSection).toContain('replace');
    expect(replaceSection).toContain('[body]');
  });

  it('should include examples from tool definitions in reference section', () => {
    const prompt = buildSystemPrompt(mockTools, '/workspace');
    const refSection = prompt.split('## AVAILABLE TOOL COMMANDS')[1];
    expect(refSection).toContain('Examples:');
    expect(refSection).toContain('++++ read_file path:./src/app.ts');
    expect(refSection).toContain('++++ end');
    expect(refSection).toContain('++++ write_to_file path:./src/new.ts');
    expect(refSection).toContain('++++ replace_in_file path:./src/app.ts');
  });

  it('should include workspace path', () => {
    const prompt = buildSystemPrompt(mockTools, '/my/project');
    expect(prompt).toContain('/my/project');
  });

  it('should handle empty tools list', () => {
    const prompt = buildSystemPrompt([], '/workspace');
    expect(prompt).toContain('None');
  });
});


