import type { DesignerScreen } from '@xai/shared';
import { buildFolderTree, type FolderNode } from '../components/designer/FolderTree';

/** Extract the <title> text from an HTML document. Returns empty string if none. */
export function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return match?.[1]?.trim() || '';
}

/** A screen with its sub-folder label (if it's the first screen in that sub-folder). */
export interface ScreenWithLabel {
  screen: DesignerScreen & { html: string };
  subFolderLabel: string | null;
}

/** Group screens by top-level folder for row-based rendering. */
export interface FolderRow {
  /** Top-level folder name (empty string for root). */
  folderName: string;
  /** Screens in this row, each potentially carrying a sub-folder label. */
  screens: ScreenWithLabel[];
}

/**
 * Build folder rows from a flat screen list.
 * Each top-level folder becomes one row; within a row, the first screen
 * of each sub-folder carries a `subFolderLabel`.
 */
export function buildFolderRows(
  screensWithScrollbar: (DesignerScreen & { html: string })[],
  folders?: string[],
): FolderRow[] {
  const tree = buildFolderTree(
    screensWithScrollbar.map(s => ({ ...s, html: '' })),
    folders,
  );

  // Helper: collect all screens from a node recursively, tagging sub-folder labels
  const collectFromNode = (
    node: FolderNode,
    depth: number,
    _isFirstInGroup: boolean,
  ): ScreenWithLabel[] => {
    const result: ScreenWithLabel[] = [];

    // This node's own screens — the first one gets a sub-folder label if depth > 0
    for (let i = 0; i < node.screens.length; i++) {
      const screen = node.screens[i];
      const matched = screensWithScrollbar.find(s => s.id === screen.id);
      if (!matched) continue;
      result.push({
        screen: matched,
        subFolderLabel: i === 0 && depth > 0 ? node.name : null,
      });
    }

    // Recurse into children
    for (const child of node.children) {
      const childScreens = collectFromNode(child, depth + 1, false);
      result.push(...childScreens);
    }

    return result;
  };

  const rows: FolderRow[] = [];

  // Root screens (no folder)
  const rootScreens: ScreenWithLabel[] = [];
  for (const s of screensWithScrollbar) {
    if (!s.folderPath) {
      rootScreens.push({ screen: s, subFolderLabel: null });
    }
  }
  if (rootScreens.length > 0) {
    rows.push({ folderName: '', screens: rootScreens });
  }

  // Top-level folders → one row each
  for (const topFolder of tree) {
    const rowScreens = collectFromNode(topFolder, 0, true);
    if (rowScreens.length > 0) {
      rows.push({ folderName: topFolder.name, screens: rowScreens });
    }
  }

  return rows;
}
