import { ToolDefinition } from '@xai/shared';
import { BrowserBaseTool } from './browser-base-tool.js';

export class BrowserInputTool extends BrowserBaseTool {
  get definition(): ToolDefinition {
    return {
      name: 'browser_input',
      description: 'Text input. "fill" (RECOMMENDED) sets an input value directly by selector, always works, optionally submits with Enter — one call replaces click+type+Enter. "type" appends keystrokes to the focused element or selector. "press-key" presses special keys (Enter, Tab, Escape, arrows, F1-F12) with optional modifiers (Control, Shift, Alt, Meta).',
      parameters: {
        sessionId: { type: 'string', description: 'Browser session ID', required: true, location: 'header' },
        action: { type: 'string', description: 'Action: fill, type, press-key', required: true, location: 'header' },
        text: { type: 'string', description: 'Text to fill/type', required: false, location: 'body' },
        selector: { type: 'string', description: 'CSS selector of the target input (required for fill; recommended for type)', required: false, location: 'header' },
        submit: { type: 'string', description: 'For fill: "true" to press Enter after filling (submits form/login)', required: false, location: 'header' },
        key: { type: 'string', description: 'Key to press (for press-key), e.g. Enter, Tab, Escape', required: false, location: 'header' },
        modifiers: { type: 'string', description: 'Modifiers: Control, Shift, Alt, Meta (comma-separated)', required: false, location: 'header' },
      },
      confirmationRequired: false,
      examples: [
        `++++ browser_input sessionId:br-abc123 action:fill selector:#username
admin
++++ end`,
      ],
    };
  }

  async _execute(params: Record<string, unknown>, _signal?: AbortSignal) {
    const start = Date.now();
    try {
      const sessionId = params.sessionId as string;
      const action = params.action as string;

      if (!sessionId || !action) {
        return this.fail('sessionId and action parameters are required', Date.now() - start);
      }

      if (!['type', 'press-key', 'fill'].includes(action)) {
        return this.fail('action must be fill, type, or press-key', Date.now() - start);
      }

      if (action === 'fill') {
        const selector = params.selector as string;
        const text = params.text as string;
        if (!selector || !text) return this.fail('selector and text are required for fill action', Date.now() - start);

        const submit = params.submit === true || params.submit === 'true';
        await this.invokeIPC('browser:fill', { sessionId, selector, text, submit });
        return this.success(`Filled "${text}" into ${selector}${submit ? ' and submitted' : ''}`, Date.now() - start);
      }

      if (action === 'type') {
        const text = params.text as string;
        if (!text) return this.fail('text is required for type action', Date.now() - start);

        const selector = params.selector as string | undefined;
        await this.invokeIPC('browser:type', { sessionId, text, ...(selector ? { selector } : {}) });
        return this.success(`Typed text into ${selector || 'focused element'}`, Date.now() - start);
      }

      // press-key
      const key = params.key as string;
      if (!key) return this.fail('key is required for press-key action', Date.now() - start);

      const modifiersStr = params.modifiers as string | undefined;
      const modifiers = modifiersStr ? modifiersStr.split(',').map(m => m.trim()) : [];

      await this.invokeIPC('browser:press-key', { sessionId, key, modifiers });
      return this.success(`Pressed key: ${key}${modifiers.length ? ` with ${modifiers.join('+')}` : ''}`, Date.now() - start);
    } catch (error) {
      return this.fail(`browser_input failed: ${error instanceof Error ? error.message : String(error)}`, Date.now() - start);
    }
  }
}
