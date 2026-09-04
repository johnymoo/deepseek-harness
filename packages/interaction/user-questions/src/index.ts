/**
 * Service Definition for the user-questions capability seam (`ctx.userQuestions`): a UI-backed service for
 * pausing an agent tool call until the human answers a question. The model-
 * facing tool lives in `@deepseek-ai/dsh-tool-ask-user`; UI packages compose
 * answerers on the Agent-scoped Cordis waterfall.
 *
 * @module @deepseek-ai/dsh-user-questions
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { scopeTarget } from '@deepseek-ai/dsh-scope'

declare module '@deepseek-ai/cordis' {
  interface Context {
    userQuestions: UserQuestionService
  }
}

import type {
  AskUserQuestionAnswer, AskUserQuestionRequestEvent,
} from './types.ts'

export type {
  AskUserQuestionAnswer, AskUserQuestionAnswerItem, AskUserQuestionIntent, AskUserQuestionItem,
  AskUserQuestionOption,
} from './types.ts'

/** Trusted destination selected by the host that started the current turn. */
export type InteractionRoute =
  | { readonly channel: 'web'; readonly destination: string }
  | { readonly channel: 'wecom'; readonly destination: string }

/** Channel names supported by built-in and external interaction providers. */
export type InteractionChannel = InteractionRoute['channel']

const interactionRouteRegistryKey = Symbol.for('@deepseek-ai/dsh-user-questions/interaction-route-registry')

interface InteractionRouteRegistry {
  readonly objects: WeakMap<object, InteractionRoute>
  readonly messageIds: Map<string, InteractionRoute>
}

const MAX_ROUTED_MESSAGE_IDS = 4096

function registryHost(): object {
  const processHost: unknown = Reflect.get(globalThis, 'process')
  return typeof processHost === 'object' && processHost !== null ? processHost : globalThis
}

function interactionRouteRegistry(): InteractionRouteRegistry {
  const host = registryHost()
  const existing: unknown = Reflect.get(host, interactionRouteRegistryKey)
  if (typeof existing === 'object' && existing !== null
    && Reflect.get(existing, 'objects') !== undefined
    && Reflect.get(existing, 'messageIds') !== undefined) {
    return existing as InteractionRouteRegistry
  }
  const registry: InteractionRouteRegistry = {
    objects: new WeakMap<object, InteractionRoute>(),
    messageIds: new Map<string, InteractionRoute>(),
  }
  Reflect.set(host, interactionRouteRegistryKey, registry)
  return registry
}

function messageIdOf(message: object): string | undefined {
  const id: unknown = Reflect.get(message, 'id')
  return typeof id === 'string' && id !== '' ? id : undefined
}

/** Associate a trusted route with a user message without serializing it. */
export function routeUserMessage<T extends object>(message: T, route: InteractionRoute): T {
  const registry = interactionRouteRegistry()
  const frozen = Object.freeze({ ...route })
  registry.objects.set(message, frozen)
  const messageId = messageIdOf(message)
  if (messageId !== undefined) {
    registry.messageIds.delete(messageId)
    registry.messageIds.set(messageId, frozen)
    while (registry.messageIds.size > MAX_ROUTED_MESSAGE_IDS) {
      const oldest = registry.messageIds.keys().next().value
      if (oldest === undefined) break
      registry.messageIds.delete(oldest)
    }
  }
  return message
}

/** Read the process-local trusted route associated with a user message. */
export function interactionRouteOf(message: object | undefined): InteractionRoute | undefined {
  if (message === undefined) return undefined
  const registry = interactionRouteRegistry()
  const direct = registry.objects.get(message)
  if (direct !== undefined) return direct
  const messageId = messageIdOf(message)
  if (messageId === undefined) return undefined
  const route = registry.messageIds.get(messageId)
  if (route !== undefined) registry.objects.set(message, route)
  return route
}

