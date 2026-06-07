import {
  calculateBackoff,
  createAbortError,
  extractRetryAfter,
  isRetryableError,
  sleep,
} from './backoff.js'
import { BudgetTracker } from './budget.js'
import { CircuitBreakerOpenError } from './circuit-breaker.js'
import { BudgetExceededError, LLMRetryError, ProviderTimeoutError } from './retry.js'
import type {
  CircuitBreakerLike,
  CostCalculator,
  FallbackDecisionContext,
  GlobalBudgetLike,
  RetryAttemptContext,
  RetryDecisionContext,
  RetryFailureContext,
  RetrySuccessContext,
  StreamRetryOptions,
  StreamRetryProvider,
  StreamRetryResult,
  StreamRetryStats,
  TokenUsage,
} from './types.js'

type RuntimeStreamProvider<TChunk> = Omit<StreamRetryProvider<TChunk>, 'circuitBreaker'> & {
  circuitBreaker?: CircuitBreakerLike
}

export function llmRetryStream<TChunk>(
  options: StreamRetryOptions<TChunk>
): StreamRetryResult<TChunk> {
  const stats: StreamRetryStats = {
    attempts: 0,
    usedFallback: false,
    totalCostUSD: 0,
    totalTokens: 0,
    chunks: 0,
    completed: false,
  }

  return {
    stream: createRetryingStream(options, stats),
    getStats: () => ({ ...stats }),
  }
}

async function* createRetryingStream<TChunk>(
  options: StreamRetryOptions<TChunk>,
  stats: StreamRetryStats
): AsyncIterable<TChunk> {
  const {
    maxRetries = 3,
    maxCostUSD,
    globalBudget,
    costPer1kTokens = 0.002,
    initialDelayMs = 1000,
    maxDelayMs = 30000,
    timeoutMs,
    signal,
    meta,
    payload,
    retryMode = 'before-first-chunk',
    chunkUsageMode = 'delta',
    getChunkUsage,
    shouldRetry,
    shouldFallback,
    onAttempt,
    onRetry,
    onChunk,
    onChunkError,
    onChunkErrorMode = 'ignore',
    onSuccess,
    onFailure,
    onBudgetExceeded,
  } = options

  validateStreamOptions({ maxRetries, initialDelayMs, maxDelayMs, timeoutMs })

  const providers = normalizeStreamProviders(options, maxRetries)
  validateStreamProviders(providers)
  const startedAt = Date.now()
  const budget = new BudgetTracker(costPer1kTokens, maxCostUSD)
  const runtimeSignal = createRuntimeSignal(signal, timeoutMs)

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

        const exceededBudget = getExceededBudget(budget, globalBudget)
        if (exceededBudget) {
          budgetExceededNotified = notifyBudgetExceeded(
            exceededBudget.spent,
            exceededBudget.limit,
            onBudgetExceeded,
            budgetExceededNotified
          )
          throw new BudgetExceededError(exceededBudget.spent, exceededBudget.limit)
        }

        stats.attempts += 1
        const attemptSignal = createAttemptSignal(runtimeSignal.signal, provider.timeoutMs)
        const context = createAttemptContext({
          attempt: stats.attempts,
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

        let emittedChunk = false
        let previousCumulativeUsage: TokenUsage | null = null

        try {
          const iterable = await runWithAbort(
            Promise.resolve(provider.stream(context)),
            attemptSignal.signal
          )

          for await (const chunk of iterateWithAbort(iterable, attemptSignal.signal)) {
            emittedChunk = true
            stats.chunks += 1
            stats.provider = provider.name
            stats.usedFallback = providerIndex > 0

            const usage = getChunkUsage?.(chunk, context)
            if (usage) {
              const usageToAdd =
                chunkUsageMode === 'cumulative'
                  ? diffCumulativeUsage(usage, previousCumulativeUsage)
                  : usage

              previousCumulativeUsage = usage
              trackStreamUsage({
                usage: usageToAdd,
                context,
                provider,
                defaultCostPer1kTokens: costPer1kTokens,
                defaultCostCalculator: options.costCalculator,
                budget,
                globalBudget,
                stats,
              })

              const exceededBudget = getExceededBudget(budget, globalBudget)
              if (exceededBudget) {
                budgetExceededNotified = notifyBudgetExceeded(
                  exceededBudget.spent,
                  exceededBudget.limit,
                  onBudgetExceeded,
                  budgetExceededNotified
                )
                throw new BudgetExceededError(exceededBudget.spent, exceededBudget.limit)
              }
            }

            await runChunkHook({
              chunk,
              context,
              onChunk,
              onChunkError,
              onChunkErrorMode,
            })
            yield chunk
          }

          provider.circuitBreaker?.recordSuccess()
          stats.completed = true
          stats.provider = provider.name
          stats.usedFallback = providerIndex > 0

          onSuccess?.({
            ...context,
            costUSD: 0,
            totalCostUSD: budget.spent,
            totalTokens: budget.tokens,
          })

          return
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error))
          lastError = err
          stats.lastError = err
          provider.circuitBreaker?.recordFailure()

          if (providerIndex === 0) {
            primaryError = err
          } else {
            fallbackError = err
          }

          const canRepeatStream =
            retryMode === 'always' || (!emittedChunk && retryMode === 'before-first-chunk')

          if (!canRepeatStream) {
            throw err
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

          onRetry?.(stats.attempts, err, delay, decisionContext)
          await sleep(delay, runtimeSignal.signal)
        } finally {
          attemptSignal.cleanup()
        }
      }

      if (providerIndex < providers.length - 1 && !providerShouldFallback) {
        break
      }
    }

    if (lastError) {
      throw lastError
    }

    throw new Error('No provider returned a successful stream')
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error))
    const retryError = new LLMRetryError(
      `LLM stream failed after ${stats.attempts} attempt${stats.attempts === 1 ? '' : 's'}: ${err.message}`,
      primaryError ?? lastError,
      fallbackError,
      budget.spent,
      budget.tokens,
      stats.attempts,
      providers.map((provider) => provider.name),
      getFailureReason(err)
    )
    const failureContext: RetryFailureContext = {
      attempts: stats.attempts,
      totalCostUSD: budget.spent,
      totalTokens: budget.tokens,
      providers: providers.map((provider) => provider.name),
      meta,
      payload,
    }

    onFailure?.(retryError, failureContext)
    throw retryError
  } finally {
    stats.totalCostUSD = budget.spent
    stats.totalTokens = budget.tokens
    runtimeSignal.cleanup()
  }
}

