/**
 * Tavily Web Search + Content Fetch Tool
 *
 * 基于 Tavily Search API（免费层 1,000 次/月）。
 * 单次调用同时完成搜索和内容提取——Tavily 自动抓取每个结果页面的正文。
 *
 * Tavily API 文档：https://docs.tavily.com/documentation/api-reference/endpoint/search
 */

import type { Tool, ToolDefinition } from '../../types/index.js';

// ===== 配置 =====

const TAVILY_BASE_URL = 'https://api.tavily.com/search';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESULTS = 5;

/** Read Tavily API key from environment. Set PURE_AGENT_TAVILY_API_KEY in your shell. */
function getApiKey(): string {
  const key = process.env.PURE_AGENT_TAVILY_API_KEY?.trim();
  if (!key) {
    throw new Error(
      'PURE_AGENT_TAVILY_API_KEY environment variable is not set. ' +
      'Get a free key at https://tavily.com.',
    );
  }
  return key;
}

// ===== 类型 =====

interface TavilySearchParams {
  query: string;
  search_depth?: 'basic' | 'advanced';   // basic 更快更便宜，advanced 更深入
  max_results?: number;                    // 0-20，默认 5
  include_answer?: boolean;               // 返回 LLM 生成的摘要答案
  include_raw_content?: boolean;          // 返回页面原始正文
  topic?: 'general' | 'news' | 'finance';
  time_range?: 'day' | 'week' | 'month' | 'year';
  include_domains?: string[];             // 限定域名
  exclude_domains?: string[];             // 排除域名
}

interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
  raw_content?: string | null;
}

interface TavilySearchResponse {
  query: string;
  answer?: string;
  results: TavilySearchResult[];
  images?: string[];
  response_time: number;
}

// ===== WebFetch 工具参数（JSON Schema） =====

const WEB_FETCH_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description:
        'The search query. Use natural language, e.g. "What\'s new in TypeScript 6.0?" or "React 19 server components tutorial". Be specific for better results.',
    },
    searchDepth: {
      type: 'string',
      enum: ['basic', 'advanced'],
      description:
        'Search depth. "basic" is fast and cheap (default). "advanced" retrieves more content per result but uses 2 credits per call.',
    },
    maxResults: {
      type: 'number',
      minimum: 1,
      maximum: 10,
      description:
        'Maximum number of results to return. Default is 5. Higher values consume more context window.',
    },
    includeAnswer: {
      type: 'boolean',
      description:
        'When true, Tavily generates a concise AI answer summarizing the search results. Useful for quick fact checks.',
    },
    includeRawContent: {
      type: 'boolean',
      description:
        'When true, includes the full raw page content for each result. Best paired with searchDepth: "advanced". Uses significantly more tokens.',
    },
    topic: {
      type: 'string',
      enum: ['general', 'news', 'finance'],
      description:
        'Search topic category. "general" (default) for most queries, "news" for recent events, "finance" for market/finance data.',
    },
    timeRange: {
      type: 'string',
      enum: ['day', 'week', 'month', 'year'],
      description:
        'Limit results to a time range. Use "week" or "month" when you need recent information.',
    },
    includeDomains: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Only include results from these domains, e.g. ["github.com", "docs.python.org"]. Useful for authoritative sources.',
    },
  },
  required: ['query'],
};

const WEB_FETCH_DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: 'web_fetch',
    description:
      'Search the web and fetch page content in a single call. Returns titles, URLs, content summaries, and scores for each result. ' +
      'Optionally returns a generated AI answer summarizing the top results. ' +
      'Use this when you need up-to-date information from the internet — news, documentation, recent updates, or facts beyond your knowledge cutoff. ' +
      'The search is powered by Tavily and covers the live web with automatic content extraction.',
    parameters: WEB_FETCH_PARAMETERS,
  },
};

// ===== 实现 =====

/**
 * 调用 Tavily Search API。
 */
