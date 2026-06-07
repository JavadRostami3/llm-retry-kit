import {
  calculateBackoff,
  createAbortError,
  extractRetryAfter,
  isRetryableError,
  sleep,
} from './backoff.js'
import { BudgetTracker } from './budget.js'
import { CircuitBreaker, CircuitBreakerOpenError } from './circuit-breaker.js'
import type {
  CircuitBreakerLike,
  CostCalculator,
  FallbackDecisionContext,
  LLMResponse,
  RetryAttemptContext,
  RetryDecisionContext,
  RetryOptions,
  RetryProvider,
  RetryResult,
  RetrySuccessContext,
  TokenUsage,
} from './types.js'

type RuntimeRetryProvider<T> = Omit<RetryProvider<T>, 'circuitBreaker'> & {
  circuitBreaker?: CircuitBreakerLike
}

export async function llmRetry<T>(options: RetryOptions<T>): Promise<RetryResult<T>> {
  const {
    maxRetries = 3,
    maxCostUSD,
    costPer1kTokens = 0.002,
    initialDelayMs = 1000,
    maxDelayMs = 30000,
    timeoutMs,
    hedgeDelayMs,
    signal,
    meta,
    payload,
    shouldRetry,
    shouldFallback,
    onAttempt,
    onRetry,
    onSuccess,
    onFailure,
    onBudgetExceeded,
  } = options

  validateOptions({ maxRetries, initialDelayMs, maxDelayMs, timeoutMs, hedgeDelayMs })

  const providers = normalizeProviders(options, maxRetries)
  validateProviders(providers)
  const startedAt = Date.now()
  const budget = new BudgetTracker(costPer1kTokens, maxCostUSD)
  const runtimeSignal = createRuntimeSignal(signal, timeoutMs)

  let attempts = 0
  let lastError: Error | null = null
  let primaryError: Error | null = null
  let fallbackError: Error | null = null
  let budgetExceededNotified = false

  try {
    for (let providerIndex = 0; providerIndex < providers.length; providerIndex++) {
      const provider = providers[providerIndex]
      const providerMaxRetries = provider.maxRetries ?? maxRetries
      let providerShouldFallback = false

      if (provider.circuitBreaker && !provider.circuitBreaker.canRequest()) {
        const err = new CircuitBreakerOpenError(provider.name)
        lastError = err

        if (providerIndex === 0) {
          primaryError = err
        } else {
          fallbackError = err
        }

        if (providerIndex < providers.length - 1) {
          continue
        }

        break
      }

      for (let retryAttempt = 0; retryAttempt <= providerMaxRetries; retryAttempt++) {
        if (runtimeSignal.signal?.aborted) {
          throw createAbortError()
        }

        if (budget.isExceeded()) {
          budgetExceededNotified = notifyBudgetExceeded(
            budget.spent,
            budget.limit,
            onBudgetExceeded,
            budgetExceededNotified
          )
          throw new BudgetExceededError(budget.spent, budget.limit)
        }

        attempts += 1
        const attemptSignal = createAttemptSignal(runtimeSignal.signal, provider.timeoutMs)

        const context = createAttemptContext({
          attempt: attempts,
          retryAttempt,
          provider,
          providerIndex,
          startedAt,
          signal: attemptSignal.signal,
          lastError,
          meta,
          payload,
        })

        onAttempt?.(context)

        try {
          const response = await runProviderAttempt({
            providers,
            providerIndex,
            context,
            runtimeSignal: runtimeSignal.signal,
            attemptSignal,
            retryAttempt,
            startedAt,
            lastError,
            meta,
            payload,
            hedgeDelayMs,
            nextAttemptNumber: () => {
              attempts += 1
              return attempts
            },
            onAttempt,
          })

          const costUSD = trackUsage({
            response: response.response,
            context: response.context,
            provider: response.provider,
            defaultCostPer1kTokens: costPer1kTokens,
            defaultCostCalculator: options.costCalculator,
            budget,
          })

          response.provider.circuitBreaker?.recordSuccess()

          onSuccess?.({
            ...response.context,
            costUSD,
            totalCostUSD: budget.spent,
            totalTokens: budget.tokens,
          })

          return {
            data: response.response.data,
            attempts,
            provider: response.provider.name,
            usedFallback: response.providerIndex > 0,
            totalCostUSD: budget.spent,
            totalTokens: budget.tokens,
          }
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error))
          lastError = err
          provider.circuitBreaker?.recordFailure()

          if (providerIndex === 0) {
            primaryError = err
          } else {
            fallbackError = err
          }

          const decisionContext: RetryDecisionContext = {
            ...context,
            maxRetries: providerMaxRetries,
            defaultShouldRetry: isRetryableError(err),
          }

          const retry = await shouldRetryAttempt({
            error: err,
            context: decisionContext,
            shouldRetry,
            retryAttempt,
            maxRetries: providerMaxRetries,
          })

          if (!retry) {
            providerShouldFallback = await shouldFallbackFromProvider({
              error: err,
              context,
              nextProvider: providers[providerIndex + 1],
              nextProviderIndex: providerIndex + 1,
              shouldFallback,
            })
            break
          }

          const serverDelay = extractRetryAfter(err)
          const delay = serverDelay ?? calculateBackoff(retryAttempt, initialDelayMs, maxDelayMs)

          onRetry?.(attempts, err, delay, decisionContext)
          await sleep(delay, runtimeSignal.signal)
        } finally {
          attemptSignal.cleanup()
        }
      }

      if (providerIndex < providers.length - 1 && !providerShouldFallback) {
        break
      }
    }

    if (budget.isExceeded()) {
      budgetExceededNotified = notifyBudgetExceeded(
        budget.spent,
        budget.limit,
        onBudgetExceeded,
        budgetExceededNotified
      )
    }

    throw new Error(lastError?.message ?? 'No provider returned a successful response')
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error))
    const reason = getFailureReason(err)
    const retryError = new LLMRetryError(
      `LLM call failed after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${err.message}`,
      primaryError ?? lastError,
      fallbackError,
      budget.spent,
      budget.tokens,
      attempts,
      providers.map((provider) => provider.name),
      reason
    )

    onFailure?.(retryError, {
      attempts,
      totalCostUSD: budget.spent,
      totalTokens: budget.tokens,
      providers: providers.map((provider) => provider.name),
      meta,
      payload,
    })
    throw retryError
  } finally {
    runtimeSignal.cleanup()
  }
}

