import { describe, expect, it, vi } from 'vitest'
import { extractRetryAfter, isRetryableError } from '../src/backoff.js'
import { CircuitBreaker } from '../src/circuit-breaker.js'
import { LLMRetryError, llmRetry } from '../src/retry.js'
import { llmRetryStream } from '../src/stream.js'

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

  it('does not fallback on non-transient client errors by default', async () => {
    const primary = vi.fn().mockRejectedValue(Object.assign(new Error('invalid request'), {
      status: 400,
    }))
    const fallback = vi.fn().mockResolvedValue(mockResponse('fallback should not run'))

    await expect(
      llmRetry({
        providers: [
          { name: 'primary', fn: primary, maxRetries: 0 },
          { name: 'fallback', fn: fallback, maxRetries: 0 },
        ],
      })
    ).rejects.toThrow(LLMRetryError)

    expect(primary).toHaveBeenCalledOnce()
    expect(fallback).not.toHaveBeenCalled()
  })

  it('allows fallback on client errors when shouldFallback opts in', async () => {
    const primary = vi.fn().mockRejectedValue(Object.assign(new Error('context too long'), {
      status: 400,
    }))
    const fallback = vi.fn().mockResolvedValue(mockResponse('larger context model'))

    const result = await llmRetry({
      providers: [
        { name: 'small-context-model', fn: primary, maxRetries: 0 },
        { name: 'large-context-model', fn: fallback, maxRetries: 0 },
      ],
      shouldFallback: (_error, context) => context.nextProvider === 'large-context-model',
    })

    expect(result.data).toBe('larger context model')
    expect(result.provider).toBe('large-context-model')
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
      defaultShouldRetry: false,
      provider: 'primary',
    }))
  })

  it('lets shouldRetry compose with the default retry decision', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('too many requests'), { status: 429 }))
      .mockResolvedValueOnce(mockResponse('ok'))

    const result = await llmRetry({
      fn,
      shouldRetry: (_error, context) => context.defaultShouldRetry,
      maxRetries: 1,
      initialDelayMs: 0,
    })

    expect(result.data).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
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

    expect(onFailure).toHaveBeenCalledWith(
      expect.any(LLMRetryError),
      expect.objectContaining({ attempts: 1 })
    )
  })

  it('passes meta and payload through attempt and failure contexts', async () => {
    const onAttempt = vi.fn()
    const onFailure = vi.fn()
    const payload = { prompt: 'summarize this' }
    const meta = { requestId: 'req-1' }

    await expect(
      llmRetry({
        fn: vi.fn().mockRejectedValue(Object.assign(new Error('bad request'), { status: 400 })),
        maxRetries: 0,
        meta,
        payload,
        onAttempt,
        onFailure,
      })
    ).rejects.toThrow(LLMRetryError)

    expect(onAttempt).toHaveBeenCalledWith(expect.objectContaining({ meta, payload }))
    expect(onFailure).toHaveBeenCalledWith(
      expect.any(LLMRetryError),
      expect.objectContaining({ meta, payload })
    )
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

  it('marks budget failures with a dedicated reason', async () => {
    await expect(
      llmRetry({
        fn: vi.fn().mockResolvedValue(mockResponse('ok')),
        maxCostUSD: 0,
      })
    ).rejects.toMatchObject({
      reason: 'budget_exceeded',
      primaryError: null,
    })
  })

  it('fails when timeoutMs is reached', async () => {
    await expect(
      llmRetry({
        fn: () => new Promise<never>(() => undefined),
        timeoutMs: 1,
        initialDelayMs: 0,
      })
    ).rejects.toThrow(LLMRetryError)
  })

  it('uses provider-specific timeout before falling back', async () => {
    const primary = vi.fn(() => new Promise<never>(() => undefined))
    const fallback = vi.fn().mockResolvedValue(mockResponse('fallback ok'))

    const result = await llmRetry({
      providers: [
        { name: 'fast-timeout', fn: primary, timeoutMs: 1, maxRetries: 0 },
        { name: 'fallback', fn: fallback, maxRetries: 0 },
      ],
    })

    expect(result.data).toBe('fallback ok')
    expect(result.provider).toBe('fallback')
    expect(primary).toHaveBeenCalledOnce()
    expect(fallback).toHaveBeenCalledOnce()
  })
})

