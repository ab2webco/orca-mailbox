import { test } from 'node:test'
import assert from 'node:assert/strict'
import { backoffDelay, classifyHttpFailure, retryAfterMs, createRateLimiter, withRetry } from '../../src/domain/backoff.mjs'

test('backoffDelay grows exponentially with full jitter and a ceiling', () => {
  const top = () => 0.999999
  assert.equal(Math.round(backoffDelay(0, { baseMs: 1000, maxMs: 60000, random: top })), 1000)
  assert.equal(Math.round(backoffDelay(3, { baseMs: 1000, maxMs: 60000, random: top })), 8000)
  assert.equal(Math.round(backoffDelay(20, { baseMs: 1000, maxMs: 60000, random: top })), 60000)
  assert.equal(backoffDelay(5, { baseMs: 1000, maxMs: 60000, random: () => 0 }), 0)
})

test('classifyHttpFailure separates retryable, auth and fatal failures', () => {
  assert.equal(classifyHttpFailure(429, ''), 'retry')
  assert.equal(classifyHttpFailure(503, ''), 'retry')
  assert.equal(classifyHttpFailure(500, ''), 'retry')
  assert.equal(classifyHttpFailure(403, 'rateLimitExceeded'), 'retry')
  assert.equal(classifyHttpFailure(403, 'userRateLimitExceeded'), 'retry')
  assert.equal(classifyHttpFailure(403, 'insufficientPermissions'), 'fatal')
  assert.equal(classifyHttpFailure(401, ''), 'auth')
  assert.equal(classifyHttpFailure(404, ''), 'fatal')
})

test('retryAfterMs reads seconds and HTTP dates', () => {
  assert.equal(retryAfterMs('7', 0), 7000)
  assert.equal(retryAfterMs('Thu, 01 Jan 1970 00:00:10 GMT', 4000), 6000)
  assert.equal(retryAfterMs(null, 0), null)
  assert.equal(retryAfterMs('soon', 0), null)
})

test('the rate limiter waits once the per-second budget is spent', async () => {
  let now = 0
  /** @type {number[]} */
  const sleeps = []
  const limiter = createRateLimiter({
    unitsPerSecond: 10,
    now: () => now,
    sleep: async (ms) => { sleeps.push(ms); now += ms }
  })
  await limiter.take(5)
  await limiter.take(5)
  assert.deepEqual(sleeps, [])
  await limiter.take(5)
  assert.equal(sleeps.length, 1)
  assert.equal(Math.round(sleeps[0]), 500)
})

test('the rate limiter rejects a single request larger than the budget', async () => {
  const limiter = createRateLimiter({ unitsPerSecond: 10, now: () => 0, sleep: async () => {} })
  await assert.rejects(limiter.take(11), /budget/)
})

test('withRetry retries retryable failures with backoff and gives up after maxAttempts', async () => {
  /** @type {number[]} */
  const sleeps = []
  let calls = 0
  const result = await withRetry(async () => {
    calls += 1
    if (calls < 3) throw Object.assign(new Error('slow down'), { retry: true })
    return 'ok'
  }, { maxAttempts: 5, baseMs: 100, maxMs: 1000, random: () => 0.5, sleep: async (ms) => { sleeps.push(ms) } })
  assert.equal(result, 'ok')
  assert.deepEqual(sleeps, [50, 100])

  calls = 0
  await assert.rejects(withRetry(async () => {
    calls += 1
    throw Object.assign(new Error('still slow'), { retry: true })
  }, { maxAttempts: 3, baseMs: 1, maxMs: 1, random: () => 0, sleep: async () => {} }), /still slow/)
  assert.equal(calls, 3)
})

test('withRetry does not retry a non-retryable failure and honours retryAfterMs', async () => {
  let calls = 0
  await assert.rejects(withRetry(async () => {
    calls += 1
    throw new Error('bad request')
  }, { maxAttempts: 5, baseMs: 1, maxMs: 1, random: () => 0, sleep: async () => {} }), /bad request/)
  assert.equal(calls, 1)

  /** @type {number[]} */
  const sleeps = []
  calls = 0
  await withRetry(async () => {
    calls += 1
    if (calls === 1) throw Object.assign(new Error('429'), { retry: true, retryAfterMs: 3000 })
    return 'ok'
  }, { maxAttempts: 5, baseMs: 1, maxMs: 1, random: () => 0, sleep: async (ms) => { sleeps.push(ms) } })
  assert.deepEqual(sleeps, [3000])
})