function normalizeProviders<T>(
  options: RetryOptions<T>,
  defaultMaxRetries: number
): Array<RuntimeRetryProvider<T>> {
  if (options.providers && options.providers.length > 0) {
    if (options.fn || options.fallback) {
      throw new Error('Use either providers or fn/fallback, not both')
    }

    return options.providers.map((provider) => ({
      ...provider,
      maxRetries: provider.maxRetries ?? defaultMaxRetries,
      circuitBreaker: normalizeCircuitBreaker(provider.circuitBreaker),
    }))
  }

  if (!options.fn) {
    throw new Error('llmRetry requires fn or at least one provider')
  }

  const providers: Array<RuntimeRetryProvider<T>> = [
    {
      name: 'primary',
      fn: options.fn,
      maxRetries: defaultMaxRetries,
      costCalculator: options.costCalculator,
      costPer1kTokens: options.costPer1kTokens,
    },
  ]

  if (options.fallback) {
    providers.push({
      name: 'fallback',
      fn: options.fallback,
      maxRetries: 0,
      costCalculator: options.costCalculator,
      costPer1kTokens: options.costPer1kTokens,
    })
  }

  return providers
}

function createAttemptContext<T>(options: {
  attempt: number
  retryAttempt: number
  provider: RuntimeRetryProvider<T>
  providerIndex: number
  startedAt: number
  signal?: AbortSignal
  lastError: Error | null
  meta?: unknown
  payload?: unknown
}): RetryAttemptContext {
  return {
    attempt: options.attempt,
    retryAttempt: options.retryAttempt,
    provider: options.provider.name,
    providerIndex: options.providerIndex,
    elapsedMs: Date.now() - options.startedAt,
    signal: options.signal,
    lastError: options.lastError ?? undefined,
    meta: options.meta,
    payload: options.payload,
  }
}

