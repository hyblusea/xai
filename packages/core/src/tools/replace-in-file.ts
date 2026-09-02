import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { ToolDefinition } from '@xai/shared';
import { BaseTool } from './base-tool.js';

export class ReplaceInFileTool extends BaseTool {
  private workspacePath: string;

  constructor(workspacePath: string) {
    super();
    this.workspacePath = workspacePath;
  }

  get definition(): ToolDefinition {
    return {
      name: 'replace_in_file',
      description: 'Find exact text in file and replace. Use ==== separator between search and replace. Returns diff.',
      parameters: {
        path: { type: 'string', description: 'File path (relative or absolute)', required: true, location: 'header' },
        search: { type: 'string', description: 'Text to find', required: true, location: 'body' },
        replace: { type: 'string', description: 'Replacement text', required: true, location: 'body' },
        replaceAll: { type: 'boolean', description: 'Replace all occurrences', location: 'header' },
      },
      confirmationRequired: false,
      contentMode: 'native',
      examples: [
        `++++ replace_in_file path:./src/app.ts
old code to find
====
new code to replace
++++ end`,
      ],
    };
  }

  /**
   * `replace_in_file` declares TWO body parameters (`search` and `replace`),
   * which the default schema parser can't handle. We split the body on a
   * standalone `====` line instead, matching the existing on-the-wire format.
   */
  override parseBlockParams(rawHeaderLine: string, body: string): Record<string, unknown> | null {
    const params: Record<string, unknown> = {};

    // Pull header params (e.g. `path:./src/app.ts`, `replaceAll:true`) using
    // the same name-based scan as the default parser, but only for the
    // parameters this tool actually declares in its header.
    const headerNames = Object.entries(this.definition.parameters)
      .filter(([, p]) => p.location !== 'body')
      .map(([n]) => n);

    const headerParamsPart = rawHeaderLine.replace(/^\s*\+\+\+\+\s+\S+/, '').trim();
    for (let i = 0; i < headerNames.length; i++) {
      const name = headerNames[i];
      const next = headerNames[i + 1];
      const keyRegex = new RegExp(`(?:^|\\s)${escapeRegex(name)}:`, '');
      const match = keyRegex.exec(headerParamsPart);
      if (!match) continue;
      const valueStart = match.index + match[0].length;
      let valueEnd = headerParamsPart.length;
      if (next) {
        const nextRegex = new RegExp(`(?:^|\\s)${escapeRegex(next)}:`, '');
        nextRegex.lastIndex = valueStart;
        const nextMatch = nextRegex.exec(headerParamsPart);
        if (nextMatch && nextMatch.index < valueEnd) {
          valueEnd = nextMatch.index;
        }
      }
      const raw = headerParamsPart.substring(valueStart, valueEnd).trim();
      const paramDef = this.definition.parameters[name];
      if (paramDef?.type === 'boolean') {
        const v = raw.toLowerCase();
        if (v === 'true' || v === '1') params[name] = true;
        else if (v === 'false' || v === '0') params[name] = false;
      } else {
        params[name] = raw;
      }
    }

    // Split body on the first standalone `====` line.
    const sepIndex = this.findReplaceSeparator(body);
    if (sepIndex === -1) {
      // No separator: cannot determine search/replace.
      return null;
    }
    const searchContent = body.substring(0, sepIndex).trimEnd();
    let replaceRaw = body.substring(sepIndex + 4); // length of "===="
    if (replaceRaw.startsWith('\n')) replaceRaw = replaceRaw.substring(1);
    const replaceContent = replaceRaw.trimEnd();

    params['search'] = searchContent;
    params['replace'] = replaceContent;

    // Required-params check
    for (const [name, paramDef] of Object.entries(this.definition.parameters)) {
      if (!paramDef.required) continue;
      const v = params[name];
      if (v === undefined || v === null || v === '') return null;
    }
    return params;
  }

  private findReplaceSeparator(body: string): number {
    let searchIndex = 0;
    while (searchIndex < body.length) {
      const idx = body.indexOf('====', searchIndex);
      if (idx === -1) return -1;
      const lineStart = idx === 0 || body[idx - 1] === '\n' || body[idx - 1] === '\r';
      if (lineStart) {
        const after = idx + 4;
        const tail = body[after];
        if (tail === undefined || tail === '\n' || tail === '\r' || tail === ' ' || tail === '\t') {
          return idx;
        }
      }
      searchIndex = idx + 4;
    }
    return -1;
  }

