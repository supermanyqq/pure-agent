import ky, { HTTPError as KyHTTPError, TimeoutError as KyTimeoutError } from 'ky';
import { HttpError, HttpAbortError } from './errors.js';

export interface HttpRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
  timeout?: number;
  maxRetries?: number;
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array>;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RETRIES = 3;
const MAX_BACKOFF_MS = 8_000;
const RETRYABLE_STATUS_CODES = [408, 429, 500, 502, 503, 504];

/**
 * 发送 HTTP POST 请求。
 *
 * 基于 ky（fetch 扩展库），内置超时、指数退避重试、429 自动遵守 Retry-After。
 * 我们获得这些能力不需要手写任何一行。
 */
export async function httpRequest(req: HttpRequest): Promise<HttpResponse> {
  try {
    const res = await ky.post(req.url, {
      headers: req.headers,
      body: req.body,
      timeout: req.timeout ?? DEFAULT_TIMEOUT_MS,
      retry: {
        limit: req.maxRetries ?? DEFAULT_MAX_RETRIES,
        backoffLimit: MAX_BACKOFF_MS,
        statusCodes: RETRYABLE_STATUS_CODES,
      },
      signal: req.signal,
    });

    return {
      status: res.status,
      headers: res.headers,
      body: res.body!,
    };
  } catch (error: unknown) {
    throw mapKyError(error);
  }
}

function mapKyError(error: unknown): HttpError {
  if (error instanceof KyHTTPError) {
    const status = error.response.status;
    const retryable = status >= 500 || status === 429;
    return new HttpError(status, retryable);
  }
  if (error instanceof KyTimeoutError) {
    return new HttpError(0, true);
  }
  if (isAbortError(error)) {
    return new HttpAbortError();
  }
  if (error instanceof Error) {
    return new HttpError(0, true);
  }
  return new HttpError(0, true);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
