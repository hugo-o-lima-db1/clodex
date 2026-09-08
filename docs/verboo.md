# Verboo provider

Verboo is an OpenAI-compatible endpoint. Clodex ships it as a **builtin provider
template** (`id: verboo`) on top of the existing generic OpenAI-compatible
infrastructure (`@ai-sdk/openai-compatible`, `/models` discovery, keyring
credential storage). No CCR/router layer is required.

## Setup

```bash
clodex providers add verboo
```

The wizard prompts for:

1. **Base URL** — the Verboo OpenAI-compatible endpoint, ending in `/v1`
   (e.g. `https://api.verboo.ai/v1`). Discovery appends `/models`, resolving to
   `/v1/models`.
2. **API key** — stored in the same keyring/helper credential store every other
   Clodex provider uses. It is never written to the registry, commits, or logs.

The connection probe hits `${baseUrl}/models`; on success the returned model ids
are cached in the registry. On 401/403 the key is rejected before it is
persisted. On 5xx, timeout, or redirect the add fails without storing anything.

## List models

```bash
clodex models
```

Verboo models appear alongside OpenAI / OpenCode Go / Anthropic models. Use
`clodex providers refresh-models verboo` to re-fetch.

### Manual models

If `/models` is temporarily unavailable, add a model manually via the model
browser (`clodex models`) and it is kept even when a later refresh fails —
refresh never removes manually-added models because the endpoint was unreachable.

## Aliases

```bash
clodex models --alias glm=clodex:verboo:glm-4.6
clodex models --alias fast=clodex:verboo:glm-4.5-air
clodex models --alias strong=clodex:verboo:glm-4.6
```

Alias names follow the same rules as every other alias
(`^[a-z0-9][a-z0-9._-]{0,63}$`, and the reserved set
`sonnet|opus|haiku|fable|best|default|opusplan|inherit` is rejected).

## Claude Code patch (the important part)

```bash
clodex patch
```

`clodex patch` builds the patch model config from **favorites + aliases**
(`buildPatchModelConfig` in `src/patcher.ts`). Every favorite Verboo model —
with its alias — is injected into the patched Claude Code binary's:

- Agent / subagent tool `model` zod enum (`src/patch-transforms.ts`, PATCH 1)
- known-alias validator
- `/model` picker
- context-window table

So `Agent(model="glm")` is accepted by Claude Code **before** the request reaches
the proxy — no enum/allowlist error. The alias is a real first-class alias, not
a remap of `opus`/`sonnet`.

Restore with:

```bash
clodex patch --restore
```

## Routing

```
Claude Code → Clodex proxy ─┬─ Anthropic   (claude-opus-5, claude-sonnet-5, …)
                            └─ Verboo API  (clodex:verboo:* and aliased models)
```

Anthropic-native models keep going to Anthropic with your normal account.
`clodex:verboo:<model>` (and any alias resolving to it) is routed to the Verboo
base URL. Selective passthrough is unchanged — Verboo is just another registered
provider.

## Example: main agent

```bash
clodex patch            # inject aliases
claude --model glm      # main session runs on Verboo
```

## Example: Agent / subagent

Inside a patched Claude Code session:

```text
Agent(model="glm", description="research", prompt="…")
```

works the same way `Agent(model="sonnet", …)` always has.

## Configuration example (no secrets)

```jsonc
// ~/.clodex/registry.json (provider entry — no key lives here)
{
  "id": "verboo",
  "templateId": "verboo",
  "name": "Verboo",
  "enabled": true,
  "authRef": "keyring:provider:verboo",
  "authType": "api",
  "api": { "npm": "@ai-sdk/openai-compatible", "url": "https://api.verboo.ai/v1" },
  "modelsCache": { /* … */ },
  "addedAt": "2026-09-08T00:00:00.000Z"
}
```

The API key is stored in the OS keyring (or the file credential helper on
systems without a keyring) under the `provider:verboo` service, referenced by
`authRef`. Run `clodex providers list` to see the resolved auth label.

## Maintaining this fork against upstream

```bash
git remote -v
# upstream  https://github.com/bman654/clodex.git
# origin    <your fork>

git fetch upstream
git checkout feat/verboo-provider
git rebase upstream/main
```

The Verboo feature is isolated to:

- `src/provider-templates.ts` — one template entry.
- `src/providers-command.ts` — `addTemplateId` plumbing + a base-URL prompt for
  templates without `defaultBaseUrl`.
- `tests/verboo.test.ts`, `tests/provider-templates.test.ts`,
  `tests/providers-command.test.ts` — test expectations updated for the new
  template.
- `docs/verboo.md` (this file).

Conflict surface with upstream is small: `PROVIDER_TEMPLATES` array append, and
`parseProvidersArgs`/`runTemplateAddFlow` are additive. If upstream adds another
template, the only merge work is the test files' `toEqual([...])` lists.

### Patch anchors (fragility notes)

The Claude Code patch anchors are **upstream's**, not this fork's — Verboo does
not add any new anchor. If a future Claude Code release moves the Agent tool
`model` zod enum, `clodex patch` fails closed for **every** provider, not just
Verboo, and `clodex patch --restore` rolls back. The risk is identical to using
Clodex with OpenAI/OpenCode Go today.

## Limitations / known risks

- Verboo discovery uses `${baseUrl}/models`. If your Verboo endpoint exposes
  models at a different path, set `modelsPath` on the template (or use a custom
  endpoint via `clodex providers add` → custom OpenAI-compatible).
- Responses API / streaming / tool calls behave as the underlying
  `@ai-sdk/openai-compatible` adapter implements them — Verboo inherits whatever
  that adapter supports, same as any other OpenAI-compatible provider in Clodex.
- A Claude Code update can break `clodex patch` independently of this fork; the
  failure mode is the same as for the built-in providers.