/** Request for a human answer. */
export interface AskUserQuestionRequest extends AskUserQuestionRequestEvent {
  /** Host-authored route copied from the message that opened the current turn. */
  route?: InteractionRoute
}

/** Direct channel provider used by out-of-tree interaction plugins. */
export interface UserQuestionProvider {
  ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer>
}

/** Stable error taxonomy for user-questions failures. */
export class UserQuestionError extends HarnessError {
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'UserQuestionError'
  }
}

function abortedQuestion(cause?: unknown): UserQuestionError {
  return new UserQuestionError(
    'ask_user_question was aborted before the user answered',
    'ASK_ABORTED',
    cause === undefined ? undefined : { cause },
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function restoreUserQuestionError(reason: unknown): unknown {
  if (reason instanceof UserQuestionError) return reason
  if (isRecord(reason)
    && reason.name === 'UserQuestionError'
    && typeof reason.message === 'string'
    && typeof reason.code === 'string') {
    return new UserQuestionError(reason.message, reason.code, { cause: reason })
  }
  return reason
}

interface ProviderRegistration {
  provider: UserQuestionProvider
  disposed: AbortController
}

/** `ctx.userQuestions`: validation, explicit routes, and the scoped answerer waterfall. */
export class UserQuestionService extends Service {
  /** Feature probe used by optional out-of-tree providers. */
  readonly supportsRouting: true = true
  private readonly providers = new Map<InteractionChannel, ProviderRegistration>()

  constructor(ctx: Context) {
    super(ctx, 'userQuestions')
  }

  /**
   * Register the legacy/default Web provider.
   *
   * @param provider Direct provider that collects the answer.
   * @returns A disposer that unregisters the provider.
   */
  registerProvider(provider: UserQuestionProvider): () => void
  /**
   * Register a provider for one explicit route channel.
   *
   * @param channel Trusted route channel owned by the provider.
   * @param provider Direct provider that collects the answer.
   * @returns A disposer that unregisters the provider and aborts pending asks.
   */
  registerProvider(channel: InteractionChannel, provider: UserQuestionProvider): () => void
  registerProvider(
    channelOrProvider: InteractionChannel | UserQuestionProvider,
    explicitProvider?: UserQuestionProvider,
  ): () => void {
    const channel = typeof channelOrProvider === 'string' ? channelOrProvider : 'web'
    const provider = typeof channelOrProvider === 'string' ? explicitProvider : channelOrProvider
    if (provider === undefined) {
      throw new UserQuestionError(`user-questions provider for channel ${channel} is missing`, 'INVALID_PROVIDER')
    }
    const registration: ProviderRegistration = { provider, disposed: new AbortController() }
    const dispose = this.ctx.effect(function* (this: UserQuestionService) {
      if (this.providers.has(channel)) {
        throw new UserQuestionError(
          `a user-questions provider for channel ${channel} is already registered`,
          'DUPLICATE_PROVIDER')
      }
      this.providers.set(channel, registration)
      yield () => {
        if (this.providers.get(channel) !== registration) return
        this.providers.delete(channel)
        registration.disposed.abort()
      }
    }.bind(this), 'userQuestions.registerProvider()')
    return () => void dispose()
  }

  private askProvider(
    registration: ProviderRegistration,
    request: AskUserQuestionRequest,
  ): Promise<AskUserQuestionAnswer> {
    const providerSignal = registration.disposed.signal
    const signal = request.signal === undefined
      ? providerSignal
      : AbortSignal.any([request.signal, providerSignal])
    return new Promise<AskUserQuestionAnswer>((resolve, reject) => {
      let settled = false
      const finish = (operation: () => void): void => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        operation()
      }
      const onAbort = (): void => finish(() => reject(providerSignal.aborted
        ? new UserQuestionError('the selected user-questions provider was disposed', 'PROVIDER_DISPOSED')
        : abortedQuestion()))
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) {
        onAbort()
        return
      }
      Promise.resolve()
        .then(() => registration.provider.ask({ ...request, signal }))
        .then(
          answer => finish(() => resolve(answer)),
          error => finish(() => reject(restoreUserQuestionError(error))),
        )
    })
  }

  /**
   * Ask the scoped answerer waterfall and wait for the user's answer.
   *
   * When a caller supplies an agent, human interaction is valid only for the
   * exact live runtime root. Runtime ownership, not durable session lineage,
   * decides this boundary: an owned child has no human answerer and would
   * block forever, while a lineage-bearing session resumed as a new runtime
   * root may ask normally.
   *
   * @param request Questions, owner agent, and abort signal.
   * @returns The answer chosen or typed by the human.
   * @throws {UserQuestionError} code `ASK_ABORTED` when the supplied signal
   *   is already or becomes aborted, `CALLER_NOT_LIVE` when a supplied agent
   *   is not the registry's exact live instance, or `DELEGATED_CALLER` when
   *   that live agent is owned by another agent.
   */
  async ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
    if (request.signal?.aborted) {
      throw abortedQuestion()
    }
    if (request.questions.length === 0) {
      throw new UserQuestionError('ask_user_question requires at least one question', 'EMPTY_QUESTIONS')
    }
    const agent = request.agent
    if (agent !== undefined) {
      const agents = this.ctx.get('agents')
      if (agents === undefined || agents.get(agent.id) !== agent) {
        throw new UserQuestionError(
          'human interaction requires the exact live calling agent when an agent is supplied',
          'CALLER_NOT_LIVE')
      }
      if (!agents.roots().includes(agent)) {
        throw new UserQuestionError(
          'human interaction is unavailable while the calling agent is owned by another live agent; '
          + "include the unresolved question or decision in the child agent's final result",
          'DELEGATED_CALLER')
      }
    }
    // A presentation intent asserts two things the types cannot: that the
    // named approve label is one of this question's own options, and that a
    // plan-review carries the plan it is a review of. A UI honouring the
    // intent answers with that label, and shows that detail as the plan, so
    // either gap would put a choice the asker never offered — or an approval of
    // something invisible — in front of the user. Caught at the asker, where
    // the mistake is, rather than in each UI.
    for (const question of request.questions) {
      const intent = question.intent
      if (intent === undefined) continue
      if (!(question.options ?? []).some(option => option.label === intent.approve)) {
        throw new UserQuestionError(
          `question ${question.id} declares intent ${intent.kind} whose approve label `
          + `${JSON.stringify(intent.approve)} names none of its options`,
          'BAD_INTENT')
      }
      if (question.detail === undefined) {
        throw new UserQuestionError(
          `question ${question.id} declares intent ${intent.kind} without the detail it reviews`,
          'BAD_INTENT')
      }
    }
    const noAnswerer = () => Promise.reject(new UserQuestionError(
      'no user-questions answerer accepted the request',
      'NO_PROVIDER',
    ))
    try {
      const route = request.route
      const directProvider = this.providers.get(route?.channel ?? 'web')
      if (directProvider !== undefined) {
        return await this.askProvider(directProvider, request)
      }
      if (route !== undefined && route.channel !== 'web') {
        throw new UserQuestionError(
          `no user-questions provider is registered for route ${route.channel}`,
          'NO_PROVIDER_FOR_ROUTE')
      }
      return await (agent === undefined
        ? this.ctx.waterfall('user-questions/request', request, noAnswerer)
        : this.ctx.waterfall(
          scopeTarget(agent, agent),
          'user-questions/request',
          { ...request, agent },
          noAnswerer,
        ))
    } catch (error) {
      const restored = restoreUserQuestionError(error)
      if (restored instanceof UserQuestionError) throw restored
      if (request.signal?.aborted) {
        throw abortedQuestion(error)
      }
      throw restored
    }
  }
}

export default UserQuestionService