async function runProviderAttempt<T>(options: {
  providers: Array<RuntimeRetryProvider<T>>
  providerIndex: number
  context: RetryAttemptContext
  runtimeSignal?: AbortSignal
  attemptSignal: AttemptSignal
  retryAttempt: number
  startedAt: number
  lastError: Error | null
  meta?: unknown
  payload?: unknown
  hedgeDelayMs?: number
  nextAttemptNumber: () => number
  onAttempt?: RetryOptions<T>['onAttempt']
}): Promise<{
  response: LLMResponse<T>
  provider: RuntimeRetryProvider<T>
  providerIndex: number
  context: RetryAttemptContext
}> {
  const provider = options.providers[options.providerIndex]
  const hedgeDelayMs = provider.hedgeDelayMs ?? options.hedgeDelayMs
  const nextProvider = options.providers[options.providerIndex + 1]

  if (
    options.retryAttempt === 0 &&
    hedgeDelayMs !== undefined &&
    nextProvider &&
    (!nextProvider.circuitBreaker || nextProvider.circuitBreaker.canRequest())
  ) {
    return runHedgedAttempt({
      ...options,
      provider,
      hedgeProvider: nextProvider,
      hedgeProviderIndex: options.providerIndex + 1,
      hedgeDelayMs,
    })
  }

  return {
    response: await runWithAbort(provider.fn(options.context), options.attemptSignal.signal),
    provider,
    providerIndex: options.providerIndex,
    context: options.context,
  }
}

function runHedgedAttempt<T>(options: {
  provider: RuntimeRetryProvider<T>
  hedgeProvider: RuntimeRetryProvider<T>
  hedgeProviderIndex: number
  providers: Array<RuntimeRetryProvider<T>>
  providerIndex: number
  context: RetryAttemptContext
  runtimeSignal?: AbortSignal
  attemptSignal: AttemptSignal
  hedgeDelayMs: number
  startedAt: number
  lastError: Error | null
  meta?: unknown
  payload?: unknown
  nextAttemptNumber: () => number
  onAttempt?: RetryOptions<T>['onAttempt']
}): Promise<{
  response: LLMResponse<T>
  provider: RuntimeRetryProvider<T>
  providerIndex: number
  context: RetryAttemptContext
}> {
  return new Promise((resolve, reject) => {
    let done = false
    let pending = 1
    let hedgeTimeout: ReturnType<typeof setTimeout> | null = null
    let hedgeSignal: AttemptSignal | null = null
    let lastFailure: Error | null = null

    const cleanup = () => {
      if (hedgeTimeout) {
        clearTimeout(hedgeTimeout)
      }

      hedgeSignal?.cleanup()
    }

    const succeed = (result: {
      response: LLMResponse<T>
      provider: RuntimeRetryProvider<T>
      providerIndex: number
      context: RetryAttemptContext
    }) => {
      if (done) return
      done = true

      if (result.providerIndex === options.providerIndex) {
        hedgeSignal?.abort()
      } else {
        options.attemptSignal.abort()
      }

      cleanup()
      resolve(result)
    }

    const fail = (error: unknown) => {
      if (done) return

      const err = error instanceof Error ? error : new Error(String(error))
      lastFailure = err
      pending -= 1

      if (pending === 0) {
        done = true
        cleanup()
        reject(lastFailure)
      }
    }

    runWithAbort(options.provider.fn(options.context), options.attemptSignal.signal).then(
      (response) => succeed({
        response,
        provider: options.provider,
        providerIndex: options.providerIndex,
        context: options.context,
      }),
      (error) => fail(error)
    )

    hedgeTimeout = setTimeout(() => {
      if (done) return

      pending += 1
      hedgeSignal = createAttemptSignal(
        options.runtimeSignal,
        options.hedgeProvider.timeoutMs
      )

      const hedgeContext = createAttemptContext({
        attempt: options.nextAttemptNumber(),
        retryAttempt: 0,
        provider: options.hedgeProvider,
        providerIndex: options.hedgeProviderIndex,
        startedAt: options.startedAt,
        signal: hedgeSignal.signal,
        lastError: options.lastError,
        meta: options.meta,
        payload: options.payload,
      })

      options.onAttempt?.(hedgeContext)

      runWithAbort(options.hedgeProvider.fn(hedgeContext), hedgeSignal.signal).then(
        (response) => succeed({
          response,
          provider: options.hedgeProvider,
          providerIndex: options.hedgeProviderIndex,
          context: hedgeContext,
        }),
        (error) => fail(error)
      )
    }, options.hedgeDelayMs)
  })
}

