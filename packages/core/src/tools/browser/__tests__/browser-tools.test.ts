import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BrowserBaseTool } from '../browser-base-tool.js';
import { BrowserSessionTool } from '../browser-session-tool.js';
import { BrowserMouseClickTool } from '../browser-mouse-click-tool.js';
import { BrowserInputTool } from '../browser-input-tool.js';
import { BrowserScreenshotTool } from '../browser-screenshot-tool.js';
import { BrowserEvaluateTool } from '../browser-evaluate-tool.js';
import { BrowserExtractTool } from '../browser-extract-tool.js';
import { BrowserWaitTool } from '../browser-wait-tool.js';
import { BrowserQueryTool } from '../browser-query-tool.js';
import { BrowserStorageTool } from '../browser-storage-tool.js';
import { BrowserInteractTool } from '../browser-interact-tool.js';
import { BrowserDragTool } from '../browser-drag-tool.js';
import { BrowserApiRequestTool } from '../browser-api-request-tool.js';
import { BrowserDebugTool } from '../browser-debug-tool.js';
import { BrowserFileTool } from '../browser-file-tool.js';

// ---------------------------------------------------------------------------
// BrowserBaseTool
// ---------------------------------------------------------------------------
describe('BrowserBaseTool', () => {
  // Create a concrete subclass for testing the abstract base
  class ConcreteBrowserTool extends BrowserBaseTool {
    get definition() {
      return {
        name: 'test_browser_tool',
        description: 'Test tool',
        parameters: {
          sessionId: { type: 'string', description: 'Session ID', required: true, location: 'header' as const },
        },
        confirmationRequired: false,
      };
    }
    async _execute(params: Record<string, unknown>, _signal?: AbortSignal) {
      const start = Date.now();
      try {
        const result = await this.invokeIPC('test:channel', params);
        return this.success(JSON.stringify(result), Date.now() - start);
      } catch (error) {
        return this.fail(`failed: ${error instanceof Error ? error.message : String(error)}`, Date.now() - start);
      }
    }
  }

  it('should return failure when invokeIPC is called without IPC sender', async () => {
    const tool = new ConcreteBrowserTool();
    const result = await tool.execute({ sessionId: 'br-123' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('requires Electron IPC (not available in current environment)');
  });

  it('should call ipcSend with correct channel and payload', async () => {
    const tool = new ConcreteBrowserTool();
    const ipcSend = vi.fn().mockResolvedValue({ success: true });
    tool.setIpcSender(ipcSend);

    await tool.execute({ sessionId: 'br-123' });
    expect(ipcSend).toHaveBeenCalledWith('test:channel', { sessionId: 'br-123' });
  });

  it('should throw when IPC returns success: false', async () => {
    const tool = new ConcreteBrowserTool();
    const ipcSend = vi.fn().mockResolvedValue({ success: false, error: 'Something went wrong' });
    tool.setIpcSender(ipcSend);

    const result = await tool.execute({ sessionId: 'br-123' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Something went wrong');
  });

  it('should throw with "Unknown error" when IPC fails without error message', async () => {
    const tool = new ConcreteBrowserTool();
    const ipcSend = vi.fn().mockResolvedValue({ success: false });
    tool.setIpcSender(ipcSend);

    const result = await tool.execute({ sessionId: 'br-123' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown error');
  });

  it('should return success result when IPC succeeds', async () => {
    const tool = new ConcreteBrowserTool();
    const ipcSend = vi.fn().mockResolvedValue({ success: true, data: 'ok' });
    tool.setIpcSender(ipcSend);

    const result = await tool.execute({ sessionId: 'br-123' });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// BrowserSessionTool
// ---------------------------------------------------------------------------
describe('BrowserSessionTool', () => {
  let tool: BrowserSessionTool;
  let ipcSend: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tool = new BrowserSessionTool();
    ipcSend = vi.fn().mockResolvedValue({ success: true });
    tool.setIpcSender(ipcSend);
  });

  describe('definition', () => {
    it('should have correct tool name', () => {
      expect(tool.definition.name).toBe('browser_session');
    });
    it('should not require confirmation', () => {
      expect(tool.definition.confirmationRequired).toBe(false);
    });
  });

  describe('execute - open', () => {
    it('should fail when action is missing', async () => {
      const result = await tool.execute({});
      expect(result.success).toBe(false);
      expect(result.error).toContain('action parameter is required');
    });

    it('should fail for invalid action', async () => {
      const result = await tool.execute({ action: 'invalid' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('action must be open, navigate, or close');
    });

    it('should fail when url is missing for open', async () => {
      const result = await tool.execute({ action: 'open' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('url is required for open action');
    });

    it('should fail when url is empty for open', async () => {
      const result = await tool.execute({ action: 'open', url: '   ' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('url is required for open action');
    });

    it('should open session and return sessionId', async () => {
      const result = await tool.execute({ action: 'open', url: 'https://example.com' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('sessionId: br-');
      expect(result.output).toContain('https://example.com');
      expect(ipcSend).toHaveBeenCalledWith('browser:create-session', expect.objectContaining({
        url: 'https://example.com',
      }));
    });
  });

  describe('execute - navigate', () => {
    it('should fail when sessionId is missing', async () => {
      const result = await tool.execute({ action: 'navigate', url: 'https://example.com' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('sessionId is required');
    });

    it('should fail when url is missing', async () => {
      const result = await tool.execute({ action: 'navigate', sessionId: 'br-123' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('url is required for navigate action');
    });

    it('should navigate successfully', async () => {
      const result = await tool.execute({ action: 'navigate', sessionId: 'br-123', url: 'https://example.com' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Navigated to https://example.com');
      expect(ipcSend).toHaveBeenCalledWith('browser:navigate', { sessionId: 'br-123', url: 'https://example.com' });
    });
  });

  describe('execute - close', () => {
    it('should fail when sessionId is missing', async () => {
      const result = await tool.execute({ action: 'close' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('sessionId is required');
    });

    it('should close session successfully', async () => {
      const result = await tool.execute({ action: 'close', sessionId: 'br-123' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('br-123 closed');
      expect(ipcSend).toHaveBeenCalledWith('browser:close', { sessionId: 'br-123' });
    });
  });
});

// ---------------------------------------------------------------------------
// BrowserMouseClickTool
// ---------------------------------------------------------------------------
describe('BrowserMouseClickTool', () => {
  let tool: BrowserMouseClickTool;
  let ipcSend: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tool = new BrowserMouseClickTool();
    ipcSend = vi.fn().mockResolvedValue({ success: true });
    tool.setIpcSender(ipcSend);
  });

  describe('definition', () => {
    it('should have correct tool name', () => {
      expect(tool.definition.name).toBe('browser_mouse_click');
    });
  });

  describe('execute', () => {
    it('should fail when sessionId is missing', async () => {
      const result = await tool.execute({ selector: '#btn' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('sessionId parameter is required');
    });

    it('should fail when neither selector nor x/y provided', async () => {
      const result = await tool.execute({ sessionId: 'br-123' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Either selector or x/y coordinates are required');
    });

    it('should fail for invalid button', async () => {
      const result = await tool.execute({ sessionId: 'br-123', selector: '#btn', button: 'invalid' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('button must be left, right, or middle');
    });

    it('should fail for invalid clickCount', async () => {
      const result = await tool.execute({ sessionId: 'br-123', selector: '#btn', clickCount: 3 });
      expect(result.success).toBe(false);
      expect(result.error).toContain('clickCount must be 1 or 2');
    });

    it('should click with selector', async () => {
      const result = await tool.execute({ sessionId: 'br-123', selector: '#submit-btn' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Clicked on #submit-btn');
    });

    it('should click with coordinates', async () => {
      const result = await tool.execute({ sessionId: 'br-123', x: 300, y: 200 });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Clicked on (300,200)');
    });

    it('should double-click with clickCount=2', async () => {
      const result = await tool.execute({ sessionId: 'br-123', selector: '#btn', clickCount: 2 });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Double-clicked');
    });

    it('should show button label for non-left clicks', async () => {
      const result = await tool.execute({ sessionId: 'br-123', selector: '#btn', button: 'right' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('(right)');
    });

    it('should pass frameSelector to IPC', async () => {
      await tool.execute({ sessionId: 'br-123', selector: '#btn', frameSelector: 'iframe#myframe' });
      expect(ipcSend).toHaveBeenCalledWith('browser:mouse-click', expect.objectContaining({
        frameSelector: 'iframe#myframe',
      }));
    });
  });
});

// ---------------------------------------------------------------------------
// BrowserInputTool
// ---------------------------------------------------------------------------
describe('BrowserInputTool', () => {
  let tool: BrowserInputTool;
  let ipcSend: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tool = new BrowserInputTool();
    ipcSend = vi.fn().mockResolvedValue({ success: true });
    tool.setIpcSender(ipcSend);
  });

  describe('definition', () => {
    it('should have correct tool name', () => {
      expect(tool.definition.name).toBe('browser_input');
    });
  });

  describe('execute - type', () => {
    it('should fail when sessionId or action is missing', async () => {
      const r1 = await tool.execute({ action: 'type', text: 'hello' });
      expect(r1.success).toBe(false);
      const r2 = await tool.execute({ sessionId: 'br-123', text: 'hello' });
      expect(r2.success).toBe(false);
    });

    it('should fail for invalid action', async () => {
      const result = await tool.execute({ sessionId: 'br-123', action: 'invalid' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('action must be fill, type, or press-key');
    });

    it('should fail when text is missing for type action', async () => {
      const result = await tool.execute({ sessionId: 'br-123', action: 'type' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('text is required for type action');
    });

    it('should type text successfully', async () => {
      const result = await tool.execute({ sessionId: 'br-123', action: 'type', text: 'Hello World' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Typed text');
      expect(ipcSend).toHaveBeenCalledWith('browser:type', { sessionId: 'br-123', text: 'Hello World' });
    });

    it('should pass selector through for targeted typing', async () => {
      const result = await tool.execute({ sessionId: 'br-123', action: 'type', text: 'admin', selector: '#username' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('#username');
      expect(ipcSend).toHaveBeenCalledWith('browser:type', { sessionId: 'br-123', text: 'admin', selector: '#username' });
    });
  });

  describe('execute - fill', () => {
    it('should fail when selector or text is missing', async () => {
      const r1 = await tool.execute({ sessionId: 'br-123', action: 'fill', text: 'admin' });
      expect(r1.success).toBe(false);
      const r2 = await tool.execute({ sessionId: 'br-123', action: 'fill', selector: '#username' });
      expect(r2.success).toBe(false);
      expect(r2.error).toContain('selector and text are required for fill action');
    });

    it('should fill text successfully', async () => {
      const result = await tool.execute({ sessionId: 'br-123', action: 'fill', selector: '#username', text: 'admin' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Filled "admin" into #username');
      expect(ipcSend).toHaveBeenCalledWith('browser:fill', {
        sessionId: 'br-123', selector: '#username', text: 'admin', submit: false,
      });
    });

    it('should pass submit flag through', async () => {
      const result = await tool.execute({ sessionId: 'br-123', action: 'fill', selector: '#password', text: '123456', submit: 'true' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('and submitted');
      expect(ipcSend).toHaveBeenCalledWith('browser:fill', {
        sessionId: 'br-123', selector: '#password', text: '123456', submit: true,
      });
    });
  });

  describe('execute - press-key', () => {
    it('should fail when key is missing', async () => {
      const result = await tool.execute({ sessionId: 'br-123', action: 'press-key' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('key is required for press-key action');
    });

    it('should press key without modifiers', async () => {
      const result = await tool.execute({ sessionId: 'br-123', action: 'press-key', key: 'Enter' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Pressed key: Enter');
    });

    it('should press key with modifiers', async () => {
      const result = await tool.execute({ sessionId: 'br-123', action: 'press-key', key: 'c', modifiers: 'Control,Shift' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Control+Shift');
      expect(ipcSend).toHaveBeenCalledWith('browser:press-key', {
        sessionId: 'br-123', key: 'c', modifiers: ['Control', 'Shift'],
      });
    });
  });
});

// ---------------------------------------------------------------------------
// BrowserScreenshotTool
// ---------------------------------------------------------------------------
describe('BrowserScreenshotTool', () => {
  let tool: BrowserScreenshotTool;
  let ipcSend: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tool = new BrowserScreenshotTool();
    ipcSend = vi.fn().mockResolvedValue({ success: true, data: 'base64data' });
    tool.setIpcSender(ipcSend);
  });

  it('should have correct tool name', () => {
    expect(tool.definition.name).toBe('browser_screenshot');
  });

  it('should fail when sessionId is missing', async () => {
    const result = await tool.execute({});
    expect(result.success).toBe(false);
    expect(result.error).toContain('sessionId parameter is required');
  });

  it('should capture screenshot successfully', async () => {
    const result = await tool.execute({ sessionId: 'br-123' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('Screenshot captured');
    expect(result.output).toContain('base64 PNG');
    expect(ipcSend).toHaveBeenCalledWith('browser:screenshot', { sessionId: 'br-123' });
  });

  it('should handle empty data', async () => {
    ipcSend.mockResolvedValue({ success: true, data: '' });
    const result = await tool.execute({ sessionId: 'br-123' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('0 chars');
  });
});

// ---------------------------------------------------------------------------
// BrowserEvaluateTool
// ---------------------------------------------------------------------------
describe('BrowserEvaluateTool', () => {
  let tool: BrowserEvaluateTool;
  let ipcSend: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tool = new BrowserEvaluateTool();
    ipcSend = vi.fn().mockResolvedValue({ success: true, result: 'Page Title' });
    tool.setIpcSender(ipcSend);
  });

  it('should have correct tool name', () => {
    expect(tool.definition.name).toBe('browser_evaluate');
  });

  it('should fail when sessionId or expression is missing', async () => {
    const r1 = await tool.execute({ expression: '1+1' });
    expect(r1.success).toBe(false);
    const r2 = await tool.execute({ sessionId: 'br-123' });
    expect(r2.success).toBe(false);
  });

  it('should evaluate expression and return string result', async () => {
    const result = await tool.execute({ sessionId: 'br-123', expression: 'document.title' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('Page Title');
  });

  it('should JSON-stringify non-string results', async () => {
    ipcSend.mockResolvedValue({ success: true, result: { key: 'value' } });
    const result = await tool.execute({ sessionId: 'br-123', expression: '({key:"value"})' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('"key"');
    expect(result.output).toContain('"value"');
  });

  it('should pass frameSelector to IPC', async () => {
    await tool.execute({ sessionId: 'br-123', expression: '1', frameSelector: 'iframe#f' });
    expect(ipcSend).toHaveBeenCalledWith('browser:evaluate', expect.objectContaining({
      frameSelector: 'iframe#f',
    }));
  });
});

// ---------------------------------------------------------------------------
// BrowserExtractTool
// ---------------------------------------------------------------------------
describe('BrowserExtractTool', () => {
  let tool: BrowserExtractTool;
  let ipcSend: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tool = new BrowserExtractTool();
    ipcSend = vi.fn().mockResolvedValue({ success: true, content: 'Extracted text' });
    tool.setIpcSender(ipcSend);
  });

  it('should fail when sessionId is missing', async () => {
    const result = await tool.execute({});
    expect(result.success).toBe(false);
    expect(result.error).toContain('sessionId parameter is required');
  });

  it('should extract content successfully', async () => {
    const result = await tool.execute({ sessionId: 'br-123' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('Extracted text');
  });

  it('should return (empty page) when content is empty', async () => {
    ipcSend.mockResolvedValue({ success: true, content: '' });
    const result = await tool.execute({ sessionId: 'br-123' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('(empty page)');
  });
});

// ---------------------------------------------------------------------------
// BrowserWaitTool
// ---------------------------------------------------------------------------
describe('BrowserWaitTool', () => {
  let tool: BrowserWaitTool;
  let ipcSend: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tool = new BrowserWaitTool();
    ipcSend = vi.fn().mockResolvedValue({ success: true });
    tool.setIpcSender(ipcSend);
  });

  it('should fail when sessionId is missing', async () => {
    const result = await tool.execute({ waitType: 'element', selector: '#result' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('sessionId parameter is required');
  });

  it('should fail when waitType=element and selector is missing', async () => {
    const result = await tool.execute({ sessionId: 'br-123', waitType: 'element' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('selector is required when waitType=element');
  });

  it('should wait for element with default timeout', async () => {
    const result = await tool.execute({ sessionId: 'br-123', waitType: 'element', selector: '#result' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('Wait condition met: element (#result)');
    expect(ipcSend).toHaveBeenCalledWith('browser:wait', expect.objectContaining({ timeout: 10000 }));
  });

  it('should wait with custom timeout', async () => {
    const result = await tool.execute({ sessionId: 'br-123', waitType: 'navigation', timeout: 5000 });
    expect(result.success).toBe(true);
    expect(ipcSend).toHaveBeenCalledWith('browser:wait', expect.objectContaining({ timeout: 5000 }));
  });

  it('should wait for networkIdle', async () => {
    const result = await tool.execute({ sessionId: 'br-123', waitType: 'networkIdle' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('networkIdle');
  });
});

// ---------------------------------------------------------------------------
// BrowserQueryTool
// ---------------------------------------------------------------------------
describe('BrowserQueryTool', () => {
  let tool: BrowserQueryTool;
  let ipcSend: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tool = new BrowserQueryTool();
    ipcSend = vi.fn().mockResolvedValue({
      success: true,
      elements: [
        {
          tagName: 'button',
          selector: '#submit',
          text: 'Submit',
          attributes: { id: 'submit', class: 'btn' },
          rect: { x: 10, y: 20, width: 100, height: 40 },
        },
      ],
    });
    tool.setIpcSender(ipcSend);
  });

  it('should fail when sessionId is missing', async () => {
    const result = await tool.execute({});
    expect(result.success).toBe(false);
    expect(result.error).toContain('sessionId parameter is required');
  });

  it('should query elements and format output', async () => {
    const result = await tool.execute({ sessionId: 'br-123' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('1 element(s)');
    expect(result.output).toContain('<button');
    expect(result.output).toContain('Submit');
    expect(result.output).toContain('#submit');
  });

  it('should return no elements message', async () => {
    ipcSend.mockResolvedValue({ success: true, elements: [] });
    const result = await tool.execute({ sessionId: 'br-123' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('No elements found');
  });

  it('should include detail info when detail=true', async () => {
    ipcSend.mockResolvedValue({
      success: true,
      elements: [{
        tagName: 'input',
        selector: '#name',
        text: '',
        attributes: { type: 'text' },
        rect: { x: 0, y: 0, width: 200, height: 30 },
        detail: {
          computedStyle: { display: 'block', visibility: 'visible', position: 'static' },
          outerHTML: '<input type="text" id="name">',
          value: 'John',
          href: null,
          src: null,
          checked: false,
          disabled: true,
          readOnly: false,
          required: true,
        },
      }],
    });
    const result = await tool.execute({ sessionId: 'br-123', detail: true });
    expect(result.success).toBe(true);
    expect(result.output).toContain('display=block');
    expect(result.output).toContain('value: John');
    expect(result.output).toContain('disabled');
    expect(result.output).toContain('required');
  });

  it('should include iframe context in output when elements found', async () => {
    ipcSend.mockResolvedValue({
      success: true,
      elements: [{
        tagName: 'button', selector: '#btn', text: 'Click',
        attributes: {}, rect: { x: 0, y: 0, width: 100, height: 30 },
      }],
    });
    const result = await tool.execute({ sessionId: 'br-123', frameSelector: 'iframe#f' });
    expect(result.output).toContain('iframe "iframe#f"');
  });

  it('should truncate long text', async () => {
    const longText = 'A'.repeat(100);
    ipcSend.mockResolvedValue({
      success: true,
      elements: [{
        tagName: 'p', selector: 'p', text: longText,
        attributes: {}, rect: { x: 0, y: 0, width: 100, height: 20 },
      }],
    });
    const result = await tool.execute({ sessionId: 'br-123' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('...');
  });
});

// ---------------------------------------------------------------------------
// BrowserStorageTool
// ---------------------------------------------------------------------------
describe('BrowserStorageTool', () => {
  let tool: BrowserStorageTool;
  let ipcSend: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tool = new BrowserStorageTool();
    ipcSend = vi.fn().mockResolvedValue({ success: true, data: { theme: 'dark' } });
    tool.setIpcSender(ipcSend);
  });

  it('should fail when required params are missing', async () => {
    const r1 = await tool.execute({ storageType: 'localStorage', action: 'list' });
    expect(r1.success).toBe(false);
    const r2 = await tool.execute({ sessionId: 'br-123', action: 'list' });
    expect(r2.success).toBe(false);
    const r3 = await tool.execute({ sessionId: 'br-123', storageType: 'localStorage' });
    expect(r3.success).toBe(false);
  });

  it('should fail for invalid storageType', async () => {
    const result = await tool.execute({ sessionId: 'br-123', storageType: 'invalid', action: 'list' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('storageType must be localStorage, sessionStorage, or cookie');
  });

  it('should fail for invalid action', async () => {
    const result = await tool.execute({ sessionId: 'br-123', storageType: 'localStorage', action: 'invalid' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('action must be list, get, set, or remove');
  });

  it('should fail when key is missing for get/set/remove', async () => {
    for (const action of ['get', 'set', 'remove']) {
      const result = await tool.execute({ sessionId: 'br-123', storageType: 'localStorage', action });
      expect(result.success).toBe(false);
      expect(result.error).toContain('key is required');
    }
  });

  it('should fail when value is missing for set action', async () => {
    const result = await tool.execute({ sessionId: 'br-123', storageType: 'localStorage', action: 'set', key: 'theme' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('value is required for action: set');
  });

  it('should list storage successfully', async () => {
    const result = await tool.execute({ sessionId: 'br-123', storageType: 'localStorage', action: 'list' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('localStorage list');
  });

  it('should handle string data from IPC', async () => {
    ipcSend.mockResolvedValue({ success: true, data: 'raw string data' });
    const result = await tool.execute({ sessionId: 'br-123', storageType: 'cookie', action: 'list' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('raw string data');
  });
});

// ---------------------------------------------------------------------------
// BrowserInteractTool
// ---------------------------------------------------------------------------
describe('BrowserInteractTool', () => {
  let tool: BrowserInteractTool;
  let ipcSend: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tool = new BrowserInteractTool();
    ipcSend = vi.fn().mockResolvedValue({ success: true });
    tool.setIpcSender(ipcSend);
  });

  it('should fail when sessionId or action is missing', async () => {
    const r1 = await tool.execute({ action: 'hover' });
    expect(r1.success).toBe(false);
    const r2 = await tool.execute({ sessionId: 'br-123' });
    expect(r2.success).toBe(false);
  });

  it('should fail for invalid action', async () => {
    const result = await tool.execute({ sessionId: 'br-123', action: 'invalid' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('action must be hover, scroll, or select');
  });

  describe('hover', () => {
    it('should fail when selector is missing', async () => {
      const result = await tool.execute({ sessionId: 'br-123', action: 'hover' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('selector is required for hover action');
    });

    it('should hover successfully', async () => {
      const result = await tool.execute({ sessionId: 'br-123', action: 'hover', selector: '.menu' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Hovered over element: .menu');
    });
  });

  describe('scroll', () => {
    it('should fail when direction is missing', async () => {
      const result = await tool.execute({ sessionId: 'br-123', action: 'scroll' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('direction is required for scroll action');
    });

    it('should fail for invalid direction', async () => {
      const result = await tool.execute({ sessionId: 'br-123', action: 'scroll', direction: 'diagonal' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('direction must be up, down, left, or right');
    });

    it('should scroll with default amount 300', async () => {
      const result = await tool.execute({ sessionId: 'br-123', action: 'scroll', direction: 'down' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Scrolled down by 300px');
      expect(ipcSend).toHaveBeenCalledWith('browser:scroll', expect.objectContaining({ amount: 300 }));
    });

    it('should scroll with custom amount', async () => {
      const result = await tool.execute({ sessionId: 'br-123', action: 'scroll', direction: 'up', amount: 500 });
      expect(result.success).toBe(true);
      expect(result.output).toContain('500px');
    });
  });

  describe('select', () => {
    it('should fail when selector or value is missing', async () => {
      const r1 = await tool.execute({ sessionId: 'br-123', action: 'select', selector: '#country' });
      expect(r1.success).toBe(false);
      const r2 = await tool.execute({ sessionId: 'br-123', action: 'select', value: 'us' });
      expect(r2.success).toBe(false);
    });

    it('should select value successfully', async () => {
      const result = await tool.execute({ sessionId: 'br-123', action: 'select', selector: '#country', value: 'us' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Selected value "us" in #country');
    });
  });
});

// ---------------------------------------------------------------------------
// BrowserDragTool
// ---------------------------------------------------------------------------
describe('BrowserDragTool', () => {
  let tool: BrowserDragTool;
  let ipcSend: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tool = new BrowserDragTool();
    ipcSend = vi.fn().mockResolvedValue({ success: true });
    tool.setIpcSender(ipcSend);
  });

  it('should fail when sessionId is missing', async () => {
    const result = await tool.execute({ fromSelector: '#a', toSelector: '#b' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('sessionId parameter is required');
  });

  it('should fail when fromSelector and fromX/fromY are both missing', async () => {
    const result = await tool.execute({ sessionId: 'br-123', toSelector: '#b' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('fromSelector or fromX/fromY');
  });

  it('should fail when toSelector and toX/toY are both missing', async () => {
    const result = await tool.execute({ sessionId: 'br-123', fromSelector: '#a' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('toSelector or toX/toY');
  });

  it('should drag with selectors', async () => {
    const result = await tool.execute({ sessionId: 'br-123', fromSelector: '#source', toSelector: '#target' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('Dragged from #source to #target');
  });

  it('should drag with coordinates', async () => {
    const result = await tool.execute({ sessionId: 'br-123', fromX: 100, fromY: 200, toX: 400, toY: 300 });
    expect(result.success).toBe(true);
    expect(result.output).toContain('Dragged from (100,200) to (400,300)');
  });

  it('should drag with mixed selector and coordinates', async () => {
    const result = await tool.execute({ sessionId: 'br-123', fromSelector: '#source', toX: 400, toY: 300 });
    expect(result.success).toBe(true);
    expect(result.output).toContain('Dragged from #source to (400,300)');
  });
});

// ---------------------------------------------------------------------------
// BrowserApiRequestTool
// ---------------------------------------------------------------------------
describe('BrowserApiRequestTool', () => {
  let tool: BrowserApiRequestTool;
  let ipcSend: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tool = new BrowserApiRequestTool();
    ipcSend = vi.fn().mockResolvedValue({
      success: true,
      status: 200,
      statusText: 'OK',
      responseHeaders: { 'content-type': 'application/json' },
      body: '{"result":"ok"}',
    });
    tool.setIpcSender(ipcSend);
  });

  it('should fail when sessionId or url is missing', async () => {
    const r1 = await tool.execute({ url: '/api/data' });
    expect(r1.success).toBe(false);
    const r2 = await tool.execute({ sessionId: 'br-123' });
    expect(r2.success).toBe(false);
  });

  it('should fail for invalid bodyType', async () => {
    const result = await tool.execute({ sessionId: 'br-123', url: '/api', bodyType: 'xml' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('bodyType must be one of: json, form, raw');
  });

  it('should fail when body is not valid JSON for json bodyType', async () => {
    const result = await tool.execute({ sessionId: 'br-123', url: '/api', bodyType: 'json', body: 'not-json' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('body must be a valid JSON string');
  });

  it('should fail when body is not valid JSON for form bodyType', async () => {
    const result = await tool.execute({ sessionId: 'br-123', url: '/api', bodyType: 'form', body: 'not-json' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('body must be a valid JSON string');
  });

  it('should send GET request by default', async () => {
    const result = await tool.execute({ sessionId: 'br-123', url: '/api/data' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('GET /api/data');
    expect(result.output).toContain('200 OK');
    expect(ipcSend).toHaveBeenCalledWith('browser:api-request', expect.objectContaining({ method: 'GET' }));
  });

  it('should send POST request with body', async () => {
    const result = await tool.execute({
      sessionId: 'br-123', url: '/api', method: 'POST', bodyType: 'json', body: '{"key":"value"}',
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain('POST /api');
    expect(ipcSend).toHaveBeenCalledWith('browser:api-request', expect.objectContaining({ method: 'POST' }));
  });

  it('should auto-detect bodyType as json when body is provided', async () => {
    await tool.execute({ sessionId: 'br-123', url: '/api', body: '{"key":"value"}' });
    expect(ipcSend).toHaveBeenCalledWith('browser:api-request', expect.objectContaining({ bodyType: 'json' }));
  });

  it('should truncate long response body', async () => {
    ipcSend.mockResolvedValue({
      success: true, status: 200, statusText: 'OK',
      body: 'A'.repeat(3000),
    });
    const result = await tool.execute({ sessionId: 'br-123', url: '/api' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('truncated');
  });

  it('should allow raw bodyType without JSON validation', async () => {
    const result = await tool.execute({ sessionId: 'br-123', url: '/api', bodyType: 'raw', body: 'plain text' });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// BrowserDebugTool
// ---------------------------------------------------------------------------
describe('BrowserDebugTool', () => {
  let tool: BrowserDebugTool;
  let ipcSend: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tool = new BrowserDebugTool();
    ipcSend = vi.fn().mockResolvedValue({ success: true, data: [] });
    tool.setIpcSender(ipcSend);
  });

  it('should fail when sessionId, target, or action is missing', async () => {
    const r1 = await tool.execute({ target: 'console', action: 'list' });
    expect(r1.success).toBe(false);
    const r2 = await tool.execute({ sessionId: 'br-123', action: 'list' });
    expect(r2.success).toBe(false);
    const r3 = await tool.execute({ sessionId: 'br-123', target: 'console' });
    expect(r3.success).toBe(false);
  });

  it('should fail for invalid target', async () => {
    const result = await tool.execute({ sessionId: 'br-123', target: 'invalid', action: 'list' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('target must be console, network, or dialog');
  });

  describe('console target', () => {
    it('should fail for invalid action', async () => {
      const result = await tool.execute({ sessionId: 'br-123', target: 'console', action: 'invalid' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('console action must be start, stop, list, or clear');
    });

    it('should start console monitoring', async () => {
      const result = await tool.execute({ sessionId: 'br-123', target: 'console', action: 'start' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Console monitoring started');
    });

    it('should stop console monitoring', async () => {
      const result = await tool.execute({ sessionId: 'br-123', target: 'console', action: 'stop' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Console monitoring stopped');
    });

    it('should clear console', async () => {
      const result = await tool.execute({ sessionId: 'br-123', target: 'console', action: 'clear' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Console monitoring cleared');
    });

    it('should list console logs', async () => {
      ipcSend.mockResolvedValue({
        success: true,
        data: [
          { level: 'error', text: 'Something failed', timestamp: 1000, url: 'app.js', line: 42 },
          { level: 'log', text: 'Hello', timestamp: 2000 },
        ],
      });
      const result = await tool.execute({ sessionId: 'br-123', target: 'console', action: 'list', level: 'error' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('2 entries');
      expect(result.output).toContain('[ERROR]');
      expect(result.output).toContain('[LOG]');
      expect(result.output).toContain('app.js:42');
    });

    it('should return no logs message when empty', async () => {
      ipcSend.mockResolvedValue({ success: true, data: [] });
      const result = await tool.execute({ sessionId: 'br-123', target: 'console', action: 'list' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('No console logs captured');
    });
  });

  describe('network target', () => {
    it('should fail for invalid action', async () => {
      const result = await tool.execute({ sessionId: 'br-123', target: 'network', action: 'invalid' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('network action must be start, stop, list, or clear');
    });

    it('should start network monitoring', async () => {
      const result = await tool.execute({ sessionId: 'br-123', target: 'network', action: 'start' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Network monitoring started');
    });

    it('should list network requests', async () => {
      ipcSend.mockResolvedValue({ success: true, data: [{ url: '/api/data', status: 200 }] });
      const result = await tool.execute({ sessionId: 'br-123', target: 'network', action: 'list', filter: '/api/' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Network requests');
    });

    it('should handle string data from network list', async () => {
      ipcSend.mockResolvedValue({ success: true, data: 'GET /api 200' });
      const result = await tool.execute({ sessionId: 'br-123', target: 'network', action: 'list' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('GET /api 200');
    });
  });

  describe('dialog target', () => {
    it('should fail for invalid action', async () => {
      const result = await tool.execute({ sessionId: 'br-123', target: 'dialog', action: 'invalid' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('dialog action must be list, accept, dismiss, set-auto, or clear-auto');
    });

    it('should list pending dialogs', async () => {
      ipcSend.mockResolvedValue({
        success: true,
        data: [{ type: 'alert', message: 'Hello!' }, { type: 'confirm', message: 'Continue?' }],
      });
      const result = await tool.execute({ sessionId: 'br-123', target: 'dialog', action: 'list' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('2');
      expect(result.output).toContain('type=alert');
      expect(result.output).toContain('type=confirm');
    });

    it('should return no pending dialogs', async () => {
      ipcSend.mockResolvedValue({ success: true, data: [] });
      const result = await tool.execute({ sessionId: 'br-123', target: 'dialog', action: 'list' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('No pending dialogs');
    });

    it('should accept dialog', async () => {
      ipcSend.mockResolvedValue({ success: true, data: { type: 'confirm', action: 'accepted' } });
      const result = await tool.execute({ sessionId: 'br-123', target: 'dialog', action: 'accept' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('accepted');
    });

    it('should dismiss dialog', async () => {
      ipcSend.mockResolvedValue({ success: true, data: { type: 'alert', action: 'dismissed' } });
      const result = await tool.execute({ sessionId: 'br-123', target: 'dialog', action: 'dismiss' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('dismissed');
    });

    it('should set auto-respond mode', async () => {
      const result = await tool.execute({ sessionId: 'br-123', target: 'dialog', action: 'set-auto', promptText: 'ok' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Auto-respond mode enabled');
    });

    it('should clear auto-respond mode', async () => {
      const result = await tool.execute({ sessionId: 'br-123', target: 'dialog', action: 'clear-auto' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Auto-respond mode cleared');
    });
  });
});

// ---------------------------------------------------------------------------
// BrowserFileTool
// ---------------------------------------------------------------------------
describe('BrowserFileTool', () => {
  let tool: BrowserFileTool;
  let ipcSend: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tool = new BrowserFileTool();
    ipcSend = vi.fn().mockResolvedValue({ success: true, data: {} });
    tool.setIpcSender(ipcSend);
  });

  it('should fail when sessionId or action is missing', async () => {
    const r1 = await tool.execute({ action: 'upload' });
    expect(r1.success).toBe(false);
    const r2 = await tool.execute({ sessionId: 'br-123' });
    expect(r2.success).toBe(false);
  });

  it('should fail for invalid action', async () => {
    const result = await tool.execute({ sessionId: 'br-123', action: 'invalid' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('action must be upload, download, or set-path');
  });

  describe('upload', () => {
    it('should fail when selector is missing', async () => {
      const result = await tool.execute({ sessionId: 'br-123', action: 'upload', filePaths: 'photo.png' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('selector is required for upload action');
    });

    it('should fail when filePaths is missing', async () => {
      const result = await tool.execute({ sessionId: 'br-123', action: 'upload', selector: 'input[type=file]' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('filePaths is required for upload action');
    });

    it('should upload files successfully', async () => {
      ipcSend.mockResolvedValue({ success: true, data: { uploaded: 2 } });
      const result = await tool.execute({
        sessionId: 'br-123', action: 'upload', selector: 'input[type=file]', filePaths: 'a.png, b.png',
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Successfully uploaded 2 file(s)');
    });
  });

  describe('download', () => {
    it('should fail when url is missing', async () => {
      const result = await tool.execute({ sessionId: 'br-123', action: 'download' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('url is required for download action');
    });

    it('should download successfully', async () => {
      ipcSend.mockResolvedValue({
        success: true,
        data: {
          downloadPath: '/tmp/downloads',
          downloads: [{ filename: 'report.pdf', state: 'completed', path: '/tmp/downloads/report.pdf' }],
        },
      });
      const result = await tool.execute({ sessionId: 'br-123', action: 'download', url: 'https://example.com/report.pdf' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('/tmp/downloads');
      expect(result.output).toContain('report.pdf');
    });

    it('should download without downloads list', async () => {
      ipcSend.mockResolvedValue({ success: true, data: { downloadPath: '/tmp' } });
      const result = await tool.execute({ sessionId: 'br-123', action: 'download', url: 'https://example.com/file' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('/tmp');
    });
  });

  describe('set-path', () => {
    it('should fail when filePaths is missing', async () => {
      const result = await tool.execute({ sessionId: 'br-123', action: 'set-path' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('filePaths is required for set-path action');
    });

    it('should set download path successfully', async () => {
      ipcSend.mockResolvedValue({ success: true, data: { downloadPath: 'C:/Downloads' } });
      const result = await tool.execute({ sessionId: 'br-123', action: 'set-path', filePaths: 'C:/Downloads' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('C:/Downloads');
    });
  });
});
