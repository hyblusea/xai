/**
 * Shared Monaco theme definitions for the xAI project.
 *
 * All Monaco editor surfaces (EditorPanel, FloatingEditorWindow,
 * SourceMonacoEditor, etc.) should call `defineXaiDarkTheme(monaco)` in
 * their `beforeMount` callback instead of duplicating the theme object.
 *
 * `defineXaiLightTheme` is the light counterpart, used only by Code-view
 * editor surfaces (EditorPanel + FloatingEditorWindow) when the user selects
 * the light skin. SourceMonacoEditor (Designer's master-layout source tab)
 * stays dark and does NOT call this.
 */
export function defineXaiDarkTheme(monaco: any): void {
  monaco.editor.defineTheme('xai-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'meta.diff', foreground: '#a78bfa' },
      { token: 'meta.diff.header', foreground: '#6ec6ff' },
      { token: 'meta.diff.index', foreground: '#a78bfa' },
      { token: 'meta.diff.range', foreground: '#a78bfa' },
      { token: 'meta.diff.separator', foreground: '#58566a' },
      { token: 'markup.inserted', foreground: '#5ac8a0' },
      { token: 'markup.deleted', foreground: '#ff6b6b' },
      { token: 'markup.inserted.diff', foreground: '#5ac8a0' },
      { token: 'markup.deleted.diff', foreground: '#ff6b6b' },
      { token: 'meta.diff.header.from-file', foreground: '#ff6b6b' },
      { token: 'meta.diff.header.to-file', foreground: '#5ac8a0' },
    ],
    colors: {
      'scrollbar.shadow': '#00000000',
      'scrollbarSlider.background': 'rgba(212, 167, 106, 0.08)',
      'scrollbarSlider.hoverBackground': 'rgba(212, 167, 106, 0.18)',
      'scrollbarSlider.activeBackground': 'rgba(212, 167, 106, 0.28)',
      'editor.background': '#0e0f14',
      'editor.foreground': '#e8e0d8',
      'editor.lineHighlightBackground': '#ffffff06',
      'editor.selectionBackground': '#264f78',
      'editor.inactiveSelectionBackground': '#3a3d41',
      'editorLineNumber.foreground': '#58566a',
      'editorLineNumber.activeForeground': '#e8e0d8',
      'editorCursor.foreground': '#d4a76a',
      'editorIndentGuide.background': '#ffffff08',
      'editorIndentGuide.activeBackground': '#ffffff15',
      'editorBracketMatch.background': '#d4a76a1a',
      'editorBracketMatch.border': '#d4a76a66',
      'editorGutter.addedBackground': '#1a3a2a',
      'editorGutter.deletedBackground': '#3a1a1a',
      'diffEditor.insertedTextBackground': '#5ac8a018',
      'diffEditor.removedTextBackground': '#ff6b6b18',
      'diffEditor.insertedLineBackground': '#5ac8a012',
      'diffEditor.removedLineBackground': '#ff6b6b12',
    },
  });
}

/**
 * Light Monaco theme for Code-view light skin. Keeps the same diff token
 * palette (readable on light bg) and softens editor chrome for a clean look.
 */
export function defineXaiLightTheme(monaco: any): void {
  monaco.editor.defineTheme('xai-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'meta.diff', foreground: '#7c3aed' },
      { token: 'meta.diff.header', foreground: '#2563eb' },
      { token: 'meta.diff.index', foreground: '#7c3aed' },
      { token: 'meta.diff.range', foreground: '#7c3aed' },
      { token: 'meta.diff.separator', foreground: '#9ca3af' },
      { token: 'markup.inserted', foreground: '#0f9d76' },
      { token: 'markup.deleted', foreground: '#d14343' },
      { token: 'markup.inserted.diff', foreground: '#0f9d76' },
      { token: 'markup.deleted.diff', foreground: '#d14343' },
      { token: 'meta.diff.header.from-file', foreground: '#d14343' },
      { token: 'meta.diff.header.to-file', foreground: '#0f9d76' },
    ],
    colors: {
      'scrollbar.shadow': '#00000000',
      'scrollbarSlider.background': 'rgba(184, 137, 74, 0.18)',
      'scrollbarSlider.hoverBackground': 'rgba(184, 137, 74, 0.32)',
      'scrollbarSlider.activeBackground': 'rgba(184, 137, 74, 0.45)',
      'editor.background': '#ffffff',
      'editor.foreground': '#1a1a2e',
      'editor.lineHighlightBackground': '#1a1a2e06',
      'editor.selectionBackground': '#c8aa6e',
      'editor.inactiveSelectionBackground': '#e6d9b8',
      'editorLineNumber.foreground': '#b0b0bc',
      'editorLineNumber.activeForeground': '#1a1a2e',
      'editorCursor.foreground': '#b8894a',
      'editorIndentGuide.background': '#1a1a2e0a',
      'editorIndentGuide.activeBackground': '#1a1a2e1a',
      'editorBracketMatch.background': '#b8894a22',
      'editorBracketMatch.border': '#b8894a66',
      'editorGutter.addedBackground': '#d6f5e7',
      'editorGutter.deletedBackground': '#fbdcdc',
      'diffEditor.insertedTextBackground': '#0f9d7618',
      'diffEditor.removedTextBackground': '#d1434318',
      'diffEditor.insertedLineBackground': '#0f9d7612',
      'diffEditor.removedLineBackground': '#d1434312',
    },
  });
}