function normalizeStreamProviders<TChunk>(
  options: StreamRetryOptions<TChunk>,
  defaultMaxRetries: number
): Array<RuntimeStreamProvider<TChunk>> {
  if (options.providers && options.providers.length > 0) {
    if (options.stream || options.fallbackStream) {
      throw new Error('Use either providers or stream/fallbackStream, not both')
    }

    return options.providers.map((provider) => ({
      ...provider,
      maxRetries: provider.maxRetries ?? defaultMaxRetries,
    }))
  }

  if (!options.stream) {
    throw new Error('llmRetryStream requires stream or at least one provider')
  }

  const providers: Array<RuntimeStreamProvider<TChunk>> = [
    {
      name: 'primary',
      stream: options.stream,
      maxRetries: defaultMaxRetries,
      costCalculator: options.costCalculator,
      costPer1kTokens: options.costPer1kTokens,
    },
  ]

  if (options.fallbackStream) {
    providers.push({
      name: 'fallback',
      stream: options.fallbackStream,
      maxRetries: 0,
      costCalculator: options.costCalculator,
      costPer1kTokens: options.costPer1kTokens,
    })
  }

  return providers
}

async function* iterateWithAbort<TChunk>(
  iterable: AsyncIterable<TChunk>,
  signal: AbortSignal
): AsyncIterable<TChunk> {
  for await (const chunk of iterable) {
    if (signal.aborted) {
      throw getAbortReason(signal)
    }

    yield chunk
  }
}

