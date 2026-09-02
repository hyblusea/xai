import { WebContents, webContents, session, app } from 'electron';
import * as path from 'path';
import { EventEmitter } from 'events';
import { existsSync, mkdirSync } from 'fs';

export interface BrowserSession {
  id: string;
  webContentsId: number;
  url: string;
  title: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  attached: boolean;
}

export class BrowserSessionManager extends EventEmitter {
  private sessions = new Map<string, BrowserSession>();
  private webviewReadyWaiters = new Map<string, { resolve: () => void; reject: (err: Error) => void }[]>();
  private networkLogs = new Map<string, Array<{ requestId: string; method: string; url: string; status?: number; mimeType?: string; resourceType?: string }>>();
  private networkMonitoring = new Map<string, boolean>();
  private consoleLogs = new Map<string, Array<{ level: string; text: string; timestamp: number; url?: string; line?: number }>>();
  private consoleMonitoring = new Map<string, boolean>();
  private _consoleHandler = new Map<string, (...args: any[]) => void>();
  private pendingDialogs = new Map<string, { type: string; message: string; defaultPrompt?: string; resolve: (action: string, promptText?: string) => void }[]>();
  private autoDialogAction = new Map<string, { action: string; promptText?: string }>();
  private downloads = new Map<string, Array<{ id: string; filename: string; path: string; state: string; totalBytes: number; receivedBytes: number }>>();
  private downloadPath = '';

  createSession(id: string, url?: string): BrowserSession {
    const session: BrowserSession = {
      id,
      webContentsId: 0, // will be set when renderer registers the webview
      url: url || 'about:blank',
      title: '',
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      attached: false,
    };
    this.sessions.set(id, session);
    console.log(`[BrowserSession] Created session ${id} url=${url || 'about:blank'}`);
    return session;
  }

  registerWebView(sessionId: string, webContentsId: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.warn(`[BrowserSession] Session ${sessionId} not found for registerWebView`);
      return;
    }
    session.webContentsId = webContentsId;
    console.log(`[BrowserSession] Registered webview ${webContentsId} for session ${sessionId}`);
    this.attachCDP(session);

