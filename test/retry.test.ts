import { describe, expect, it, vi } from 'vitest'
import { extractRetryAfter, isRetryableError } from '../src/backoff.js'
import { LLMRetryError, llmRetry } from '../src/retry.js'

const mockResponse = (data: string, tokens = 100) => ({
  data,
  usage: { promptTokens: 60, completionTokens: 40, totalTokens: tokens },
})

describe('llmRetry legacy API', () => {
  it('returns the first successful response', async () => {
    const fn = vi.fn().mockResolvedValue(mockResponse('hello'))

    const result = await llmRetry({ fn })

    expect(result.data).toBe('hello')
    expect(result.attempts).toBe(1)
    expect(result.provider).toBe('primary')
    expect(result.usedFallback).toBe(false)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries retryable errors and returns the later success', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('rate limit exceeded'))
      .mockResolvedValueOnce(mockResponse('success'))

    const result = await llmRetry({ fn, initialDelayMs: 0 })

    expect(result.data).toBe('success')
    expect(result.attempts).toBe(2)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('calls fallback after the primary function exhausts retries', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('server error 503'))
    const fallback = vi.fn().mockResolvedValue(mockResponse('fallback result'))

    const result = await llmRetry({ fn, fallback, maxRetries: 1, initialDelayMs: 0 })

    expect(result.data).toBe('fallback result')
    expect(result.attempts).toBe(3)
    expect(result.provider).toBe('fallback')
    expect(result.usedFallback).toBe(true)
    expect(fn).toHaveBeenCalledTimes(2)
    expect(fallback).toHaveBeenCalledTimes(1)
  })
})

describe('llmRetry provider chain', () => {
  it('tries named providers in order', async () => {
    const openai = vi.fn().mockRejectedValue(new Error('server error 500'))
    const anthropic = vi.fn().mockResolvedValue(mockResponse('claude ok'))

    const result = await llmRetry({
      providers: [
        { name: 'openai:gpt-4o', fn: openai, maxRetries: 0 },
        { name: 'anthropic:sonnet', fn: anthropic, maxRetries: 0 },
      ],
      initialDelayMs: 0,
    })

    expect(result.data).toBe('claude ok')
    expect(result.provider).toBe('anthropic:sonnet')
    expect(result.usedFallback).toBe(true)
    expect(openai).toHaveBeenCalledOnce()
    expect(anthropic).toHaveBeenCalledOnce()
  })

  it('uses provider-specific retry counts', async () => {
    const provider = vi
      .fn()
      .mockRejectedValueOnce(new Error('429'))
      .mockResolvedValueOnce(mockResponse('ok'))

    const result = await llmRetry({
      providers: [{ name: 'primary-model', fn: provider, maxRetries: 1 }],
      maxRetries: 0,
      initialDelayMs: 0,
    })

    expect(result.data).toBe('ok')
    expect(result.attempts).toBe(2)
  })
})

describe('llmRetry policy hooks', () => {
  it('supports custom shouldRetry logic', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('custom transient'))
      .mockResolvedValueOnce(mockResponse('ok'))

    const shouldRetry = vi.fn().mockReturnValue(true)

    const result = await llmRetry({
      fn,
      shouldRetry,
      maxRetries: 1,
      initialDelayMs: 0,
    })

    expect(result.data).toBe('ok')
    expect(shouldRetry).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({
      attempt: 1,
      provider: 'primary',
    }))
  })

  it('calls observability callbacks', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('server error 500'))
      .mockResolvedValueOnce(mockResponse('ok'))

    const onAttempt = vi.fn()
    const onRetry = vi.fn()
    const onSuccess = vi.fn()

    await llmRetry({ fn, onAttempt, onRetry, onSuccess, initialDelayMs: 0 })

    expect(onAttempt).toHaveBeenCalledTimes(2)
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error), expect.any(Number), expect.any(Object))
    expect(onSuccess).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'primary',
      totalTokens: 100,
    }))
  })

  it('calls onFailure with LLMRetryError', async () => {
    const onFailure = vi.fn()

    await expect(
      llmRetry({
        fn: vi.fn().mockRejectedValue(new Error('invalid api key')),
        onFailure,
        initialDelayMs: 0,
      })
    ).rejects.toThrow(LLMRetryError)

    expect(onFailure).toHaveBeenCalledWith(expect.any(LLMRetryError))
  })
})

describe('llmRetry budget and cancellation', () => {
  it('supports custom cost calculators', async () => {
    const costCalculator = vi.fn().mockReturnValue(0.42)

    const result = await llmRetry({
      fn: vi.fn().mockResolvedValue(mockResponse('ok', 500)),
      costCalculator,
    })

    expect(result.totalCostUSD).toBe(0.42)
    expect(costCalculator).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      provider: 'primary',
    }))
  })

  it('does not call the primary function when the budget is already exhausted', async () => {
    const fn = vi.fn().mockResolvedValue(mockResponse('ok'))
    const onBudgetExceeded = vi.fn()

    await expect(
      llmRetry({
        fn,
        maxCostUSD: 0,
        initialDelayMs: 0,
        onBudgetExceeded,
      })
    ).rejects.toThrow(LLMRetryError)

    expect(fn).not.toHaveBeenCalled()
    expect(onBudgetExceeded).toHaveBeenCalledOnce()
  })

  it('fails when timeoutMs is reached', async () => {
    await expect(
      llmRetry({
        fn: () => new Promise(() => undefined),
        timeoutMs: 1,
        initialDelayMs: 0,
      })
    ).rejects.toThrow(LLMRetryError)
  })
})

describe('retryable errors', () => {
  it('does not retry authentication errors', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('invalid api key'))

    await expect(llmRetry({ fn, maxRetries: 3, initialDelayMs: 0 })).rejects.toThrow()

    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('recognizes SDK status codes as retryable', () => {
    expect(isRetryableError(Object.assign(new Error('oops'), { status: 429 }))).toBe(true)
    expect(isRetryableError(Object.assign(new Error('oops'), { statusCode: 503 }))).toBe(true)
    expect(isRetryableError(Object.assign(new Error('oops'), { status: 529 }))).toBe(true)
  })

  it('extracts retry-after from plain and nested headers', () => {
    expect(extractRetryAfter({ headers: { 'Retry-After': '2' } })).toBe(2000)
    expect(extractRetryAfter({ response: { headers: { 'retry-after': '3' } } })).toBe(3000)
  })
})
