import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import UserQuestionService, {
  interactionRouteOf,
  routeUserMessage,
  UserQuestionError,
  type AskUserQuestionRequest,
  type UserQuestionProvider,
} from '@deepseek-ai/dsh-user-questions'

function provider(answer = 'approved'): UserQuestionProvider & { seen: AskUserQuestionRequest[] } {
  const seen: AskUserQuestionRequest[] = []
  return {
    seen,
    async ask(request) {
      seen.push(request)
      return { answers: [{ id: request.questions[0]?.id ?? 'missing', selected: [answer] }] }
    },
  }
}

function stubAgent(id: string, delegationDepth = 0): Agent {
  const agentId = id as Agent['id']
  return {
    id: agentId,
    session: { id: agentId, header: { delegationDepth } },
  } as unknown as Agent
}

describe('UserQuestionService', () => {
  it('keeps trusted routes process-local and out of serialized messages', () => {
    const message = routeUserMessage(createUserMessage({
      content: [{ type: 'text', text: 'hello' }],
      source: { kind: 'user' },
    }), { channel: 'wecom', destination: 'single:secret-user' })

    expect(interactionRouteOf(message)).toEqual({ channel: 'wecom', destination: 'single:secret-user' })
    expect(JSON.stringify(message)).not.toContain('single:secret-user')
  })

  it('delegates ask requests to the registered provider', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    const p = provider('yes')
    ctx.userQuestions.registerProvider(p)

    const result = await ctx.userQuestions.ask({ questions: [{ id: 'confirm', question: 'Proceed?' }] })

    expect(result).toEqual({ answers: [{ id: 'confirm', selected: ['yes'] }] })
    expect(p.seen).toMatchObject([{ questions: [{ id: 'confirm', question: 'Proceed?' }] }])
  })

  it('rejects ask requests when no provider is registered', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)

    await expect(ctx.userQuestions.ask({ questions: [{ id: 'confirm', question: 'Proceed?' }] }))
      .rejects.toMatchObject({ name: 'UserQuestionError', code: 'NO_PROVIDER' })
  })

  it('registers providers with HMR-safe disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    const p = provider()
    const dispose = ctx.userQuestions.registerProvider(p)

    dispose()
    dispose()

    await expect(ctx.userQuestions.ask({ questions: [{ id: 'confirm', question: 'Proceed?' }] }))
      .rejects.toMatchObject({ code: 'NO_PROVIDER' })
  })

  it('rejects duplicate providers instead of replacing the active UI', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    ctx.userQuestions.registerProvider(provider('first'))

    expect(() => ctx.userQuestions.registerProvider(provider('second')))
      .toThrow(UserQuestionError)
  })

  it('normalizes non-Error provider failures', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- exercises a hostile provider boundary.
    ctx.userQuestions.registerProvider({ ask: () => Promise.reject('broken provider') })

    await expect(ctx.userQuestions.ask({ questions: [{ id: 'confirm', question: 'Proceed?' }] }))
      .rejects.toMatchObject({ name: 'UserQuestionError', code: 'PROVIDER_FAILED', cause: 'broken provider' })
  })

  it('routes Web and WeCom requests to concurrent channel providers', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    const web = provider('web-answer')
    const wecom = provider('wecom-answer')
    ctx.userQuestions.registerProvider('web', web)
    ctx.userQuestions.registerProvider('wecom', wecom)

    await expect(ctx.userQuestions.ask({
      questions: [{ id: 'route', question: 'Where?' }],
      route: { channel: 'wecom', destination: 'single:user-1' },
    })).resolves.toEqual({ answers: [{ id: 'route', selected: ['wecom-answer'] }] })
    await expect(ctx.userQuestions.ask({
      questions: [{ id: 'route', question: 'Where?' }],
      route: { channel: 'web', destination: 'session-1' },
    })).resolves.toEqual({ answers: [{ id: 'route', selected: ['web-answer'] }] })
    expect(web.seen).toHaveLength(1)
    expect(wecom.seen).toHaveLength(1)
  })

  it('defaults legacy route-less asks to Web and never falls back explicit routes', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    const web = provider('web-answer')
    ctx.userQuestions.registerProvider(web)

    await expect(ctx.userQuestions.ask({ questions: [{ id: 'legacy', question: 'Continue?' }] }))
      .resolves.toEqual({ answers: [{ id: 'legacy', selected: ['web-answer'] }] })
    await expect(ctx.userQuestions.ask({
      questions: [{ id: 'explicit', question: 'Continue?' }],
      route: { channel: 'wecom', destination: 'single:user-1' },
    })).rejects.toMatchObject({ code: 'NO_PROVIDER_FOR_ROUTE' })
    expect(web.seen).toHaveLength(1)
  })

  it('aborts only the disposed provider pending asks', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    const never = (): UserQuestionProvider => ({ ask: () => new Promise(() => undefined) })
    const disposeWecom = ctx.userQuestions.registerProvider('wecom', never())
    ctx.userQuestions.registerProvider('web', provider('web-answer'))
    const pending = ctx.userQuestions.ask({
      questions: [{ id: 'pending', question: 'Continue?' }],
      route: { channel: 'wecom', destination: 'single:user-1' },
    })

    disposeWecom()

    await expect(pending).rejects.toMatchObject({ code: 'PROVIDER_DISPOSED' })
    await expect(ctx.userQuestions.ask({ questions: [{ id: 'web', question: 'Continue?' }] }))
      .resolves.toMatchObject({ answers: [{ selected: ['web-answer'] }] })
  })

  it('fails before reaching the provider when the signal is already aborted', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    const p = { ask: vi.fn(async () => ({ answers: [{ id: 'confirm', selected: ['too late'] }] })) }
    ctx.userQuestions.registerProvider(p)
    const controller = new AbortController()
    controller.abort()

    await expect(ctx.userQuestions.ask({ questions: [{ id: 'confirm', question: 'Proceed?' }], signal: controller.signal }))
      .rejects.toMatchObject({ code: 'ASK_ABORTED' })
    expect(p.ask).not.toHaveBeenCalled()
  })

  it('rejects empty question batches before reaching the provider', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    const p = { ask: vi.fn(async () => ({ answers: [] })) }
    ctx.userQuestions.registerProvider(p)

    await expect(ctx.userQuestions.ask({ questions: [] }))
      .rejects.toMatchObject({ name: 'UserQuestionError', code: 'EMPTY_QUESTIONS' })
    expect(p.ask).not.toHaveBeenCalled()
  })

  it('rejects a live runtime-owned agent before reaching the provider', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserQuestionService)
    const p = { ask: vi.fn(async () => ({ answers: [] })) }
    ctx.userQuestions.registerProvider(p)
    const root = stubAgent('root', 0)
    const child = stubAgent('child', 0)
    ctx.agents.enter(root, undefined)
    ctx.agents.enter(child, root)

    await expect(ctx.userQuestions.ask({
      questions: [{ id: 'confirm', question: 'Proceed?' }],
      agent: child,
    })).rejects.toMatchObject({
      name: 'UserQuestionError',
      code: 'DELEGATED_CALLER',
      message: "human interaction is unavailable while the calling agent is owned by another live agent; include the unresolved question or decision in the child agent's final result",
    })
    expect(p.ask).not.toHaveBeenCalled()
  })

  it('reaches the provider for a lineage-bearing session resumed as a runtime root', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserQuestionService)
    const p = provider('yes')
    ctx.userQuestions.registerProvider(p)
    const agent = stubAgent('resumed-root', 1)
    ctx.agents.enter(agent, undefined)

    const result = await ctx.userQuestions.ask({
      questions: [{ id: 'confirm', question: 'Proceed?' }],
      agent,
    })

    expect(result).toEqual({ answers: [{ id: 'confirm', selected: ['yes'] }] })
  })

  it('rejects a supplied agent when no live registry can attest it', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    const p = { ask: vi.fn(async () => ({ answers: [] })) }
    ctx.userQuestions.registerProvider(p)

    await expect(ctx.userQuestions.ask({
      questions: [{ id: 'confirm', question: 'Proceed?' }],
      agent: stubAgent('unattested'),
    })).rejects.toMatchObject({ name: 'UserQuestionError', code: 'CALLER_NOT_LIVE' })
    expect(p.ask).not.toHaveBeenCalled()
  })

  it('rejects a stale agent object that reuses a live id', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserQuestionService)
    const p = { ask: vi.fn(async () => ({ answers: [] })) }
    ctx.userQuestions.registerProvider(p)
    const live = stubAgent('same-id')
    ctx.agents.enter(live, undefined)

    await expect(ctx.userQuestions.ask({
      questions: [{ id: 'confirm', question: 'Proceed?' }],
      agent: stubAgent('same-id'),
    })).rejects.toMatchObject({ name: 'UserQuestionError', code: 'CALLER_NOT_LIVE' })
    expect(p.ask).not.toHaveBeenCalled()
  })

  it('rejects an intent whose approve label names none of its own options', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    const p = { ask: vi.fn(async () => ({ answers: [] })) }
    ctx.userQuestions.registerProvider(p)
    const question = { id: 'plan-review', question: 'Approve?', detail: '# Plan' }

    // A wrong label among offered options, and no options offered at all.
    for (const options of [[{ label: 'Approve' }], undefined]) {
      await expect(ctx.userQuestions.ask({
        questions: [{
          ...question,
          ...(options === undefined ? {} : { options }),
          intent: { kind: 'plan-review', approve: 'Ship it' },
        }],
      })).rejects.toMatchObject({ name: 'UserQuestionError', code: 'BAD_INTENT' })
    }
    expect(p.ask).not.toHaveBeenCalled()
  })

  it('rejects a plan-review intent on a question carrying no plan to review', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    const p = { ask: vi.fn(async () => ({ answers: [] })) }
    ctx.userQuestions.registerProvider(p)

    // Detail IS the plan for this intent, so a UI honouring it would ask the
    // user to approve something they cannot see.
    await expect(ctx.userQuestions.ask({
      questions: [{
        id: 'plan-review', question: 'Approve?',
        options: [{ label: 'Approve' }, { label: 'Keep planning' }],
        intent: { kind: 'plan-review', approve: 'Approve' },
      }],
    })).rejects.toMatchObject({ name: 'UserQuestionError', code: 'BAD_INTENT' })
    expect(p.ask).not.toHaveBeenCalled()
  })

  it('passes an intent through once its approve label names an offered option', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    const p = provider('Approve')
    ctx.userQuestions.registerProvider(p)
    const intent = { kind: 'plan-review', approve: 'Approve' } as const

    const result = await ctx.userQuestions.ask({
      questions: [
        { id: 'plain', question: 'Proceed?' },
        {
          id: 'plan-review', question: 'Approve?', detail: '# Plan',
          options: [{ label: 'Approve' }, { label: 'Keep planning' }], intent,
        },
      ],
    })

    expect(result.answers).toEqual([{ id: 'plain', selected: ['Approve'] }])
    expect(p.seen[0]?.questions[1]?.intent).toEqual(intent)
  })
})