  async _execute(params: Record<string, unknown>, _signal?: AbortSignal) {
    const start = Date.now();
    try {
      const filePath = this.resolvePath(params.path as string);

      if (!existsSync(filePath)) {
        return this.fail(`File not found: ${filePath}`, Date.now() - start);
      }

      const originalContent = await readFile(filePath, 'utf-8');
      let newContent: string;
      let matchCount: number;

      const searchStr = params.search as string;
      const replaceStr = params.replace as string;
      const replaceAll = (params.replaceAll as boolean) ?? false;

      if (searchStr == null || searchStr === '') {
        return this.fail('Search string cannot be empty', Date.now() - start);
      }
      // replace === '' is a legitimate value (deletion), so only reject
      // undefined/null — this is what previously caused the
      // "Cannot read properties of undefined (reading 'trimEnd')" crash.
      if (replaceStr === undefined || replaceStr === null) {
        return this.fail(
          "Replace string is required (use an empty string '' to delete the matched text). " +
            `Received params: ${JSON.stringify(Object.keys(params))}`,
          Date.now() - start,
        );
      }

      const searchResult = this.replaceBySearch(originalContent, searchStr, replaceStr, replaceAll);
      if (!searchResult) {
        const preview = searchStr.length > 200 ? searchStr.substring(0, 200) + '...' : searchStr;
        const suggestions = this.findSimilarContent(originalContent, searchStr);
        let errorMsg = `Search string not found in file: ${path.relative(this.workspacePath, filePath)}`;
        errorMsg += `\n\n--- Your search text ---\n${preview}`;
        if (suggestions.length > 0) {
          errorMsg += `\n\n--- Did you mean? (similar content found) ---\n`;
          for (const s of suggestions) {
            errorMsg += `\nLine ${s.line}: ${s.text}\n`;
          }
          errorMsg += `\nPlease read the file first to get the exact content, then retry.`;
        } else {
          errorMsg += `\n\nNo similar content found. Please read the file first to verify the exact text to replace.`;
        }
        return this.fail(errorMsg, Date.now() - start);
      }
      newContent = searchResult.content;
      matchCount = searchResult.count;

      if (newContent === originalContent) {
        return this.fail('No changes made - replacement produces identical content', Date.now() - start);
      }

      await writeFile(filePath, newContent, 'utf-8');

      const originalLines = originalContent.split('\n').length;
      const newLines = newContent.split('\n').length;
      const relativePath = path.relative(this.workspacePath, filePath);
      let output = `Replaced ${matchCount} occurrence(s) in: ${relativePath}\nLines: ${originalLines} → ${newLines}`;

      output += '\n\n--- Changes ---\n';
      const diff = this.generateDiff(originalContent, newContent, relativePath);
      output += diff;

      output += '\n\n--- Context After Change ---\n';
      const contextOutput = this.generateContextAfterChange(newContent, params, originalContent);
      output += contextOutput;

      return this.success(output, Date.now() - start);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('EACCES') || message.includes('EPERM')) {
        return this.fail(`Permission denied: ${params.path}`, Date.now() - start);
      }
      // Distinguish programming errors (TypeError, missing fields, etc.)
      // from genuine file-operation failures, so callers don't get
      // misleading "Failed to replace in file" wrappers for bugs.
      const isTypeError =
        error instanceof TypeError ||
        message.startsWith("Cannot read properties of") ||
        message.includes('is not a function');
      const reason = isTypeError
        ? `Internal tool error (likely invalid params): ${message}. ` +
          `Received params: ${JSON.stringify(Object.keys(params))}`
        : `Failed to replace in file: ${message}`;
      return this.fail(reason, Date.now() - start);
    }
  }

  private resolvePath(inputPath: string): string {
    if (path.isAbsolute(inputPath)) {
      return path.normalize(inputPath);
    }
    return path.resolve(this.workspacePath, inputPath);
  }

  private replaceBySearch(
    content: string,
    search: string,
    replace: string,
    replaceAll: boolean,
  ): { content: string; count: number } | null {
    // 1. Fuzzy-first: line-level semantics are more intuitive
    //    Internally tries strict line match first, then trimEnd tolerance
    const fuzzyResult = this.tryFuzzyReplace(content, search, replace, replaceAll);
    if (fuzzyResult) return fuzzyResult;

    // 2. Exact substring fallback: handles intra-line replacements
    return this.exactReplace(content, search, replace, replaceAll);
  }

  private exactReplace(
    content: string,
    search: string,
    replace: string,
    replaceAll: boolean,
  ): { content: string; count: number } | null {
    if (replaceAll) {
      const occurrences = this.countOccurrences(content, search);
      if (occurrences === 0) return null;
      return { content: content.split(search).join(replace), count: occurrences };
    } else {
      const index = content.indexOf(search);
      if (index === -1) return null;
      return {
        content: content.slice(0, index) + replace + content.slice(index + search.length),
        count: 1,
      };
    }
  }

  private countOccurrences(content: string, search: string): number {
    let count = 0;
    let pos = 0;
    while ((pos = content.indexOf(search, pos)) !== -1) {
      count++;
      pos += search.length;
    }
    return count;
  }

  /**
   * Smart trimEnd: if the search line has intentional trailing whitespace, preserve it;
   * otherwise use regular trimEnd for fuzzy tolerance.
   */
  private smartTrimEnd(line: string): string {
    const trimmed = line.trimEnd();
    return (trimmed.length < line.length) ? line : trimmed;
  }

  private tryFuzzyReplace(
    content: string,
    search: string,
    replace: string,
    replaceAll: boolean,
  ): { content: string; count: number } | null {
    const contentLines = content.split('\n');

    // Use smartTrimEnd: preserves intentional trailing WS, trims otherwise
    const searchLines = search.split('\n').map(l => this.smartTrimEnd(l));

    let sStart = 0;
    while (sStart < searchLines.length && searchLines[sStart] === '') sStart++;
    let sEnd = searchLines.length;
    while (sEnd > sStart && searchLines[sEnd - 1] === '') sEnd--;

    const effectiveSearchLines = searchLines.slice(sStart, sEnd);
    if (effectiveSearchLines.length === 0) return null;

    const replaceText = replace.trimEnd();
    const replaceLines = replaceText.split('\n');

    if (!replaceAll) {
      // Pass 1: strict comparison using smartTrimEnd search lines
      const contentStrict = contentLines.map(l => l.replace(/\r$/, ''));
      let matchRange = this.findFuzzyMatchRange(contentLines, contentStrict, effectiveSearchLines);

      // Pass 2: fallback to trimEnd tolerance
      if (!matchRange) {
        const trimmedContentLines = contentLines.map(l => l.trimEnd());
        const trimmedSearch = effectiveSearchLines.map(l => l.trimEnd());
        matchRange = this.findFuzzyMatchRange(contentLines, trimmedContentLines, trimmedSearch);
      }
      if (!matchRange) return null;

      const { matchIdx, indentDelta, originalIndentStr } = matchRange;

      // Detect CRLF: check if original first matched line has \r
      const hasCRLF = contentLines[matchIdx].endsWith('\r');

      const adjustedReplaceLines = replaceLines.map(line => {
        let adjusted = line;
        if (indentDelta !== 0) {
          if (adjusted.trim().length === 0) return hasCRLF ? adjusted + '\r' : adjusted;
          adjusted = originalIndentStr + adjusted.trimStart();
        }
        // Preserve CRLF line ending
        if (hasCRLF) adjusted += '\r';
        return adjusted;
      });

      const resultLines = [
        ...contentLines.slice(0, matchIdx),
        ...adjustedReplaceLines,
        ...contentLines.slice(matchIdx + effectiveSearchLines.length),
      ];

      return { content: resultLines.join('\n'), count: 1 };
    } else {
      let matches: number[] = [];
      let searchFrom = 0;

      // Pass 1: strict comparison using smartTrimEnd search lines
      const contentStrict = contentLines.map(l => l.replace(/\r$/, ''));
      while (searchFrom <= contentStrict.length - effectiveSearchLines.length) {
        const idx = this.findLineRangeMatch(contentStrict, effectiveSearchLines, searchFrom);
        if (idx === -1) break;
        matches.push(idx);
        searchFrom = idx + effectiveSearchLines.length;
      }

      // Pass 2: fallback to trimEnd tolerance
      if (matches.length === 0) {
        const trimmedContentLines = contentLines.map(l => l.trimEnd());
        const trimmedSearch = effectiveSearchLines.map(l => l.trimEnd());
        searchFrom = 0;
        while (searchFrom <= trimmedContentLines.length - trimmedSearch.length) {
          const idx = this.findLineRangeMatch(trimmedContentLines, trimmedSearch, searchFrom);
          if (idx === -1) break;
          matches.push(idx);
          searchFrom = idx + trimmedSearch.length;
        }
      }

      // Pass 3: fully trimmed fallback
      if (matches.length === 0) {
        const fullyTrimmedContent = contentLines.map(l => l.trim());
        const fullyTrimmedSearch = effectiveSearchLines.map(l => l.trim());
        searchFrom = 0;
        while (searchFrom <= fullyTrimmedContent.length - fullyTrimmedSearch.length) {
          const idx = this.findLineRangeMatch(fullyTrimmedContent, fullyTrimmedSearch, searchFrom);
          if (idx === -1) break;
          matches.push(idx);
          searchFrom = idx + fullyTrimmedSearch.length;
        }
      }

      if (matches.length === 0) return null;

      const resultLines = [...contentLines];
      for (let i = matches.length - 1; i >= 0; i--) {
        const idx = matches[i];
        const originalLine = contentLines[idx];
        const originalIndentStr = originalLine.substring(0, originalLine.length - originalLine.trimStart().length);
        const searchIndent = effectiveSearchLines[0].length - effectiveSearchLines[0].trimStart().length;
        const indentDelta = originalIndentStr.length - searchIndent;
        const hasCRLF = originalLine.endsWith('\r');

        const adjustedReplace = replaceLines.map(line => {
          let adjusted = line;
          if (indentDelta !== 0) {
            if (adjusted.trim().length === 0) return hasCRLF ? adjusted + '\r' : adjusted;
            adjusted = originalIndentStr + adjusted.trimStart();
          }
          if (hasCRLF) adjusted += '\r';
          return adjusted;
        });

        resultLines.splice(idx, effectiveSearchLines.length, ...adjustedReplace);
      }

      return { content: resultLines.join('\n'), count: matches.length };
    }
  }

  private findFuzzyMatchRange(
    contentLines: string[],
    trimmedContentLines: string[],
    effectiveSearchLines: string[],
  ): { matchIdx: number; indentDelta: number; originalIndentStr: string } | null {
    let matchIdx = this.findLineRangeMatch(trimmedContentLines, effectiveSearchLines, 0);

    if (matchIdx !== -1) {
      const originalLine = contentLines[matchIdx];
      const originalIndentStr = originalLine.substring(0, originalLine.length - originalLine.trimStart().length);
      const searchIndent = effectiveSearchLines[0].length - effectiveSearchLines[0].trimStart().length;
      const indentDelta = originalIndentStr.length - searchIndent;
      return { matchIdx, indentDelta, originalIndentStr };
    }

    const fullyTrimmedContent = contentLines.map(l => l.trim());
    const fullyTrimmedSearch = effectiveSearchLines.map(l => l.trim());
    matchIdx = this.findLineRangeMatch(fullyTrimmedContent, fullyTrimmedSearch, 0);

    if (matchIdx !== -1) {
      const originalLine = contentLines[matchIdx];
      const originalIndentStr = originalLine.substring(0, originalLine.length - originalLine.trimStart().length);
      const searchIndent = effectiveSearchLines[0].length - effectiveSearchLines[0].trimStart().length;
      const indentDelta = originalIndentStr.length - searchIndent;
      return { matchIdx, indentDelta, originalIndentStr };
    }

    return null;
  }

  private findLineRangeMatch(contentLines: string[], searchLines: string[], fromIndex: number): number {
    for (let i = fromIndex; i <= contentLines.length - searchLines.length; i++) {
      let match = true;
      for (let j = 0; j < searchLines.length; j++) {
        if (contentLines[i + j] !== searchLines[j]) {
          match = false;
          break;
        }
      }
      if (match) return i;
    }
    return -1;
  }

  private generateDiff(original: string, modified: string, filePath: string): string {
    const oLines = original.split('\n');
    const mLines = modified.split('\n');

    const MAX_LCS_SIZE = 3000;
    const useLCS = oLines.length <= MAX_LCS_SIZE && mLines.length <= MAX_LCS_SIZE;

    const editOps = useLCS
      ? this.computeEditOpsLCS(oLines, mLines)
      : this.computeEditOpsPrefixSuffix(oLines, mLines);

    const hunks = this.buildHunksFromEditOps(editOps, oLines, mLines);

    if (hunks.length === 0) return '';

    const result: string[] = [];
    result.push(`--- a/${filePath}`);
    result.push(`+++ b/${filePath}`);

    for (const hunk of hunks) {
      result.push(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`);
      result.push(...hunk.lines);
    }

    return result.join('\n');
  }

  private computeEditOpsLCS(oLines: string[], mLines: string[]): Array<'equal' | 'delete' | 'insert'> {
    const m = oLines.length;
    const n = mLines.length;

    const dp: number[][] = [];
    for (let i = 0; i <= m; i++) {
      dp[i] = new Array(n + 1).fill(0);
    }

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (oLines[i - 1] === mLines[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
      }
    }

    const ops: Array<'equal' | 'delete' | 'insert'> = [];
    let i = m, j = n;

    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && oLines[i - 1] === mLines[j - 1]) {
        ops.push('equal');
        i--;
        j--;
      } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
        ops.push('insert');
        j--;
      } else {
        ops.push('delete');
        i--;
      }
    }

    ops.reverse();
    return ops;
  }

  private computeEditOpsPrefixSuffix(oLines: string[], mLines: string[]): Array<'equal' | 'delete' | 'insert'> {
    let prefixLen = 0;
    while (prefixLen < oLines.length && prefixLen < mLines.length && oLines[prefixLen] === mLines[prefixLen]) {
      prefixLen++;
    }

    let suffixLen = 0;
    const maxSuffix = Math.min(oLines.length - prefixLen, mLines.length - prefixLen);
    while (suffixLen < maxSuffix && oLines[oLines.length - 1 - suffixLen] === mLines[mLines.length - 1 - suffixLen]) {
      suffixLen++;
    }

    const ops: Array<'equal' | 'delete' | 'insert'> = [];
    for (let i = 0; i < prefixLen; i++) ops.push('equal');
    for (let i = prefixLen; i < oLines.length - suffixLen; i++) ops.push('delete');
    for (let i = prefixLen; i < mLines.length - suffixLen; i++) ops.push('insert');
    for (let i = 0; i < suffixLen; i++) ops.push('equal');

    return ops;
  }

  private buildHunksFromEditOps(
    ops: Array<'equal' | 'delete' | 'insert'>,
    oLines: string[],
    mLines: string[],
  ): Array<{ oldStart: number; oldCount: number; newStart: number; newCount: number; lines: string[] }> {
    const contextSize = 3;

    const oIndices: number[] = [];
    const mIndices: number[] = [];
    let curO = 0, curM = 0;
    for (const op of ops) {
      oIndices.push(curO);
      mIndices.push(curM);
      if (op === 'equal') { curO++; curM++; }
      else if (op === 'delete') { curO++; }
      else { curM++; }
    }
    oIndices.push(curO);
    mIndices.push(curM);

    interface ChangeRegion {
      opStart: number;
      opEnd: number;
      oldStart: number;
      newStart: number;
    }

    const changes: ChangeRegion[] = [];
    let inChange = false;
    let changeStart = 0;
    let changeOStart = 0;
    let changeMStart = 0;

    for (let i = 0; i < ops.length; i++) {
      if (ops[i] !== 'equal') {
        if (!inChange) {
          changeStart = i;
          changeOStart = oIndices[i];
          changeMStart = mIndices[i];
          inChange = true;
        }
      } else {
        if (inChange) {
          changes.push({ opStart: changeStart, opEnd: i, oldStart: changeOStart, newStart: changeMStart });
          inChange = false;
        }
      }
    }
    if (inChange) {
      changes.push({ opStart: changeStart, opEnd: ops.length, oldStart: changeOStart, newStart: changeMStart });
    }

    if (changes.length === 0) return [];

    const mergedChanges: ChangeRegion[] = [changes[0]];
    for (let i = 1; i < changes.length; i++) {
      const last = mergedChanges[mergedChanges.length - 1];
      const gap = changes[i].opStart - last.opEnd;
      if (gap <= 2 * contextSize) {
        last.opEnd = changes[i].opEnd;
      } else {
        mergedChanges.push(changes[i]);
      }
    }

    const hunks: Array<{ oldStart: number; oldCount: number; newStart: number; newCount: number; lines: string[] }> = [];

    for (const change of mergedChanges) {
      const hunkOpStart = Math.max(0, change.opStart - contextSize);
      const hunkOpEnd = Math.min(ops.length, change.opEnd + contextSize);

      const hunkOldStart = oIndices[hunkOpStart];
      const hunkNewStart = mIndices[hunkOpStart];

      const diffLines: string[] = [];
      let oI = hunkOldStart;
      let mI = hunkNewStart;

      for (let i = hunkOpStart; i < hunkOpEnd; i++) {
        if (ops[i] === 'equal') {
          diffLines.push(` ${oLines[oI]}`);
          oI++;
          mI++;
        } else if (ops[i] === 'delete') {
          diffLines.push(`-${oLines[oI]}`);
          oI++;
        } else {
          diffLines.push(`+${mLines[mI]}`);
          mI++;
        }
      }

      let oldCount = 0, newCount = 0;
      for (const line of diffLines) {
        if (line[0] === ' ' || line[0] === '-') oldCount++;
        if (line[0] === ' ' || line[0] === '+') newCount++;
      }

      hunks.push({
        oldStart: hunkOldStart + 1,
        oldCount,
        newStart: hunkNewStart + 1,
        newCount,
        lines: diffLines,
      });
    }

    return hunks;
  }

  private generateContextAfterChange(
    newContent: string,
    params: Record<string, unknown>,
    originalContent: string,
  ): string {
    const lines = newContent.split('\n');
    const totalLines = lines.length;
    const contextPadding = 2;

    const searchStr = params.search as string;
    const replaceStr = params.replace as string;
    const replaceAll = (params.replaceAll as boolean) ?? false;

    const searchLineCount = searchStr.split('\n').length;
    const replaceLineCount = replaceStr.split('\n').length;
    const lineDelta = replaceLineCount - searchLineCount;

    if (replaceAll) {
      const originalLines = originalContent.split('\n');
      const occurrences: number[] = [];
      for (let i = 0; i < originalLines.length; i++) {
        if (originalLines[i].includes(searchStr.split('\n')[0])) {
          occurrences.push(i + 1);
        }
      }
      if (occurrences.length === 0) return '(no context available)';
      const firstOccurrence = occurrences[0];
      const affectedEnd = firstOccurrence + lineDelta + replaceLineCount - 1;
      return this.formatContextLines(lines, totalLines, firstOccurrence, affectedEnd, contextPadding);
    }

    const originalLines = originalContent.split('\n');
    const searchFirstLine = searchStr.split('\n')[0];
    let matchLine = -1;
    for (let i = 0; i < originalLines.length; i++) {
      if (originalLines[i].includes(searchFirstLine)) {
        matchLine = i + 1;
        break;
      }
    }
    if (matchLine === -1) return '(no context available)';
    const affectedEnd = matchLine + lineDelta + replaceLineCount - 1;
    return this.formatContextLines(lines, totalLines, matchLine, affectedEnd, contextPadding);
  }

  private formatContextLines(
    lines: string[],
    totalLines: number,
    affectedStart: number,
    affectedEnd: number,
    padding: number,
  ): string {
    const displayStart = Math.max(1, affectedStart - padding);
    const displayEnd = Math.min(totalLines, affectedEnd + padding);
    const maxLineNumWidth = String(displayEnd).length;

    const result: string[] = [];
    for (let i = displayStart; i <= displayEnd; i++) {
      const lineNum = String(i).padStart(maxLineNumWidth, ' ');
      const marker = (i >= affectedStart && i <= affectedEnd) ? '→' : ' ';
      result.push(`${lineNum}${marker}${lines[i - 1]}`);
    }
    return result.join('\n');
  }

  /**
   * Find lines in the file that are similar to the search text,
   * to help the AI understand what's actually in the file.
   */
  private findSimilarContent(content: string, search: string): { line: number; text: string }[] {
    const searchLines = search.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    if (searchLines.length === 0) return [];

    const contentLines = content.split('\n');
    const firstSearchLine = searchLines[0];
    const results: { line: number; text: string; score: number }[] = [];

    for (let i = 0; i < contentLines.length; i++) {
      const line = contentLines[i].trim();
      if (line.length === 0) continue;

      // Check if the first search line is a substring or vice versa
      if (line.includes(firstSearchLine) || firstSearchLine.includes(line)) {
        const contextLines = contentLines.slice(i, i + searchLines.length).map(l => l.trim());
        let matchCount = 0;
        for (let j = 0; j < searchLines.length && j < contextLines.length; j++) {
          if (contextLines[j].includes(searchLines[j]) || searchLines[j].includes(contextLines[j])) {
            matchCount++;
          }
        }
        const score = matchCount / searchLines.length;
        if (score > 0.3) {
          const text = contentLines.slice(i, i + Math.min(searchLines.length, 3)).join(' ').trim();
          results.push({ line: i + 1, text: text.length > 120 ? text.substring(0, 120) + '...' : text, score });
        }
      }
    }

    // Sort by score descending, return top 3
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, 3).map(r => ({ line: r.line, text: r.text }));
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
