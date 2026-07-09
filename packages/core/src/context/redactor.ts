/**
 * 敏感信息脱敏模块。
 *
 * 在内容进入 LLM summarizer 或回退摘要前，移除 API key、token、密码等凭证。
 * 参考 hermes-agent ``agent/redact.py``（812 行，覆盖 80+ 种模式）。
 *
 * 三条强制脱敏路径：
 * 1. serializeForSummary() 入口 — 所有消息内容序列化前
 * 2. buildFallbackSummary() — 回退摘要文本提取前
 * 3. 摘要 LLM 返回内容后（二次脱敏，纵深防御）
 */

/**
 * 脱敏规则列表。每个规则是 [正则, 替换文本或替换函数]。
 * 只做正则替换，不引入额外依赖。
 */
const SENSITIVE_PATTERNS: Array<[RegExp, string | ((match: string, ...groups: string[]) => string)]> = [
  // OpenAI API keys: sk-...
  [/\b(sk-[A-Za-z0-9]{32,})\b/g, '[REDACTED_API_KEY]'],
  // Anthropic API keys: sk-ant-...
  [/\b(sk-ant-[A-Za-z0-9_-]{32,})\b/g, '[REDACTED_API_KEY]'],
  // GitHub personal access tokens (classic + fine-grained)
  [/\b(ghp_[A-Za-z0-9]{36,})\b/g, '[REDACTED_TOKEN]'],
  [/\b(gho_[A-Za-z0-9]{36,})\b/g, '[REDACTED_TOKEN]'],
  [/\b(ghu_[A-Za-z0-9]{36,})\b/g, '[REDACTED_TOKEN]'],
  [/\b(ghs_[A-Za-z0-9]{36,})\b/g, '[REDACTED_TOKEN]'],
  [/\b(ghr_[A-Za-z0-9]{36,})\b/g, '[REDACTED_TOKEN]'],
  [/\b(github_pat_[A-Za-z0-9_]{36,})\b/g, '[REDACTED_TOKEN]'],
  // AWS access keys (long-term + temporary STS)
  [/\b(AKIA[A-Z0-9]{16})\b/g, '[REDACTED_AWS_KEY]'],
  [/\b(ASIA[A-Z0-9]{16})\b/g, '[REDACTED_AWS_KEY]'],
  // OpenAI project/service-account keys
  [/\b(sk-proj-[A-Za-z0-9_-]{32,})\b/g, '[REDACTED_API_KEY]'],
  [/\b(sk-admin-[A-Za-z0-9_-]{32,})\b/g, '[REDACTED_API_KEY]'],
  [/\b(sk-svcacct-[A-Za-z0-9_-]{32,})\b/g, '[REDACTED_API_KEY]'],
  // JWT tokens (three base64url segments separated by dots)
  [/\b(eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, '[REDACTED_JWT]'],
  // Bearer tokens in headers
  [/(?:bearer|token)\s+([A-Za-z0-9+/=._-]{20,})/gi, 'bearer [REDACTED_TOKEN]'],
  // Connection strings with passwords (URL-style, JSON, .env, colon-separated)
  [/(?:password|passwd|pwd)\s*[:=]\s*["']?([^&\s"',}]+)["']?/gi,
    (match: string): string => {
      const label = match.slice(0, match.search(/[:=]/));
      return `${label}=[REDACTED_PASSWORD]`;
    }],
  // API key / secret key assignment patterns
  [/(?:api_key|apikey|api-secret|secret_key|secret)\s*[:=]\s*([A-Za-z0-9+/=._-]{16,})/gi,
    (match: string): string => {
      const label = match.split(/[:=]/)[0].trim();
      return `${label}=[REDACTED]`;
    }],
  // Generic high-entropy tokens: 40+ base64 chars with high character diversity
  // Excludes git commit hashes (40 hex chars starting with [0-9a-f]+)
  [/\b([A-Za-z0-9+/=_-]{50,})\b/g, (_match: string, token: string) => {
    // Skip if looks like a git SHA (40 hex chars)
    if (/^[0-9a-f]{40}$/i.test(token)) return token;
    const unique = new Set(token.slice(0, 25)).size;
    return unique > 12 ? '[REDACTED_TOKEN]' : token;
  }],
];

/**
 * 对文本中的敏感信息进行正则脱敏。
 */
export function redactSensitiveText(text: string): string {
  let result = text;
  for (const [pattern, replacement] of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, replacement as string);
  }
  return result;
}
