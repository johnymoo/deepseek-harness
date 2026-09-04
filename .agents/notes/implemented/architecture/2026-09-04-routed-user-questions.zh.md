# Agent Note: 按渠道路由用户提问

Status: implemented

[English](2026-09-04-routed-user-questions.md) | 中文

## Problem

`ctx.userQuestions` 过去在整个进程中只允许一个提供方。Web 宿主与另一条可信交互渠道无法同时回答问题，即使它们只是先后使用同一个会话。按 agent 或 session 身份选择提供方也不成立，因为这些身份不能说明当前 turn 是由哪个渠道开启的。

## Decision

服务按 `web` 或 `wecom` 渠道注册提供方。兼容旧调用的单参数注册仍表示默认 Web 注册。宿主通过共享的进程内 Symbol 把 `InteractionRoute` 写入开启 turn 的用户消息。`ask_user_question` 在首个 pre-step 捕获它，并把冻结的路由复制到内部请求。该 Symbol 不进入 JSON 持久化、线上的历史记录、模型工具 schema 或参数。

无路由请求为兼容旧行为而选择 Web。显式路由只选择指定渠道；该渠道不可用时以 `NO_PROVIDER_FOR_ROUTE` 失败。注销注册会中止该提供方的待处理工作，不影响其他渠道。

提供方依据自身可信状态验证路由目的地。Web 提供方要求目的地等于准确的存活 session。各渠道提供方仍负责验证发送者、传输关联和回答所有权。

## Alternatives considered

**按 agent 或 session 身份选择。** 一个绑定会话可以先后接收 Web 和企微 turn，因此任一身份都会把至少一个 turn 发往错误 UI。

**让模型指定渠道。** 工具参数属于不可信模型输出，这会允许提示词把人工问题重定向到另一种传输渠道。

**回退到其他提供方。** 静默回退会跨越显式渠道边界，可能向错误受众泄露问题或接受错误受众的回答。

## Consequences

Web 与企微提供方可以并存；即使后来有其他来源的 steering，turn 仍保留可信入口选定的路由。路由只存在于存活 turn 内，恢复 session 后刻意不存在。增加新渠道需要扩展封闭的内置路由联合类型。提供方收到服务拥有的 abort signal，因此注销渠道可以终止待处理提问；调用方应依赖 signal 行为，而不是 signal 对象身份。

## Testing

用户提问服务测试覆盖并存提供方、旧请求默认 Web、显式路由禁止回退、重复注册和按提供方注销。工具测试证明开启 turn 的消息优先于后来携带不同路由的消息。ApiProxy 测试会拒绝与准确调用 session 不一致的 Web 目的地。
