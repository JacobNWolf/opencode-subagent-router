# OpenCode Subagent Router

Route simple OpenCode subagent tasks onto a faster, cheaper model. Hard work stays on the parent.

## Why

OpenCode is a fantastic tool, with one flaw: Subagents [inherit the calling agent's model](https://opencode.ai/docs/agents/#model) unless you pin one. This leads to unnecessarily expensive and slow sessions. Why does a frontier, high-reasoning model like Astra or Fable need to run a grep command or query a MCP for documentation? Pinning a cheap model on every subagent is too coarse: the same `@general` does both.

This plugin classifies each **direct child** task with [TypeSafe Jev](https://openrouter.ai/typesafe/jev-1.13) and downgrades only when the work looks cheap **and** a fast target exists. Ambiguous, low-confidence, and high-reasoning tasks keep the parent.

It never upgrades a model, never overrides a subagent that already has an explicit model or variant, and does not route nested subagents. Missing credentials, timeouts, and API errors fail open to the inherited parent model.

## Install

Add the plugin to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@jacobwolf/opencode-subagent-router"]
}
```

Jev runs on OpenRouter. The router reads `OPENROUTER_API_KEY`, then `$XDG_DATA_HOME/opencode/auth.json` (or `~/.local/share/opencode/auth.json`) for `openrouter.key`.

A keep-parent result shows a warning toast. Every outcome is logged under the `jev-router` service.

## How a fast target is chosen

The cheap model comes from OpenCode's enabled provider catalog, in this order:

1. The last matching route override, if it changes the model or lowers effort.
2. The same model at `low` effort when the parent uses `high`, `xhigh`, or `max`.
3. The cheapest non-deprecated, tool-capable model in the same provider and model family.

Jev is only called after a fast target exists. Search, mechanical edits, review, and bounded implementation can downgrade. Architecture, diagnosis, and anything that needs deep reasoning stay on the parent.

Optional overrides help when catalog family or cost metadata is missing:

```json
{
  "plugin": [
    [
      "@jacobwolf/opencode-subagent-router",
      {
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
    ]
  ]
}
```

Routes use `provider/model` identifiers. The last matching route wins. Omitting `parent.variant` matches every variant of that parent model.

## Contributing

Issues and PRs are welcome. CI runs these same checks:

```bash
bun install
bun run fmt:check
bun run lint
bun run lint:ts
bun run test:coverage
```
