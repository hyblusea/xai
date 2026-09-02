import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo, useReducer } from 'react';
import { createPortal } from 'react-dom';
import { Send, Square, FileText, X, Loader2, Image as ImageIcon, Gauge, ChevronsDownUp, Pencil, Plus, History } from 'lucide-react';
import type { AgentState, SessionConfig, ChatTag, ContextUsage, CompactionResult } from '@xai/shared';
import { IPCChannel } from '@xai/shared';

/** Office document extensions intercepted on paste and converted to Markdown. */
const OFFICE_EXTENSIONS = ['docx', 'xlsx', 'xls', 'xlsm', 'csv', 'pdf'];

/** Image extensions intercepted on paste and recognized via the OCR service. */
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'bmp', 'gif', 'tiff', 'webp'];

/** Plain-text pastes longer than this are attached as a .txt chip instead of
 *  being inserted inline. Huge inline insertions used to freeze the renderer
 *  (editing-pipeline + layout + undo costs are super-linear in Blink), and a
 *  160px-tall input cannot meaningfully display hundreds of lines anyway. */
const MAX_INLINE_PASTE_CHARS = 50_000;

/** Providers that expose session compression (getContextUsage / compressHistory). */
const COMPRESSION_PROVIDERS = ['openai', 'deveco', 'cline', 'freebuff'];

/** Map a usage percentage to a color-severity level for the badge. */
function usageLevel(percent: number): 'low' | 'medium' | 'high' | 'critical' {
  if (percent < 50) return 'low';
  if (percent < 80) return 'medium';
  if (percent < 95) return 'high';
  return 'critical';
}

/** Format a token count compactly, e.g. 128000 -> "128k". */
function formatTokens(tokens: number): string {
  if (tokens >= 1000) {
    const k = tokens / 1000;
    return Number.isInteger(k) ? `${k}k` : `${k.toFixed(1)}k`;
  }
  return String(tokens);
}

function isOfficeFile(file: File): boolean {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return OFFICE_EXTENSIONS.includes(ext);
}

function isImageFile(file: File): boolean {
  // Prefer MIME type, fall back to extension (clipboard images may lack an extension).
  if (file.type && file.type.startsWith('image/')) return true;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_EXTENSIONS.includes(ext);
}

interface PendingFile {
  id: string;
  file: File;
  name: string;
  /** 'text' = oversized plain-text paste attached as a .txt chip (no conversion). */
  kind: 'office' | 'image' | 'text';
  /** Pre-converted markdown content; when set, send skips re-conversion.
   *  Used to restore pending-file attachments from the input history. */
  convertedMarkdown?: string;
}

/** A snapshot of a sent message kept for the designer input history. */
interface InputHistoryEntry {
  id: string;
  /** Short preview shown in the popup (truncated text or file names). */
  preview: string;
  /** Editor innerHTML snapshot at send time (text + inline-tag spans). */
  editorHtml: string;
  /** chatTags snapshot at send time (with original IDs). */
  tags: ChatTag[];
  /** Metadata + converted markdown for each pending file attachment. */
  pendingFilesMeta: Array<{ name: string; kind: 'office' | 'image' | 'text'; markdown: string }>;
  /** Send timestamp. */
  timestamp: number;
  /** Normalized content signature used for duplicate detection.
   *  Built from fullText (which already includes inline-tag textual forms
   *  like "[File: ...]") plus pending-file metadata; avoids HTML-representation
   *  drift where browsers wrap identical plain text in different
   *  <div>/<br>/whitespace structures between sends. */
  contentSignature: string;
}

interface ChatInputProps {
  agentState: AgentState;
  onSend: (content: string) => void;
  onAbort: () => void;
  chatTags: ChatTag[];
  onRemoveChatTag: (tagId: string) => void;
  /** Currently selected screen id (null = no screen selected). */
  currentScreenId?: string | null;
  /** Whether to show the 新增/修改 mode badge (designer view only). */
  showModeBadge?: boolean;
  /** Switch designer mode between 'new' (blank canvas) and 'edit' (restore selected screen). */
  onSwitchMode?: (mode: 'new' | 'edit') => void;
  /** Whether switching to edit mode is available (a screen was previously selected). */
  canSwitchToEdit?: boolean;
  /** Whether a project is currently selected (designer view only).
   *  When false and showModeBadge is true, the input is disabled with a hint. */
  hasCurrentProject?: boolean;
  /** Restore chat tags from a history snapshot (designer view only).
   *  When provided together with showModeBadge, the input-history button is shown. */
  onRestoreTags?: (tags: ChatTag[]) => void;
  /** Current session context usage (only populated for compression-aware providers). */
  contextUsage?: ContextUsage | null;
  /** Auto-compaction toast from the agent loop (shows alongside manual compress toast). */
  autoCompressToast?: { kind: 'compressing' | 'compressed' | 'error'; message: string } | null;
  /** Manually compact the current session's conversation history. */
  onCompressSession?: () => Promise<{ success: boolean; result?: CompactionResult; error?: string }>;
}

