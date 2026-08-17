# J-Space integration

[← Back to configuration](configuration.md)

PUM includes an optional J-Space-style inference control layer.

J-Space does not change model weights. It adds a bounded task ledger around the
agent loop and refreshes that ledger before each provider call.

## Enable J-Space

J-Space is disabled by default.

Enable it in `Ctrl+P`:

1. Select `J-Space`.
2. Set it to `on`.
3. Press `s` to save the choice globally, if required.

The equivalent global setting is:

```json
{
  "jspace": true
}
```

## PUM behavior

The implementation uses these control modes:

- `fast` handles a small direct request.
- `full` handles a limited multi-step request.
- `loop` handles repository work, multiple tools, and long tasks.

The session state stores these fields:

- `Goal`
- `Core`
- `Verified`
- `Open`
- `Next`
- `Checkpoint`
- `Coverage`

PUM stores the state in `<session>.jspace.json`.

PUM does not store tool arguments or tool output in this sidecar.

PUM updates the state after tool execution and at agent settlement.

PUM injects a bounded custom context message before each provider call.

PUM does not force first-person wording, reveal private chain-of-thought, or
start automatic continuation loops.

Normal worker subagents use the extension. Goal judges and AFK delegates do not.

## References

These are engineering references, not peer-reviewed papers:

- [J-Space Cognition Suite V3.6](https://github.com/Tiger3807861189/J-Space-Cognition-Suite-V3.6)
- [DeepSeek V4 × J-Space Capability Realization Report](https://github.com/Tiger3807861189/DeepSeek-V4-J-Space-Capability-Realization-Report)
- [DeepSeek Thinking Mode API documentation](https://api-docs.deepseek.com/guides/thinking_mode)
- [pi coding-agent extension documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)

The benchmark claims in the J-Space report are reported as single-run results.
Run controlled A/B tests before treating those claims as general evidence.
