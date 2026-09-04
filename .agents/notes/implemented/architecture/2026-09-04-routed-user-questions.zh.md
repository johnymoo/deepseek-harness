# Agent Note: 按渠道路由用户提问

Status: implemented

[English](2026-09-04-routed-user-questions.md) | 中文

## Problem

`ctx.userQuestions` 过去无法让仓库外的交互渠道只接管由自己发起的 turn。按 agent 或 session 身份选择回答方也不成立，因为这些身份不能说明当前 turn 是由哪个渠道开启的。

## Decision

服务保留上游用于 Web 与无 route 请求的 Agent-scoped waterfall，并为显式 `web` 或 `wecom` route 增加直接提供方。兼容旧调用的单参数注册仍表示默认 Web 注册。宿主在共享的进程内注册表中，同时以开启 turn 的用户消息对象及其生成的消息 id 记录 `InteractionRoute`。有容量上限的 id 索引让消息经过持久化 inbox 校验并被复制后仍能恢复路由，WeakMap 则保留低开销的对象直达路径。`ask_user_question` 在首个 pre-step 捕获路由，并把冻结的值复制到内部请求。该路由不进入 JSON 持久化、线上的历史记录、模型工具 schema 或参数。

无 route 与显式 Web 请求在没有旧式直接 Web 提供方时使用 scoped waterfall。显式非 Web route 只选择指定渠道；该渠道不可用时以 `NO_PROVIDER_FOR_ROUTE` 失败。注销注册会中止该提供方的待处理工作，不影响其他渠道。

直接提供方依据自身可信状态验证路由目的地。各渠道提供方仍负责验证发送者、传输关联和回答所有权。

## Alternatives considered

**按 agent 或 session 身份选择。** 一个绑定会话可以先后接收 Web 和企微 turn，因此任一身份都会把至少一个 turn 发往错误 UI。

**让模型指定渠道。** 工具参数属于不可信模型输出，这会允许提示词把人工问题重定向到另一种传输渠道。

**回退到其他提供方。** 静默回退会跨越显式渠道边界，可能向错误受众泄露问题或接受错误受众的回答。

## Consequences

scoped Web 回答方与企微提供方可以并存；即使后来有其他来源的 steering，turn 仍保留可信入口选定的路由。路由只存在于存活 turn 内，恢复 session 后刻意不存在。增加新渠道需要扩展封闭的内置路由联合类型。直接提供方收到服务拥有的 abort signal，因此注销渠道可以终止待处理提问；调用方应依赖 signal 行为，而不是 signal 对象身份。

## Testing

用户提问服务测试覆盖 scoped Web 回答方与直接企微提供方并存、显式路由禁止回退、按提供方注销，以及从复制后的 inbox 消息恢复路由。工具测试证明开启 turn 的消息优先于后来携带不同路由的消息。
