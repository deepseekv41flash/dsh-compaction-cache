/**
 * dsh-compaction-cache — make the compaction summarization call carry the same
 * request parameters as the routed turn it replaces, so the provider's prefix
 * cache keeps hitting.
 *
 * The defect it works around (upstream: deepseek-harness discussion #1944,
 * cross-referenced by #3002, #7588, #7794) lives in `dsh-compaction-basic`'s
 * `summarizeWithLlm`, which builds its envelope as
 *
 *   { provider, model, messages, toolHistory, tools?, maxTokens: config.maxTokens,
 *     sessionId, purpose: 'compaction', signal }
 *
 * — it takes only `provider`/`model` from the session's routed request header,
 * drops `reasoningEffort` (the adapter then resolves its own default, which is
 * `high` for the DeepSeek adapter unless the connection declares one), and
 * forces `BasicCompactionConfig.maxTokens` (default = `headroomTokens` =
 * 65,536). A provider whose cache key includes those parameters then sees a
 * different key for the compaction call and re-bills the entire replayed
 * context at the full input rate.
 *
 * Measured in one deployment (1M window, DeepSeek route, session effort `max`):
 * a manual `/compact` at a ~150K context billed `inputTokens: 132528` +
 * `cacheReadTokens: 17792` for a 150,320-token prompt, while ordinary turns in
 * the same session read 149,632 of 149,837 from cache. Over 51 folds in 216
 * archived sessions the mean hit rate was 23%, with a constant ~17.3–18K
 * cached head (system prompt + tool schemas) — the shape of "only the static
 * prefix ever hits".
 *
 * The real fix belongs upstream, in `summarizeWithLlm`. This plugin applies the
 * same inheritance at the public `llm/stream` waterfall, so no package has to be
 * forked, and it is meant to be deleted once the fix ships.
 *
 * Scope: it only rewrites scalar request parameters of a request its own caller
 * tagged `purpose: 'compaction'`. It never touches the message list, never
 * touches an ordinary turn, and never blocks a model call — every path is
 * wrapped so a failure here degrades to the stock behaviour.
 */

/** Registered plugin name. */
export const name = 'compaction-cache'

/**
 * Parameters mirrored from the routed header when the summarizer left them
 * unset. `maxTokens` is handled separately: the summarizer does not leave it
 * unset, it always overrides it.
 */
const DEFAULT_MIRROR = Object.freeze(['reasoningEffort', 'temperature'])

/** Default configuration, documented in cordis.patch.yml. */
const DEFAULTS = Object.freeze({
  enabled: true,
  log: true,
  mirror: DEFAULT_MIRROR,
  alignMaxTokens: true
})

/** Whether a value is a usable non-null object. */
function isObject(value) {
  return value !== null && typeof value === 'object'
}

/**
 * Whether the request identifies itself as the summarizer's call.
 *
 * Only the caller's own tag counts. A heuristic on message content would be
 * wrong here for the same reason it is wrong upstream: an ordinary turn whose
 * trailing tool result happens to quote the compaction instruction is not a
 * compaction call, and rewriting its parameters would be a silent corruption.
 *
 * @param options - request envelope observed at the `llm/stream` waterfall.
 * @returns whether the envelope carries the compaction tag.
 */
export function isCompactionRequest(options) {
  return isObject(options) && options.purpose === 'compaction'
}

/**
 * Align one summarization envelope with the session's routed request header.
 *
 * Two different rules, because the defect has two halves:
 *
 * - `mirror` keys are copied only when the summarizer left them **unset** and
 *   the header does not mark them adapter-materialized (`adapterDefaults`). A
 *   normal turn lets the adapter fill such a field, and so does the summarizer,
 *   so both already agree — injecting there would change behaviour rather than
 *   restore it.
 * - `maxTokens` is the opposite case: the summarizer **always** sets it to its
 *   own config value, so a normal turn can never agree with it unless the routed
 *   value happens to be that same number. It is therefore overwritten with the
 *   routed value whenever the header carries one. Raising the summarizer's
 *   output ceiling is inert for a checkpoint (it emits a few thousand tokens),
 *   and the value is the one ordinary turns already send on this route.
 *
 * @param options - the summarizer envelope, mutated in place.
 * @param header - `session.requestHeader()`: the last routed envelope.
 * @param mirror - parameter names to copy when unset.
 * @param alignMaxTokens - whether to force the routed `maxTokens`.
 * @returns human-readable `key=value` notes for each change actually applied.
 */
