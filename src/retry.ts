import {
  calculateBackoff,
  createAbortError,
  extractRetryAfter,
  isRetryableError,
  sleep,
} from './backoff.js'
import { BudgetTracker } from './budget.js'
import type {
  CostCalculator,
  LLMResponse,
  RetryAttemptContext,
  RetryDecisionContext,
  RetryOptions,
  RetryProvider,
  RetryResult,
  RetrySuccessContext,
  TokenUsage,
} from './types.js'

export async function llmRetry<T>(options: RetryOptions<T>): Promise<RetryResult<T>> {
  const {
    maxRetries = 3,
    maxCostUSD,
    costPer1kTokens = 0.002,
    initialDelayMs = 1000,
    maxDelayMs = 30000,
    timeoutMs,
    signal,
    shouldRetry,
    onAttempt,
    onRetry,
    onSuccess,
    onFailure,
    onBudgetExceeded,
  } = options

  validateOptions({ maxRetries, initialDelayMs, maxDelayMs, timeoutMs })

  const providers = normalizeProviders(options, maxRetries)
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
          throw new Error('Budget exceeded')
        }

        attempts += 1

        const context = createAttemptContext({
          attempt: attempts,
          retryAttempt,
          provider,
          providerIndex,
          startedAt,
          signal: runtimeSignal.signal,
          lastError,
        })

        onAttempt?.(context)

        try {
          const response = await runWithAbort(provider.fn(context), runtimeSignal.signal)
          const costUSD = trackUsage({
            response,
            context,
            provider,
            defaultCostPer1kTokens: costPer1kTokens,
            defaultCostCalculator: options.costCalculator,
            budget,
          })

          onSuccess?.({
            ...context,
            costUSD,
            totalCostUSD: budget.spent,
            totalTokens: budget.tokens,
          })

          return {
            data: response.data,
            attempts,
            provider: provider.name,
            usedFallback: providerIndex > 0,
            totalCostUSD: budget.spent,
            totalTokens: budget.tokens,
          }
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error))
          lastError = err

          if (providerIndex === 0) {
            primaryError = err
          } else {
            fallbackError = err
          }

          const decisionContext: RetryDecisionContext = {
            ...context,
            maxRetries: providerMaxRetries,
          }

          const retry = await shouldRetryAttempt({
            error: err,
            context: decisionContext,
            shouldRetry,
            retryAttempt,
            maxRetries: providerMaxRetries,
          })

          if (!retry) {
            break
          }

          const serverDelay = extractRetryAfter(err)
          const delay = serverDelay ?? calculateBackoff(retryAttempt, initialDelayMs, maxDelayMs)

          onRetry?.(attempts, err, delay, decisionContext)
          await sleep(delay, runtimeSignal.signal)
        }
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
    const retryError = new LLMRetryError(
      `LLM call failed after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${err.message}`,
      primaryError ?? lastError,
      fallbackError,
      budget.spent,
      budget.tokens,
      attempts,
      providers.map((provider) => provider.name)
    )

    onFailure?.(retryError)
    throw retryError
  } finally {
    runtimeSignal.cleanup()
  }
}

function normalizeProviders<T>(
  options: RetryOptions<T>,
  defaultMaxRetries: number
): Array<RetryProvider<T>> {
  if (options.providers && options.providers.length > 0) {
    if (options.fn || options.fallback) {
      throw new Error('Use either providers or fn/fallback, not both')
    }

    return options.providers.map((provider) => ({
      ...provider,
      maxRetries: provider.maxRetries ?? defaultMaxRetries,
    }))
  }

  if (!options.fn) {
    throw new Error('llmRetry requires fn or at least one provider')
  }

  const providers: Array<RetryProvider<T>> = [
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
  provider: RetryProvider<T>
  providerIndex: number
  startedAt: number
  signal?: AbortSignal
  lastError: Error | null
}): RetryAttemptContext {
  return {
    attempt: options.attempt,
    retryAttempt: options.retryAttempt,
    provider: options.provider.name,
    providerIndex: options.providerIndex,
    elapsedMs: Date.now() - options.startedAt,
    signal: options.signal,
    lastError: options.lastError ?? undefined,
  }
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

function trackUsage<T>(options: {
  response: LLMResponse<T>
  context: RetryAttemptContext
  provider: RetryProvider<T>
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
    return Promise.reject(createAbortError())
  }

  return new Promise((resolve, reject) => {
    const abort = () => reject(createAbortError())

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

function createRuntimeSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined
): { signal?: AbortSignal; cleanup: () => void } {
  if (timeoutMs === undefined) {
    return { signal, cleanup: () => undefined }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  const abortFromParent = () => controller.abort()
  signal?.addEventListener('abort', abortFromParent, { once: true })

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abortFromParent)
    },
  }
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
    public readonly providers: string[] = []
  ) {
    super(message)
    this.name = 'LLMRetryError'
  }
}

function validateOptions(options: {
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

  if (options.maxDelayMs < 0) {
    throw new Error('maxDelayMs must be greater than or equal to 0')
  }

  if (options.maxDelayMs < options.initialDelayMs) {
    throw new Error('maxDelayMs must be greater than or equal to initialDelayMs')
  }

  if (options.timeoutMs !== undefined && options.timeoutMs < 0) {
    throw new Error('timeoutMs must be greater than or equal to 0')
  }
}
