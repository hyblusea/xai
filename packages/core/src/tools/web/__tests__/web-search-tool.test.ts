import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebSearchTool } from '../web-search-tool.js';
import { providerRegistry } from '../providers/index.js';

// Mock all providers to avoid real network calls
vi.mock('../providers/google-provider.js', () => {
  return {
    GoogleSearchProvider: vi.fn().mockImplementation(() => ({
      name: 'google',
      search: vi.fn().mockResolvedValue({
        search_metadata: { id: 'test-id', status: 'Success', engine: 'google', created_at: '2026-01-01T00:00:00Z', total_time_taken: 1.0 },
        search_parameters: { engine: 'google', q: 'test', num: 10 },
        search_information: { query_displayed: 'test' },
        organic_results: [
          { position: 1, title: 'Test Result', link: 'https://example.com', snippet: 'Test snippet' },
        ],
      }),
    })),
  };
});

vi.mock('../providers/bing-provider.js', () => {
  return {
    BingSearchProvider: vi.fn().mockImplementation(() => ({
      name: 'bing',
      search: vi.fn().mockResolvedValue({
        search_metadata: { id: 'test-id', status: 'Success', engine: 'bing', created_at: '2026-01-01T00:00:00Z', total_time_taken: 1.0 },
        search_parameters: { engine: 'bing', q: 'test', num: 10 },
        search_information: { query_displayed: 'test' },
        organic_results: [
          { position: 1, title: 'Test Result', link: 'https://example.com', snippet: 'Test snippet' },
        ],
      }),
    })),
  };
});

describe('WebSearchTool', () => {
  let tool: WebSearchTool;

  beforeEach(() => {
    tool = new WebSearchTool();
  });

  describe('definition', () => {
    it('should have correct tool name', () => {
      expect(tool.definition.name).toBe('web_search');
    });

    it('should require query parameter', () => {
      expect(tool.definition.parameters.query.required).toBe(true);
    });

    it('should not require confirmation', () => {
      expect(tool.definition.confirmationRequired).toBe(false);
    });

    it('should have num parameter with default', () => {
      expect(tool.definition.parameters.num.default).toBe(10);
    });
  });

  describe('execute', () => {
    it('should fail for empty query', async () => {
      const result = await tool.execute({ query: '' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('cannot be empty');
    });

    it('should fail for whitespace-only query', async () => {
      const result = await tool.execute({ query: '   ' });
      expect(result.success).toBe(false);
    });

    it('should fail for Chinese query (English-only)', async () => {
      const result = await tool.execute({ query: '大语言模型' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('English');
    });

    it('should fail for mixed Chinese query', async () => {
      const result = await tool.execute({ query: '如何学习 machine learning' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('English');
    });

    it('should cap num at 20', async () => {
      const result = await tool.execute({ query: 'test', num: 50 });
      // The tool should cap num at 20, but still succeed
      // (depends on provider mock returning results)
      expect(result.success).toBe(true);
    });

    it('should return formatted search results', async () => {
      const result = await tool.execute({ query: 'React 19' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Test Result');
      expect(result.output).toContain('https://example.com');
      expect(result.output).toContain('Test snippet');
    });

    it('should accept num as string', async () => {
      const result = await tool.execute({ query: 'test', num: '5' });
      expect(result.success).toBe(true);
    });
  });

  describe('config', () => {
    it('should use default config when none provided', () => {
      const tool = new WebSearchTool();
      expect(tool.definition.name).toBe('web_search');
    });

    it('should accept custom config', () => {
      const tool = new WebSearchTool({ defaultEngine: 'bing', maxResults: 5 });
      expect(tool.definition.name).toBe('web_search');
    });

    it('should update config at runtime', () => {
      const tool = new WebSearchTool();
      tool.updateConfig({ maxResults: 5 });
      // Config updated, no error
    });
  });

  describe('parseBlockParams', () => {
    it('should parse web_search block with num parameter', () => {
      const params = tool.parseBlockParams('++++ web_search num:5', 'React 19 新特性');
      expect(params).not.toBeNull();
      expect(params!.query).toBe('React 19 新特性');
      expect(params!.num).toBe(5);
    });

    it('should parse web_search block without num', () => {
      const params = tool.parseBlockParams('++++ web_search', 'TypeScript 5.5 release notes');
      expect(params).not.toBeNull();
      expect(params!.query).toBe('TypeScript 5.5 release notes');
    });
  });
});
