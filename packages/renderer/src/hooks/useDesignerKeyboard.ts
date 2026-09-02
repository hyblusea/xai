import { useEffect } from 'react';
import type { SelectedElement } from '@xai/shared';

interface UseDesignerKeyboardOptions {
  iframeRefs: React.MutableRefObject<Map<string, HTMLIFrameElement>>;
  selectedScreenIdRef: React.MutableRefObject<string | null>;
  selectedElement: SelectedElement | null;
  isGenerating: boolean;
  runOpen: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onDeleteElement: (selector: string) => void;
  onHtmlChange: (html: string) => void;
  onSelectElement: (el: SelectedElement | null) => void;
  /** Clear any stuck drag/resize state. Called on Escape. */
  onResetDragState?: () => void;
  /** Manually save the current screen. Called on Ctrl+S. */
  onSave?: () => void;
  /** When true, GrapesJS handles all shortcuts. We only keep Ctrl+S. */
  editMode?: boolean;
}

/**
 * Global keyboard shortcuts for the designer canvas:
 *  - Ctrl+Z / Ctrl+Shift+Z (or Ctrl+Y): undo / redo
 *  - Delete / Backspace: remove selected element
 *  - Ctrl+D: duplicate selected element
 *  - Arrow keys: nudge element position (Shift = 10px step)
 *  - Escape: deselect
 * Extracted from DesignerCanvas.
 */
export function useDesignerKeyboard({
  iframeRefs,
  selectedScreenIdRef,
  selectedElement,
  isGenerating,
  runOpen,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onDeleteElement,
  onHtmlChange,
  onSelectElement,
  onResetDragState,
  onSave,
  editMode = false,
}: UseDesignerKeyboardOptions) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept when typing in inputs/textareas
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
      // Don't intercept during generation or run mode
      if (isGenerating || runOpen) return;

      // In edit mode, GrapesJS handles ALL keyboard shortcuts (copy, paste,
      // delete, undo, redo, arrow nudge, escape). We only keep Ctrl+S so the
      // user can still save. Without this guard, our hook conflicts with
      // GrapesJS — e.g. Delete triggers both our handler and GrapesJS's,
      // Ctrl+Z reverts htmlBuffer while GrapesJS reverts its own stack, etc.
      if (editMode) {
        if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
          e.preventDefault();
          onSave?.();
        }
        return;
      }

      // Undo: Ctrl+Z (not Shift)
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        if (canUndo) onUndo();
        return;
      }
      // Redo: Ctrl+Shift+Z or Ctrl+Y
      if ((e.ctrlKey || e.metaKey) && ((e.key === 'z' && e.shiftKey) || e.key === 'y')) {
        e.preventDefault();
        if (canRedo) onRedo();
        return;
      }

      // Save: Ctrl+S — persist manual canvas edits to the backend
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        onSave?.();
        return;
      }

      // Remaining shortcuts require a selected element
      if (!selectedElement) return;

      // Delete: remove selected element
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        onDeleteElement(selectedElement.selector);
        return;
      }

      // Ctrl+D: duplicate selected element
      if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
        e.preventDefault();
        const iframe = iframeRefs.current.get(selectedScreenIdRef.current || '');
        if (!iframe?.contentDocument) return;
        const el = iframe.contentDocument.querySelector(selectedElement.selector) as HTMLElement | null;
        if (el && el.parentElement) {
          const clone = el.cloneNode(true) as HTMLElement;
          // Offset the clone slightly
          const ml = parseFloat(getComputedStyle(el).marginLeft) || 0;
          const mt = parseFloat(getComputedStyle(el).marginTop) || 0;
          clone.style.marginLeft = `${ml + 20}px`;
          clone.style.marginTop = `${mt + 20}px`;
          el.parentElement.insertBefore(clone, el.nextSibling);
          const newHtml = '<!DOCTYPE html>\n' + iframe.contentDocument.documentElement.outerHTML;
          onHtmlChange(newHtml);
        }
        return;
      }

      // Arrow keys: nudge element position
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const iframe = iframeRefs.current.get(selectedScreenIdRef.current || '');
        if (!iframe?.contentDocument) return;
        const el = iframe.contentDocument.querySelector(selectedElement.selector) as HTMLElement | null;
        if (!el) return;
        const step = e.shiftKey ? 10 : 1;
        const ml = parseFloat(getComputedStyle(el).marginLeft) || 0;
        const mt = parseFloat(getComputedStyle(el).marginTop) || 0;
        if (e.key === 'ArrowLeft') el.style.marginLeft = `${ml - step}px`;
        if (e.key === 'ArrowRight') el.style.marginLeft = `${ml + step}px`;
        if (e.key === 'ArrowUp') el.style.marginTop = `${mt - step}px`;
        if (e.key === 'ArrowDown') el.style.marginTop = `${mt + step}px`;
        const rect = el.getBoundingClientRect();
        onSelectElement({
          ...selectedElement,
          rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
        });
        const newHtml = '<!DOCTYPE html>\n' + iframe.contentDocument.documentElement.outerHTML;
        onHtmlChange(newHtml);
        return;
      }

      // Escape: deselect and clear any stuck drag/resize state
      if (e.key === 'Escape') {
        e.preventDefault();
        onResetDragState?.();
        onSelectElement(null);
        return;
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onUndo, onRedo, canUndo, canRedo, isGenerating, runOpen, selectedElement, onDeleteElement, onHtmlChange, onSelectElement, onResetDragState, onSave, editMode, iframeRefs, selectedScreenIdRef]);
}
