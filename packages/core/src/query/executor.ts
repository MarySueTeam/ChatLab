/**
 * Async SQL executor abstraction.
 *
 * Provides a platform-agnostic async interface for executing SQL queries.
 * - Electron: wraps synchronous `better-sqlite3` calls via `Promise.resolve()`
 * - CLI Web: wraps `pluginQuery` HTTP calls (natively async)
 * - Server direct: wraps `DatabaseAdapter` for `/api/v1` or AI tool use
 */

export interface AsyncSqlExecutor {
  all<T>(sql: string, params?: unknown[]): Promise<T[]>
  get<T>(sql: string, params?: unknown[]): Promise<T | undefined>
}
