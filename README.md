# llm-retry-kit

[![npm](https://img.shields.io/npm/v/llm-retry-kit?label=npm)](https://www.npmjs.com/package/llm-retry-kit)
[![downloads](https://img.shields.io/npm/dm/llm-retry-kit?label=downloads)](https://www.npmjs.com/package/llm-retry-kit)
[![license](https://img.shields.io/npm/l/llm-retry-kit?label=license)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](./package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](./tsconfig.json)
[![CI](https://img.shields.io/github/actions/workflow/status/JavadRostami3/llm-retry-kit/ci.yml?label=CI)](https://github.com/JavadRostami3/llm-retry-kit/actions)

Small resilience layer for production LLM calls. `llm-retry-kit` gives you
provider-aware retries, fallback chains, jittered exponential backoff,
`Retry-After` handling, streaming retries, circuit breakers, hedged requests,
budget tracking, cancellation, timeouts, and observability hooks without
runtime dependencies.

```bash
npm install llm-retry-kit
```

## Why llm-retry-kit?

LLM APIs fail in ways that normal API wrappers often do not model well:

- `429` rate limits need backoff, not immediate loops.
- `500`, `503`, `504`, and Anthropic `529 overloaded_error` are usually
  transient and often worth retrying or failing over.
- `400`, `401`, `403`, and request-too-large errors are usually request or
  credential problems and should not blindly retry or fallback.
- Failed retry attempts can still count toward provider rate limits.
- Production apps need cancellation, budget limits, and logs around every
  attempt.

This package keeps the core primitive small: you provide the actual SDK call,
and `llm-retry-kit` manages the reliability policy around it.

## Features

- Retry transient LLM failures with exponential backoff and jitter.
- Respect `Retry-After` headers from provider errors.
- Chain named providers or models with explicit fallback behavior.
- Avoid fallback on non-transient client errors by default.
- Customize retry and fallback decisions with `shouldRetry` and
  `shouldFallback`.
- Track token usage and estimated cost.
- Use custom input/output token pricing through `costCalculator`.
- Wrap streaming responses with retry-before-first-chunk safety.
- Track partial stream token usage from provider events.
- Skip unhealthy providers with `CircuitBreaker`.
- Set timeout budgets per provider/model.
- Start hedged requests to reduce tail latency.
- Pass request `meta` and `payload` through every context for logging.
- Abort long calls and retry sleeps with `AbortSignal` or `timeoutMs`.
- Observe attempts, retries, success, failure, and budget events.
- Strict TypeScript types.
- ESM package with no runtime dependencies.

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
  initialDelayMs: 1000,
  maxDelayMs: 30000,
})

console.log(result.data)
console.log(result.provider)
console.log(result.attempts)
console.log(result.totalCostUSD)
```

## Complete Provider Fallback Example

This example tries OpenAI first, then falls back to Anthropic only for transient
failures. Client errors like invalid requests or bad credentials stop the chain
by default.

```ts
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { llmRetry } from 'llm-retry-kit'

const openai = new OpenAI()
const anthropic = new Anthropic()

const prompt = 'Summarize the following support ticket...'

const result = await llmRetry({
  providers: [
    {
      name: 'openai:gpt-4o-mini',
      maxRetries: 2,
      fn: async ({ signal }) => {
        const response = await openai.chat.completions.create(
          {
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: prompt }],
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
    },
    {
      name: 'anthropic:claude-sonnet',
      maxRetries: 1,
      fn: async ({ signal }) => {
        const response = await anthropic.messages.create(
          {
            model: 'claude-sonnet-4-6',
            max_tokens: 1024,
            messages: [{ role: 'user', content: prompt }],
          },
          { signal }
        )

        const text = response.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('')

        return {
          data: text,
          usage: {
            promptTokens: response.usage.input_tokens,
            completionTokens: response.usage.output_tokens,
            totalTokens: response.usage.input_tokens + response.usage.output_tokens,
          },
        }
      },
    },
  ],
  timeoutMs: 45_000,
})

console.log({
  provider: result.provider,
  usedFallback: result.usedFallback,
  attempts: result.attempts,
  answer: result.data,
})
```

## Streaming

OpenAI and Anthropic both expose streaming APIs, but their event formats and
resume behavior are provider-specific. `llm-retry-kit` therefore keeps the
stream wrapper provider-agnostic and conservative:

- By default, it retries only if the stream fails before the first chunk.
- After a chunk has been yielded, retrying could duplicate output, so it stops
  unless you explicitly set `retryMode: 'always'`.
- Token usage can be tracked from stream events with `getChunkUsage`.
- Use `chunkUsageMode: 'cumulative'` for providers that send cumulative usage
  snapshots during a stream.

```ts
import { llmRetryStream } from 'llm-retry-kit'

const result = llmRetryStream({
  stream: async ({ signal }) => {
    const stream = await openai.responses.create({
      model: 'gpt-4o-mini',
      input: 'Write a short incident summary.',
      stream: true,
    }, { signal })

    return stream
  },
  retryMode: 'before-first-chunk',
  getChunkUsage: (event) => {
    if (!('usage' in event) || !event.usage) return undefined

    return {
      promptTokens: event.usage.input_tokens ?? 0,
      completionTokens: event.usage.output_tokens ?? 0,
      totalTokens: event.usage.total_tokens ?? 0,
    }
  },
  chunkUsageMode: 'cumulative',
})

for await (const event of result.stream) {
  // Send provider events to your UI, parser, or SSE response.
}

console.log(result.getStats())
```

## Advanced Production Controls

### Circuit Breaker

Keep one `CircuitBreaker` instance per provider/model at application scope. If
the failure threshold is reached inside the time window, later calls skip that
provider until the cooldown expires.

```ts
import { CircuitBreaker, llmRetry } from 'llm-retry-kit'

const openaiBreaker = new CircuitBreaker({
  failureThreshold: 5,
  windowMs: 60_000,
  cooldownMs: 120_000,
})

await llmRetry({
  providers: [
    {
      name: 'openai:gpt-4o-mini',
      fn: callOpenAI,
      circuitBreaker: openaiBreaker,
    },
    {
      name: 'anthropic:claude-sonnet',
      fn: callAnthropic,
    },
  ],
})
```

### Per-Provider Timeout

Use global `timeoutMs` for the whole workflow and provider `timeoutMs` for a
single attempt.

```ts
await llmRetry({
  providers: [
    { name: 'openai:fast', fn: callOpenAI, timeoutMs: 3_000, maxRetries: 1 },
    { name: 'anthropic:steady', fn: callAnthropic, timeoutMs: 10_000 },
  ],
  timeoutMs: 30_000,
})
```

### Hedged Requests

Hedging starts the next provider in parallel if the current provider has not
answered after `hedgeDelayMs`. The first successful response wins and the
slower request is aborted through the context signal.

```ts
await llmRetry({
  providers: [
    { name: 'primary', fn: callPrimary },
    { name: 'hedge', fn: callBackup },
  ],
  hedgeDelayMs: 750,
})
```

Hedging is best for latency-sensitive read paths. It can increase provider
traffic, so pair it with budget tracking and conservative delay values.

### Metadata And Payload Tracking

Attach request metadata once and it flows into provider calls and hooks.

```ts
await llmRetry({
  fn: callModel,
  meta: { requestId: 'req_123', tenant: 'acme' },
  payload: { prompt: 'Classify this ticket', userId: 'user_42' },
  onAttempt: (context) => {
    console.log(context.meta, context.payload)
  },
  onFailure: (error, context) => {
    console.error(context.meta, error)
  },
})
```

## Simple Fallback API

For smaller apps, `fn` plus `fallback` is still supported.

```ts
const result = await llmRetry({
  fn: async () => callPrimaryModel(),
  fallback: async () => callFallbackModel(),
  maxRetries: 2,
})
```

## Configuration

### Retry Timing

```ts
await llmRetry({
  fn: myLLMCall,
  maxRetries: 4,
  initialDelayMs: 500,
  maxDelayMs: 60_000,
})
```

Retries use exponential backoff with jitter. If the provider exposes a
`Retry-After` header, that delay is preferred.

### Timeout And Cancellation

```ts
const controller = new AbortController()

const result = await llmRetry({
  fn: async ({ signal }) => myLLMCall({ signal }),
  signal: controller.signal,
  timeoutMs: 30_000,
})
```

`timeoutMs` aborts the wrapper and retry sleeps. Passing `signal` into your SDK
call also lets the underlying request stop when the SDK supports it.

### Budget Tracking

```ts
const result = await llmRetry({
  fn: myLLMCall,
  maxCostUSD: 0.5,
  costPer1kTokens: 0.002,
  onBudgetExceeded: (spent, limit) => {
    console.warn(`Budget exceeded: $${spent.toFixed(4)} / $${limit}`)
  },
})
```

For real provider pricing, prefer `costCalculator`:

```ts
const result = await llmRetry({
  fn: myLLMCall,
  costCalculator: (usage) => {
    const inputCost = usage.promptTokens * 0.00000015
    const outputCost = usage.completionTokens * 0.0000006
    return inputCost + outputCost
  },
})
```

Budget tracking is based on the `usage` object returned by your function. A
wrapper cannot know the final cost of an in-flight LLM call before the provider
returns usage, so `maxCostUSD` is a guard for later attempts and fallback calls.

### Custom Retry Policy

Use `context.defaultShouldRetry` to compose with the built-in transient error
detection.

```ts
await llmRetry({
  fn: myLLMCall,
  shouldRetry: (error, context) => {
    if (error.message.includes('insufficient quota')) return false
    return context.defaultShouldRetry
  },
})
```

By default, `llm-retry-kit` retries common transient failures such as HTTP
`408`, `409`, `429`, `5xx`, Anthropic `529`, timeout, network, and overload
errors.

### Custom Fallback Policy

Fallback is a separate decision from retry. By default, fallback is allowed only
after transient failures. If you intentionally want to fallback for a known
client-side case, opt in explicitly.

```ts
await llmRetry({
  providers: [
    { name: 'small-context-model', fn: callSmallModel },
    { name: 'large-context-model', fn: callLargeModel },
  ],
  shouldFallback: (error, context) => {
    if (error.message.includes('context length')) {
      return context.nextProvider === 'large-context-model'
    }

    return context.defaultShouldFallback
  },
})
```

### Observability

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
  onFailure: (error, context) => {
    console.error(context.meta, error)
  },
})
```

## API Reference

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
| `hedgeDelayMs` | `number` | optional | Start the next provider after this delay if the current provider is still pending. |
| `signal` | `AbortSignal` | optional | External cancellation signal. |
| `meta` | `unknown` | optional | User metadata copied into attempt/failure contexts. |
| `payload` | `unknown` | optional | Request payload copied into attempt/failure contexts. |
| `shouldRetry` | `(error, context) => boolean \| Promise<boolean>` | optional | Override retry decisions. |
| `shouldFallback` | `(error, context) => boolean \| Promise<boolean>` | optional | Override provider fallback decisions. |
| `onAttempt` | `(context) => void` | optional | Called before each attempt. |
| `onRetry` | `(attempt, error, delayMs, context) => void` | optional | Called before retry wait. |
| `onSuccess` | `(context) => void` | optional | Called after a successful response. |
| `onFailure` | `(error, context) => void` | optional | Called before final failure is thrown. |
| `onBudgetExceeded` | `(spentUSD, limitUSD) => void` | optional | Called when budget is exhausted. |

### `RetryProvider<T>`

```ts
{
  name: string
  fn: (context: RetryAttemptContext) => Promise<LLMResponse<T>>
  maxRetries?: number
  timeoutMs?: number
  hedgeDelayMs?: number
  circuitBreaker?: CircuitBreaker | CircuitBreakerOptions
  costPer1kTokens?: number
  costCalculator?: (usage, context) => number
}
```

### `llmRetryStream(options)`

Returns `{ stream, getStats }`. The request begins when the returned async
iterable is consumed.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `stream` | `(context) => AsyncIterable<TChunk> \| Promise<AsyncIterable<TChunk>>` | optional | Primary stream call for the simple API. |
| `fallbackStream` | `(context) => AsyncIterable<TChunk> \| Promise<AsyncIterable<TChunk>>` | optional | Backup stream call. |
| `providers` | `StreamRetryProvider<TChunk>[]` | optional | Explicit stream provider chain. |
| `retryMode` | `'before-first-chunk' \| 'always' \| 'never'` | `'before-first-chunk'` | Controls whether interrupted streams are retried. |
| `getChunkUsage` | `(chunk, context) => TokenUsage \| undefined` | optional | Extract token usage from stream chunks/events. |
| `chunkUsageMode` | `'delta' \| 'cumulative'` | `'delta'` | Interpret chunk usage as incremental or cumulative. |
| `maxRetries` | `number` | `3` | Retries after the first attempt. |
| `timeoutMs` | `number` | optional | Abort the whole stream workflow after this time. |
| `meta` | `unknown` | optional | User metadata copied into contexts. |
| `payload` | `unknown` | optional | Request payload copied into contexts. |

### `CircuitBreaker`

```ts
new CircuitBreaker({
  failureThreshold: 5,
  windowMs: 60_000,
  cooldownMs: 120_000,
})
```

`snapshot()` returns `{ state, failures, openedAt }`, where state is
`'closed'`, `'open'`, or `'half_open'`.

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

### `LLMRetryError`

```ts
{
  name: 'LLMRetryError'
  primaryError: Error | null
  fallbackError: Error | null
  totalCostUSD: number
  totalTokens: number
  attempts: number
  providers: string[]
  reason: 'failure' | 'budget_exceeded' | 'aborted'
}
```

## Defaults

| Setting | Default |
| --- | --- |
| `maxRetries` | `3` |
| `initialDelayMs` | `1000` |
| `maxDelayMs` | `30000` |
| `costPer1kTokens` | `0.002` |
| stream retry mode | `before-first-chunk` |
| fallback on client errors | `false` |
| fallback on transient errors | `true` |
| runtime dependencies | none |

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

## License

MIT
