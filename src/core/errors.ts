/**
 * 带 HTTP 语义的业务错误。
 *
 * 之前所有 `new Error(...)` 到了 fastify 都变成 500，导致「环境正在运行」「代理仍被引用」
 * 这类完全可预期的业务拒绝，看起来像服务崩溃。这里把它们显式区分出来。
 */
export class AppError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (message: string): AppError => new AppError(message, 404, 'NOT_FOUND');
export const conflict = (message: string): AppError => new AppError(message, 409, 'CONFLICT');
export const badRequest = (message: string): AppError => new AppError(message, 400, 'BAD_REQUEST');
export const upstream = (message: string): AppError => new AppError(message, 502, 'UPSTREAM_UNAVAILABLE');
