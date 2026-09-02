import { describe, it, expect } from 'vitest';

/**
 * processCarriageReturns - same logic as in execute-command.ts and App.tsx
 * Extracted here for unit testing since the original is a private method.
 */
function processCarriageReturns(text: string): string {
  const lines: string[] = [];
  for (const segment of text.split('\n')) {
    let currentLine = '';
    for (const part of segment.split('\r')) {
      if (part.length >= currentLine.length) {
        currentLine = part;
      } else {
        currentLine = part + currentLine.slice(part.length);
      }
    }
    lines.push(currentLine);
  }
  return lines.join('\n');
}

describe('processCarriageReturns', () => {
  it('should return unchanged text without \\r', () => {
    expect(processCarriageReturns('hello world')).toBe('hello world');
  });

  it('should return empty string for empty input', () => {
    expect(processCarriageReturns('')).toBe('');
  });

  // ---- curl progress bar simulation ----

  it('should collapse curl-style progress updates into the last frame', () => {
    // Simulates curl output: each \r overwrites the previous progress line
    const raw =
      '  0     0    0     0    0     0      0      0 --:--:-- --:--:-- --:--:--     0\r' +
      '100    99  100    99    0     0    310      0 --:--:-- --:--:-- --:--:--   312\r' +
      '  1 4635k    1 59847    0     0  37047      0  0:02:08  0:00:01  0:02:07 59137';

    const result = processCarriageReturns(raw);
    // Should only contain the last frame
    expect(result).toBe('  1 4635k    1 59847    0     0  37047      0  0:02:08  0:00:01  0:02:07 59137');
    // Should NOT contain earlier frames
    expect(result).not.toContain('--:--:-- --:--:-- --:--:--     0');
    expect(result).not.toContain('100    99');
  });

  it('should handle curl progress with trailing \\r\\n and DONE message', () => {
    const raw =
      '  0     0    0     0    0     0      0      0 --:--:-- --:--:-- --:--:--     0\r' +
      '100   256  100   256    0     0    650      0 --:--:-- --:--:-- --:--:--   650\r\n' +
      'DONE';

    const result = processCarriageReturns(raw);
    expect(result).toContain('100   256  100   256');
    expect(result).toContain('DONE');
    expect(result).not.toContain('--:--:-- --:--:-- --:--:--     0');
  });

  // ---- wget progress bar simulation ----

  it('should handle wget-style progress with \\r overwrites', () => {
    const raw =
      '      0K .......... .......... .......... .......... ..........   0%\r' +
      '     50K .......... .......... .......... .......... ..........  25%\r' +
      '    100K .......... .......... .......... .......... ..........  50%';

    const result = processCarriageReturns(raw);
    expect(result).toContain('50%');
    expect(result).not.toContain('25%');
    expect(result).not.toContain('0% ');
  });

  // ---- npm/pip install progress simulation ----

  it('should handle pip-style download progress bar', () => {
    const raw =
      'Downloading example-1.0.tar.gz (2.5 MB)\r' +
      'Downloading example-1.0.tar.gz (2.5 MB): 1.0 MB\r' +
      'Downloading example-1.0.tar.gz (2.5 MB): 2.0 MB\r' +
      'Downloading example-1.0.tar.gz (2.5 MB): 2.5 MB';

    const result = processCarriageReturns(raw);
    expect(result).toBe('Downloading example-1.0.tar.gz (2.5 MB): 2.5 MB');
  });

  // ---- Short overwrite (partial line) ----

  it('should handle partial line overwrite: shorter text overwrites longer', () => {
    // In a real terminal: "hello\rab" displays "abllo"
    const raw = 'hello\rab';
    const result = processCarriageReturns(raw);
    expect(result).toBe('abllo');
  });

  it('should handle partial line overwrite: same-length text', () => {
    const raw = 'hello\rworld';
    const result = processCarriageReturns(raw);
    expect(result).toBe('world');
  });

  // ---- Multiple lines with \\r\\n ----

  it('should handle \\r\\n as line break (standard Windows line ending)', () => {
    const raw = 'line1\r\nline2\r\nline3';
    const result = processCarriageReturns(raw);
    expect(result).toBe('line1\nline2\nline3');
  });

  // ---- Mixed: some lines with \\r, some without ----

  it('should handle mixed output: progress lines + normal lines', () => {
    const raw =
      'Processing file...\r' +
      'Processing file... 50%\r' +
      'Processing file... 100%\r\n' +
      'Done!';

    const result = processCarriageReturns(raw);
    expect(result).toContain('Processing file... 100%');
    expect(result).toContain('Done!');
    expect(result).not.toContain('50%');
  });

  // ---- Edge cases ----

  it('should handle lone \\r', () => {
    expect(processCarriageReturns('\r')).toBe('');
  });

  it('should handle \\r at end of text', () => {
    expect(processCarriageReturns('hello\r')).toBe('hello');
  });

  it('should handle multiple \\r in sequence', () => {
    expect(processCarriageReturns('\r\r\r')).toBe('');
  });

  it('should handle \\r\\n\\r\\n (two Windows line endings)', () => {
    // \r\n\r\n = two CRLF = two newlines
    expect(processCarriageReturns('\r\n\r\n')).toBe('\n\n');
  });

  // ---- git clone progress simulation ----

  it('should handle git clone style progress', () => {
    // "Cloning into" is a permanent line (ends with \n), not overwritten by \r
    const raw =
      'Cloning into \'repo\'...\n' +
      'remote: Enumerating objects: 42, done.\r\n' +
      'remote: Counting objects:  10% (5/42)\r' +
      'remote: Counting objects:  50% (21/42)\r' +
      'remote: Counting objects: 100% (42/42)\r\n' +
      'Receiving objects: 100% (42/42), done.';

    const result = processCarriageReturns(raw);
    expect(result).toContain('Cloning into \'repo\'...');
    expect(result).toContain('Counting objects: 100% (42/42)');
    expect(result).toContain('Receiving objects: 100% (42/42), done.');
    // Earlier progress should be overwritten
    expect(result).not.toContain('10%');
    expect(result).not.toContain('50%');
  });

  // ---- docker pull progress simulation ----

  it('should handle docker pull style progress with multiple \\r lines', () => {
    const raw =
      'a1b2c3d4e5f6: Downloading [=>                                                 ]     512B/5.5MB\r' +
      'a1b2c3d4e5f6: Downloading [========>                                         ]  1.024MB/5.5MB\r' +
      'a1b2c3d4e5f6: Downloading [================>                                 ]  2.048MB/5.5MB\r' +
      'a1b2c3d4e5f6: Download complete';

    const result = processCarriageReturns(raw);
    expect(result).toContain('Download complete');
    expect(result).not.toContain('512B/5.5MB');
    expect(result).not.toContain('1.024MB/5.5MB');
  });
});