export default function ChatInput({ agentState, onSend, onAbort, chatTags, onRemoveChatTag, currentScreenId, showModeBadge, onSwitchMode, canSwitchToEdit, hasCurrentProject, onRestoreTags, contextUsage, autoCompressToast, onCompressSession }: ChatInputProps) {
  // 用 ref 存储输入文本，避免每次字符输入都触发 React 重渲染（干扰 IME）。
  // 只在「空 ↔ 非空」状态变化时才 forceUpdate，以刷新发送按钮的 disabled 状态。
  const inputTextRef = useRef('');
  const prevEmptyRef = useRef(true);
  const [, forceUpdate] = useReducer((x: number) => x + 1, 0);
  const [shortcutCommands, setShortcutCommands] = useState<string[]>([]);
  const [currentModel, setCurrentModel] = useState<string>('');
  const [currentProvider, setCurrentProvider] = useState<string>('');
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [shortcutFilter, setShortcutFilter] = useState('');
  const [shortcutSelectedIndex, setShortcutSelectedIndex] = useState(0);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [converting, setConverting] = useState(false);
  const [compressing, setComverting] = useState(false);
  const [compressToast, setCompressToast] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const shortcutPanelRef = useRef<HTMLDivElement>(null);
  const isComposingRef = useRef(false);

  // Designer input history — keeps the last 5 sent messages (text + inline
  // tags + pending file attachments) so the user can restore them.
  const historyEnabled = !!showModeBadge && !!onRestoreTags;
  const [history, setHistory] = useState<InputHistoryEntry[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const historyPanelRef = useRef<HTMLDivElement>(null);
  const historyBtnRef = useRef<HTMLButtonElement>(null);
  // Popup is rendered with position: fixed so it escapes the chat-input-container
  // (which has overflow: hidden and would otherwise clip it). Coordinates are
  // computed from the button's bounding rect when the popup opens.
  const [popupPos, setPopupPos] = useState<{ bottom: number; right: number } | null>(null);

  const isActive = ['thinking', 'acting', 'observing'].includes(agentState);
  const compressionEnabled = COMPRESSION_PROVIDERS.includes(currentProvider);

  // In designer view (showModeBadge), block input when no project is selected.
  const noProjectInDesigner = !!showModeBadge && !hasCurrentProject;

  // Edit mode = modifying an existing page; New mode = generating from scratch.
  // Edit triggers: a current screen is selected, OR a UI element tag is present.
  const hasElementTag = chatTags.some(t => t.type === 'element');
  const isEditMode = !!currentScreenId || hasElementTag;

  const addPendingFiles = useCallback((files: File[], kind: 'office' | 'image' | 'text') => {
    const newPending: PendingFile[] = files.map((file) => ({
      id: `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      file,
      name: file.name,
      kind,
    }));
    setPendingFiles((prev) => [...prev, ...newPending]);
  }, []);

  const removePendingFile = useCallback((id: string) => {
    setPendingFiles((prev) => prev.filter((f) => f.id !== id));
  }, []);

  useEffect(() => {
    const loadShortcuts = async () => {
      try {
        const config = (await window.electronAPI.invoke(IPCChannel.ConfigGet)) as SessionConfig;
        setShortcutCommands(config.shortcutCommands || []);
        const provider = config.llm?.provider || '';
        const model = config.llm?.model || '';
        setCurrentProvider(provider);
        setCurrentModel(model ? (provider ? `${provider} / ${model}` : model) : '');
      } catch {}
    };
    loadShortcuts();

    const handleConfigChanged = (newConfig: unknown) => {
      const cfg = newConfig as SessionConfig;
      setShortcutCommands(cfg.shortcutCommands || []);
      const provider = cfg.llm?.provider || '';
      const model = cfg.llm?.model || '';
      setCurrentProvider(provider);
      setCurrentModel(model ? (provider ? `${provider} / ${model}` : model) : '');
    };
    window.electronAPI?.on(IPCChannel.ConfigChanged, handleConfigChanged);
    return () => {
      window.electronAPI?.removeListener?.(IPCChannel.ConfigChanged, handleConfigChanged);
    };
  }, []);

  const closeShortcuts = useCallback(() => {
    setShowShortcuts(false);
    setShortcutFilter('');
  }, []);

  const syncEditorInput = useCallback(() => {
    const text = editorRef.current?.textContent ?? '';
    inputTextRef.current = text;

    // Sync tags: remove from state any tags that no longer exist in DOM
    if (editorRef.current) {
      const domTagIds = new Set<string>();
      editorRef.current.querySelectorAll('.inline-tag').forEach((el) => {
        const tagId = (el as HTMLElement).dataset.tagId;
        if (tagId) domTagIds.add(tagId);
      });
      chatTags.forEach((tag) => {
        if (!domTagIds.has(tag.id)) {
          onRemoveChatTag(tag.id);
        }
      });
    }

    if (text === '/' || (text.startsWith('/') && !text.includes(' '))) {
      setShortcutFilter(text.length > 1 ? text.slice(1) : '');
      if (!showShortcuts) {
        setShortcutSelectedIndex(0);
        setShowShortcuts(true);
      }
    } else if (showShortcuts) {
      closeShortcuts();
    }

    // 只在「空 ↔ 非空」状态变化时才触发重渲染（刷新发送按钮 disabled）。
    // 这是消除 IME 字符重复的关键：普通字符输入不再触发 React 重渲染，
    // 从而彻底避免 concurrent rendering 干扰 IME 状态机。
    const isEmpty = !text.trim();
    if (isEmpty !== prevEmptyRef.current) {
      prevEmptyRef.current = isEmpty;
      forceUpdate();
    }
  }, [showShortcuts, closeShortcuts, chatTags, onRemoveChatTag]);

  const prevTagsRef = useRef<ChatTag[]>([]);

  useEffect(() => {
    if (!editorRef.current) return;
    const prevIds = new Set(prevTagsRef.current.map((t) => t.id));
    const newTags = chatTags.filter((t) => !prevIds.has(t.id));
    prevTagsRef.current = chatTags;

    for (const tag of newTags) {
      const span = document.createElement('span');
      span.className = 'inline-tag';
      span.contentEditable = 'false';
      span.dataset.tagId = tag.id;
      span.style.cssText =
        'display:inline-flex;align-items:center;gap:3px;padding:1px 5px;margin:0 4px;background:rgba(212,167,106,0.15);border:1px solid rgba(212,167,106,0.25);border-radius:3px;font-size:11px;font-family:var(--font-mono);color:var(--accent);cursor:default;user-select:none;vertical-align:baseline;line-height:1.4;';
      if (tag.type === 'file') {
        span.textContent = `\u{1F4C4} ${tag.filePath.split(/[\\/]/).pop() ?? tag.filePath}`;
      } else if (tag.type === 'table') {
        span.textContent = `\u{1F4CA} ${tag.tableName ?? tag.filePath}${tag.dbType ? ` (${tag.dbType})` : ''}`;
        span.title = `${tag.dbType ? `[${tag.dbType}] ` : ''}${tag.filePath}.${tag.tableName ?? ''}`;
      } else if (tag.type === 'element') {
        span.textContent = `\u{1F3A8} ${tag.elementTag || 'element'}`;
        span.title = `Element: <${tag.elementTag}> (${tag.elementSelector})\nScreen: ${tag.screenName || ''}`;
      } else if (tag.type === 'screen') {
        span.textContent = `\u{1F5BC} ${tag.screenName || tag.filePath}`;
        span.title = `Style Reference: ${tag.screenName || tag.filePath}`;
      } else {
        span.textContent = `\u{1F4BB} ${tag.filePath.split(/[\\/]/).pop() ?? tag.filePath}:${tag.startLine}-${tag.endLine}`;
      }
      span.title = tag.type === 'file' ? tag.filePath : tag.type === 'table' ? `${tag.dbType ? `[${tag.dbType}] ` : ''}${tag.filePath}.${tag.tableName ?? ''}` : tag.type === 'element' ? `Element: <${tag.elementTag}> (${tag.elementSelector})` : tag.type === 'screen' ? `Style Reference: ${tag.screenName || tag.filePath}` : `${tag.filePath}:${tag.startLine}-${tag.endLine}`;

      const sel = window.getSelection();
      let inserted = false;
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        if (editorRef.current.contains(range.commonAncestorContainer)) {
          range.collapse(false);
          range.insertNode(span);
          const space = document.createTextNode('\u200B');
          range.setStartAfter(span);
          range.insertNode(space);
          range.setStartAfter(space);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
          inserted = true;
        }
      }
      if (!inserted) {
        editorRef.current.appendChild(span);
        const space = document.createTextNode('\u200B');
        editorRef.current.appendChild(space);
      }
    }
    syncEditorInput();
  }, [chatTags, syncEditorInput]);

  const filteredShortcuts = useMemo(() => {
    if (!shortcutFilter) return shortcutCommands;
    return shortcutCommands.filter((cmd) => cmd.toLowerCase().includes(shortcutFilter.toLowerCase()));
  }, [shortcutCommands, shortcutFilter]);

  useEffect(() => {
    if (!showShortcuts) return;
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (shortcutPanelRef.current && !shortcutPanelRef.current.contains(target)) {
        setShowShortcuts(false);
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [showShortcuts]);

  // Close the input-history popup when clicking outside of it (or its button).
  useEffect(() => {
    if (!showHistory) return;
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      const inPopup = historyPanelRef.current?.contains(target);
      const inBtn = historyBtnRef.current?.contains(target);
      if (!inPopup && !inBtn) {
        setShowHistory(false);
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [showHistory]);

  // Toggle the popup open/closed. Position is computed in a layout effect
  // after showHistory flips true (see below), so this just toggles state.
  const toggleHistory = useCallback(() => {
    setShowHistory(v => !v);
  }, []);

  // When the popup opens, compute fixed coordinates from the button's rect so
  // the popup floats above the button, escaping chat-input-container's
  // overflow:hidden. Runs synchronously before paint, so no visible flash.
  useLayoutEffect(() => {
    if (!showHistory) return;
    const btn = historyBtnRef.current;
    if (!btn) {
      // Fallback: anchor to bottom-right of viewport.
      setPopupPos({ bottom: 80, right: 16 });
      return;
    }
    const rect = btn.getBoundingClientRect();
    setPopupPos({
      bottom: window.innerHeight - rect.top + 6, // 6px gap above button top
      right: window.innerWidth - rect.right,
    });
  }, [showHistory]);

  // Keep popup anchored to the button on viewport resize while open.
  useEffect(() => {
    if (!showHistory) return;
    const handleResize = () => {
      const btn = historyBtnRef.current;
      if (!btn) return;
      const rect = btn.getBoundingClientRect();
      setPopupPos({
        bottom: window.innerHeight - rect.top + 6,
        right: window.innerWidth - rect.right,
      });
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [showHistory]);

  useEffect(() => {
    setShortcutSelectedIndex(0);
  }, [shortcutFilter]);

  const getEditorText = useCallback(() => {
    if (!editorRef.current) return '';
    let text = '';
    for (const node of editorRef.current.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent;
      } else if (node instanceof HTMLElement && node.classList.contains('inline-tag')) {
        const tagId = node.dataset.tagId;
        const tag = chatTags.find((t) => t.id === tagId);
        if (tag) {
          if (tag.type === 'file') {
            text += `[File: ${tag.filePath}]`;
          } else if (tag.type === 'table') {
            text += `[Table${tag.dbType ? ` (${tag.dbType})` : ''}: ${tag.filePath}.${tag.tableName ?? ''}]`;
            if (tag.content) {
              text += '\n' + tag.content;
            }
          } else if (tag.type === 'element') {
            text += `[Element: <${tag.elementTag}> | Selector: ${tag.elementSelector} | Screen: ${tag.screenName || ''}]`;
            if (tag.elementHtml) {
              text += '\n' + tag.elementHtml;
            }
          } else if (tag.type === 'screen') {
            text += `[Style Reference: ${tag.screenName || tag.filePath}]`;
          } else {
            text += `[Code: ${tag.filePath} | Lines ${tag.startLine}-${tag.endLine}]`;
          }
        }
      } else if (node instanceof HTMLElement) {
        text += node.textContent ?? '';
      }
    }
    return text;
  }, [chatTags]);

  const handleCompress = useCallback(async () => {
    if (!onCompressSession || compressing || isActive) return;
    setComverting(true);
    setCompressToast(null);
    try {
      const res = await onCompressSession();
      if (res.success && res.result) {
        const r = res.result;
        setCompressToast({
          kind: 'success',
          message: `${r.beforeMessages}→${r.afterMessages} 消息  ${r.beforeTokens}→${r.afterTokens} tokens`,
        });
      } else {
        setCompressToast({
          kind: 'error',
          message: res.error || (res.result?.error) || '压缩失败',
        });
      }
    } catch (err) {
      setCompressToast({ kind: 'error', message: String(err) });
    } finally {
      setComverting(false);
      window.setTimeout(() => setCompressToast(null), 3000);
    }
  }, [onCompressSession, compressing, isActive]);

  const handleSend = async () => {
    const fullText = getEditorText().trim();
    if ((!fullText && pendingFiles.length === 0) || isActive || converting) return;

    let content = fullText;
    // Capture converted markdown per pending file for history restoration.
    const convertedParts: Array<{ name: string; kind: 'office' | 'image' | 'text'; markdown: string }> = [];

    if (pendingFiles.length > 0) {
      setConverting(true);
      try {
        const parts: string[] = [];
        for (const pending of pendingFiles) {
          let markdown: string | null = null;
          // Restored-from-history files carry their previously-converted markdown;
          // reuse it instead of re-running conversion (File object is synthetic).
          if (pending.convertedMarkdown) {
            markdown = pending.convertedMarkdown;
          } else {
            try {
              const arrayBuffer = await pending.file.arrayBuffer();
              if (pending.kind === 'office') {
                const result = await window.electronAPI.invoke(IPCChannel.Office2MdConvert, {
                  filename: pending.name,
                  buffer: new Uint8Array(arrayBuffer),
                }) as { success: boolean; markdown?: string; error?: string };
                if (result.success && result.markdown) {
                  markdown = `# 📄 ${pending.name}\n\n${result.markdown}`;
                } else {
                  markdown = `# 📄 ${pending.name}\n\n[Conversion failed: ${result.error ?? 'unknown error'}]`;
                }
              } else if (pending.kind === 'text') {
                // Oversized plain-text paste — content is already plain text;
                // no office conversion or OCR needed beyond UTF-8 decoding.
                const decoded = new TextDecoder('utf-8').decode(new Uint8Array(arrayBuffer));
                markdown = `# 📄 ${pending.name}\n\n${decoded}`;
              } else {
                // image — run OCR and append recognized text
                const result = await window.electronAPI.invoke(IPCChannel.OCRRecognizeImage, {
                  filename: pending.name,
                  buffer: new Uint8Array(arrayBuffer),
                }) as { success: boolean; message?: string; text?: string };
                if (result.success && result.text && result.text.trim()) {
                  markdown = `# 🖼️ ${pending.name} (OCR)\n\n${result.text.trim()}`;
                } else {
                  markdown = `# 🖼️ ${pending.name} (OCR)\n\n[Recognition failed: ${result.message ?? 'no text recognized'}]`;
                }
              }
            } catch (err) {
              const label = pending.kind === 'office' ? 'Conversion' : 'OCR';
              markdown = `# ${pending.kind === 'office' ? '📄' : '🖼️'} ${pending.name}\n\n[${label} error: ${err}]`;
            }
          }
          if (markdown !== null) {
            parts.push(markdown);
            convertedParts.push({ name: pending.name, kind: pending.kind, markdown });
          }
        }
        if (parts.length > 0) {
          content = parts.join('\n\n---\n\n') + (content ? '\n\n' + content : '');
        }
      } finally {
        setConverting(false);
        setPendingFiles([]);
      }
    }

    if (!content.trim()) return;

    // Snapshot to designer input history (text + inline tags + pending file
    // attachments) BEFORE clearing the editor. Only when the history feature
    // is enabled (designer view).
    if (historyEnabled && editorRef.current) {
      const editorHtml = editorRef.current.innerHTML;
      const tagSnapshot = chatTags.map(t => ({ ...t }));
      const preview =
        fullText.slice(0, 100) ||
        convertedParts.map(p => p.name).join(', ') ||
        '(无文本内容)';
      // Build a normalized content signature for deduplication.
      // Comparing editorHtml directly is unreliable: browsers wrap identical
      // plain text in different <div>/<br>/whitespace structures between
      // sends, so the same input ("设计一个采购管理的UI") recorded across
      // multiple typing sessions rarely produces byte-identical innerHTML.
      // fullText already includes textual representations of inline tags
      // (e.g. "[File: ...]", "[Element: ...]"), so semantically identical
      // inputs collapse to the same signature.
      const contentSignature = JSON.stringify({
        text: fullText,
        files: convertedParts.map(p => ({ name: p.name, kind: p.kind })),
      });
      const entry: InputHistoryEntry = {
        id: `hist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        preview,
        editorHtml,
        tags: tagSnapshot,
        pendingFilesMeta: convertedParts,
        timestamp: Date.now(),
        contentSignature,
      };
      setHistory(prev => {
        // Skip duplicate: same normalized content already in history
        if (prev.some(e => e.contentSignature === contentSignature)) return prev;
        return [entry, ...prev].slice(0, 5);
      });
    }

    onSend(content);
    inputTextRef.current = '';
    prevEmptyRef.current = true;
    forceUpdate();
    if (editorRef.current) {
      editorRef.current.innerHTML = '';
      editorRef.current.focus();
    }
  };

  // Restore a history entry into the input box: rebuilds the editor's HTML
  // (text + inline-tag chips) and pending-file attachments. Tag IDs are
  // regenerated so restored chips don't conflict with any lingering state.
  const handleRestoreHistory = useCallback((entry: InputHistoryEntry) => {
    if (!editorRef.current || !onRestoreTags) return;

    // 1. Reset editor and pending-file state.
    editorRef.current.innerHTML = '';
    setPendingFiles([]);

    // 2. Restore pending files as chips with pre-converted markdown so they
    //    don't need to be re-converted on the next send.
    if (entry.pendingFilesMeta.length > 0) {
      const restoredPending: PendingFile[] = entry.pendingFilesMeta.map(meta => ({
        id: `restored-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        // Synthetic empty File — never read because convertedMarkdown is set.
        file: new File([], meta.name, { type: meta.kind === 'image' ? 'image/png' : 'application/octet-stream' }),
        name: meta.name,
        kind: meta.kind,
        convertedMarkdown: meta.markdown,
      }));
      setPendingFiles(restoredPending);
    }

    // 3. Regenerate tag IDs and remap them inside the saved editor HTML so
    //    chip spans and the chatTags state stay in sync.
    const oldToNewId = new Map<string, string>();
    const newTags: ChatTag[] = entry.tags.map(t => {
      const newId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      oldToNewId.set(t.id, newId);
      return { ...t, id: newId };
    });

    // Parse saved HTML and rewrite data-tag-id attributes to the new IDs.
    let updatedHtml = entry.editorHtml;
    if (oldToNewId.size > 0) {
      const parser = new DOMParser();
      const doc = parser.parseFromString(`<div>${entry.editorHtml}</div>`, 'text/html');
      doc.querySelectorAll('[data-tag-id]').forEach(el => {
        const oldId = el.getAttribute('data-tag-id');
        if (oldId && oldToNewId.has(oldId)) {
          el.setAttribute('data-tag-id', oldToNewId.get(oldId)!);
        }
      });
      updatedHtml = doc.body.firstElementChild?.innerHTML ?? entry.editorHtml;
    }

    // 4. Set prevTagsRef BEFORE updating chatTags state so the chatTags
    //    useEffect sees all tags as already-inserted and skips re-insertion
    //    (which would duplicate chips at the end of the editor).
    prevTagsRef.current = newTags;
    onRestoreTags(newTags);

    // 5. Apply the rebuilt HTML to the editor and sync local input state.
    editorRef.current.innerHTML = updatedHtml;
    syncEditorInput();

    setShowHistory(false);
    editorRef.current.focus();
  }, [onRestoreTags, syncEditorInput]);

  // Format a history entry timestamp as "HH:MM" for display in the popup.
  const formatHistoryTime = useCallback((ts: number) => {
    const d = new Date(ts);
    return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  }, []);

  const selectShortcut = useCallback(
    (cmd: string) => {
      inputTextRef.current = cmd + ' ';
      prevEmptyRef.current = false;
      forceUpdate();
      closeShortcuts();
      if (editorRef.current) {
        editorRef.current.textContent = cmd + ' ';
        const range = document.createRange();
        range.selectNodeContents(editorRef.current);
        range.collapse(false);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        editorRef.current.focus();
      }
    },
    [closeShortcuts],
  );

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    // Intercept pasted office document and image files — convert/OCR on send.
    const files = e.clipboardData.files;
    if (files && files.length > 0) {
      const allFiles = Array.from(files);
      const officeFiles = allFiles.filter(isOfficeFile);
      const imageFiles = allFiles.filter(isImageFile);
      if (officeFiles.length > 0 || imageFiles.length > 0) {
        e.preventDefault();
        if (officeFiles.length > 0) addPendingFiles(officeFiles, 'office');
        if (imageFiles.length > 0) addPendingFiles(imageFiles, 'image');
        return;
      }
    }

    // Handle clipboard image items (e.g. screenshots, copied images) which arrive
    // via clipboardData.items rather than .files, often with a generic name.
    const items = e.clipboardData.items;
    if (items && items.length > 0) {
      const clipboardImages: File[] = [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.kind === 'file' && it.type.startsWith('image/')) {
          const f = it.getAsFile();
          if (f) {
            // Clipboard images often have a generic name like "image.png"; give a
            // timestamped name based on MIME type so the OCR server gets a real ext.
            const ext = f.type.split('/')[1] || 'png';
            const named = new File([f], `clipboard-${Date.now()}.${ext}`, { type: f.type });
            clipboardImages.push(named);
          }
        }
      }
      if (clipboardImages.length > 0) {
        e.preventDefault();
        addPendingFiles(clipboardImages, 'image');
        return;
      }
    }

    e.preventDefault();
    // Always paste as plain text to avoid bringing in external styles
    const text = e.clipboardData.getData('text/plain');
    if (!text) return;

    // Normalize: replace \r\n with \n, collapse trailing/leading whitespace
    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // 超大文本不内联插入：转为 .txt 附件走附件管线。内联插入几十万字符
    // 会带来巨量的编辑管线/排版/undo 开销并冻结渲染进程，且 160px 高的
    // 输入框也无法有效展示上百行内容。
    if (normalized.length > MAX_INLINE_PASTE_CHARS) {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      addPendingFiles([new File([normalized], `paste-${stamp}.txt`, { type: 'text/plain' })], 'text');
      return;
    }

    // Insert plain text at the current cursor position
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;

    const range = sel.getRangeAt(0);
    // Ensure the paste target is within our editor
    if (!editorRef.current || !editorRef.current.contains(range.commonAncestorContainer)) return;

    const editor = editorRef.current;

    // Delete any selected content first
    range.deleteContents();

    // Chromium 清空后的 contenteditable 会残留一个占位 <br>，先移除它，
    // 否则粘贴后首/尾会多出一个空行。
    if (editor && editor.childNodes.length === 1 && editor.firstChild instanceof HTMLBRElement) {
      editor.textContent = '';
      range.selectNodeContents(editor);
      range.collapse(false);
    }

    // 以单个 Text 节点直接插入（O(n) 一次成型）。不再使用
    // document.execCommand('insertText')：它会走 Blink 完整编辑管线
    // （选区重算/样式解析/undo 记录/拼写检查分词），对大文本是超线性
    // 开销，粘贴上百行文本时会长时间阻塞主线程导致界面卡死。
    const textNode = document.createTextNode(normalized);
    range.insertNode(textNode);

    // 合并编辑器内所有相邻文本节点 —— 与 execCommand 管线内部的 DOM
    // 归一化等效。这是原 execCommand 方案规避的 IME 问题（多个相邻
    // text node 边界导致中文标点被插入两次）的关键，归一化后同样安全。
    editor?.normalize();

    // 光标定位到插入内容末尾
    range.setStartAfter(textNode);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);

    // 手动 DOM 插入不会自动派发 input 事件（原 execCommand 路径依赖其
    // 自动触发的 input → onInput 同步），这里显式同步一次。
    syncEditorInput();
  }, [syncEditorInput, addPendingFiles]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // IME 组合期间放行所有按键，避免干扰中文/日文输入法的候选与确认流程
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Backspace' || e.key === 'Delete') {
      const sel = window.getSelection();
      if (sel && editorRef.current) {
        const anchorNode = sel.anchorNode;
        if (anchorNode === editorRef.current && sel.anchorOffset > 0) {
          const prevNode = editorRef.current.childNodes[sel.anchorOffset - 1];
          if (prevNode instanceof HTMLElement && prevNode.classList.contains('inline-tag')) {
            e.preventDefault();
            const tagId = prevNode.dataset.tagId;
            if (tagId) onRemoveChatTag(tagId);
            prevNode.remove();
            syncEditorInput();
            return;
          }
        } else if (anchorNode instanceof HTMLElement && anchorNode.classList.contains('inline-tag')) {
          e.preventDefault();
          const tagId = anchorNode.dataset.tagId;
          if (tagId) onRemoveChatTag(tagId);
          anchorNode.remove();
          syncEditorInput();
          return;
        }
      }
    }

    if (showShortcuts && filteredShortcuts.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setShortcutSelectedIndex((prev) => (prev + 1) % filteredShortcuts.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setShortcutSelectedIndex((prev) => (prev - 1 + filteredShortcuts.length) % filteredShortcuts.length);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) {
        e.preventDefault();
        selectShortcut(filteredShortcuts[shortcutSelectedIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeShortcuts();
        return;
      }
    }

    if (e.key === 'Enter' && e.ctrlKey) {
      e.preventDefault();
      document.execCommand('insertLineBreak');
    } else if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !converting) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="chat-input-area">
      {showShortcuts && shortcutCommands.length > 0 && (
        <div className="shortcut-popup" ref={shortcutPanelRef}>
          <div className="shortcut-popup-header">
            <span>快捷指令</span>
            <span className="shortcut-popup-count">{filteredShortcuts.length} 项</span>
          </div>
          {filteredShortcuts.length === 0 ? (
            <div className="shortcut-popup-empty">无匹配指令</div>
          ) : (
            <div className="shortcut-popup-list">
              {filteredShortcuts.map((cmd, idx) => (
                <div
                  key={cmd}
                  className={`shortcut-popup-item${idx === shortcutSelectedIndex ? ' shortcut-popup-item-active' : ''}`}
                  onClick={() => selectShortcut(cmd)}
                  onMouseEnter={() => setShortcutSelectedIndex(idx)}
                >
                  <span className="shortcut-popup-icon">/</span>
                  <span className="shortcut-popup-text">{cmd}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="chat-input-container">
        {pendingFiles.length > 0 && (
          <div className="chat-input-attachments">
            {pendingFiles.map((pf) => (
              <div
                key={pf.id}
                className={`chat-attachment-chip${pf.kind === 'image' ? ' chat-attachment-chip-image' : ''}`}
                title={pf.name}
              >
                {pf.kind === 'image' ? (
                  <ImageIcon size={12} className="chat-attachment-icon" />
                ) : (
                  <FileText size={12} className="chat-attachment-icon" />
                )}
                <span className="chat-attachment-name">{pf.name}</span>
                {!converting && (
                  <button
                    className="chat-attachment-remove"
                    onClick={() => removePendingFile(pf.id)}
                    title="Remove"
                  >
                    <X size={11} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        <div
          ref={editorRef}
          className="chat-input"
          contentEditable={!isActive && !converting && !noProjectInDesigner}
          suppressContentEditableWarning
          // 关闭拼写检查：大文本粘贴后 Chromium 会对全文重新分词查词典，
          // 并为每个拼错词生成波浪线 marker（主线程 + 布局开销），加剧卡顿。
          spellCheck={false}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => { isComposingRef.current = true; }}
          onCompositionEnd={() => {
            isComposingRef.current = false;
            syncEditorInput();
          }}
          onInput={() => {
            if (!isComposingRef.current) {
              syncEditorInput();
            }
          }}
          onPaste={handlePaste}
          data-placeholder={noProjectInDesigner ? '请先创建项目或选择项目' : 'Send a message... (Enter to send, Ctrl+Enter for new line, Ctrl+V to paste clipboard content or file)'}
          role="textbox"
          aria-multiline="true"
        />
        <div className="chat-input-actions">
          <div className="chat-input-model">
            {showModeBadge && (
              <div className={`chat-mode-switch ${isEditMode ? 'mode-edit' : 'mode-new'}`}>
                <button
                  type="button"
                  className={`mode-option mode-edit-btn ${isEditMode ? 'active' : ''}`}
                  onClick={() => !isEditMode && onSwitchMode?.('edit')}
                  disabled={isEditMode || !canSwitchToEdit || isActive}
                  title={canSwitchToEdit ? '修改模式：编辑现有页面' : '没有选中的页面，无法切换到修改模式'}
                >
                  <Pencil size={10} />
                  <span className="mode-label">修改</span>
                </button>
                <button
                  type="button"
                  className={`mode-option mode-new-btn ${!isEditMode ? 'active' : ''}`}
                  onClick={() => isEditMode && onSwitchMode?.('new')}
                  disabled={!isEditMode || isActive}
                  title="新增模式：生成新页面"
                >
                  <Plus size={10} />
                  <span className="mode-label">新建</span>
                </button>
              </div>
            )}
            {currentModel && <span className="model-name">{currentModel}</span>}
            {compressionEnabled && contextUsage && (
              <span
                className={`chat-usage-badge chat-usage-${usageLevel(contextUsage.usagePercent)}`}
                title={`会话使用率\n当前约 ${contextUsage.totalTokens} / ${contextUsage.contextWindow} tokens (${contextUsage.usagePercent}%)\n消息数：${contextUsage.messageCount}\n点击右侧按钮手动压缩会话`}
              >
                <Gauge size={11} className="chat-usage-icon" />
                <span className="chat-usage-text">
                  {contextUsage.usagePercent}%
                </span>
                <span className="chat-usage-tokens">
                  {formatTokens(contextUsage.totalTokens)}/{formatTokens(contextUsage.contextWindow)}
                </span>
              </span>
            )}
          </div>
          <div className="chat-input-actions-right">
            {compressionEnabled && contextUsage && onCompressSession && (
              <div className="chat-compress-wrapper">
                <button
                  className="chat-compress-btn"
                  onClick={handleCompress}
                  disabled={compressing || isActive || (contextUsage.messageCount ?? 0) < 4}
                  data-tooltip={
                    compressing
                      ? '正在压缩会话…'
                      : (contextUsage.messageCount ?? 0) < 4
                        ? '会话内容太少，无需压缩'
                        : '压缩会话历史（将早期对话总结为摘要）'
                  }
                >
                  {compressing ? <Loader2 size={14} className="spin" /> : <ChevronsDownUp size={14} />}
                </button>
                {(compressToast || autoCompressToast) && (
                  <div className={`chat-compress-toast chat-compress-toast-${(autoCompressToast || compressToast)!.kind === 'compressing' ? 'compressing' : (autoCompressToast || compressToast)!.kind === 'compressed' ? 'success' : 'error'}`}>
                    {(autoCompressToast || compressToast)!.message}
                  </div>
                )}
              </div>
            )}
            {isActive ? (
              <button className="chat-abort-btn" onClick={onAbort} title="Stop">
                <Square size={14} />
              </button>
            ) : converting ? (
              <button className="chat-send-btn" disabled title="Processing attachments...">
                <Loader2 size={14} className="spin" />
              </button>
            ) : (
              <>
                {historyEnabled && (
                  <button
                    ref={historyBtnRef}
                    className="chat-history-btn"
                    onClick={toggleHistory}
                    title={history.length === 0 ? '暂无历史消息' : '查看最近 5 条发送历史'}
                    aria-label="Input history"
                  >
                    <History size={14} />
                  </button>
                )}
                <button
                  className="chat-send-btn"
                  onClick={handleSend}
                  disabled={!inputTextRef.current.trim() && pendingFiles.length === 0}
                  title="Send"
                >
                  <Send size={14} />
                </button>
              </>
            )}
          </div>
        </div>
      </div>
      {/* History popup — rendered via Portal to document.body so it escapes
          all ancestor containing blocks (designer-floating-chat has
          transform + backdrop-filter, which would otherwise turn this
          position:fixed element into a child-positioned one and clip it via
          the ancestor's overflow:hidden). */}
      {showHistory && historyEnabled && popupPos && createPortal(
        <div
          className="chat-history-popup"
          ref={historyPanelRef}
          style={{ bottom: `${popupPos.bottom}px`, right: `${popupPos.right}px` }}
        >
          <div className="chat-history-popup-header">
            <span>历史消息</span>
            <span className="chat-history-popup-count">最近 {history.length} 条</span>
          </div>
          {history.length === 0 ? (
            <div className="chat-history-popup-empty">暂无历史</div>
          ) : (
            <div className="chat-history-popup-list">
              {history.map(entry => (
                <div
                  key={entry.id}
                  className="chat-history-popup-item"
                  onClick={() => handleRestoreHistory(entry)}
                  title="点击还原到输入框"
                >
                  <div className="chat-history-popup-item-preview">
                    {entry.preview}
                  </div>
                  <div className="chat-history-popup-item-meta">
                    {formatHistoryTime(entry.timestamp)}
                    {entry.pendingFilesMeta.length > 0 && (
                      <span className="chat-history-popup-item-files">
                        {entry.pendingFilesMeta.length} 个附件
                      </span>
                    )}
                    {entry.tags.length > 0 && (
                      <span className="chat-history-popup-item-tags">
                        {entry.tags.length} 个引用
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
