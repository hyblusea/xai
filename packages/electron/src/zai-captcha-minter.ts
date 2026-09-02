/**
 * ZaiCaptchaMinter — mints fresh captcha_verify_param for chat.z.ai
 * using a hidden Electron BrowserWindow.
 *
 * Same approach as glm2api's captcha_worker.py:
 * - Serve a minimal harness HTML on the REAL chat.z.ai origin
 *   (via session.protocol.handle intercepting https://chat.z.ai/__captcha_harness)
 * - The harness loads the Aliyun SDK and initializes captcha
 * - All other network requests pass through (SDK needs to reach Aliyun servers)
 * - The harness page has NO conflicting JS from the real SPA
 *
 * The real origin is critical: Aliyun's captcha endpoints are origin-sensitive
 * and reject requests with wrong Origin/Referer headers.
 */
import { BrowserWindow, session, net } from 'electron';

const ORIGIN = 'https://chat.z.ai';
const HARNESS_URL = `${ORIGIN}/__captcha_harness`;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

// chat.z.ai's exact Aliyun captcha config (extracted from the prod bundle)
const SCENE_ID = 'didk33e0';
const REGION = 'sgp';
const PREFIX = 'no8xfe';
const MODE = 'popup';
const LOGO_IMAGE = 'https://z-cdn.chatglm.cn/z-ai/static/logo.svg';
const ALIYUN_SDK_URL = 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js';

// Minimal harness page served on the real origin. Mirrors chat.z.ai's wiring.
const HARNESS_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>h</title></head>
<body>
<div id="chat-captcha-element"
     style="position:absolute;left:-99999px;top:-99999px;width:0;height:0;overflow:hidden;pointer-events:none;"></div>
<button id="chat-captcha-trigger" type="button" aria-hidden="true" tabindex="-1"
        style="position:absolute;left:-99999px;top:-99999px;width:1px;height:1px;opacity:0;"></button>
<script>
window.__CVP = null;
window.__CVP_ERR = null;
window.__CVP_SEQ = 0;
window.__CAPTCHA_READY = false;
window.__captchaInstance = null;

window.AliyunCaptchaConfig = { region: ${JSON.stringify(REGION)}, prefix: ${JSON.stringify(PREFIX)} };

function __loadSdk() {
  return new Promise(function (resolve, reject) {
    if (window.initAliyunCaptcha) { resolve(); return; }
    var s = document.createElement('script');
    s.src = ${JSON.stringify(ALIYUN_SDK_URL)};
    s.onload = function () { resolve(); };
    s.onerror = function () { reject(new Error('sdk load failed')); };
    document.head.appendChild(s);
  });
}

window.__initCaptcha = function () {
  return new Promise(function (resolve, reject) {
    __loadSdk().then(function () {
      if (!window.initAliyunCaptcha) { reject(new Error('initAliyunCaptcha missing')); return; }
      window.__CVP = null;
      window.__CVP_ERR = null;
      window.__CAPTCHA_READY = false;
      try {
        window.initAliyunCaptcha({
          SceneId: ${JSON.stringify(SCENE_ID)},
          mode: ${JSON.stringify(MODE)},
          element: '#chat-captcha-element',
          button: '#chat-captcha-trigger',
          captchaLogoImg: ${JSON.stringify(LOGO_IMAGE)},
          language: 'en',
          timeout: 10000,
          delayBeforeSuccess: false,
          success: function (param) {
            window.__CVP = param;
            window.__CVP_SEQ = (window.__CVP_SEQ | 0) + 1;
          },
          fail: function (e) {
            window.__CVP_ERR = 'fail:' + (typeof e === 'string' ? e : JSON.stringify(e || ''));
          },
          onError: function (e) {
            window.__CVP_ERR = 'onError:' + (typeof e === 'string' ? e : JSON.stringify(e || ''));
          },
          getInstance: function (instance) {
            window.__captchaInstance = instance;
            window.__CAPTCHA_READY = true;
            resolve();
          }
        });
      } catch (e) {
        reject(e);
      }
    }).catch(reject);
  });
};