async function shouldRetryAttempt(options: {
  error: Error
  context: RetryDecisionContext
  shouldRetry?: StreamRetryOptions['shouldRetry']
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

async function shouldFallbackFromProvider<TChunk>(options: {
  error: Error
  context: RetryAttemptContext
  nextProvider?: RuntimeStreamProvider<TChunk>
  nextProviderIndex: number
  shouldFallback?: StreamRetryOptions['shouldFallback']
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

function trackStreamUsage<TChunk>(options: {
  usage: TokenUsage
  context: RetryAttemptContext
  provider: RuntimeStreamProvider<TChunk>
  defaultCostPer1kTokens: number
  defaultCostCalculator?: CostCalculator
  budget: BudgetTracker
  globalBudget?: GlobalBudgetLike
  stats: StreamRetryStats
}): void {
  const calculator = options.provider.costCalculator ?? options.defaultCostCalculator
  const costUSD = calculator
    ? calculator(options.usage, options.context)
    : (options.usage.totalTokens / 1000) *
      (options.provider.costPer1kTokens ?? options.defaultCostPer1kTokens)

  options.budget.add(options.usage, costUSD)
  options.globalBudget?.add(costUSD)
  options.stats.totalCostUSD = options.budget.spent
  options.stats.totalTokens = options.budget.tokens
}

async function runChunkHook<TChunk>(options: {
  chunk: TChunk
  context: RetryAttemptContext
  onChunk?: StreamRetryOptions<TChunk>['onChunk']
  onChunkError?: StreamRetryOptions<TChunk>['onChunkError']
  onChunkErrorMode: NonNullable<StreamRetryOptions<TChunk>['onChunkErrorMode']>
}): Promise<void> {
  if (!options.onChunk) {
    return
  }

  try {
    await options.onChunk(options.chunk, options.context)
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error))

    try {
      await options.onChunkError?.(err, options.chunk, options.context)
    } catch {
      // Hook error handlers are observability paths; by default they must not break streaming.
    }

    if (options.onChunkErrorMode === 'throw') {
      throw err
    }
  }
}

function getExceededBudget(
  budget: BudgetTracker,
  globalBudget: GlobalBudgetLike | undefined
): { spent: number; limit: number | null } | null {
  if (budget.isExceeded()) {
    return { spent: budget.spent, limit: budget.limit }
  }

  if (globalBudget?.isExceeded()) {
    return { spent: globalBudget.spent, limit: globalBudget.limit }
  }

  return null
}

function diffCumulativeUsage(current: TokenUsage, previous: TokenUsage | null): TokenUsage {
  if (!previous) {
    return current
  }

  return {
    promptTokens: Math.max(current.promptTokens - previous.promptTokens, 0),
    completionTokens: Math.max(current.completionTokens - previous.completionTokens, 0),
    totalTokens: Math.max(current.totalTokens - previous.totalTokens, 0),
  }
}

function createAttemptContext<TChunk>(options: {
  attempt: number
  retryAttempt: number
  provider: RuntimeStreamProvider<TChunk>
  providerIndex: number
  startedAt: number
  signal: AbortSignal
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

function runWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
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
  callback: StreamRetryOptions['onBudgetExceeded'],
  alreadyNotified: boolean
): boolean {
  if (!alreadyNotified && limitUSD !== null) {
    callback?.(spentUSD, limitUSD)
  }

  return true
}

function validateStreamOptions(options: {
  maxRetries: number
  initialDelayMs: number
  maxDelayMs: number
  timeoutMs?: number
}): void {
  if (!Number.isInteger(options.maxRetries) || options.maxRetries < 0) {
    throw new Error('maxRetries must be a non-negative integer')
  }

  if (options.initialDelayMs < 0) {
    throw new Error('initialDelayMs must be greater than or equal to 0')
  }

  if (options.maxDelayMs < options.initialDelayMs) {
    throw new Error('maxDelayMs must be greater than or equal to initialDelayMs')
  }

  if (options.timeoutMs !== undefined && options.timeoutMs < 0) {
    throw new Error('timeoutMs must be greater than or equal to 0')
  }
}

function validateStreamProviders<TChunk>(providers: Array<RuntimeStreamProvider<TChunk>>): void {
  providers.forEach((provider) => {
    if (provider.timeoutMs !== undefined && provider.timeoutMs < 0) {
      throw new Error(`timeoutMs for provider "${provider.name}" must be greater than or equal to 0`)
    }
  })
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
