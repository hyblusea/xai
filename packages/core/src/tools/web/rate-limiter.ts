export class SearchRateLimiter {
  private lastRequestTime: Map<string, number> = new Map();
  private readonly minInterval: number;

  constructor(minInterval = 2000) {
    this.minInterval = minInterval;
  }

  async waitIfNeeded(engine: string): Promise<void> {
    const lastTime = this.lastRequestTime.get(engine) || 0;
    const elapsed = Date.now() - lastTime;
    if (elapsed < this.minInterval) {
      await new Promise(resolve => setTimeout(resolve, this.minInterval - elapsed));
    }
    this.lastRequestTime.set(engine, Date.now());
  }

  reset(engine?: string): void {
    if (engine) {
      this.lastRequestTime.delete(engine);
    } else {
      this.lastRequestTime.clear();
    }
  }

  setMinInterval(interval: number): void {
    // Note: only affects future calls
    (this as any).minInterval = interval;
  }
}
