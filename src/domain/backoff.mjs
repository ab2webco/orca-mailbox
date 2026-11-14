// @ts-check
// Exponential backoff with full jitter, a per-second rate limiter and a retry loop.
// Clock, sleep and randomness are injected so the logic is testable without waiting.

/**
 * @typedef {object} BackoffOptions
 * @property {number} baseMs
 * @property {number} maxMs
 * @property {() => number} random
 */

/**
 * @param {number} attempt  0 for the first retry.
 * @param {BackoffOptions} options
 */
export function backoffDelay (attempt, { baseMs, maxMs, random }) {
  const ceiling = Math.min(maxMs, baseMs * 2 ** attempt)
  return random() * ceiling
}

/** @typedef {'retry' | 'auth' | 'fatal'} FailureKind */

/**
 * @param {number} status
 * @param {string} reason  Provider error reason (Gmail `errors[0].reason`, Graph `error.code`).
 * @returns {FailureKind}
 */
export function classifyHttpFailure (status, reason) {
  if (status === 401) return 'auth'
  if (status === 429 || status >= 500) return 'retry'
  if (status === 403 && /ratelimitexceeded|throttl/i.test(reason)) return 'retry'
  return 'fatal'
}

/**
 * @param {string | null | undefined} header  Retry-After value.
 * @param {number} nowMs
 * @returns {number | null}
 */
export function retryAfterMs (header, nowMs) {
  if (header === null || header === undefined) return null
  const trimmed = header.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000
  const at = Date.parse(trimmed)
  if (!Number.isFinite(at)) return null
  return Math.max(0, at - nowMs)
}

/**
 * Token bucket refilled continuously at `unitsPerSecond`, holding at most one
 * second of budget.
 *
 * @param {{ unitsPerSecond: number, now: () => number, sleep: (ms: number) => Promise<void> }} options
 */
export function createRateLimiter ({ unitsPerSecond, now, sleep }) {
  let available = unitsPerSecond
  let last = now()
  const refill = () => {
    const t = now()
    available = Math.min(unitsPerSecond, available + ((t - last) / 1000) * unitsPerSecond)
    last = t
  }
  return {
    /** @param {number} units */
    async take (units) {
      if (units > unitsPerSecond) {
        throw new RangeError(`request of ${units} units exceeds the ${unitsPerSecond}/s budget`)
      }
      refill()
      if (available < units) {
        await sleep(((units - available) / unitsPerSecond) * 1000)
        refill()
      }
      available -= units
    }
  }
}

/**
 * An error a caller marks as retryable, optionally with the server's Retry-After.
 * @typedef {Error & { retry?: boolean, retryAfterMs?: number | null }} RetryableError
 */

/**
 * @template T
 * @param {() => Promise<T>} operation
 * @param {BackoffOptions & { maxAttempts: number, sleep: (ms: number) => Promise<void> }} options
 * @returns {Promise<T>}
 */
export async function withRetry (operation, options) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation()
    } catch (caught) {
      const error = /** @type {RetryableError} */ (caught)
      if (!error || error.retry !== true || attempt + 1 >= options.maxAttempts) throw error
      const wait = typeof error.retryAfterMs === 'number'
        ? error.retryAfterMs
        : backoffDelay(attempt, options)
      await options.sleep(wait)
    }
  }
}
