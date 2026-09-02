import { ToolDefinition, ToolParameter, ToolResult, TOOL_OUTPUT_MAX_CHARS } from '@xai/shared';

/** 工具执行后的强制冷却时间（毫秒），防止工具结果瞬间返给 AI 导致请求过快触发限流。 */
const TOOL_COOLDOWN_MS = 100;

export abstract class BaseTool {
  abstract get definition(): ToolDefinition;

  /**
   * Execute the tool with the given parameters.
   * Subclasses implement the actual logic in `_execute()`.
   * This wrapper adds a post-execution cooldown sleep to slow down
   * the ReAct loop and prevent LLM rate-limit errors (429).
   */
  async execute(params: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    const result = await this._execute(params, signal);
    // 统一截断：超过 90KB 的输出在此处截断（截断标记计入预算，总长不超过阈值）。
    // 这是唯一截断点——AI 上下文与聊天气泡消费同一份 result.output，保证两侧内容一致。
    if (result.output && result.output.length > TOOL_OUTPUT_MAX_CHARS) {
      const marker = `\n... [truncated, ${result.output.length} chars total]`;
      result.output = result.output.substring(0, TOOL_OUTPUT_MAX_CHARS - marker.length) + marker;
    }
    // 工具执行完成后冷却，避免工具结果瞬间返给 AI → 下一轮请求太快 → 429
    // await new Promise(r => setTimeout(r, TOOL_COOLDOWN_MS));
    return result;
  }

  /** 实际的工具执行逻辑，由子类实现。 */
  protected abstract _execute(params: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>;

  /**
   * Parse the raw tool block (header line + body) into a parameters object.
   *
   * The default implementation reads the tool's `definition.parameters` schema
   * and uses parameter-name matching (each param is parsed independently by
   * scanning the header for `<name>:`), so values that contain colons (e.g.
   * Windows paths) or whitespace (e.g. queries) are parsed correctly.
   *
   * Tools with non-standard body formats (e.g. `replace_in_file` uses
   * `====` to split search/replace) should override this method.
   *
   * Returns `null` if required parameters are missing or the block cannot
   * be parsed.
   */
  parseBlockParams(rawHeaderLine: string, body: string): Record<string, unknown> | null {
    return defaultParseBlockParams(this.definition, rawHeaderLine, body);
  }

  protected success(output: string, executionTime?: number): ToolResult {
    return { toolName: this.definition.name, success: true, output, executionTime };
  }

  protected fail(error: string, executionTime?: number): ToolResult {
    return { toolName: this.definition.name, success: false, output: error, error, executionTime };
  }
}

/**
 * Default block parameter parser. Uses the tool's parameter schema to
 * extract values from the header line and body.
 *
 * Algorithm:
 *   1. For each header parameter declared in the definition, scan the
 *      header for `<name>:` (word boundary + name + colon) and take the
 *      substring up to the next known parameter as the value. This
 *      tolerates colons inside values (e.g. `path:D:\foo`) because we
 *      only look for known parameter names.
 *   2. If the tool declares exactly one body parameter, assign the body
 *      content to it (stripping one trailing newline if present).
 *   3. If the tool declares multiple body parameters, return `null` —
 *      the tool must override `parseBlockParams` to handle this case.
 *   4. Apply declared defaults and check required parameters.
 */
export function defaultParseBlockParams(
  definition: ToolDefinition,
  rawHeaderLine: string,
  body: string,
): Record<string, unknown> | null {
  const params: Record<string, unknown> = {};

  const headerEntries: Array<[string, ToolParameter]> = [];
  const bodyEntries: Array<[string, ToolParameter]> = [];
  for (const [name, paramDef] of Object.entries(definition.parameters)) {
    if (paramDef.location === 'body') {
      bodyEntries.push([name, paramDef]);
    } else {
      headerEntries.push([name, paramDef]);
    }
  }

  // Parse header params. We find every occurrence of every known
  // parameter name in the header line, sort them by position, and let
  // each match "own" the text up to the next match. This means the
  // actual order in which the LLM wrote the params determines value
  // boundaries — not the order they appear in the tool's definition
  // schema. This is what makes values with colons (e.g. Windows paths)
  // and spaces parse correctly: the slice is bounded by known names.
  if (headerEntries.length > 0) {
    const headerParamsPart = stripBlockMarker(rawHeaderLine);

    interface Hit {
      name: string;
      paramDef: ToolParameter;
      matchIndex: number;
      valueStart: number;
    }
    const hits: Hit[] = [];

    for (const [name, paramDef] of headerEntries) {
      const keyRegex = new RegExp(`(?:^|\\s)${escapeRegex(name)}:`, 'g');
      let m: RegExpExecArray | null;
      while ((m = keyRegex.exec(headerParamsPart)) !== null) {
        hits.push({
          name,
          paramDef,
          matchIndex: m.index,
          valueStart: m.index + m[0].length,
        });
      }
    }

    hits.sort((a, b) => a.matchIndex - b.matchIndex);

    for (let i = 0; i < hits.length; i++) {
      const hit = hits[i];
      const next = hits[i + 1];
      const valueEnd = next ? next.matchIndex : headerParamsPart.length;
      const rawValue = headerParamsPart.substring(hit.valueStart, valueEnd).trim();
      // If this parameter name was already seen earlier (duplicate),
      // the later occurrence wins so we overwrite.
      const converted = convertParamValue(rawValue, hit.paramDef);
      if (converted !== undefined) {
        params[hit.name] = converted;
      }
    }
  }

  // Parse body params
  if (bodyEntries.length === 1) {
    let value = body;
    // Strip one trailing newline (common convention) so files written
    // with the parser don't gain an extra empty line.
    if (value.endsWith('\n')) {
      value = value.slice(0, -1);
    }
    params[bodyEntries[0][0]] = value;
  } else if (bodyEntries.length > 1) {
    // Multiple body params need a custom parser (e.g. `replace_in_file`).
    return null;
  }

  // Body-only params are assigned below. Header-only params are
  // validated for required-ness. We intentionally do NOT apply
  // declared `default` values here — tools apply their own defaults
  // in `execute`, so that the parsed-parameters object only contains
  // values the LLM actually sent. This keeps behaviour predictable
  // for downstream code that checks `params.x === undefined`.
  void bodyEntries;

  // Check required params
  for (const [name, paramDef] of Object.entries(definition.parameters)) {
    if (!paramDef.required) continue;
    const v = params[name];
    if (v === undefined || v === null || v === '') {
      return null;
    }
  }

  return params;
}

function convertParamValue(rawValue: string, paramDef: ToolParameter): unknown {
  if (paramDef.type === 'boolean') {
    const v = rawValue.toLowerCase();
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0') return false;
    return undefined;
  }
  if (paramDef.type === 'number' || paramDef.type === 'integer') {
    const num = Number(rawValue);
    return Number.isNaN(num) ? undefined : num;
  }
  return rawValue;
}

function stripBlockMarker(headerLine: string): string {
  // Remove the `++++ tool_name` prefix so we can scan the rest for params.
  // Also strip trailing ` +++` or `++++` artifacts that LLMs sometimes append
  // when writing tool call markers on the same line as parameters.
  let result = headerLine.replace(/^\s*\+\+\+\+\s+\S+/, '');
  // Remove trailing "+" sequences (3 or more) that aren't part of a parameter value.
  // Allow optional trailing whitespace (\s*) before $ so that artifacts like
  // "++++ " (trailing space) or "++++\r" (Windows CRLF) are also stripped.
  result = result.replace(/\s+\+{3,}\s*$/, '');
  return result.trim();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