// Trigger one fresh verification round.
// RE-INITIALIZE the SDK on every round (not refresh) — this runs the fast
// TRACELESS handshake (~0.5s warm) instead of the slow PUZZLE fallback (~27s).
window.__trigger = async function () {
  window.__CVP = null;
  window.__CVP_ERR = null;
  await window.__initCaptcha();
  var btn = document.getElementById('chat-captcha-trigger');
  if (btn) btn.click();
  return true;
};
</script>
</body></html>`;

export class ZaiCaptchaMinter {
  private win: BrowserWindow | null = null;
  private ready = false;
  private minting = false;
  private readonly mintTimeout: number;
  private ses: Electron.Session | null = null;
  private protocolRegistered = false;

  constructor(mintTimeout: number = 25000) {
    this.mintTimeout = mintTimeout;
  }

  async start(): Promise<void> {
    if (this.ready && this.win && !this.win.isDestroyed()) return;

    // Use a dedicated partition so we don't pollute the default session
    this.ses = session.fromPartition('persist:zai-captcha');

    const harnessBuffer = Buffer.from(HARNESS_HTML, 'utf-8');

    // Intercept https://chat.z.ai/__captcha_harness and serve our HTML.
    // All other https requests fall through to the real network via net.fetch.
    // This gives the page the REAL https://chat.z.ai origin, which is critical
    // because Aliyun's captcha endpoints are origin-sensitive.
    if (!this.protocolRegistered) {
      try {
        this.ses.protocol.handle('https', async (request) => {
          const url = request.url.split('?')[0].split('#')[0].replace(/\/$/, '');
          if (url === HARNESS_URL) {
            return new Response(harnessBuffer, {
              status: 200,
              headers: {
                'Content-Type': 'text/html; charset=utf-8',
              },
            });
          }
          // Fall through to network for all other https requests
          return net.fetch(request);
        });
        this.protocolRegistered = true;
      } catch (e) {
        console.log('[ZaiCaptchaMinter] https protocol handle issue:', e);
      }
    }

    this.win = new BrowserWindow({
      width: 1280,
      height: 800,
      show: false,
      webPreferences: {
        session: this.ses,
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
      },
    });

    this.win.webContents.setUserAgent(UA);

    // Navigate to the harness URL on the REAL origin
    console.log('[ZaiCaptchaMinter] Loading harness page on real origin...');
    try {
      await this.win.loadURL(HARNESS_URL);
    } catch (e) {
      console.error('[ZaiCaptchaMinter] loadURL failed:', e);
      throw e;
    }

    // Wait for the page to be ready
    await this.waitForPageReady();

    // Initialize the SDK
    console.log('[ZaiCaptchaMinter] Initializing Aliyun SDK...');
    await this.win.webContents.executeJavaScript('window.__initCaptcha()');

    // Wait for the SDK to be ready
    await this.waitForSDK();
    this.ready = true;
    console.log('[ZaiCaptchaMinter] Ready — Aliyun SDK initialized');
  }

  private async waitForPageReady(): Promise<void> {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        const ready = await this.win!.webContents.executeJavaScript(
          'typeof window.__initCaptcha === "function"',
        );
        if (ready) return;
      } catch {
        // page not ready yet
      }
      await new Promise(r => setTimeout(r, 200));
    }
    throw new Error('ZaiCaptchaMinter: page load timeout');
  }

  private async waitForSDK(): Promise<void> {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      try {
        const ready = await this.win!.webContents.executeJavaScript(
          'window.__CAPTCHA_READY === true',
        );
        if (ready) return;
      } catch {
        // not ready yet
      }
      await new Promise(r => setTimeout(r, 200));
    }
    throw new Error('ZaiCaptchaMinter: SDK init timeout');
  }

  async mint(): Promise<string> {
    if (this.minting) {
      throw new Error('ZaiCaptchaMinter: already minting');
    }
    this.minting = true;
    try {
      if (!this.ready || !this.win || this.win.isDestroyed()) {
        await this.start();
      }

      // Snapshot current success sequence so we can detect a *new* one
      const prevSeq: number = await this.win!.webContents.executeJavaScript(
        'window.__CVP_SEQ | 0',
      );

      // Fire a verification round (re-inits the SDK fresh, then triggers)
      await this.win!.webContents.executeJavaScript('window.__trigger()');

      // Poll for a new param
      const deadline = Date.now() + this.mintTimeout;
      while (Date.now() < deadline) {
        const state = await this.win!.webContents.executeJavaScript(
          '(function(prev) { return { seq: window.__CVP_SEQ | 0, cvp: window.__CVP, err: window.__CVP_ERR, isNew: (window.__CVP_SEQ | 0) > prev && !!window.__CVP }; })(' + prevSeq + ')',
        );

        if (state.isNew && state.cvp) {
          return state.cvp as string;
        }
        if (state.err) {
          throw new Error('Captcha verification error: ' + state.err);
        }
        await new Promise(r => setTimeout(r, 150));
      }

      // Timed out
      const err = await this.win!.webContents.executeJavaScript('window.__CVP_ERR');
      throw new Error('Captcha mint timeout after ' + this.mintTimeout + 'ms (err=' + err + ')');
    } catch (err) {
      console.error('[ZaiCaptchaMinter] Mint failed, will re-init on next call:', err);
      this.ready = false;
      try { this.win?.destroy(); } catch {}
      this.win = null;
      throw err;
    } finally {
      this.minting = false;
    }
  }

  async stop(): Promise<void> {
    try { this.win?.destroy(); } catch {}
    this.win = null;
    this.ready = false;
  }
}
