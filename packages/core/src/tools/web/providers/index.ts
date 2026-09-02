import type { SearchProvider, SearchOptions, SerpApiResponse } from './search-provider.js';
import { GoogleSearchProvider } from './google-provider.js';
import { BingSearchProvider } from './bing-provider.js';
import { DuckDuckGoSearchProvider } from './duckduckgo-provider.js';
import { BaiduSearchProvider } from './baidu-provider.js';

export type EngineName = 'google' | 'bing' | 'duckduckgo' | 'baidu';

const ALL_ENGINES: EngineName[] = ['google', 'bing', 'duckduckgo', 'baidu'];

export class ProviderRegistry {
  private providers: Map<string, SearchProvider> = new Map();

  constructor() {
    this.register(new GoogleSearchProvider());
    this.register(new BingSearchProvider());
    this.register(new DuckDuckGoSearchProvider());
    this.register(new BaiduSearchProvider());
  }

  register(provider: SearchProvider): void {
    this.providers.set(provider.name, provider);
  }

  get(name: string): SearchProvider | undefined {
    return this.providers.get(name);
  }

  getAll(): SearchProvider[] {
    return Array.from(this.providers.values());
  }

  getEngineNames(): EngineName[] {
    return [...ALL_ENGINES];
  }

  getFallbackEngine(currentEngine: string): EngineName | null {
    const idx = ALL_ENGINES.indexOf(currentEngine as EngineName);
    if (idx < 0 || idx >= ALL_ENGINES.length - 1) return null;
    return ALL_ENGINES[idx + 1];
  }
}

// Singleton instance
export const providerRegistry = new ProviderRegistry();
