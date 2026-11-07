# OpenCode Subagent Router

Route simple OpenCode subagent tasks onto a faster, cheaper model. Hard work stays on the parent.

## Why

OpenCode is a fantastic tool, with one flaw: Subagents [inherit the calling agent's model](https://opencode.ai/docs/agents/#model) unless you pin one. This leads to unnecessarily expensive and slow sessions. Why does a frontier, high-reasoning model like Astra or Fable need to run a grep command or query a MCP for documentation? Pinning a cheap model on every subagent is too coarse: the same `@general` does both.

This plugin classifies each **direct child** task with [TypeSafe Jev](https://openrouter.ai/typesafe/jev-1.13) and downgrades only when the work looks cheap **and** a fast target exists. Ambiguous, low-confidence, and high-reasoning tasks keep the parent.

It never upgrades a model, never overrides a subagent that already has an explicit model or variant, and does not route nested subagents. Missing credentials, timeouts, and API errors fail open to the inherited parent model.

## Install

The same package runs on OpenCode V2 and V1. Add it to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@jacobwolf/opencode-subagent-router"]
}
```

On V1, use the `plugin` key instead of `plugins`.

Jev runs on OpenRouter. The router reads `OPENROUTER_API_KEY`, then `$XDG_DATA_HOME/opencode/auth.json` (or `~/.local/share/opencode/auth.json`) for `openrouter.key`.

Every outcome is logged under the `jev-router` service in the OpenCode server log. On V1, a keep-parent result also shows a warning toast.

On V2, the router fills the `subagent` tool's `model` before the child session starts. It skips follow-ups to an existing subagent and tasks whose call or agent already sets a model.

## How a fast target is chosen

The cheap model comes from OpenCode's enabled provider catalog, in this order:

1. The last matching route override, if it changes the model or lowers effort.
2. The cheapest compatible model in the same inferred lab generation.
3. The same model at `low` effort when the parent uses `high`, `xhigh`, or `max`.
4. The cheapest eligible exact-family sibling.

Cross-model selection stays on the same enabled OpenCode provider. It infers lab, lineage, and major version from Models.dev metadata rather than a table of model names. Input and output prices must be no higher at every compared context tier, with at least one price strictly lower, and the candidate must preserve the parent's agent-critical capabilities and limits. OpenCode subscription or other non-list rates fall back to Models.dev list prices instead of disabling this step. Ambiguous identity or cost data disables only this step.

A Models.dev network failure uses the package snapshot. If metadata is missing entirely, the router falls back to same-model `low` and the older exact-family rule.

Jev is only called after a fast target exists. Search, mechanical edits, review, and bounded implementation can downgrade. Architecture, diagnosis, and anything that needs deep reasoning stay on the parent.

Optional overrides remain the escape hatch when metadata is incomplete:

```json
{
  "plugins": [
    {
      "package": "@jacobwolf/opencode-subagent-router",
      "options": {
        "timeoutMs": 2000,
        "confidenceMin": 0.5,
        "routes": [
          {
            "parent": {
              "model": "anthropic/claude-fable-5.1",
              "variant": ["high", "max"]
            },
            "fast": {
              "model": "anthropic/claude-sonnet-4-6"
            }
          }
        ]
      }
    }
  ]
}
```

On V1, pass the same options as `"plugin": [["@jacobwolf/opencode-subagent-router", { ... }]]`.

Routes use `provider/model` identifiers. The last matching route wins. Omitting `parent.variant` matches every variant of that parent model.

## Contributing

Issues and PRs are welcome. CI runs these same checks:

```bash
bun install
bun run fmt:check
bun run lint
bun run lint:ts
bun run typecheck
bun run test:coverage
```
