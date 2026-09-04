# Agent Note: Routed user questions

Status: implemented

English | [中文](2026-09-04-routed-user-questions.zh.md)

## Problem

`ctx.userQuestions` previously had no way for an out-of-tree interaction channel to claim only the turns it originated. Selecting an answerer from agent or session identity was insufficient because those identities do not identify which channel opened the current turn.

## Decision

The service keeps the upstream Agent-scoped waterfall for Web and route-less requests, and adds direct providers for explicit `web` or `wecom` routes. The legacy one-argument registration remains the default Web registration. A host records an `InteractionRoute` in a shared process-local registry under both the opening user-message object and its generated message id. The bounded id index preserves the route when durable inbox validation clones the message; the WeakMap keeps the direct-object path cheap. `ask_user_question` captures the route at the first pre-step and copies the frozen value into the internal request. The route is absent from JSON persistence, wire history, and the model tool schema and arguments.

Route-less and explicit Web requests use the scoped waterfall unless a legacy direct Web provider is registered. An explicit non-Web route selects only its named channel and fails with `NO_PROVIDER_FOR_ROUTE` when that channel is unavailable. Registration disposal aborts pending work for that provider without affecting other channels.

Direct providers authenticate the route destination against their own trusted state. Channel-specific providers remain responsible for sender, transport correlation, and response ownership.

## Alternatives considered

**Select by agent or session identity.** One bound session can receive successive Web and WeCom turns, so either identity sends at least one turn to the wrong UI.

**Let the model name the channel.** Tool arguments are untrusted model output and would let a prompt redirect a human question to another transport.

**Fall back to another provider.** Silent fallback crosses an explicit channel boundary and can disclose a question or accept an answer from the wrong audience.

## Consequences

The scoped Web answerer and WeCom provider can coexist, and each turn keeps the route chosen by its trusted ingress even if later steering arrives from another source. The route exists only for the live turn and is deliberately absent after resume. New channels require extending the closed built-in route union. Direct providers receive a service-owned abort signal so channel disposal reaches pending asks; callers must use signal behavior rather than signal object identity.

## Testing

User-question service tests cover the scoped Web answerer alongside a direct WeCom provider, explicit no-fallback errors, provider-scoped disposal, and route recovery from a cloned inbox message. Tool tests prove the opening message wins over a later differently routed message.
