# llm-retry-kit

Small resilience layer for production LLM calls. It gives you retries,
provider fallback, jittered exponential backoff, `Retry-After` handling,
budget tracking, cancellation, timeouts, and observability hooks.

## Install

```bash
npm install llm-retry-kit
```

## Quick Start

```ts
import { llmRetry } from 'llm-retry-kit'
import OpenAI from 'openai'

const openai = new OpenAI()

const result = await llmRetry({
  fn: async ({ signal }) => {
    const response = await openai.chat.completions.create(
      {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Hello!' }],
      },
      { signal }
    )

    return {
      data: response.choices[0]?.message.content ?? '',
      usage: response.usage
        ? {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
            totalTokens: response.usage.total_tokens,
          }
        : undefined,
    }
  },
  maxRetries: 3,
})

console.log(result.data)
console.log(result.provider)
console.log(result.totalCostUSD)
```

## Provider Fallback Chain

Use `providers` when you want explicit model or vendor failover. Each provider
can have its own retry count and cost calculator.

```ts
const result = await llmRetry({
  providers: [
    {
      name: 'openai:gpt-4o',
      fn: async (context) => callOpenAI(context),
      maxRetries: 2,
    },
    {
      name: 'anthropic:sonnet',
      fn: async (context) => callAnthropic(context),
      maxRetries: 1,
    },
  ],
})

console.log(result.provider)
console.log(result.usedFallback)
```

The older `fn` + `fallback` API still works:

```ts
const result = await llmRetry({
  fn: async () => callPrimaryModel(),
  fallback: async () => callFallbackModel(),
})
```

## Custom Retry Policy

```ts
const result = await llmRetry({
  fn: myLLMCall,
  shouldRetry: (error, context) => {
    if (error.message.includes('quota exceeded')) return false
    return context.retryAttempt < context.maxRetries
  },
})
```

Without `shouldRetry`, the package retries common transient failures such as
HTTP `408`, `409`, `429`, `5xx`, Anthropic `529`, timeout, network, and
overload errors.

## Timeouts And Cancellation

```ts
const controller = new AbortController()

const result = await llmRetry({
  fn: async ({ signal }) => myLLMCall({ signal }),
  signal: controller.signal,
  timeoutMs: 30_000,
})
```

`timeoutMs` aborts the wrapper and retry waits. Passing `signal` into your SDK
call lets the underlying HTTP request stop too, when the SDK supports it.

## Budget Tracking

Simple mode:

```ts
const result = await llmRetry({
  fn: myLLMCall,
  maxCostUSD: 0.5,
  costPer1kTokens: 0.002,
})
```

Provider pricing is often more nuanced than one flat token price, so production
apps should prefer `costCalculator`:

```ts
const result = await llmRetry({
  fn: myLLMCall,
  costCalculator: (usage) => {
    const input = usage.promptTokens * 0.00000015
    const output = usage.completionTokens * 0.0000006
    return input + output
  },
})
```

## Observability

```ts
await llmRetry({
  fn: myLLMCall,
  onAttempt: (context) => {
    console.log(`Calling ${context.provider}, attempt ${context.attempt}`)
  },
  onRetry: (attempt, error, delayMs, context) => {
    console.log(`${context.provider} failed: ${error.message}`)
    console.log(`Retrying in ${delayMs}ms`)
  },
  onSuccess: (context) => {
    console.log(`Cost so far: $${context.totalCostUSD}`)
  },
  onFailure: (error) => {
    console.error(error)
  },
})
```

## API

### `llmRetry(options)`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `fn` | `(context) => Promise<LLMResponse<T>>` | optional | Primary LLM call for the simple API. |
| `fallback` | `(context) => Promise<LLMResponse<T>>` | optional | Backup LLM call for the simple API. |
| `providers` | `RetryProvider<T>[]` | optional | Explicit provider/model chain. |
| `maxRetries` | `number` | `3` | Retries after the first attempt. |
| `maxCostUSD` | `number` | optional | Maximum tracked cost before later attempts stop. |
| `costPer1kTokens` | `number` | `0.002` | Simple cost estimate. |
| `costCalculator` | `(usage, context) => number` | optional | Custom cost calculation. |
| `initialDelayMs` | `number` | `1000` | Initial retry delay. |
| `maxDelayMs` | `number` | `30000` | Maximum retry delay. |
| `timeoutMs` | `number` | optional | Abort wrapper after this time. |
| `signal` | `AbortSignal` | optional | External cancellation signal. |
| `shouldRetry` | `(error, context) => boolean \| Promise<boolean>` | optional | Override retry decisions. |
| `onAttempt` | `(context) => void` | optional | Called before each attempt. |
| `onRetry` | `(attempt, error, delayMs, context) => void` | optional | Called before retry wait. |
| `onSuccess` | `(context) => void` | optional | Called after a successful response. |
| `onFailure` | `(error) => void` | optional | Called before final failure is thrown. |
| `onBudgetExceeded` | `(spentUSD, limitUSD) => void` | optional | Called when budget is exhausted. |

### `RetryResult<T>`

```ts
{
  data: T
  attempts: number
  provider: string
  usedFallback: boolean
  totalCostUSD: number
  totalTokens: number
}
```

## Notes

Budget tracking is based on the `usage` object returned by your function. A
wrapper cannot know the final cost of an in-flight LLM call before the provider
returns usage, so `maxCostUSD` is a guard for later attempts and fallback calls.

## License

MIT
