/**
 * Dynamic tool names store — populated from the main process ToolRegistry
 * via IPC. Both chatUtils.ts and ToolCallBubble.tsx read from this store
 * so that adding/removing tools in core doesn't require manual sync here.
 */
import { IPCChannel } from '@xai/shared';

let toolNames: Set<string> = new Set();
/** Map of tool name → contentMode ('text' | 'native' | undefined). */
let toolContentModes: Map<string, string> = new Map();
let fetchPromise: Promise<void> | null = null;

/**
 * Fetch tool names from the main process and cache them.
 * Safe to call multiple times — subsequent calls are no-ops unless force=true.
 *
 * 兼容两种 IPC 返回格式：
 *   - 旧格式：string[]（仅工具名，contentMode 默认 'native'）
 *   - 新格式：{ name: string; contentMode?: string }[]（带 contentMode 元数据）
 */
export async function refreshToolNames(force = false): Promise<void> {
  if (fetchPromise && !force) return fetchPromise;
  fetchPromise = (async () => {
    try {
      const data = await window.electronAPI.invoke(IPCChannel.AgentToolNames) as Array<string | { name: string; contentMode?: string }>;
      const names = new Set<string>();
      const modes = new Map<string, string>();
      for (const item of data) {
        if (typeof item === 'string') {
          // 旧格式：仅工具名
          names.add(item);
          modes.set(item, 'native');
        } else if (item && typeof item === 'object' && item.name) {
          // 新格式：带 contentMode
          names.add(item.name);
          modes.set(item.name, item.contentMode ?? 'native');
        }
      }
      toolNames = names;
      toolContentModes = modes;
    } catch {
      // Keep existing names on failure
    } finally {
      fetchPromise = null;
    }
  })();
  return fetchPromise;
}

/**
 * Returns true if the given tool name is a registered tool.
 * Used by parseEditorBlockLabel to confirm ++++ block headers reference
 * a known tool (prevents arbitrary ++++ text from being rendered as
 * tool instruction blocks).
 */
export function isEditorBlockTool(toolName: string): boolean {
  return toolNames.has(toolName);
}

/**
 * Returns true if the given tool uses the ++++ text format
 * (contentMode === 'text'). These tools have large content bodies
 * (e.g. write_to_file) and should:
 *   - Hide their "Running" bubble until completion (processMessages)
 *   - Not display raw parameters in the bubble (ToolCallBubble)
 *
 * Native tools (contentMode !== 'text') show their "Running" bubble
 * immediately and display formatted parameters.
 */
export function isTextModeTool(toolName: string): boolean {
  return toolContentModes.get(toolName) === 'text';
}

/** Returns the current set of registered tool names. */
export function getToolNames(): Set<string> {
  return toolNames;
}