export function alignCompactionOptions(options, header, mirror = DEFAULT_MIRROR, alignMaxTokens = true) {
  if (!isObject(options) || !isObject(header)) return []
  const config = header.config
  if (!isObject(config)) return []
  const defaults = isObject(header.adapterDefaults) ? header.adapterDefaults : {}
  const keys = Array.isArray(mirror) ? mirror : DEFAULT_MIRROR
  const applied = []
  for (const key of keys) {
    if (typeof key !== 'string' || key.length === 0) continue
    if (options[key] !== undefined) continue
    const value = config[key]
    if (value === undefined || value === null) continue
    if (defaults[key] === true) continue
    options[key] = value
    applied.push(`${key}=${String(value)}`)
  }
  if (alignMaxTokens) {
    const routed = config.maxTokens
    if (Number.isInteger(routed) && routed > 0 && options.maxTokens !== routed) {
      applied.push(`maxTokens=${routed} (was ${String(options.maxTokens)})`)
      options.maxTokens = routed
    }
  }
  return applied
}

/**
 * Read one session's routed request header.
 *
 * The service is resolved per use and by name, never snapshotted at apply time:
 * a deployment that mounts `sessions` later (or not at all) must not turn this
 * plugin into a pending entry. Hard `inject` is deliberately avoided for the
 * same reason — an unsatisfied injection leaves the plugin inert and silent,
 * which is how the sibling capability went unnoticed for a day.
 *
 * @returns the header, or `undefined` when it cannot be read.
 */
function headerOf(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
  const sessions = serviceOf(ctx, 'sessions')
  if (!isObject(sessions) || typeof sessions.get !== 'function') return undefined
  try {
    const session = sessions.get(sessionId)
    if (!isObject(session) || typeof session.requestHeader !== 'function') return undefined
    return session.requestHeader()
  } catch {
    return undefined
  }
}

/** Resolve a service by name through either cordis accessor; never throws. */
function serviceOf(ctx, key) {
  let viaMethod
  try {
    viaMethod = ctx.get(key)
  } catch {
    viaMethod = undefined
  }
  if (isObject(viaMethod)) return viaMethod
  try {
    const viaProperty = ctx[key]
    return isObject(viaProperty) ? viaProperty : undefined
  } catch {
    return undefined
  }
}

/** Log through the host logger when present; logging must never break a turn. */
function logLine(ctx, level, format, ...args) {
  try {
    const logger = ctx.logger
    if (logger !== undefined && typeof logger[level] === 'function') logger[level](format, ...args)
  } catch {
    // A logger that throws is the logger's problem, not the turn's.
  }
}

/** Normalize user configuration over the defaults. */
export function resolveOptions(config) {
  const source = isObject(config) ? config : {}
  return {
    enabled: source.enabled !== false,
    log: source.log !== false,
    mirror: Array.isArray(source.mirror) ? source.mirror.map(String) : DEFAULT_MIRROR,
    alignMaxTokens: source.alignMaxTokens !== false
  }
}

/**
 * Mount the `llm/stream` listener.
 *
 * The listener must reach the request while it is still being assembled, so it
 * is registered without `prepend`: waterfall order does not matter against the
 * sibling plugin, which rewrites a different field of the same envelope
 * (`messages`), and matching the sibling's proven registration shape is worth
 * more here than an ordering guarantee nothing in this deployment needs.
 *
 * @param ctx - plugin context; the listener is disposed with it.
 * @param config - optional overrides of the defaults above.
 */
export function apply(ctx, config) {
  const resolved = resolveOptions(config)
  if (!resolved.enabled) return
  // Mount-time evidence: without this line a plugin that silently failed to
  // reach the waterfall is indistinguishable from one that found nothing to do.
  logLine(
    ctx,
    'info',
    'compaction-cache: armed (mirror=%s alignMaxTokens=%s)',
    resolved.mirror.join(','),
    String(resolved.alignMaxTokens)
  )
  let warnedNoHeader = false
  let reportedAligned = false
  ctx.on('llm/stream', (request, next) => {
    try {
      if (isCompactionRequest(request)) {
        const header = headerOf(ctx, request.sessionId)
        if (header === undefined) {
          if (!warnedNoHeader) {
            warnedNoHeader = true
            logLine(
              ctx,
              'warn',
              'compaction-cache: no routed request header for session %s; the summarization call keeps the parameters it built itself',
              String(request.sessionId)
            )
          }
        } else {
          const applied = alignCompactionOptions(request, header, resolved.mirror, resolved.alignMaxTokens)
          if (applied.length > 0) {
            if (resolved.log) {
              logLine(
                ctx,
                'info',
                'compaction-cache: aligned summarization envelope (%s) session=%s',
                applied.join(' '),
                String(request.sessionId)
              )
            }
          } else if (resolved.log && !reportedAligned) {
            reportedAligned = true
            logLine(ctx, 'info', 'compaction-cache: summarization envelope already matches the routed header')
          }
        }
      }
    } catch {
      // Interception must never break a model call.
    }
    return next()
  })
}

/** Test surface; not part of the plugin contract. */
export const internals = {
  DEFAULT_MIRROR,
  DEFAULTS,
  alignCompactionOptions,
  headerOf,
  isCompactionRequest,
  resolveOptions,
  serviceOf
}
