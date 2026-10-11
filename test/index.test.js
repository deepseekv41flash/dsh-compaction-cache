import test from 'node:test'
import assert from 'node:assert/strict'
import { alignCompactionOptions, apply, internals, isCompactionRequest, resolveOptions } from '../lib/index.js'

/** The routed envelope measured in the reporting deployment. */
const HEADER = Object.freeze({
  config: Object.freeze({
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    reasoningEffort: 'max',
    maxTokens: 256000
  }),
  adapterDefaults: Object.freeze({ maxTokens: true })
})

/** The envelope `summarizeWithLlm` builds today: no effort, forced maxTokens. */
function stockEnvelope() {
  return { purpose: 'compaction', sessionId: 'session-x', maxTokens: 65536 }
}

/** A minimal host context that records the listener and the log lines. */
function fakeHost(session) {
  const handlers = []
  const logs = []
  return {
    handlers,
    logs,
    ctx: {
      get: (key) => (key === 'sessions' && session !== undefined ? { get: () => session } : undefined),
      on: (event, handler) => handlers.push({ event, handler }),
      logger: {
        info: (format, ...args) => logs.push(['info', format, ...args]),
        warn: (format, ...args) => logs.push(['warn', format, ...args])
      }
    }
  }
}

/** Log lines whose format matches, so mount-time lines never skew a listener test. */
function logged(host, pattern) {
  return host.logs.filter((entry) => pattern.test(entry[1]))
}

test('mirrors the routed reasoning effort and restores the routed maxTokens', () => {
  const options = stockEnvelope()
  const applied = alignCompactionOptions(options, HEADER)
  assert.equal(options.reasoningEffort, 'max')
  assert.equal(options.maxTokens, 256000)
  assert.deepEqual(applied, ['reasoningEffort=max', 'maxTokens=256000 (was 65536)'])
})

test('leaves an adapter-materialized parameter to the adapter', () => {
  const options = stockEnvelope()
  const header = { config: { reasoningEffort: 'max', maxTokens: 256000 }, adapterDefaults: { reasoningEffort: true } }
  const applied = alignCompactionOptions(options, header)
  assert.equal(options.reasoningEffort, undefined)
  assert.deepEqual(applied, ['maxTokens=256000 (was 65536)'])
})

test('never overwrites a parameter the summarizer set explicitly', () => {
  const options = { purpose: 'compaction', reasoningEffort: 'low', maxTokens: 65536 }
  alignCompactionOptions(options, HEADER)
  assert.equal(options.reasoningEffort, 'low')
})

test('mirrors temperature when the route carries one', () => {
  const options = stockEnvelope()
  const header = { config: { temperature: 0.3, maxTokens: 256000 }, adapterDefaults: {} }
  const applied = alignCompactionOptions(options, header)
  assert.equal(options.temperature, 0.3)
  assert.deepEqual(applied, ['temperature=0.3', 'maxTokens=256000 (was 65536)'])
})

test('keeps the summarizer maxTokens when the route declares none', () => {
  const options = stockEnvelope()
  const applied = alignCompactionOptions(options, { config: { reasoningEffort: 'max' } })
  assert.equal(options.maxTokens, 65536)
  assert.deepEqual(applied, ['reasoningEffort=max'])
})

test('keeps the summarizer maxTokens when that half is switched off', () => {
  const options = stockEnvelope()
  const applied = alignCompactionOptions(options, HEADER, internals.DEFAULT_MIRROR, false)
  assert.equal(options.maxTokens, 65536)
  assert.deepEqual(applied, ['reasoningEffort=max'])
})

test('ignores a header without a config object', () => {
  for (const header of [undefined, null, {}, { config: null }, { config: 'nope' }, 42]) {
    const options = stockEnvelope()
    assert.deepEqual(alignCompactionOptions(options, header), [])
    assert.deepEqual(options, stockEnvelope())
  }
})

test('ignores an options object that is not a request envelope', () => {
  assert.deepEqual(alignCompactionOptions(null, HEADER), [])
  assert.deepEqual(alignCompactionOptions('nope', HEADER), [])
})

test('is idempotent', () => {
  const options = stockEnvelope()
  assert.equal(alignCompactionOptions(options, HEADER).length, 2)
  assert.deepEqual(alignCompactionOptions(options, HEADER), [])
})

test('a compaction request is recognised by its tag alone', () => {
  assert.equal(isCompactionRequest({ purpose: 'compaction' }), true)
  assert.equal(isCompactionRequest({ purpose: 'session-title' }), false)
  assert.equal(isCompactionRequest({ purpose: undefined }), false)
  assert.equal(isCompactionRequest({ messages: [{ role: 'user', content: 'acting as a compaction engine' }] }), false)
  assert.equal(isCompactionRequest(null), false)
})