async function shouldRetryAttempt(options: {
  error: Error
  context: RetryDecisionContext
  shouldRetry?: RetryOptions['shouldRetry']
  retryAttempt: number
  maxRetries: number
}): Promise<boolean> {
  if (options.error.name === 'AbortError') {
    return false
  }

  if (options.retryAttempt >= options.maxRetries) {
    return false
  }

  if (options.shouldRetry) {
    return options.shouldRetry(options.error, options.context)
  }

  return isRetryableError(options.error)
}

async function shouldFallbackFromProvider<T>(options: {
  error: Error
  context: RetryAttemptContext
  nextProvider?: RuntimeRetryProvider<T>
  nextProviderIndex: number
  shouldFallback?: RetryOptions['shouldFallback']
}): Promise<boolean> {
  if (!options.nextProvider) {
    return false
  }

  const fallbackContext: FallbackDecisionContext = {
    ...options.context,
    defaultShouldFallback: isRetryableError(options.error),
    nextProvider: options.nextProvider.name,
    nextProviderIndex: options.nextProviderIndex,
  }

  if (options.shouldFallback) {
    return options.shouldFallback(options.error, fallbackContext)
  }

  return fallbackContext.defaultShouldFallback
}

function trackUsage<T>(options: {
  response: LLMResponse<T>
  context: RetryAttemptContext
  provider: RuntimeRetryProvider<T>
  defaultCostPer1kTokens: number
  defaultCostCalculator?: CostCalculator
  budget: BudgetTracker
}): number {
  const usage = options.response.usage
  if (!usage) {
    return 0
  }

  const calculator = options.provider.costCalculator ?? options.defaultCostCalculator
  const costUSD = calculator
    ? calculator(usage, options.context)
    : calculateDefaultCost(usage, options.provider.costPer1kTokens ?? options.defaultCostPer1kTokens)

  options.budget.add(usage, costUSD)

  return costUSD
}

function calculateDefaultCost(usage: TokenUsage, costPer1kTokens: number): number {
  return (usage.totalTokens / 1000) * costPer1kTokens
}

function runWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return promise
  }

  if (signal.aborted) {
    return Promise.reject(getAbortReason(signal))
  }

  return new Promise((resolve, reject) => {
    const abort = () => reject(getAbortReason(signal))

    signal.addEventListener('abort', abort, { once: true })

    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      }
    )
  })
}

interface AttemptSignal {
  signal: AbortSignal
  abort: () => void
  cleanup: () => void
}

function createAttemptSignal(parentSignal: AbortSignal | undefined, timeoutMs: number | undefined): AttemptSignal {
  const controller = new AbortController()
  const timeout =
    timeoutMs === undefined
      ? null
      : setTimeout(() => controller.abort(new ProviderTimeoutError(timeoutMs)), timeoutMs)

  const abortFromParent = () => controller.abort(getAbortReason(parentSignal))
  parentSignal?.addEventListener('abort', abortFromParent, { once: true })

  return {
    signal: controller.signal,
    abort: () => controller.abort(createAbortError()),
    cleanup: () => {
      if (timeout) {
        clearTimeout(timeout)
      }

      parentSignal?.removeEventListener('abort', abortFromParent)
    },
  }
}

function createRuntimeSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined
): { signal?: AbortSignal; cleanup: () => void } {
  if (timeoutMs === undefined) {
    return { signal, cleanup: () => undefined }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(createAbortError()), timeoutMs)

  const abortFromParent = () => controller.abort(getAbortReason(signal))
  signal?.addEventListener('abort', abortFromParent, { once: true })

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abortFromParent)
    },
  }
}

function getAbortReason(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason
  return reason instanceof Error ? reason : createAbortError()
}

function notifyBudgetExceeded(
  spentUSD: number,
  limitUSD: number | null,
  callback: RetryOptions['onBudgetExceeded'],
  alreadyNotified: boolean
): boolean {
  if (!alreadyNotified && limitUSD !== null) {
    callback?.(spentUSD, limitUSD)
  }

  return true
}

export class LLMRetryError extends Error {
  constructor(
    message: string,
    public readonly primaryError: Error | null,
    public readonly fallbackError: Error | null,
    public readonly totalCostUSD: number,
    public readonly totalTokens: number,
    public readonly attempts = 0,
    public readonly providers: string[] = [],
    public readonly reason: 'failure' | 'budget_exceeded' | 'aborted' = 'failure'
  ) {
    super(message)
    this.name = 'LLMRetryError'
  }
}

export class BudgetExceededError extends Error {
  constructor(
    public readonly spentUSD: number,
    public readonly limitUSD: number | null
  ) {
    const limit = limitUSD === null ? 'unknown' : `$${limitUSD}`
    super(`Budget exceeded: $${spentUSD.toFixed(6)} / ${limit}`)
    this.name = 'BudgetExceededError'
  }
}

export class ProviderTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Provider timed out after ${timeoutMs}ms`)
    this.name = 'TimeoutError'
  }
}

function getFailureReason(error: Error): 'failure' | 'budget_exceeded' | 'aborted' {
  if (error instanceof BudgetExceededError) {
    return 'budget_exceeded'
  }

  if (error.name === 'AbortError') {
    return 'aborted'
  }

  return 'failure'
}

function validateOptions(options: {
  maxRetries: number
  initialDelayMs: number
  maxDelayMs: number
  timeoutMs?: number
  hedgeDelayMs?: number
}): void {
  if (!Number.isInteger(options.maxRetries) || options.maxRetries < 0) {
    throw new Error('maxRetries must be a non-negative integer')
  }

  if (options.initialDelayMs < 0) {
    throw new Error('initialDelayMs must be greater than or equal to 0')
  }

  if (options.maxDelayMs < 0) {
    throw new Error('maxDelayMs must be greater than or equal to 0')
  }

  if (options.maxDelayMs < options.initialDelayMs) {
    throw new Error('maxDelayMs must be greater than or equal to initialDelayMs')
  }

  if (options.timeoutMs !== undefined && options.timeoutMs < 0) {
    throw new Error('timeoutMs must be greater than or equal to 0')
  }

  if (options.hedgeDelayMs !== undefined && options.hedgeDelayMs < 0) {
    throw new Error('hedgeDelayMs must be greater than or equal to 0')
  }
}

function validateProviders<T>(providers: Array<RuntimeRetryProvider<T>>): void {
  providers.forEach((provider) => {
    if (provider.timeoutMs !== undefined && provider.timeoutMs < 0) {
      throw new Error(`timeoutMs for provider "${provider.name}" must be greater than or equal to 0`)
    }

    if (provider.hedgeDelayMs !== undefined && provider.hedgeDelayMs < 0) {
      throw new Error(`hedgeDelayMs for provider "${provider.name}" must be greater than or equal to 0`)
    }
  })
}

function normalizeCircuitBreaker(
  circuitBreaker: RetryProvider['circuitBreaker']
): CircuitBreakerLike | undefined {
  if (!circuitBreaker) {
    return undefined
  }

  if ('canRequest' in circuitBreaker) {
    return circuitBreaker
  }

  return new CircuitBreaker(circuitBreaker)
}
