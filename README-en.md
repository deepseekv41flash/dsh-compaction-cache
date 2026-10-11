# dsh-compaction-cache

> Makes DSH's **compaction summarization call** carry the exact request envelope of the turn it replaces, so the provider's prefix cache keeps hitting — instead of re-billing the whole replayed history at the fresh-input rate.

DeepSeek Harness plugin · **zero dependencies** · **no tools** · **no UI** · **no build step** · MIT

**This is a temporary stopgap for an upstream defect.** Once it is fixed upstream
(`deepseek-harness` discussion
[#1944](https://github.com/deepseek-ai/deepseek-harness/discussions/1944)), delete this package.

中文文档：[README.md](README.md)

---

## The problem

`summarizeWithLlm` in `@deepseek-ai/dsh-compaction-basic` builds the summarization request like this:

```js
{ provider, model, messages, toolHistory, tools?, maxTokens: config.maxTokens,
  sessionId, purpose: 'compaction', signal }
```

It takes only `provider` / `model` from the session's established route, so:

| field | ordinary turn | compaction call | |
|---|---|---|---|
| `reasoningEffort` | `max` (session level) | **absent** → adapter falls back to `high` | diverges |
| `maxTokens` | `256000` (adapter default) | **`65536`** (`config.maxTokens ?? headroomTokens`) | always diverges |

The provider partitions its prefix cache by request envelope — the thinking level is the decisive
field (measured; see below) — so a diverging envelope misses the entire replayed prefix, and a
compaction that should cost "one instruction's worth of tokens" re-bills the whole context.

### Measured

Same session, same command (manual `/compact`, `source: user`), same route; the only difference is
whether this plugin is installed:

| | region folded | prompt | `inputTokens` | `cacheReadTokens` | hit | output | wall |
|---|---|---|---|---|---|---|---|
| before | 113,767 | 150,320 | **132,528** | 17,792 | **11.8%** | 3,749 | 17.0 s |
| after | 170,026 | 223,920 | **560** | **223,360** | **99.7%** | 4,590 | 18.2 s |

The 560 fresh tokens left after the fix are the appended compaction instruction itself
(2,336 chars ≈ 4.2 chars/token) — i.e. the entire replayed prefix is cache-served. Ordinary turns in
the same session were already at 99.9% (149,632 / 149,837); the fold is now back in the same cache
entry as they are.

Before the fix the shape was self-consistent across 51 folds in 216 archived sessions: mean hit
**23%**, 40 below 50%, and the cached part a constant **~17.3–18K** (system prompt + tool schemas)
regardless of fold size. That phenomenon **predates any third-party compaction plugin** on this
machine — the first fold on 09-28 was 518,458 / 0 (0.0%).

### Attribution: the decisive field is `reasoningEffort`, not `maxTokens`

Grouping the 52 folds that have a `request/header` event before them by whether the summarizer's
envelope agreed with the session's ordinary-turn envelope:

| group | folds | mean hit | fresh input |
|---|---|---|---|
| effort agrees (session level `high`) | 7 | **99.9%** | 448–589 tokens |
| effort differs (session level `max`) | 45 | **12.7%** | 50K–660K tokens |

All 7 fully-hitting folds still sent a **mismatched** `maxTokens` (65536 vs the turn's 256000). If
`max_tokens` were part of the cache key those folds could not have hit — so on this provider it is
not, and the thinking level alone partitions the cache. Two further confirmations: one session
switched levels mid-life and went from five 99.9% folds to 22-of-27 folds at 0.3–3.4%; and two
aborted-then-retried folds hit 99.97% because the aborted attempt had already warmed that prefix in
the diverging envelope.

## What it does

It hooks the public `llm/stream` waterfall and, **only for requests the caller itself tagged
`purpose: 'compaction'`**, fills in the routed values:

```js
reasoningEffort = header.config.reasoningEffort   // only when unset and not marked an adapter default
temperature     = header.config.temperature       // same rule
maxTokens       = header.config.maxTokens         // unconditional (the summarizer always overrides it)
```

The two different rules come from the two halves of the defect: `mirror`-style fields are normally
materialized by the adapter for ordinary turns too, so they are only injected when the header does
not mark them as adapter defaults; `maxTokens` is *always* overwritten by the summarizer, so it can
never agree by accident and has to be assigned.

**Boundaries**: scalars only, **never the message list**; no effect on ordinary requests; every
exception is swallowed and `next()` runs unchanged — if this plugin breaks, behaviour degrades to
stock DSH and a model call is never blocked.

## Install (GitHub only)

Not published to npm and not submitted to any plugin marketplace: it is a stopgap for a three-line
upstream fix that is meant to be deleted afterwards. (`"private": true` in `package.json` is
deliberate.) Take the source from GitHub:

```jsonc
// <DSH_HOME>/profiles/<profile>/package.json
"dependencies": { "dsh-compaction-cache": "github:deepseekv41flash/dsh-compaction-cache" },
"dsh": { "profile": { "bundles": ["…", "dsh-compaction-cache"] } }
```

> Verified on this machine with pnpm 11.22.0: `pnpm add github:deepseekv41flash/dsh-compaction-cache`
> resolves to `0.1.0` and imports cleanly; `private: true` does not block the install. Profile
> dependencies are installed with pnpm, so this spec works.
> (`npm install github:…` resolves the shorthand to `ssh://git@github.com/…` and fails with
> `Permission denied (publickey)` where no SSH key is configured — that is npm's shorthand
> behaviour, not the package.)

Or clone locally and use a `link:` dependency (the path verified on this machine):

```sh
git clone https://github.com/deepseekv41flash/dsh-compaction-cache
# then: "dsh-compaction-cache": "link:<clone path>" in dependencies, plus the name in bundles
```

The package carries `dsh.bundle.patch`, so listing it in `dsh.profile.bundles` mounts it
automatically. `lib/` is plain JS — no build step. Without bundles you can also insert it in the
profile patch layer:

```yaml
- insert:
    - id: compaction-cache
      name: dsh-compaction-cache
```

## Configuration (all optional)

| key | default | meaning |
|---|---|---|
| `enabled` | `true` | master switch |
| `log` | `true` | one `info` line per alignment |
| `mirror` | `['reasoningEffort','temperature']` | parameter names mirrored from the routed header |
| `alignMaxTokens` | `true` | align `maxTokens` to the routed value |

## Verification

```sh
npm test          # 20 unit tests: mirroring / adapter defaults / idempotence / frozen envelopes /
                  # missing service / tag gating / mount self-report
```

Once active, the host log shows:

```
compaction-cache: aligned summarization envelope (reasoningEffort=max maxTokens=256000 (was 65536)) session=...
```

The criterion, against the before-state: in the next fold's `compaction/summary.usage`,
`inputTokens` drops from ~130K to a few hundred and `cacheReadTokens` becomes six digits.

## Known open points

- Attribution is settled by the natural experiments above; the only thing not done is an *active*
  single-field run (empty `mirror` while keeping `alignMaxTokens: true`) — the data predicts no change.
- The correct upstream fix is to inherit the routed **envelope as a whole**, not to patch fields.
- An audit-only trap: the `maxTokens` recorded in the `compaction/summary` event is the *spec*
  (`config.maxTokens`), **not** the envelope actually sent — so it always reads 65536. Judge this
  plugin by the `inputTokens` / `cacheReadTokens` split, not by that field.

## Uninstall

Remove the line from the profile patch / bundles and restart — no tools, no persisted state, no
patched package sources. **Remove it once the upstream fix lands.**

## License

MIT
