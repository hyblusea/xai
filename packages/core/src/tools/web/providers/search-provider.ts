import type { SearchProxyConfig } from '@xai/shared';

/** Options for BrowserHtmlFetcher. */
export interface BrowserFetchOptions {
  timeout?: number;
  /** Cookies to set before loading the URL (name → value). */
  cookies?: Record<string, string>;
  /** Override the Accept-Language HTTP header for all requests in this session. */
  acceptLanguage?: string;
  /**
   * Instead of navigating directly to the URL, load this page first
   * to establish cookies/session state, then navigate to the target URL.
   * This is more elegant than searchViaInput — like typing in the browser address bar.
   * - `preloadUrl`: The page to load first (e.g. Bing international homepage to set ENSEARCH cookie)
   */
  preloadUrl?: string;

  /**
   * Cookie names to wait for after the preloadUrl page loads.
   * The browser will poll the session cookies until all specified names appear
   * (or a 5s timeout expires), ensuring the preload page's JS has finished
   * setting cookies before navigating to the target URL.
   */
  preloadCookies?: string[];

  /** Show the BrowserWindow and open DevTools for debugging. */
  debug?: boolean;

  /**
   * Instead of navigating directly to the URL, load this page first,
   * then type `searchQuery` into the search box and submit the form.
   * This mimics real user behavior and preserves full session state (cookies, headers, JS).
   * - `startUrl`: The page to load first (e.g. Bing international homepage)
   * - `searchQuery`: The text to type into the search box
   * - `searchBoxSelector`: CSS selector for the search input element
   */
  searchViaInput?: {
    startUrl: string;
    searchQuery: string;
    searchBoxSelector: string;
  };
}

/** Fetches raw HTML from a URL using a real browser (e.g. Electron BrowserWindow). */
export type BrowserHtmlFetcher = (url: string, timeoutOrOptions?: number | BrowserFetchOptions) => Promise<string>;

export interface SearchOptions {
  num?: number;
  proxy?: SearchProxyConfig;
  start?: number;
  hl?: string;
  gl?: string;
  /** Extra cookies to include in the request (e.g. after CAPTCHA resolution) */
  cookie?: string;
  /** Real browser HTML fetcher (Electron BrowserWindow). Takes priority over HTTP fetch. */
  browserFetcher?: BrowserHtmlFetcher;
}

export interface OrganicResult {
  position: number;
  title: string;
  link: string;
  displayed_link?: string;
  snippet: string;
  snippet_highlighted_words?: string[];
  rich_snippet?: Record<string, unknown>;
}

export interface SerpApiResponse {
  search_metadata: {
    id: string;
    status: 'Success' | 'Error' | 'Captcha';
    engine: string;
    created_at: string;
    total_time_taken: number;
    error_message?: string;
  };
  search_parameters: {
    engine: string;
    q: string;
    hl?: string;
    gl?: string;
    num: number;
  };
  search_information: {
    query_displayed: string;
    total_results?: string;
    time_taken_displayed?: string;
  };
  organic_results: OrganicResult[];
  related_searches?: { query: string }[];
  pagination?: {
    current_page: number;
    next_page_token?: string;
  };
}

export interface SearchProvider {
  readonly name: string;
  search(query: string, options: SearchOptions): Promise<SerpApiResponse>;
}