async function callTavily(params: TavilySearchParams): Promise<TavilySearchResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(TAVILY_BASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getApiKey()}`,
      },
      body: JSON.stringify({
        query: params.query,
        search_depth: params.search_depth ?? 'basic',
        max_results: params.max_results ?? DEFAULT_MAX_RESULTS,
        include_answer: params.include_answer ?? false,
        include_raw_content: params.include_raw_content ?? false,
        topic: params.topic ?? 'general',
        ...(params.time_range ? { time_range: params.time_range } : {}),
        ...(params.include_domains ? { include_domains: params.include_domains } : {}),
        ...(params.exclude_domains ? { exclude_domains: params.exclude_domains } : {}),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      let errorMsg = `HTTP ${response.status}`;
      try {
        const parsed = JSON.parse(errorBody) as { detail?: { error?: string } };
        if (parsed.detail?.error) {
          errorMsg += `: ${parsed.detail.error}`;
        }
      } catch {
        if (errorBody) errorMsg += `: ${errorBody.slice(0, 200)}`;
      }

      if (response.status === 401) {
        errorMsg += ' (API key invalid or expired)';
      } else if (response.status === 429) {
        errorMsg += ' (Rate limit exceeded — try again later)';
      } else if (response.status === 500) {
        errorMsg += ' (Tavily server error — retry may succeed)';
      }

      throw new Error(errorMsg);
    }

    const data = (await response.json()) as TavilySearchResponse;
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 将 Tavily 搜索结果格式化为 LLM 可读的文本。
 */
function formatResults(response: TavilySearchResponse, params: TavilySearchParams): string {
  const lines: string[] = [];

  // 查询摘要
  lines.push(`Search query: "${response.query}"`);
  lines.push(`Response time: ${response.response_time.toFixed(2)}s`);
  lines.push(`Results: ${response.results.length}`);
  lines.push('');

  // AI 生成的答案（如果请求了）
  if (response.answer) {
    lines.push('--- AI Answer ---');
    lines.push(response.answer);
    lines.push('');
  }

  // 搜索结果
  if (response.results.length === 0) {
    lines.push('(No results found. Try a different query or broader terms.)');
  } else {
    lines.push('--- Search Results ---');
    response.results.forEach((r, i) => {
      lines.push(`[${i + 1}] ${r.title}`);
      lines.push(`    URL: ${r.url}`);
      lines.push(`    Score: ${r.score.toFixed(2)}`);
      lines.push(`    Content: ${r.content.slice(0, 500)}`);
      if (r.raw_content && params.include_raw_content) {
        lines.push(`    Raw Content (preview): ${r.raw_content.slice(0, 800)}`);
      }
      lines.push('');
    });
  }

  // 图片（如果有）
  if (response.images && response.images.length > 0) {
    lines.push('--- Related Images ---');
    response.images.slice(0, 5).forEach((img) => {
      lines.push(`  ${img}`);
    });
    lines.push('');
  }

  return lines.join('\n');
}

// ===== 导出工具工厂 =====

export function createWebFetchTool(): Tool {
  return {
    definition: WEB_FETCH_DEFINITION,

    async execute(args: Record<string, unknown>): Promise<string> {
      // 参数校验
      const query = String(args['query'] ?? '');
      if (!query.trim()) {
        return 'Error: "query" is required and must be a non-empty string.';
      }

      const searchDepth = args['searchDepth'] as 'basic' | 'advanced' | undefined;
      if (searchDepth !== undefined && !['basic', 'advanced'].includes(searchDepth)) {
        return 'Error: "searchDepth" must be "basic" or "advanced".';
      }

      const maxResults = args['maxResults'] as number | undefined;
      if (maxResults !== undefined) {
        if (typeof maxResults !== 'number' || !Number.isFinite(maxResults)) {
          return 'Error: "maxResults" must be a number.';
        }
        if (maxResults < 1 || maxResults > 10) {
          return 'Error: "maxResults" must be between 1 and 10.';
        }
      }

      const includeAnswer = args['includeAnswer'] as boolean | undefined;
      if (includeAnswer !== undefined && typeof includeAnswer !== 'boolean') {
        return 'Error: "includeAnswer" must be a boolean.';
      }

      const includeRawContent = args['includeRawContent'] as boolean | undefined;
      if (includeRawContent !== undefined && typeof includeRawContent !== 'boolean') {
        return 'Error: "includeRawContent" must be a boolean.';
      }

      const topic = args['topic'] as string | undefined;
      if (topic !== undefined && !['general', 'news', 'finance'].includes(topic)) {
        return 'Error: "topic" must be "general", "news", or "finance".';
      }

      const timeRange = args['timeRange'] as string | undefined;
      if (timeRange !== undefined && !['day', 'week', 'month', 'year'].includes(timeRange)) {
        return 'Error: "timeRange" must be "day", "week", "month", or "year".';
      }

      const includeDomains = args['includeDomains'] as string[] | undefined;
      if (includeDomains !== undefined) {
        if (!Array.isArray(includeDomains)) {
          return 'Error: "includeDomains" must be an array of domain strings.';
        }
        if (!includeDomains.every((d) => typeof d === 'string')) {
          return 'Error: Every item in "includeDomains" must be a string.';
        }
      }

      // 构建参数
      const params: TavilySearchParams = {
        query: query.trim(),
        search_depth: searchDepth ?? 'basic',
        max_results: maxResults ?? DEFAULT_MAX_RESULTS,
        include_answer: includeAnswer ?? false,
        include_raw_content: includeRawContent ?? false,
        topic: (topic as 'general' | 'news' | 'finance') ?? 'general',
        ...(timeRange ? { time_range: timeRange as 'day' | 'week' | 'month' | 'year' } : {}),
        ...(includeDomains ? { include_domains: includeDomains } : {}),
      };

      // 调用 API
      try {
        const response = await callTavily(params);
        return formatResults(response, params);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('AbortError') || message.includes('aborted')) {
          return `Error: Web search timed out after ${DEFAULT_TIMEOUT_MS / 1000}s. Try a simpler query or check your network.`;
        }
        return `Error: Web search failed — ${message}`;
      }
    },
  };
}
