/**
 * Provider 层错误基类。
 *
 * retryable 标记由 http-client 设置，供上层（Agent Loop）决定是否重试整个请求。
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** HTTP 传输层错误（网络/超时/状态码），由 http-client 抛出 */
export class HttpError extends ProviderError {
  constructor(
    public readonly status: number,
    retryable: boolean,
  ) {
    const prefix = status === 0 ? 'Network error' : `HTTP ${status}`;
    super(`${prefix}: request failed`, 'HTTP_ERROR', retryable);
    this.name = 'HttpError';
  }
}

/** 用户主动取消请求（AbortController.abort()），由 http-client 抛出 */
export class HttpAbortError extends HttpError {
  constructor() {
    super(0, false);
    this.name = 'HttpAbortError';
  }
}

/** SSE 流整体无效时抛出（Content-Type 错误、首字节非 SSE 格式等） */
export class SSEParseError extends ProviderError {
  constructor(message: string) {
    super(message, 'SSE_PARSE_ERROR', false);
    this.name = 'SSEParseError';
  }
}

/** DeepSeek API 返回的业务错误（余额不足、模型不存在等），由 deepseek-client 抛出 */
export class ApiError extends ProviderError {
  constructor(message: string, retryable = false) {
    super(message, 'API_ERROR', retryable);
    this.name = 'ApiError';
  }
}