    // Resolve any pending waiters for this session
    const waiters = this.webviewReadyWaiters.get(sessionId);
    if (waiters) {
      for (const w of waiters) w.resolve();
      this.webviewReadyWaiters.delete(sessionId);
    }
  }

  async waitForWebView(sessionId: string, timeoutMs = 15000): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    if (session.webContentsId > 0) return;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiters = this.webviewReadyWaiters.get(sessionId);
        if (waiters) {
          const idx = waiters.findIndex(w => w.resolve === resolve);
          if (idx >= 0) waiters.splice(idx, 1);
        }
        reject(new Error(`Timeout waiting for webview registration: ${sessionId}`));
      }, timeoutMs);

      const entry = {
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (err: Error) => { clearTimeout(timer); reject(err); },
      };

      if (!this.webviewReadyWaiters.has(sessionId)) {
        this.webviewReadyWaiters.set(sessionId, []);
      }
      this.webviewReadyWaiters.get(sessionId)!.push(entry);
    });
  }

  private attachCDP(session: BrowserSession): void {
    if (session.webContentsId === 0) return;

    const wc = webContents.fromId(session.webContentsId);
    if (!wc) {
      console.error(`[BrowserSession] webContents ${session.webContentsId} not found`);
      return;
    }

    // attach debugger for CDP
    try {
      if (!wc.debugger.isAttached()) {
        wc.debugger.attach('1.3');
      }
      session.attached = true;
      console.log(`[BrowserSession] CDP attached for session ${session.id}`);
    } catch (err) {
      console.error(`[BrowserSession] Failed to attach CDP for ${session.id}:`, err);
      return;
    }

    // Listen for navigation events → forward to renderer
    wc.on('page-title-updated', (_e, title) => {
      session.title = title;
      this.emit('title-update', { sessionId: session.id, title });
    });

    wc.on('did-start-navigation', (_e, url, _isInPlace, isMainFrame) => {
      if (isMainFrame) {
        session.isLoading = true;
        session.url = url;
        this.emit('url-update', { sessionId: session.id, url, isLoading: true });
      }
    });

    wc.on('did-navigate', (_e, url) => {
      session.url = url;
      session.isLoading = false;
      session.canGoBack = wc.canGoBack();
      session.canGoForward = wc.canGoForward();
      this.emit('navigation-complete', {
        sessionId: session.id,
        url,
        canGoBack: session.canGoBack,
        canGoForward: session.canGoForward,
        title: session.title,
      });
    });

    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (isMainFrame) {
        session.url = url;
        session.canGoBack = wc.canGoBack();
        session.canGoForward = wc.canGoForward();
        this.emit('navigation-complete', {
          sessionId: session.id,
          url,
          canGoBack: session.canGoBack,
          canGoForward: session.canGoForward,
          title: session.title,
        });
      }
    });

    wc.on('did-start-loading', () => {
      session.isLoading = true;
      this.emit('loading-state', { sessionId: session.id, isLoading: true });
    });

    wc.on('did-stop-loading', () => {
      session.isLoading = false;
      session.canGoBack = wc.canGoBack();
      session.canGoForward = wc.canGoForward();
      this.emit('loading-state', { sessionId: session.id, isLoading: false });
    });

    // CDP event monitoring (Network, Console, etc.)
    wc.debugger.on('message', (_event, method, params) => {
      this.emit('cdp-event', { sessionId: session.id, method, params });
      // Collect console logs
      if (method === 'Runtime.consoleAPICalled' && this.consoleMonitoring.get(session.id)) {
        const logs = this.consoleLogs.get(session.id);
        if (logs) {
          const text = (params.args || []).map((a: any) => a.value ?? a.description ?? a.preview?.properties?.map((p: any) => `${p.name}: ${p.value}`).join(', ') ?? String(a.type)).join(' ');
          logs.push({
            level: params.type || 'log',
            text,
            timestamp: params.timestamp || Date.now(),
            url: params.url,
            line: params.lineNumber,
          });
          // Keep max 500 entries
          if (logs.length > 500) logs.splice(0, logs.length - 500);
        }
      }
    });

    // Handle native dialogs (alert/confirm/prompt/beforeunload)
    wc.on('-will-present-dialog' as any, (_e: any, type: string, message: string, _value: string, _secOrigin: string, _secTitle: string, _checkbox: string, _checkboxChecked: boolean, callback: (action: string, promptText?: string) => void) => {
      const auto = this.autoDialogAction.get(session.id);
      if (auto) {
        callback(auto.action, auto.promptText);
        return;
      }
      // Queue the dialog for manual handling
      if (!this.pendingDialogs.has(session.id)) this.pendingDialogs.set(session.id, []);
      this.pendingDialogs.get(session.id)!.push({
        type, message,
        resolve: callback,
      });
      this.emit('dialog-detected', { sessionId: session.id, type, message });
    });

    // Download tracking
    const ses = session.webContentsId > 0 ? wc.session : null;
    if (ses) {
      ses.on('will-download', (_event: any, item: any) => {
        if (!this.downloads.has(session.id)) this.downloads.set(session.id, []);
        const entry = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          filename: item.getFilename(),
          path: '',
          state: 'progressing',
          totalBytes: item.getTotalBytes(),
          receivedBytes: 0,
        };
        const list = this.downloads.get(session.id)!;
        list.push(entry);
        if (list.length > 100) list.shift();

        // Auto-set save path to downloads directory
        const dlDir = this.getDownloadPath();
        item.setSavePath(path.join(dlDir, item.getFilename()));
        entry.path = item.getSavePath();

        item.on('updated', (_e: any, state: string) => {
          entry.state = state;
          entry.receivedBytes = item.getReceivedBytes();
        });
        item.once('done', (_e: any, state: string) => {
          entry.state = state;
          entry.path = item.getSavePath();
          entry.receivedBytes = item.getReceivedBytes();
          this.emit('browser-download', { sessionId: session.id, ...entry });
        });
      });
    }

    wc.debugger.on('detach', () => {
      session.attached = false;
      console.log(`[BrowserSession] CDP detached for session ${session.id}`);
    });
  }

  // ── CDP Command ──
  async sendCDPCommand(
    sessionId: string,
    method: string,
    params?: Record<string, unknown>
  ): Promise<unknown> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    const wc = webContents.fromId(session.webContentsId);
    if (!wc) throw new Error(`webContents not found for ${sessionId}`);

    if (!wc.debugger.isAttached()) {
      wc.debugger.attach('1.3');
      session.attached = true;
    }

    return wc.debugger.sendCommand(method as any, params);
  }

  // ── High-level operations ──
  async navigate(sessionId: string, url: string): Promise<void> {
    const wc = this.getWC(sessionId);
    await wc.loadURL(url);
  }

  goBack(sessionId: string): void {
    const wc = this.getWC(sessionId);
    if (wc.canGoBack()) wc.goBack();
  }

  goForward(sessionId: string): void {
    const wc = this.getWC(sessionId);
    if (wc.canGoForward()) wc.goForward();
  }

  reload(sessionId: string): void {
    this.getWC(sessionId).reload();
  }

  async screenshot(sessionId: string): Promise<string> {
    const result = await this.sendCDPCommand(sessionId, 'Page.captureScreenshot', {
      format: 'png',
    }) as { data: string };
    return result.data;
  }

  // ── Unified mouse click (replaces click, rightClick, doubleClick, coordinateClick) ──
  async mouseClick(sessionId: string, opts: {
    selector?: string; x?: number; y?: number;
    button?: string; clickCount?: number; frameSelector?: string;
  }): Promise<void> {
    const button = opts.button || 'left';
    const clickCount = opts.clickCount || 1;
    let cx = opts.x ?? 0;
    let cy = opts.y ?? 0;

    // Ensure the guest widget is focused so the click (and subsequent typing)
    // actually lands and takes effect in Electron.
    this.getWC(sessionId).focus();

    if (opts.frameSelector) {
      const offset = await this.getIframeOffset(sessionId, opts.frameSelector);
      cx += offset.x;
      cy += offset.y;
    } else if (opts.selector) {
      const pos = await this.getElementCenter(sessionId, opts.selector);
      cx = pos.x; cy = pos.y;
    }

    await this.sendCDPCommand(sessionId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy });
    await this.sendCDPCommand(sessionId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button, clickCount });
    await this.sendCDPCommand(sessionId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button, clickCount });
  }

  async type(sessionId: string, text: string, selector?: string): Promise<void> {
    const wc = this.getWC(sessionId);
    // Electron: CDP Input.insertText goes through the focused render widget's
    // TextInputClient. If the <webview> guest widget isn't focused (e.g. IDE
    // chat panel holds OS focus), insertText is silently dropped — force focus.
    wc.focus();

    // Optionally focus a specific element instead of relying on prior click state
    if (selector) {
      const focused = await this.evaluate(sessionId, `(function() {
        var el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return 'not-found';
        el.scrollIntoView({ block: 'center', inline: 'center' });
        el.focus();
        return 'ok';
      })()`);
      if (focused !== 'ok') throw new Error(`Element not found for type: ${selector}`);
    }

    // Ensure an editable element actually has DOM focus before typing
    const focusState = await this.evaluate(sessionId, `(function() {
      var el = document.activeElement;
      if (!el || el === document.body) return { editable: false, tag: el ? el.tagName : 'NONE' };
      var editable = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
      return { editable: editable, tag: el.tagName };
    })()`) as { editable: boolean; tag: string };

    if (focusState?.editable) {
      // Path 1: bulk insert via CDP (fast, fires real beforeinput/input events)
      await this.sendCDPCommand(sessionId, 'Input.insertText', { text });
      if (await this.verifyTypedText(sessionId, text)) {
        await this.dispatchInputEvents(sessionId);
        return;
      }

      // Path 2: per-character key events (works when insertText is dropped)
      for (const char of text) {
        await this.sendCDPCommand(sessionId, 'Input.dispatchKeyEvent', { type: 'keyDown', text: char });
        await this.sendCDPCommand(sessionId, 'Input.dispatchKeyEvent', { type: 'keyUp' });
      }
      if (await this.verifyTypedText(sessionId, text)) {
        await this.dispatchInputEvents(sessionId);
        return;
      }
    }

    // Path 3: last resort — set value via native setter + dispatch events.
    // Works with React/Vue controlled inputs regardless of widget focus.
    const ok = await this.evaluate(sessionId, `(function() {
      var el = document.activeElement;
      if (!el) return false;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        var desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) {
          desc.set.call(el, (el.value || '') + ${JSON.stringify(text)});
        } else {
          el.value = (el.value || '') + ${JSON.stringify(text)};
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      if (el.isContentEditable) {
        el.textContent = (el.textContent || '') + ${JSON.stringify(text)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }
      return false;
    })()`);

    if (!ok) {
      throw new Error(`No editable element is focused (active element: ${focusState?.tag || 'unknown'}). Click the target input first or pass a selector.`);
    }
  }

  /** Check whether the focused editable element's content ends with the typed text. */
  private async verifyTypedText(sessionId: string, text: string): Promise<boolean> {
    const result = await this.evaluate(sessionId, `(function() {
      var el = document.activeElement;
      if (!el) return false;
      var v = (typeof el.value === 'string') ? el.value : (el.textContent || '');
      return v.indexOf(${JSON.stringify(text)}) !== -1;
    })()`);
    return result === true;
  }

  /** Dispatch input/change events so frameworks like AngularJS detect the value change. */
  private async dispatchInputEvents(sessionId: string): Promise<void> {
    await this.evaluate(sessionId, `(function() {
      var el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    })()`);
  }

  /**
   * Fill a form field deterministically: replaces the current value with `text`.
   * Unlike type(), this does not rely on keyboard focus — the primary path uses
   * the native value setter + real events, which works with React/Vue/Angular
   * controlled inputs. Falls back to real CDP click + select-all + insertText.
   * When submit=true, presses Enter on the field after filling.
   */
  async fill(sessionId: string, selector: string, text: string, submit = false): Promise<void> {
    const wc = this.getWC(sessionId);
    wc.focus();

    const safeSel = JSON.stringify(selector);
    const safeText = JSON.stringify(text);

    // Locate the element, scroll into view, focus it, and check editability
    const state = await this.evaluate(sessionId, `(function() {
      var el = document.querySelector(${safeSel});
      if (!el) return { status: 'not-found' };
      if (el.disabled) return { status: 'disabled' };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.focus();
      var editable = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
      if (!editable) return { status: 'not-editable', tag: el.tagName };
      return { status: 'ok', tag: el.tagName, readOnly: !!el.readOnly };
    })()`) as { status: string; tag?: string; readOnly?: boolean };

    if (state?.status === 'not-found') throw new Error(`Element not found for fill: ${selector}`);
    if (state?.status === 'disabled') throw new Error(`Element is disabled: ${selector}`);
    if (state?.status === 'not-editable') throw new Error(`Element is not editable (tag: ${state.tag}): ${selector}`);
    if (state?.readOnly) throw new Error(`Element is readOnly: ${selector}`);

    const verify = async (): Promise<boolean> => {
      const v = await this.evaluate(sessionId, `(function() {
        var el = document.querySelector(${safeSel});
        if (!el) return null;
        return (typeof el.value === 'string') ? el.value : (el.textContent || '');
      })()`);
      return v === text;
    };

    // Path 1 (deterministic): native value setter + real events. Bypasses all
    // focus/IME requirements and triggers framework state updates.
    const setOk = await this.evaluate(sessionId, `(function() {
      var el = document.querySelector(${safeSel});
      if (!el) return false;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        var desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) desc.set.call(el, ${safeText}); else el.value = ${safeText};
      } else if (el.isContentEditable) {
        el.textContent = ${safeText};
      } else return false;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);

    if (setOk && await verify()) {
      if (submit) await this.submitFilled(sessionId, selector);
      return;
    }

    // Path 2: real CDP interaction — click element center, select all, insertText
    const pos = await this.getElementCenter(sessionId, selector);
    await this.sendCDPCommand(sessionId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y });
    await this.sendCDPCommand(sessionId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
    await this.sendCDPCommand(sessionId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
    // Select existing content so insertText replaces it
    await this.sendCDPCommand(sessionId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await this.sendCDPCommand(sessionId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await this.sendCDPCommand(sessionId, 'Input.insertText', { text });

    if (await verify()) {
      if (submit) await this.submitFilled(sessionId, selector);
      return;
    }

    throw new Error(`Fill failed: value of ${selector} is not "${text}". The element may be controlled by a custom component.`);
  }

  /** Press Enter on a filled field via real CDP key events (triggers form submit / login handlers). */
  private async submitFilled(sessionId: string, selector: string): Promise<void> {
    await this.evaluate(sessionId, `(function() {
      var el = document.querySelector(${JSON.stringify(selector)});
      if (el) el.focus();
    })()`);
    await this.pressKey(sessionId, 'Enter');
  }

  async evaluate(sessionId: string, expression: string, frameSelector?: string): Promise<unknown> {
    if (frameSelector) {
      // Wrap expression to execute in iframe context (same-origin iframes only)
      const safeSel = JSON.stringify(frameSelector);
      const safeLabel = frameSelector.replace(/"/g, '\\"');
      const wrappedJs = `(function() {
        var __f = document.querySelector(${safeSel});
        if (!__f || !__f.contentWindow) throw new Error('iframe not found or inaccessible: ${safeLabel}');
        try {
          return __f.contentWindow.eval(${JSON.stringify(expression)});
        } catch(e) {
          throw new Error('Cannot access iframe content (cross-origin?): ' + e.message);
        }
      })()`;
      const result = await this.sendCDPCommand(sessionId, 'Runtime.evaluate', {
        expression: wrappedJs,
        returnByValue: true,
        awaitPromise: true,
      }) as { result?: { value?: unknown } };
      return result.result?.value;
    }
    const result = await this.sendCDPCommand(sessionId, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }) as { result?: { value?: unknown } };
    return result.result?.value;
  }

  async extractContent(sessionId: string): Promise<string> {
    return this.getAccessibilityTree(sessionId);
  }

  /**
   * 获取页面的无障碍树（Accessibility Tree），用于 Computer Use 场景。
   * 通过 CDP Accessibility.getFullAXTree 获取，返回结构化文本。
   */
  async getAccessibilityTree(sessionId: string): Promise<string> {
    // 确保 CDP debugger 已附加
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    const wc = webContents.fromId(session.webContentsId);
    if (!wc) throw new Error(`webContents not found for ${sessionId}`);
    if (!wc.debugger.isAttached()) {
      wc.debugger.attach('1.3');
      session.attached = true;
    }

    // 先启用 Accessibility domain
    await wc.debugger.sendCommand('Accessibility.enable' as any);

    const result = await wc.debugger.sendCommand('Accessibility.getFullAXTree' as any) as {
      nodes: Array<{
        nodeId: string;
        parentId?: string;
        childIds?: string[];
        role?: { value?: string; type?: string };
        name?: { value?: string; type?: string };
        properties?: Array<{ name: string; value: { value?: unknown; type?: string } }>;
        ignored?: boolean;
      }>;
    };

    // 构建节点映射
    const nodeMap = new Map<string, typeof result.nodes[0]>();
    for (const node of result.nodes) {
      nodeMap.set(node.nodeId, node);
    }

    // 交互式角色集合（只保留有意义的控件）
    const INTERACTIVE_ROLES = new Set([
      'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox',
      'radio', 'slider', 'switch', 'menuitem', 'menuitemcheckbox',
      'menuitemradio', 'tab', 'treeitem', 'option', 'spinbutton',
      'progressbar', 'dialog', 'alertdialog', 'alert', 'status',
      'heading', 'table', 'row', 'cell', 'gridcell', 'listbox', 'list',
      'listitem', 'image', 'img', 'tree', 'grid', 'toolbar', 'menubar',
      'tablist', 'tabpanel', 'scrollbar', 'separator',
    ]);

    // 收集所有非忽略且有意义的节点
    const lines: string[] = [];
    let uid = 0;

    const formatNode = (nodeId: string, depth: number): void => {
      const node = nodeMap.get(nodeId);
      if (!node || node.ignored) return;

      const role = node.role?.value || '';
      const name = node.name?.value || '';

      // 只输出有意义的角色（过滤 StaticText、generic、none 等噪声）
      if (role && INTERACTIVE_ROLES.has(role)) {
        const props: string[] = [];
        if (node.properties) {
          for (const p of node.properties) {
            if (p.value?.value !== undefined && p.value.value !== null && p.value.value !== '' && p.value.value !== false) {
              if (['checked', 'expanded', 'selected', 'pressed', 'disabled', 'readonly', 'required', 'focused', 'modal'].includes(p.name)) {
                props.push(`${p.name}=${p.value.value}`);
              }
            }
          }
        }
        const propsStr = props.length > 0 ? ` (${props.join(', ')})` : '';
        const indent = '  '.repeat(depth);
        const nameStr = name ? ` "${name}"` : '';
        lines.push(`${indent}[${role}]${nameStr} uid=${++uid}${propsStr}`);
      }

      // 递归子节点
      if (node.childIds) {
        for (const childId of node.childIds) {
          formatNode(childId, role && INTERACTIVE_ROLES.has(role) ? depth + 1 : depth);
        }
      }
    };

    // 从根节点开始
    for (const node of result.nodes) {
      if (!node.parentId) {
        formatNode(node.nodeId, 0);
      }
    }

    if (lines.length === 0) {
      return '(无可交互的无障碍节点)';
    }

    return `Accessibility Tree (${lines.length} nodes):\n${lines.join('\n')}`;
  }

  // ── Wait ──
  async wait(sessionId: string, waitType: string, selector?: string, timeout = 10000): Promise<void> {
    if (waitType === 'element' && selector) {
      // Poll for element using JS
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const found = await this.evaluate(sessionId, `!!document.querySelector(${JSON.stringify(selector)})`) as boolean;
        if (found) return;
        await new Promise(r => setTimeout(r, 200));
      }
      throw new Error(`Timeout waiting for element: ${selector}`);
    }

    if (waitType === 'navigation') {
      const session = this.sessions.get(sessionId);
      if (!session) throw new Error(`Session ${sessionId} not found`);
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (!session.isLoading) return;
        await new Promise(r => setTimeout(r, 200));
      }
      throw new Error('Timeout waiting for navigation');
    }

    if (waitType === 'networkIdle') {
      const deadline = Date.now() + timeout;
      let lastActivity = Date.now();
      const checkInterval = 500;

      // Listen for network activity
      const handler = (data: { sessionId: string; method: string; params: Record<string, unknown> }) => {
        if (data.sessionId !== sessionId) return; // Only track current session
        lastActivity = Date.now();
      };
      this.on('cdp-event', handler);

      try {
        while (Date.now() < deadline) {
          if (Date.now() - lastActivity > checkInterval * 2) {
            return; // No network activity for 1 second
          }
          await new Promise(r => setTimeout(r, checkInterval));
        }
        throw new Error('Timeout waiting for network idle');
      } finally {
        this.off('cdp-event', handler);
      }
    }

    throw new Error(`Unknown waitType: ${waitType}`);
  }

  // ── Query elements ──
  // ── Console monitoring ──
  async consoleAction(sessionId: string, action: string, level?: string): Promise<unknown> {
    switch (action) {
      case 'start': {
        this.consoleMonitoring.set(sessionId, true);
        if (!this.consoleLogs.has(sessionId)) this.consoleLogs.set(sessionId, []);
        await this.sendCDPCommand(sessionId, 'Runtime.enable');
        return true;
      }
      case 'stop': {
        this.consoleMonitoring.set(sessionId, false);
        return true;
      }
      case 'list': {
        const logs = this.consoleLogs.get(sessionId) || [];
        return level ? logs.filter(l => l.level === level) : logs;
      }
      case 'clear': {
        this.consoleLogs.set(sessionId, []);
        return true;
      }
      default:
        throw new Error(`Unknown console action: ${action}`);
    }
  }

  // ── Dialog handling ──
  dialogAction(sessionId: string, action: string, promptText?: string): unknown {
    switch (action) {
      case 'list': {
        const pending = this.pendingDialogs.get(sessionId) || [];
        return pending.map(d => ({ type: d.type, message: d.message }));
      }
      case 'accept': {
        const pending = this.pendingDialogs.get(sessionId) || [];
        if (pending.length === 0) throw new Error('No pending dialog');
        const dialog = pending.shift()!;
        dialog.resolve('accept', promptText);
        return { type: dialog.type, action: 'accepted' };
      }
      case 'dismiss': {
        const pending = this.pendingDialogs.get(sessionId) || [];
        if (pending.length === 0) throw new Error('No pending dialog');
        const dialog = pending.shift()!;
        dialog.resolve('dismiss');
        return { type: dialog.type, action: 'dismissed' };
      }
      case 'set-auto': {
        // Auto-respond to future dialogs. promptText='dismiss' means auto-dismiss, otherwise auto-accept with optional promptText
        const autoAction = promptText === 'dismiss' ? 'dismiss' : 'accept';
        const autoPrompt = (promptText && promptText !== 'dismiss') ? promptText : undefined;
        this.autoDialogAction.set(sessionId, { action: autoAction, promptText: autoPrompt });
        return true;
      }
      case 'clear-auto': {
        this.autoDialogAction.delete(sessionId);
        return true;
      }
      default:
        throw new Error(`Unknown dialog action: ${action}`);
    }
  }

  // ── Query elements (with detail/iframe support) ──
  async queryElements(sessionId: string, selector?: string, detail?: boolean, frameSelector?: string): Promise<Array<{
    tagName: string;
    selector: string;
    text: string;
    attributes: Record<string, string>;
    rect: { x: number; y: number; width: number; height: number };
    detail?: Record<string, unknown>;
  }>> {
    const effectiveSelector = selector || 'a, button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [onclick], [tabindex]';
    const detailCode = detail ? `
        var cs = window.getComputedStyle(el);
        detail.computedStyle = { display: cs.display, visibility: cs.visibility, opacity: cs.opacity, position: cs.position, zIndex: cs.zIndex, overflow: cs.overflow };
        detail.value = el.value;
        detail.checked = el.checked;
        detail.disabled = el.disabled;
        detail.readOnly = el.readOnly;
        detail.required = el.required;
        detail.placeholder = el.placeholder;
        detail.href = el.href;
        detail.src = el.src;
        detail.outerHTML = el.outerHTML.substring(0, 500);
    ` : '';
    const docRef = frameSelector ? `document.querySelector(${JSON.stringify(frameSelector)}).contentDocument` : 'document';
    const js = `(function() {
      var doc = ${docRef};
      if (!doc) return [];
      var elements = doc.querySelectorAll(${JSON.stringify(effectiveSelector)});
      var results = [];
      elements.forEach(function(el, idx) {
        var rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return;
        var attrs = {};
        for (var i = 0; i < el.attributes.length; i++) {
          attrs[el.attributes[i].name] = el.attributes[i].value;
        }
        var sel = el.id ? '#' + el.id : el.tagName.toLowerCase();
        if (el.className && typeof el.className === 'string') {
          var cls = el.className.trim().split(/\\s+/).slice(0, 2).join('.');
          if (cls) sel = el.tagName.toLowerCase() + '.' + cls;
        }
        if (!el.id && el.name) sel = el.tagName.toLowerCase() + '[name="' + el.name + '"]';
        var detail = {};
        ${detailCode}
        results.push({
          tagName: el.tagName.toLowerCase(),
          selector: sel,
          text: (el.innerText || el.value || el.placeholder || '').trim().substring(0, 200),
          attributes: attrs,
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
          detail: Object.keys(detail).length > 0 ? detail : undefined
        });
      });
      return results;
    })()`;
    return (await this.evaluate(sessionId, js)) as Array<{
      tagName: string;
      selector: string;
      text: string;
      attributes: Record<string, string>;
      rect: { x: number; y: number; width: number; height: number };
    }>;
  }

  // ── Storage ──
  async getStorage(sessionId: string, storageType: string, action: string, key?: string, value?: string): Promise<unknown> {
    if (storageType === 'cookie') {
      return this.handleCookies(sessionId, action, key, value);
    }

    // localStorage / sessionStorage
    const storage = storageType === 'sessionStorage' ? 'sessionStorage' : 'localStorage';
    switch (action) {
      case 'list': {
        const js = `(function() {
          var items = [];
          for (var i = 0; i < ${storage}.length; i++) {
            var k = ${storage}.key(i);
            items.push({ key: k, value: ${storage}.getItem(k) });
          }
          return items;
        })()`;
        return this.evaluate(sessionId, js);
      }
      case 'get': {
        const js = `${storage}.getItem(${JSON.stringify(key)})`;
        return this.evaluate(sessionId, js);
      }
      case 'set': {
        const js = `${storage}.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`;
        return this.evaluate(sessionId, js);
      }
      case 'remove': {
        const js = `${storage}.removeItem(${JSON.stringify(key)})`;
        return this.evaluate(sessionId, js);
      }
      default:
        throw new Error(`Unknown storage action: ${action}`);
    }
  }

  private async handleCookies(sessionId: string, action: string, key?: string, value?: string): Promise<unknown> {
    switch (action) {
      case 'list': {
        const result = await this.sendCDPCommand(sessionId, 'Network.getAllCookies') as { cookies: Array<{ name: string; value: string; domain: string; path: string }> };
        return result.cookies;
      }
      case 'get': {
        const result = await this.sendCDPCommand(sessionId, 'Network.getAllCookies') as { cookies: Array<{ name: string; value: string; domain: string; path: string }> };
        return result.cookies.filter(c => c.name === key);
      }
      case 'set': {
        await this.sendCDPCommand(sessionId, 'Network.setCookie', {
          name: key,
          value: value,
        });
        return true;
      }
      case 'remove': {
        await this.sendCDPCommand(sessionId, 'Network.deleteCookies', {
          name: key,
        });
        return true;
      }
      default:
        throw new Error(`Unknown cookie action: ${action}`);
    }
  }

  private _networkHandler = new Map<string, (data: { sessionId: string; method: string; params: Record<string, unknown> }) => void>();

  // ── Network monitoring ──
  async networkAction(sessionId: string, action: string, filter?: string): Promise<unknown> {
    switch (action) {
      case 'start': {
        this.networkMonitoring.set(sessionId, true);
        if (!this.networkLogs.has(sessionId)) {
          this.networkLogs.set(sessionId, []);
        }
        await this.sendCDPCommand(sessionId, 'Network.enable');
        // Set up listener for network events
        const handler = (data: { sessionId: string; method: string; params: Record<string, unknown> }) => {
          if (data.sessionId !== sessionId) return;
          const logs = this.networkLogs.get(sessionId);
          if (!logs) return;

          if (data.method === 'Network.requestWillBeSent') {
            const p = data.params as { requestId: string; request: { method: string; url: string }; type?: string };
            logs.push({
              requestId: p.requestId,
              method: p.request.method,
              url: p.request.url,
              resourceType: p.type,
            });
          } else if (data.method === 'Network.responseReceived') {
            const p = data.params as { requestId: string; response: { status: number; mimeType: string } };
            const entry = logs.find(l => l.requestId === p.requestId);
            if (entry) {
              entry.status = p.response.status;
              entry.mimeType = p.response.mimeType;
            }
          }
        };
        this.on('cdp-event', handler);
        this._networkHandler.set(sessionId, handler);
        return true;
      }
      case 'stop': {
        this.networkMonitoring.set(sessionId, false);
        const handler = this._networkHandler.get(sessionId);
        if (handler) {
          this.off('cdp-event', handler);
          this._networkHandler.delete(sessionId);
        }
        try { await this.sendCDPCommand(sessionId, 'Network.disable'); } catch { /* ignore */ }
        return true;
      }
      case 'list': {
        const logs = this.networkLogs.get(sessionId) || [];
        const filtered = filter
          ? logs.filter(l => l.url.includes(filter))
          : logs;
        return filtered;
      }
      case 'clear': {
        this.networkLogs.set(sessionId, []);
        return true;
      }
      default:
        throw new Error(`Unknown network action: ${action}`);
    }
  }

  // ── Press key ──
  async pressKey(sessionId: string, key: string, modifiers: string[] = []): Promise<void> {
    // Map common key names to CDP key values
    const keyMap: Record<string, { key: string; code: string; windowsVirtualKeyCode?: number }> = {
      'Enter': { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
      'Tab': { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
      'Escape': { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
      'Backspace': { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
      'Delete': { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
      'ArrowUp': { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
      'ArrowDown': { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
      'ArrowLeft': { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
      'ArrowRight': { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
      'Home': { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
      'End': { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
      'PageUp': { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
      'PageDown': { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
      'F1': { key: 'F1', code: 'F1', windowsVirtualKeyCode: 112 },
      'F2': { key: 'F2', code: 'F2', windowsVirtualKeyCode: 113 },
      'F3': { key: 'F3', code: 'F3', windowsVirtualKeyCode: 114 },
      'F4': { key: 'F4', code: 'F4', windowsVirtualKeyCode: 115 },
      'F5': { key: 'F5', code: 'F5', windowsVirtualKeyCode: 116 },
      'F6': { key: 'F6', code: 'F6', windowsVirtualKeyCode: 117 },
      'F7': { key: 'F7', code: 'F7', windowsVirtualKeyCode: 118 },
      'F8': { key: 'F8', code: 'F8', windowsVirtualKeyCode: 119 },
      'F9': { key: 'F9', code: 'F9', windowsVirtualKeyCode: 120 },
      'F10': { key: 'F10', code: 'F10', windowsVirtualKeyCode: 121 },
      'F11': { key: 'F11', code: 'F11', windowsVirtualKeyCode: 122 },
      'F12': { key: 'F12', code: 'F12', windowsVirtualKeyCode: 123 },
      ' ': { key: ' ', code: 'Space', windowsVirtualKeyCode: 32 },
    };

    const mapped = keyMap[key] || { key, code: `Key${key.toUpperCase()}` };

    const modifierFlags: Record<string, number> = {
      'Alt': 1, 'Control': 2, 'Meta': 4, 'Shift': 8,
    };
    let modifierBit = 0;
    for (const mod of modifiers) {
      modifierBit |= modifierFlags[mod] || 0;
    }

    await this.sendCDPCommand(sessionId, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: mapped.key,
      code: mapped.code,
      windowsVirtualKeyCode: mapped.windowsVirtualKeyCode,
      modifiers: modifierBit,
    });
    await this.sendCDPCommand(sessionId, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: mapped.key,
      code: mapped.code,
      windowsVirtualKeyCode: mapped.windowsVirtualKeyCode,
      modifiers: modifierBit,
    });
  }

  // ── Hover ──
  async hover(sessionId: string, selector: string, frameSelector?: string): Promise<void> {
    let cx: number, cy: number;
    if (frameSelector) {
      const offset = await this.getIframeOffset(sessionId, frameSelector);
      const pos = await this.getElementCenter(sessionId, selector);
      cx = pos.x + offset.x;
      cy = pos.y + offset.y;
    } else {
      const pos = await this.getElementCenter(sessionId, selector);
      cx = pos.x; cy = pos.y;
    }
    await this.sendCDPCommand(sessionId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy });
  }

  // ── Scroll ──
  async scroll(sessionId: string, direction: string, amount = 300, selector?: string, frameSelector?: string): Promise<void> {
    const deltaX = direction === 'left' ? -amount : direction === 'right' ? amount : 0;
    const deltaY = direction === 'up' ? -amount : direction === 'down' ? amount : 0;

    if (selector) {
      const docRef = frameSelector
        ? `document.querySelector(${JSON.stringify(frameSelector)}).contentDocument`
        : 'document';
      const js = `(function() {
        var doc = ${docRef};
        if (!doc) return false;
        var el = doc.querySelector(${JSON.stringify(selector)});
        if (el) { el.scrollBy(${deltaX}, ${deltaY}); return true; }
        return false;
      })()`;
      const result = await this.evaluate(sessionId, js);
      if (!result) throw new Error(`Scroll target not found: ${selector}`);
    } else if (frameSelector) {
      // Scroll the iframe itself
      const js = `(function() {
        var f = document.querySelector(${JSON.stringify(frameSelector)});
        if (!f || !f.contentWindow) return false;
        f.contentWindow.scrollBy(${deltaX}, ${deltaY});
        return true;
      })()`;
      const result = await this.evaluate(sessionId, js);
      if (!result) throw new Error(`iframe not found: ${frameSelector}`);
    } else {
      await this.sendCDPCommand(sessionId, 'Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: 0, y: 0,
        deltaX,
        deltaY,
      });
    }
  }

  // ── Select dropdown ──
  async selectOption(sessionId: string, selector: string, value: string, frameSelector?: string): Promise<void> {
    const docRef = frameSelector
      ? `document.querySelector(${JSON.stringify(frameSelector)}).contentDocument`
      : 'document';
    const js = `(function() {
      var doc = ${docRef};
      if (!doc) return 'iframe not accessible';
      var el = doc.querySelector(${JSON.stringify(selector)});
      if (!el) return 'Element not found';
      el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`;
    const result = await this.evaluate(sessionId, js);
    if (typeof result === 'string') throw new Error(result);
  }

  // ── Drag ──
  async drag(sessionId: string, opts: {
    fromSelector?: string; toSelector?: string;
    fromX?: number; fromY?: number; toX?: number; toY?: number;
    frameSelector?: string;
  }): Promise<void> {
    let startX = opts.fromX ?? 0;
    let startY = opts.fromY ?? 0;
    let endX = opts.toX ?? 0;
    let endY = opts.toY ?? 0;

    let offsetX = 0, offsetY = 0;
    if (opts.frameSelector) {
      const offset = await this.getIframeOffset(sessionId, opts.frameSelector);
      offsetX = offset.x;
      offsetY = offset.y;
    }

    if (opts.fromSelector) {
      const pos = await this.getElementCenter(sessionId, opts.fromSelector);
      startX = pos.x + offsetX; startY = pos.y + offsetY;
    } else {
      startX += offsetX; startY += offsetY;
    }
    if (opts.toSelector) {
      const pos = await this.getElementCenter(sessionId, opts.toSelector);
      endX = pos.x + offsetX; endY = pos.y + offsetY;
    } else {
      endX += offsetX; endY += offsetY;
    }

    // Move to start
    await this.sendCDPCommand(sessionId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: startX, y: startY });
    // Press
    await this.sendCDPCommand(sessionId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: startX, y: startY, button: 'left', clickCount: 1 });
    // Move in steps for realistic drag
    const steps = 10;
    for (let i = 1; i <= steps; i++) {
      const x = startX + (endX - startX) * (i / steps);
      const y = startY + (endY - startY) * (i / steps);
      await this.sendCDPCommand(sessionId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await new Promise(r => setTimeout(r, 16));
    }
    // Release
    await this.sendCDPCommand(sessionId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: endX, y: endY, button: 'left', clickCount: 1 });
  }

  // ── API request from browser context ──
  async apiRequest(sessionId: string, opts: {
    url: string; method?: string; headers?: Record<string, string>; bodyType?: string; body?: string;
  }): Promise<{ status: number; statusText: string; headers: Record<string, string>; body: string }> {
    const method = opts.method || 'GET';
    const bodyType = opts.bodyType || (opts.body ? 'json' : undefined);
    const mergedHeaders: Record<string, string> = { ...opts.headers };

    // Auto-set Content-Type based on bodyType (only if not already provided by user)
    if (opts.body && bodyType) {
      if (bodyType === 'json' && !mergedHeaders['Content-Type'] && !mergedHeaders['content-type']) {
        mergedHeaders['Content-Type'] = 'application/json';
      } else if (bodyType === 'form' && !mergedHeaders['Content-Type'] && !mergedHeaders['content-type']) {
        mergedHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
      }
    }

    const headersJson = Object.keys(mergedHeaders).length > 0 ? JSON.stringify(mergedHeaders) : '{}';

    // Build the body processing JS snippet based on bodyType
    let bodySnippet = '';
    if (opts.body && bodyType) {
      const safeBody = JSON.stringify(opts.body);
      if (bodyType === 'json') {
        // body is a JSON string, pass it directly as the fetch body
        bodySnippet = `opts.body = ${safeBody};`;
      } else if (bodyType === 'form') {
        // body is a JSON object string, URL-encode it
        bodySnippet = `opts.body = new URLSearchParams(JSON.parse(${safeBody})).toString();`;
      } else {
        // raw: pass as-is
        bodySnippet = `opts.body = ${safeBody};`;
      }
    }

    const js = `(async function() {
      try {
        var opts = { method: ${JSON.stringify(method)}, headers: ${headersJson} };
        ${bodySnippet}
        var resp = await fetch(${JSON.stringify(opts.url)}, opts);
        var respHeaders = {};
        resp.headers.forEach(function(v, k) { respHeaders[k] = v; });
        var body = await resp.text();
        return { status: resp.status, statusText: resp.statusText, headers: respHeaders, body: body };
      } catch(e) {
        return { error: e.message };
      }
    })()`;

    const result = await this.evaluate(sessionId, js) as
      { status: number; statusText: string; headers: Record<string, string>; body: string; error?: string } | null;

    if (!result) {
      throw new Error('API request returned no result');
    }
    if (result.error) {
      throw new Error(`API request error: ${result.error}`);
    }

    return {
      status: result.status,
      statusText: result.statusText || '',
      headers: result.headers || {},
      body: result.body || '',
    };
  }

  // ── Helper: get element center position ──
  private async getElementCenter(sessionId: string, selector: string): Promise<{ x: number; y: number }> {
    const { root } = await this.sendCDPCommand(sessionId, 'DOM.getDocument', { depth: 0 }) as { root: { nodeId: number } };
    const { nodeId } = await this.sendCDPCommand(sessionId, 'DOM.querySelector', { nodeId: root.nodeId, selector }) as { nodeId: number };
    if (!nodeId || nodeId === 0) throw new Error(`Element not found: ${selector}`);

    const { model } = await this.sendCDPCommand(sessionId, 'DOM.getBoxModel', { nodeId }) as { model: { content: number[] } };
    return {
      x: (model.content[0] + model.content[2]) / 2,
      y: (model.content[1] + model.content[3]) / 2,
    };
  }

  // ── Helper: get iframe offset (position of iframe in main page) ──
  private async getIframeOffset(sessionId: string, frameSelector: string): Promise<{ x: number; y: number }> {
    const js = `(function() {
      var f = document.querySelector(${JSON.stringify(frameSelector)});
      if (!f) return { x: 0, y: 0 };
      var rect = f.getBoundingClientRect();
      return { x: Math.round(rect.x), y: Math.round(rect.y) };
    })()`;
    return await this.evaluate(sessionId, js) as { x: number; y: number };
  }

  // ── File management (upload + download) ──
  getDownloadPath(): string {
    if (!this.downloadPath) {
      this.downloadPath = path.join(app.getPath('downloads'), 'xai-browser-downloads');
      try {
        if (!existsSync(this.downloadPath)) mkdirSync(this.downloadPath, { recursive: true });
      } catch { /* ignore */ }
    }
    return this.downloadPath;
  }

  async fileAction(sessionId: string, action: string, opts: {
    selector?: string; filePaths?: string[]; url?: string;
  }): Promise<unknown> {
    switch (action) {
      case 'upload': {
        if (!opts.selector || !opts.filePaths?.length) throw new Error('selector and filePaths required for upload');
        const { root } = await this.sendCDPCommand(sessionId, 'DOM.getDocument', { depth: 0 }) as { root: { nodeId: number } };
        const { nodeId } = await this.sendCDPCommand(sessionId, 'DOM.querySelector', { nodeId: root.nodeId, selector: opts.selector }) as { nodeId: number };
        if (!nodeId || nodeId === 0) throw new Error(`File input not found: ${opts.selector}`);
        await this.sendCDPCommand(sessionId, 'DOM.setFileInputFiles', { nodeId, files: opts.filePaths });
        return { uploaded: opts.filePaths.length };
      }
      case 'download': {
        if (!opts.url) throw new Error('url required for download');
        const dlPath = this.getDownloadPath();
        const s = session.fromPartition('persist:browser');
        s.setDownloadPath(dlPath);
        s.downloadURL(opts.url);
        // Wait briefly for download to start
        await new Promise(r => setTimeout(r, 500));
        const dls = this.downloads.get(sessionId) || [];
        return { downloadPath: dlPath, downloads: dls.slice(-5) };
      }
      case 'set-path': {
        if (!opts.filePaths?.length) throw new Error('filePaths[0] required for set-path');
        this.downloadPath = opts.filePaths[0];
        try {
          if (!existsSync(this.downloadPath)) mkdirSync(this.downloadPath, { recursive: true });
        } catch { /* ignore */ }
        return { downloadPath: this.downloadPath };
      }
      default:
        throw new Error(`Unknown file action: ${action}`);
    }
  }

  closeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.webContentsId > 0) {
      const wc = webContents.fromId(session.webContentsId);
      if (wc?.debugger.isAttached()) {
        try { wc.debugger.detach(); } catch { /* ignore */ }
      }
    }
    // Clean up network monitoring
    this.networkLogs.delete(sessionId);
    this.networkMonitoring.delete(sessionId);
    const handler = this._networkHandler.get(sessionId);
    if (handler) {
      this.off('cdp-event', handler);
      this._networkHandler.delete(sessionId);
    }
    // Clean up console monitoring
    this.consoleLogs.delete(sessionId);
    this.consoleMonitoring.delete(sessionId);
    this._consoleHandler.delete(sessionId);
    // Clean up dialogs
    const pending = this.pendingDialogs.get(sessionId) || [];
    for (const d of pending) { try { d.resolve('dismiss'); } catch { /* ignore */ } }
    this.pendingDialogs.delete(sessionId);
    this.autoDialogAction.delete(sessionId);
    // Clean up downloads
    this.downloads.delete(sessionId);
    this.sessions.delete(sessionId);
    console.log(`[BrowserSession] Closed session ${sessionId}`);
  }

  getSession(sessionId: string): BrowserSession | undefined {
    return this.sessions.get(sessionId);
  }

  getAllSessions(): BrowserSession[] {
    return Array.from(this.sessions.values());
  }

  private getWC(sessionId: string): WebContents {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    const wc = webContents.fromId(session.webContentsId);
    if (!wc) throw new Error(`webContents not found for session ${sessionId}`);
    return wc;
  }
}