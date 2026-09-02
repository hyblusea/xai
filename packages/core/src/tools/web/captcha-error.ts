/**
 * Error thrown when a CAPTCHA page is detected during search.
 * Carries the search URL so it can be rendered for manual verification.
 */
export class CaptchaError extends Error {
  readonly searchUrl: string;
  readonly engine: string;

  constructor(engine: string, searchUrl: string) {
    super('CAPTCHA detected');
    this.name = 'CaptchaError';
    this.engine = engine;
    this.searchUrl = searchUrl;
  }
}
