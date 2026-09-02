/**
 * Fetch raw HTML from a URL using a hidden Electron BrowserWindow.
 * Designed for search engine scraping — avoids bot detection by using a real browser.
 */
import { BrowserWindow } from 'electron';
import type { BrowserHtmlFetcher, BrowserFetchOptions } from '@xai/core';

function normalizeOptions(timeoutOrOptions?: number | BrowserFetchOptions): BrowserFetchOptions {
  if (typeof timeoutOrOptions === 'number') {
    return { timeout: timeoutOrOptions };
  }
  return timeoutOrOptions ?? {};
}

/**
 * Fetch raw HTML via a hidden BrowserWindow.
 *
 * Key anti-detection measures:
 * - No `offscreen: true` (offscreen rendering is a known bot signal)
 * - Waits for search result DOM to appear after page load
 * - Uses real Chromium rendering with full JS execution
 * - Supports `searchViaInput` mode: loads a start page, types into the search box,
 *   and submits the form — identical to real user behavior, preserving all session state
 * - Supports setting cookies before loading
 * - Supports overriding Accept-Language header
 */
export const fetchHtmlViaBrowser: BrowserHtmlFetcher = (url: string, timeoutOrOptions?: number | BrowserFetchOptions): Promise<string> => {
  const options = normalizeOptions(timeoutOrOptions);
  const timeout = options.timeout ?? 30000;

  return new Promise((resolve, reject) => {
    const debug = options.debug === true;
    const win = new BrowserWindow({
      show: debug,
      width: 1280,
      height: 800,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    if (debug) {
      win.webContents.openDevTools();
    }

    const timer = setTimeout(() => {
      win.destroy();
      reject(new Error(`Browser fetch timeout: ${url}`));
    }, timeout);

    const cleanup = () => {
      clearTimeout(timer);
    };

    // Override Accept-Language if specified
    if (options.acceptLanguage) {
      win.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => {
        details.requestHeaders['Accept-Language'] = options.acceptLanguage!;
        callback({ requestHeaders: details.requestHeaders });
      });
    }

    const waitForContent = async (): Promise<string> => {
      // Wait for search results to render (Bing/Google/Baidu use JS to populate results)
      await win.webContents.executeJavaScript(`
        new Promise((resolve) => {
          const check = () => {
            const hasResults = document.querySelector('#b_results .b_algo, #search .g, #content_left .result, .result--more');
            if (hasResults) return resolve(true);
            if (document.readyState === 'complete') return resolve(true);
            return false;
          };
          if (check() !== true) {
            const observer = new MutationObserver(() => { if (check() === true) { observer.disconnect(); resolve(true); } });
            observer.observe(document.body, { childList: true, subtree: true });
            setTimeout(() => { observer.disconnect(); resolve(true); }, 5000);
          }
        })
      `);
      return win.webContents.executeJavaScript('document.documentElement.outerHTML');
    };

    /**
     * Wait for the search box element to appear in the DOM.
     * Uses MutationObserver for efficiency — no polling, no arbitrary delays.
     * Falls back to a 5s timeout to avoid hanging forever.
     */
    const waitForSearchBox = async () => {
      const selector = options.searchViaInput!.searchBoxSelector;
      await win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          if (document.querySelector(${JSON.stringify(selector)})) return resolve(true);
          const observer = new MutationObserver(() => {
            if (document.querySelector(${JSON.stringify(selector)})) {
              observer.disconnect();
              resolve(true);
            }
          });
          observer.observe(document.body, { childList: true, subtree: true });
          setTimeout(() => { observer.disconnect(); reject(new Error('Search box not found: ' + ${JSON.stringify(selector)})); }, 5000);
        })
      `);
    };

    /**
     * Wait for specific cookies to appear in the session after the preload page loads.
     * Polls every 100ms until all specified cookie names are found or a 5s timeout expires.
     * This ensures the preload page's JS has finished setting cookies before we navigate away.
     */
    const waitForCookies = async (cookieNames: string[]) => {
      const remaining = new Set(cookieNames);
      const deadline = Date.now() + 5000;
      while (remaining.size > 0 && Date.now() < deadline) {
        const cookies = await win.webContents.session.cookies.get({});
        for (const cookie of cookies) {
          remaining.delete(cookie.name);
        }
        if (remaining.size === 0) break;
        await new Promise(r => setTimeout(r, 100));
      }
    };

    /**
     * searchViaInput mode: type query into search box → submit form.
     * This is identical to real user behavior: all cookies, headers, JS execution
     * happen naturally in the browser session.
     */
    const typeAndSearch = async () => {
      const { searchQuery, searchBoxSelector } = options.searchViaInput!;
      await win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const input = document.querySelector(${JSON.stringify(searchBoxSelector)});
          if (!input) return reject(new Error('Search box not found: ' + ${JSON.stringify(searchBoxSelector)}));

          // Focus and set value
          input.focus();
          input.value = ${JSON.stringify(searchQuery)};

          // Dispatch input event so the page JS recognizes the change
          input.dispatchEvent(new Event('input', { bubbles: true }));

          // Submit the form (or press Enter)
          const form = input.closest('form');
          if (form) {
            form.submit();
          } else {
            // Fallback: simulate Enter key
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
            input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
          }
          resolve(true);
        })
      `);
    };

    let isPreloadPage = options.preloadUrl != null;
    let isStartPage = options.searchViaInput != null;

    win.webContents.on('did-finish-load', async () => {
      try {
        if (isPreloadPage) {
          // We're on the preload page (e.g. Bing international homepage).
          // Wait for the page's JS to set cookies before navigating away.
          isPreloadPage = false;
          if (options.preloadCookies && options.preloadCookies.length > 0) {
            await waitForCookies(options.preloadCookies);
          }
          win.loadURL(url);
          return;
        }

        if (isStartPage) {
          // We're on the start page (e.g. Bing international homepage).
          // did-finish-load means all resources (including JS) have loaded.
          // Wait for the search box to appear in the DOM, then type and submit.
          isStartPage = false;
          try {
            await waitForSearchBox();
            await typeAndSearch();
            // After form submit, did-finish-load will fire again with search results
            return;
          } catch {
            // Search box not found (page layout changed?) — fall back to direct URL navigation
            win.loadURL(url);
            return;
          }
        }

        // Search results page: extract HTML
        const html = await waitForContent();
        cleanup();
        if (debug) {
          // In debug mode, keep the window open for inspection (auto-close after 60s)
          setTimeout(() => { try { win.destroy(); } catch {} }, 60000);
        } else {
          win.destroy();
        }
        resolve(html);
      } catch (err) {
        cleanup();
        win.destroy();
        reject(err);
      }
    });

    win.webContents.on('did-fail-load', (_event, _errorCode, errorDesc) => {
      cleanup();
      win.destroy();
      reject(new Error(`Load failed: ${errorDesc}`));
    });

    // Set cookies before loading the URL
    const startLoading = () => {
      const loadUrl = options.preloadUrl ?? options.searchViaInput?.startUrl ?? url;
      win.loadURL(loadUrl);
    };

    if (options.cookies && Object.keys(options.cookies).length > 0) {
      const urlObj = new URL(options.preloadUrl ?? options.searchViaInput?.startUrl ?? url);
      const cookiePromises = Object.entries(options.cookies).map(([name, value]) =>
        win.webContents.session.cookies.set({
          url: `${urlObj.protocol}//${urlObj.hostname}`,
          name,
          value,
        })
      );
      Promise.all(cookiePromises).then(startLoading).catch(reject);
    } else {
      startLoading();
    }
  });
};
