const CAPTCHA_PATTERNS: Record<string, string[]> = {
  google: ['captcha', 'sorry/index', 'unusual traffic', 'detected unusual traffic'],
  bing: ['captcha', 'verify you are human'],
  duckduckgo: [],
  baidu: ['验证码', 'captcha_verify', '安全验证'],
};

export class CaptchaHandler {
  static detect(engine: string, html: string): boolean {
    const patterns = CAPTCHA_PATTERNS[engine] || [];
    if (patterns.length === 0) return false;
    const lowerHtml = html.toLowerCase();
    return patterns.some(p => lowerHtml.includes(p.toLowerCase()));
  }

  static getFallbackEngine(currentEngine: string, availableEngines: string[]): string | null {
    const idx = availableEngines.indexOf(currentEngine);
    if (idx < 0 || idx >= availableEngines.length - 1) return null;
    return availableEngines[idx + 1];
  }

  static getAvailableEngines(): string[] {
    return Object.keys(CAPTCHA_PATTERNS);
  }
}
