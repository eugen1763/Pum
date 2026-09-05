# Context budgets and selective recovery

`get_context_remaining` is an approximate, runtime-local meter, not a tokenizer,
a provider limit guarantee, a billing total, or an automatic rollover trigger.
`new_context` still commits only after its complete successful tool batch and
creates no generated summary. The canonical transcript and session ID remain.

## Measured anchor and conservative estimates

A usable anchor is a successful terminal assistant response observed by the
bound controller after its request transform. It must match the exact runtime,
model provider/id/API/capacity, active window and model generation. Its source
prefix and response fingerprints must still match current state. Resumed,
cloned, manually inserted, nested tool-result, failed and aborted usage is not
an anchor. Branch restoration, manual compaction and rollover reset pairing;
model changes invalidate it, including changing away and back.

Every normalized usage component and `totalTokens` must be a nonnegative safe
integer, and input plus cache-read plus cache-write must be positive. Missing,
nonfinite, fractional, negative, all-zero, output-only and total-only values
are rejected. The measured anchor is the larger of the component sum
(input + output + cache-read + cache-write) and reported total. This preserves
conservative provider-normalization differences. Neither capacity nor a
calibration factor caps or multiplies the measured anchor. It remains a
provider report, **not an exact measurement of the next request**.

The unmeasured heuristic is:

- UTF-8 text bytes / 3, rounded upward, including thinking and tool arguments;
- 16 tokens per message for framing;
- 1200 tokens per image, regardless of encoded size (not a vision tokenizer);
- active tool name/description/parameter JSON bytes / 3 plus 32 framing tokens
  per definition;
- system prompt bytes / 3 and the full positive observed transformed-context
  surplus over source messages, including retained memory/operational chains.

The request estimate used to calibrate includes its effective public next-turn
prompt, tool schemas and all transformed input messages exactly once. When
that estimate is at least 1024 tokens and normalized prompt input is available,
`calibrationFactor = clamp(prompt input / estimated request, 1, 2)`. A larger
reported total than the component sum cannot train a prompt-only ratio. Tiny
samples and unavailable input use factor 1. This is bounded upward extrapolation
from one matching request, not learned provider-wide accuracy. It does not carry
across windows or runtime replacements. `calibrationLimited` reports when the
uncapped ratio exceeded 2; the cap limits extrapolation, not the actual anchor.

With an anchor:

```
usedTokens = measured total
           + ceil(heuristic trailing messages * calibrationFactor)
           + ceil(positive overhead growth * calibrationFactor)
```

The measured request already contains prompt, schema and injected context, so
these are not added again. Positive growth is evaluated separately for prompt,
schemas and observed injection. Their combined growth keeps a per-anchor
high-water mark: shrinking one component never subtracts from measured usage,
and observed growth does not disappear until a newer trusted response includes
it. A supplied effective next-turn prompt/schema baseline is retained when
agent state itself has not changed. Without a trustworthy anchor, the complete
active state, prompt, schema and observed injection are estimated with factor 1.
A non-append source or altered response falls back once, avoiding quadratic
re-hashing of every older request prefix.

`providerUsageTokens`, `estimatedTrailingTokens` and `estimatedOverheadTokens`
expose the three terms. `uncalibratedTrailingTokens` and
`uncalibratedOverheadTokens` expose the heuristic terms before multiplication;
`calibrationFactor`, `calibrationEligible` and `calibrationLimited` make the
calibration's scope visible. A zero estimate term does not mean exactness.

## Reserves and history

The configured compaction response reserve remains a separate deduction from
capacity, never hidden in usage and never an automatic threshold. Negative or
nonfinite reserves cannot increase headroom. Remaining capacities clamp at
zero; unknown capacity remains unknown. A measured total beyond capacity is
not discarded or reduced.

If the configured reserve equals or exceeds the entire model window, explicit
rollover and history use bounded output headroom instead: the lesser of the
valid positive model output limit (otherwise 1024) and one quarter of capacity.
This exception permits small models to recover rather than becoming permanently
stuck behind a larger default reserve. Fresh handoff validation includes the
synthetic header, prompt/schema overhead and observed injection; old injected
chains can conservatively overreserve until the fresh projection is observed.

History executes sequentially. The controller divides available space by the
current factor and subtracts message framing before the history fitter applies
its shared text/image heuristic. Each prior result is charged before the next
page in the same tool batch. If even metadata cannot fit, a bounded refusal is
unavoidable, but it advances neither text nor image offsets. Unknown capacity
keeps existing static result caps. Cursor authentication, append-only snapshot
pagination and no private structural-content recovery are unchanged.

## Audience-aware recovery

Common system guidance is stable; no changing capability list enters the system
prefix. The fresh-window synthetic header is generated from actual active
`session.agent.state.tools` names, after tool-group narrowing, not from a guessed
role allowlist. It suggests history only for missing relevant instructions or
results, and `todo_list` only when active and genuinely needed. It never enables
hidden todos merely to recover; the literal handoff can be enough.

Memory injection is a separate explicit runtime capability. Main, headless and
worker factories identify the actual registered `createMemoryExtension` object
through a private identity marker, not an extension name or role. They explain
that the supplied snapshot is already present and need not be reread. Empty,
unavailable and withdrawn notices are not usable older facts. Without injection,
`memory_read` is suggested only when actually active and needed. Recovery never
suggests memory writes, so readonly and ordinary workers are not told to call
unavailable mutation tools. Internal judge and AFK runtimes still have neither
the controller nor memory authority.

## Privacy and limitations

Calibration snapshots contain numeric estimates, hashes, generations and window/
model identity, not copies of raw prompts, schemas, image payloads, private memory
or transcript content. They live only in the controller's runtime-local WeakMap.
There is no calibration file, transcript scan for saved calibration, historical
memory companion, or extra diagnostic session entry. Explicit meter results
retain their ordinary tool-result persistence contract. Existing opt-in request
diagnostics stay independent and do not supply calibration authority; billing
usage aggregation (`agent-usage.ts`) is unchanged.

The meter cannot observe a future injection before its context hook runs, count
arbitrary provider-payload hook rewrites, or guarantee provider image accounting,
message conversion, deferred-tool representation, tokenizer behavior or context
limits. Provider-normalized usage is trusted only through the paired SDK
response, not cryptographically attested; trusted extensions/custom providers
can change it. A capped factor can still underestimate new content, and a
conservative heuristic can overestimate. No paid/live provider, cache-hit, native
sandbox, Windows or UI-rendering claim follows from the mock SDK regressions.
The transport, security-epoch admission/argument guards and exact-runtime idle
boundaries are unchanged.