test('mounting announces itself and installs exactly one listener', () => {
  const host = fakeHost({ requestHeader: () => HEADER })
  apply(host.ctx, {})
  assert.equal(host.handlers.length, 1)
  assert.equal(host.handlers[0].event, 'llm/stream')
  const armed = logged(host, /armed \(mirror=/)
  assert.equal(armed.length, 1)
  assert.equal(armed[0][0], 'info')
})

test('the listener aligns a tagged request and always continues the waterfall', () => {
  const session = { requestHeader: () => HEADER }
  const host = fakeHost(session)
  apply(host.ctx, {})
  const options = stockEnvelope()
  let nextCalls = 0
  const returned = host.handlers[0].handler(options, () => {
    nextCalls += 1
    return 'stream'
  })
  assert.equal(returned, 'stream')
  assert.equal(nextCalls, 1)
  assert.equal(options.reasoningEffort, 'max')
  assert.equal(options.maxTokens, 256000)
  const aligned = logged(host, /aligned summarization envelope/)
  assert.equal(aligned.length, 1)
  assert.equal(aligned[0][0], 'info')
})

test('the listener leaves an ordinary turn untouched', () => {
  const host = fakeHost({ requestHeader: () => HEADER })
  apply(host.ctx, {})
  const options = { purpose: 'session-title', maxTokens: 8192 }
  let nextCalls = 0
  host.handlers[0].handler(options, () => {
    nextCalls += 1
  })
  assert.equal(nextCalls, 1)
  assert.deepEqual(options, { purpose: 'session-title', maxTokens: 8192 })
  assert.equal(logged(host, /aligned summarization envelope|already matches|no routed/).length, 0)
})

test('a missing sessions service warns once and never breaks the call', () => {
  const host = fakeHost(undefined)
  apply(host.ctx, {})
  let nextCalls = 0
  const next = () => {
    nextCalls += 1
  }
  host.handlers[0].handler(stockEnvelope(), next)
  host.handlers[0].handler(stockEnvelope(), next)
  assert.equal(nextCalls, 2)
  const warnings = logged(host, /no routed request header/)
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0][0], 'warn')
})

test('a session without a header warns once and never breaks the call', () => {
  const host = fakeHost({})
  apply(host.ctx, {})
  let nextCalls = 0
  host.handlers[0].handler(stockEnvelope(), () => {
    nextCalls += 1
  })
  assert.equal(nextCalls, 1)
  assert.equal(logged(host, /no routed request header/).length, 1)
})

test('a throwing header lookup is swallowed', () => {
  const host = fakeHost({
    requestHeader: () => {
      throw new Error('boom')
    }
  })
  apply(host.ctx, {})
  let nextCalls = 0
  host.handlers[0].handler(stockEnvelope(), () => {
    nextCalls += 1
  })
  assert.equal(nextCalls, 1)
})

test('a frozen envelope cannot break the waterfall', () => {
  const host = fakeHost({ requestHeader: () => HEADER })
  apply(host.ctx, {})
  const options = Object.freeze(stockEnvelope())
  let nextCalls = 0
  host.handlers[0].handler(options, () => {
    nextCalls += 1
  })
  assert.equal(nextCalls, 1)
})

test('the listener is not installed when the plugin is disabled', () => {
  const host = fakeHost({ requestHeader: () => HEADER })
  apply(host.ctx, { enabled: false })
  assert.equal(host.handlers.length, 0)
  assert.equal(host.logs.length, 0)
})

test('an already-aligned envelope reports once instead of logging every fold', () => {
  const host = fakeHost({ requestHeader: () => HEADER })
  apply(host.ctx, {})
  const aligned = { purpose: 'compaction', sessionId: 'session-x', reasoningEffort: 'max', maxTokens: 256000 }
  host.handlers[0].handler(aligned, () => {})
  host.handlers[0].handler(aligned, () => {})
  assert.equal(logged(host, /already matches/).length, 1)
})

test('configuration defaults and overrides resolve as documented', () => {
  assert.deepEqual(resolveOptions(undefined), {
    enabled: true,
    log: true,
    mirror: ['reasoningEffort', 'temperature'],
    alignMaxTokens: true
  })
  assert.deepEqual(resolveOptions(null), {
    enabled: true,
    log: true,
    mirror: ['reasoningEffort', 'temperature'],
    alignMaxTokens: true
  })
  assert.equal(resolveOptions({ enabled: false }).enabled, false)
  assert.equal(resolveOptions({ log: false }).log, false)
  assert.equal(resolveOptions({ alignMaxTokens: false }).alignMaxTokens, false)
  assert.deepEqual(resolveOptions({ mirror: ['reasoningEffort'] }).mirror, ['reasoningEffort'])
  assert.equal(resolveOptions({ mirror: 'nope' }).mirror, internals.DEFAULT_MIRROR)
})
