# @deepseek-ai/dsh-user-questions

English | [中文](README.zh.md)

User-interaction Service Definition. It owns `ctx.userQuestions`, the service a model-facing tool or permission plugin uses when it needs to pause work and ask the human for a decision.

## Service: `UserQuestionService` (ctx key: `userQuestions`)

### Public API

- `ctx.userQuestions.registerProvider(provider): () => void` Register the legacy/default Web provider.
- `ctx.userQuestions.registerProvider(channel, provider): () => void` Register one Web or WeCom provider; disposal unregisters that channel and aborts its pending asks.
- `ctx.userQuestions.ask(request): Promise<AskUserQuestionAnswer>` Ask the provider selected by the trusted route and wait for the answer.

### Key Types

- `AskUserQuestionRequest` — `{ questions: [{ id, question, detail?, header?, options?, multiSelect?, intent? }], agent?, signal?, route? }`; `route` is host-authored and never part of the model tool schema. When present, `agent` must be the registry's exact live runtime root.
- `InteractionRoute` — `{ channel: 'web' | 'wecom', destination }`, frozen by the host on the message that opens the turn.
- `AskUserQuestionOption` — `{ label, description? }`.
- `AskUserQuestionIntent` — `{ kind: 'plan-review', approve }`; the tagged presentation intent below.
- `AskUserQuestionAnswer` — `{ answers: [{ id, selected, custom? }] }`.
- `UserQuestionProvider` — UI implementation with `ask(request)`.
- `UserQuestionError` — `HarnessError` subclass with codes such as `EMPTY_QUESTIONS`, `BAD_INTENT`, `NO_PROVIDER`, `NO_PROVIDER_FOR_ROUTE`, `DUPLICATE_PROVIDER`, `PROVIDER_DISPOSED`, `ASK_ABORTED`, `CALLER_NOT_LIVE`, and `DELEGATED_CALLER`.

For a single-select question, `custom` overrides the selected choice and `selected` is empty. For a multi-select question, `custom` may supplement the labels in `selected`. A UI may preserve a skipped item as `{ id, selected: [] }`, keeping the existing answer shape while retaining other answers in the batch.

When a request carries an agent, `ask()` authenticates its exact identity through the live `AgentRegistry` and admits only a runtime root. Durable lineage is not authority: a session with historical delegation depth may ask after it is resumed as a new runtime root, while a live child owned by another agent is rejected even if its durable depth is zero. Agentless programmatic requests retain the existing provider path.

### Presentation intent

`intent` declares that a question IS a known kind of decision, so a UI that recognises the tag may present it as such — `plan-review` says `detail` is a plan under review, and `dsh-plan-mode` sets it on the `exit_plan_mode` question. An intent changes presentation only: a UI honouring it answers with the same option labels a generic UI would send, and a UI that does not know the tag renders the generic option list, so callers read the same answer fields either way. `approve` names the label that approves rather than relying on option order. `ask()` rejects with `BAD_INTENT` the two assertions no type can carry: an `approve` naming none of that question's own options, and an intent on a question with no `detail` — the thing it declares itself a review of.

## Role

This is the Service Definition package. Consumers such as `@deepseek-ai/dsh-tool-ask-user` depend on this service; the Web host runtime supplies the shipped Service Provider. The loop stays unchanged: a tool call awaits a promise, and the tool result resumes the normal agent loop.

## Model Experience

Indirectly, through `dsh-tool-ask-user`, which retains a successful provider answer as compact JSON or one of these failures: `Error: ask_user_question was aborted before the user answered`, `Error: ask_user_question requires at least one question`, `Error: human interaction requires the exact live calling agent when an agent is supplied`, `Error: human interaction is unavailable while the calling agent is owned by another live agent; include the unresolved question or decision in the child agent's final result`, `Error: no user-questions provider is registered`, or `Error: <message>`. Waiting for the human adds no tokens.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

Route-less requests select Web for compatibility. Explicit routes never fall back to another channel: a missing provider fails with `NO_PROVIDER_FOR_ROUTE`. Duplicate registration is rejected per channel, so Web and WeCom may coexist while two Web providers may not.

## Known Limitations and Deferred Work

- **The vocabulary is the question-form shape only** — selectable options plus optional custom text; richer interaction shapes (file pickers, diff-preview confirmations) have no seam vocabulary yet.
