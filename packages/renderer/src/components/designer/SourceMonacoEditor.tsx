/**
 * Monaco-based source code editor for the MasterLayoutDialog "源码编辑" tab.
 *
 * Provides syntax highlighting and intelligent autocompletion for HTML, CSS,
 * and JavaScript. Uses a single Monaco instance with the `path` prop to create
 * separate models per language — preserving independent undo/redo stacks and
 * cursor positions across sub-tab switches.
 *
 * A Bootstrap 5 completion provider is registered for HTML mode, offering
 * class name suggestions inside `class="..."` attribute values.
 */
import { useRef, useEffect, useCallback } from 'react';
import Editor, { type OnMount, type BeforeMount } from '@monaco-editor/react';
import { defineXaiDarkTheme } from '../../monaco/theme';
import { registerBootstrapCompletionProvider } from '../../monaco/bootstrapCompletion';

interface SourceMonacoEditorProps {
  /** Current language — determines Monaco language mode and model URI. */
  language: 'html' | 'css' | 'javascript';
  /** Current editor content (controlled value). */
  value: string;
  /** Callback on content change. */
  onChange: (value: string) => void;
}

/** Map sub-tab language to model path (creates separate Monaco models). */
const LANGUAGE_PATH_MAP: Record<string, string> = {
  html: 'master-layout-html',
  css: 'master-layout-css',
  javascript: 'master-layout-javascript',
};

export default function SourceMonacoEditor({ language, value, onChange }: SourceMonacoEditorProps) {
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const monacoRef = useRef<any>(null);
  const disposableRef = useRef<{ dispose: () => void } | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const handleBeforeMount: BeforeMount = useCallback((monaco) => {
    defineXaiDarkTheme(monaco);
  }, []);

  const handleEditorMount: OnMount = useCallback((editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    // Register Bootstrap completion provider for HTML
    if (!disposableRef.current) {
      disposableRef.current = registerBootstrapCompletionProvider(monaco);
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (disposableRef.current) {
        disposableRef.current.dispose();
        disposableRef.current = null;
      }
    };
  }, []);

  const handleChange = useCallback((v: string | undefined) => {
    onChangeRef.current(v ?? '');
  }, []);

  return (
    <div className="designer-master-source-editor">
      <Editor
        height="100%"
        language={language}
        path={LANGUAGE_PATH_MAP[language]}
        value={value}
        onChange={handleChange}
        beforeMount={handleBeforeMount}
        onMount={handleEditorMount}
        theme="xai-dark"
        options={{
          fontSize: 13,
          fontFamily: "var(--font-mono)",
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          wordWrap: 'on',
          automaticLayout: true,
          padding: { top: 8 },
          lineNumbers: 'on',
          renderLineHighlight: 'line',
          cursorBlinking: 'smooth',
          smoothScrolling: true,
          scrollbar: {
            verticalScrollbarSize: 6,
            horizontalScrollbarSize: 6,
            useShadows: false,
            alwaysConsumeMouseWheel: false,
          },
          overviewRulerBorder: false,
          hideCursorInOverviewRuler: true,
          guides: {
            indentation: true,
            bracketPairs: true,
          },
          tabSize: 2,
          suggestOnTriggerCharacters: true,
          quickSuggestions: true,
        }}
      />
    </div>
  );
}
