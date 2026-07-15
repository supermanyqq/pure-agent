/**
 * web_search — 免费 Web 搜索（DuckDuckGo HTML 抓取）。
 *
 * 参考：Hermes Agent ddgs provider.py（免费、无需 API Key、搜索专用）
 * 实现：直接对 DuckDuckGo HTML 搜索结果页进行 HTTP GET 抓取并解析
 * 注意：DuckDuckGo 抓取不是官方 API，可能在 DuckDuckGo 更新页面结构时失效
 */

import type { Tool, ToolDefinition } from '../../types/index.js';

// ===== 常量 =====

const DDG_LITE_URL = 'https://lite.duckduckgo.com/lite/';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESULTS = 5;

// ===== 参数 Schema =====

const WEB_SEARCH_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description:
        'The search query. Use natural language. Be specific for better results.',
    },
    maxResults: {
      type: 'number',
      minimum: 1,
      maximum: 10,
      description: `Maximum number of results to return. Default is ${DEFAULT_MAX_RESULTS}.`,
    },
  },
  required: ['query'],
};

const WEB_SEARCH_DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: 'web_search',
    description:
      'Search the web for information using DuckDuckGo (free, no API key needed). ' +
      'Returns titles, URLs, and descriptions for each result. ' +
      'This is search-only — it returns links and snippets, not full page content. ' +
      'To read the full content of a specific URL, use the web_fetch tool after getting URLs from this tool. ' +
      'Use this when you need to find current information, documentation, or facts from the internet. ' +
      'The search is powered by DuckDuckGo and respects your privacy.',
    parameters: WEB_SEARCH_PARAMETERS,
  },
};

// ===== DuckDuckGo HTML 解析 =====

interface SearchResult {
  title: string;
  url: string;
  description: string;
  position: number;
}

/**
 * 从 DuckDuckGo Lite HTML 中提取搜索结果。
 * DuckDuckGo Lite 是一个轻量级版本，HTML 结构简单稳定。
 */
function parseDdgLiteHtml(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];

  // DuckDuckGo Lite 结构：
  // <table> <tr class="result-snippet"> <td> description </td> </tr>
  // 每 3 行一组：链接行、描述行、空行

  // 方法 1: 正则提取链接和描述
  const linkRegex = /<a[^>]*href="(https?:\/\/[^"]*)"[^>]*>(.*?)<\/a>/gi;
  const snippetRegex = /<td class="result-snippet">(.*?)<\/td>/gi;

  const links: Array<{ url: string; title: string }> = [];
  const snippets: string[] = [];

  let linkMatch;
  while ((linkMatch = linkRegex.exec(html)) !== null) {
    const url = decodeURIComponent(linkMatch[1]);
    const title = linkMatch[2].replace(/<[^>]+>/g, '').trim();
    // 跳过 DuckDuckGo 内部链接
    if (url.includes('duckduckgo.com') || url.includes('spreadprivacy.com')) continue;
    links.push({ url, title });
  }

  let snippetMatch;
  while ((snippetMatch = snippetRegex.exec(html)) !== null) {
    const desc = snippetMatch[1].replace(/<[^>]+>/g, '').trim();
    snippets.push(desc);
  }

  // 配对
  const count = Math.min(links.length, snippets.length, maxResults);
  for (let i = 0; i < count; i++) {
    results.push({
      title: links[i].title || 'Untitled',
      url: links[i].url,
      description: snippets[i] || '',
      position: i + 1,
    });
  }

  return results;
}

/**
 * 调用 DuckDuckGo Lite 搜索。
 */
async function searchDuckDuckGo(query: string, maxResults: number): Promise<SearchResult[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const url = `${DDG_LITE_URL}?q=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PureAgent/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`DuckDuckGo returned HTTP ${response.status}`);
    }

    const html = await response.text();

    if (html.length < 100) {
      throw new Error('DuckDuckGo returned an empty or invalid response');
    }

    return parseDdgLiteHtml(html, maxResults);
  } finally {
    clearTimeout(timeout);
  }
}

// ===== 工厂函数 =====

export function createWebSearchTool(): Tool {
  return {
    definition: WEB_SEARCH_DEFINITION,

    async execute(args: Record<string, unknown>): Promise<string> {
      const query = String(args['query'] ?? '');
      if (!query.trim()) {
        return 'Error: "query" is required and must be a non-empty string.';
      }

      const maxResults = (args['maxResults'] as number | undefined) ?? DEFAULT_MAX_RESULTS;
      if (!Number.isFinite(maxResults) || maxResults < 1 || maxResults > 10) {
        return 'Error: "maxResults" must be a number between 1 and 10.';
      }

      try {
        const results = await searchDuckDuckGo(query.trim(), Math.floor(maxResults));

        const parts: string[] = [];
        parts.push(`Web search results for: "${query.trim()}"`);
        parts.push(`Source: DuckDuckGo (free, no API key)`);
        parts.push('');
        parts.push('--- Results ---');

        if (results.length === 0) {
          parts.push('(No results found. Try a different query or broader terms.)');
        } else {
          for (const r of results) {
            parts.push(`[${r.position}] ${r.title}`);
            parts.push(`    URL: ${r.url}`);
            parts.push(`    ${r.description}`);
            parts.push('');
          }
        }

        parts.push('---');
        parts.push('Tip: Use web_fetch tool with any URL above to read the full page content.');

        return parts.join('\n');
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);

        if (message.includes('AbortError') || message.includes('aborted')) {
          return `Error: Web search timed out after ${DEFAULT_TIMEOUT_MS / 1000}s. DuckDuckGo may be rate-limiting. Try again later or use a simpler query.`;
        }

        // DuckDuckGo 限流或反爬
        if (message.includes('403') || message.includes('429')) {
          return `Error: DuckDuckGo is rate-limiting requests. Wait a moment before trying again.`;
        }

        if (message.includes('empty') || message.includes('invalid')) {
          return `Error: DuckDuckGo returned an unexpected response. The service may be temporarily unavailable. Try again shortly.`;
        }

        return `Error: Web search failed — ${message}`;
      }
    },
  };
}