describe('llmRetry resilience controls', () => {
  it('skips a provider while its circuit breaker is open', async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      windowMs: 1000,
      cooldownMs: 1000,
    })
    const primary = vi.fn().mockRejectedValue(Object.assign(new Error('server error'), {
      status: 503,
    }))
    const fallback = vi.fn().mockResolvedValue(mockResponse('fallback ok'))

    await llmRetry({
      providers: [
        { name: 'openai', fn: primary, maxRetries: 0, circuitBreaker: breaker },
        { name: 'anthropic', fn: fallback, maxRetries: 0 },
      ],
      initialDelayMs: 0,
    })

    await llmRetry({
      providers: [
        { name: 'openai', fn: primary, maxRetries: 0, circuitBreaker: breaker },
        { name: 'anthropic', fn: fallback, maxRetries: 0 },
      ],
      initialDelayMs: 0,
    })

    expect(primary).toHaveBeenCalledTimes(1)
    expect(fallback).toHaveBeenCalledTimes(2)
  })

  it('supports hedged requests and aborts the slower loser', async () => {
    let primaryAborted = false
    const primary = vi.fn((context) => {
      context.signal?.addEventListener('abort', () => {
        primaryAborted = true
      })

      return new Promise((resolve) => {
        setTimeout(() => resolve(mockResponse('slow primary')), 50)
      })
    })
    const hedge = vi.fn().mockResolvedValue(mockResponse('fast hedge'))

    const result = await llmRetry({
      providers: [
        { name: 'primary', fn: primary, maxRetries: 0 },
        { name: 'hedge', fn: hedge, maxRetries: 0 },
      ],
      hedgeDelayMs: 1,
    })

    expect(result.data).toBe('fast hedge')
    expect(result.provider).toBe('hedge')
    expect(result.attempts).toBe(2)
    expect(primaryAborted).toBe(true)
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

  it('does not parse non-finite numeric retry-after values as dates', () => {
    const hugeNumericHeader = '9'.repeat(400)

    expect(extractRetryAfter({ headers: { 'Retry-After': hugeNumericHeader } })).toBeNull()
  })
})

describe('llmRetryStream', () => {
  it('retries a stream when it fails before the first chunk', async () => {
    let calls = 0
    const stream = vi.fn(() => {
      calls += 1

      return (async function* () {
        if (calls === 1) {
          throw Object.assign(new Error('rate limit'), { status: 429 })
        }

        yield 'ok'
      })()
    })

    const result = llmRetryStream({
      stream,
      maxRetries: 1,
      initialDelayMs: 0,
    })
    const chunks: string[] = []

    for await (const chunk of result.stream) {
      chunks.push(chunk)
    }

    expect(chunks).toEqual(['ok'])
    expect(result.getStats()).toMatchObject({
      attempts: 2,
      chunks: 1,
      completed: true,
      totalTokens: 0,
    })
  })

  it('does not retry a stream after a chunk is emitted by default', async () => {
    const fallback = vi.fn(async function* () {
      yield 'fallback'
    })
    const result = llmRetryStream({
      providers: [
        {
          name: 'primary',
          stream: () => (async function* () {
            yield 'first'
            throw Object.assign(new Error('rate limit'), { status: 429 })
          })(),
          maxRetries: 1,
        },
        { name: 'fallback', stream: fallback, maxRetries: 0 },
      ],
      initialDelayMs: 0,
    })
    const chunks: string[] = []

    await expect(async () => {
      for await (const chunk of result.stream) {
        chunks.push(chunk)
      }
    }).rejects.toThrow(LLMRetryError)

    expect(chunks).toEqual(['first'])
    expect(fallback).not.toHaveBeenCalled()
  })

  it('tracks cumulative stream usage without double counting', async () => {
    const result = llmRetryStream({
      stream: () => (async function* () {
        yield {
          text: 'a',
          usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
        }
        yield {
          text: 'b',
          usage: { promptTokens: 5, completionTokens: 10, totalTokens: 15 },
        }
      })(),
      chunkUsageMode: 'cumulative',
      getChunkUsage: (chunk) => chunk.usage,
    })

    for await (const _chunk of result.stream) {
      // consume the stream
    }

    expect(result.getStats()).toMatchObject({
      chunks: 2,
      totalTokens: 15,
    })
  })
})
