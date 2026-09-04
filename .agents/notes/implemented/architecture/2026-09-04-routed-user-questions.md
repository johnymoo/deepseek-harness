# Agent Note: Routed user questions

Status: implemented

English | [中文](2026-09-04-routed-user-questions.zh.md)

## Problem

`ctx.userQuestions` previously allowed one provider for the whole process. A Web host and another trusted interaction channel could not both answer questions, even when successive turns used the same session. Selecting a provider from agent or session identity was insufficient because those identities do not identify which channel opened the current turn.

## Decision

The service registers providers by `web` or `wecom` channel. The legacy one-argument registration remains the default Web registration. A host writes an `InteractionRoute` under a shared process-local Symbol on the user message that opens a turn. `ask_user_question` captures it at the first pre-step and copies the frozen route into the internal request. The Symbol is absent from JSON persistence, wire history, and the model tool schema and arguments.

Route-less requests select Web for compatibility. An explicit route selects only its named channel and fails with `NO_PROVIDER_FOR_ROUTE` when that channel is unavailable. Registration disposal aborts pending work for that provider without affecting other channels.

Providers authenticate the route destination against their own trusted state. The Web provider requires the destination to equal the exact live session. Channel-specific providers remain responsible for sender, transport correlation, and response ownership.

## Alternatives considered

**Select by agent or session identity.** One bound session can receive successive Web and WeCom turns, so either identity sends at least one turn to the wrong UI.

**Let the model name the channel.** Tool arguments are untrusted model output and would let a prompt redirect a human question to another transport.

**Fall back to another provider.** Silent fallback crosses an explicit channel boundary and can disclose a question or accept an answer from the wrong audience.

## Consequences

Web and WeCom providers can coexist, and each turn keeps the route chosen by its trusted ingress even if later steering arrives from another source. The route exists only for the live turn and is deliberately absent after resume. New channels require extending the closed built-in route union. Providers receive a service-owned abort signal so channel disposal reaches pending asks; callers must use signal behavior rather than signal object identity.

## Testing

User-question service tests cover concurrent providers, legacy Web defaulting, explicit no-fallback errors, duplicate registration, and provider-scoped disposal. Tool tests prove the opening message wins over a later differently routed message. ApiProxy tests reject a Web destination that differs from the exact calling session.
