import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session'
import {
  DESKTOP_PROTOCOL_VERSION,
  DesktopCapabilityMethod,
  DesktopCapabilityParams,
  DesktopCapabilityResult,
  DesktopEventData,
  DesktopEventName,
} from '@dolphinminer/dsh-desktop-protocol'

import {
  DesktopCallOptions,
  DesktopCapabilityClient,
  processIpcTransport,
} from './bridge.js'

export * from './bridge.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    desktopBridge: DesktopBridgeService
  }
}

export class DesktopBridgeService extends Service {
  private readonly client = new DesktopCapabilityClient(processIpcTransport())

  constructor(ctx: Context) {
    super(ctx, 'desktopBridge')
  }

  call<M extends DesktopCapabilityMethod>(
    method: M,
    params: DesktopCapabilityParams<M>,
    options?: DesktopCallOptions,
  ): Promise<DesktopCapabilityResult<M>> {
    return this.client.call(method, params, options)
  }

  on<E extends DesktopEventName>(
    event: E,
    listener: (data: DesktopEventData<E>) => void,
  ): () => void {
    return this.client.on(event, listener)
  }

  dispose(): void {
    this.client.dispose()
  }
}

export const inject = ['sessions']

export function apply(ctx: Context): void {
  const bridge = new DesktopBridgeService(ctx)
  ctx.effect(() => () => bridge.dispose(), 'dsh-desktop: capability bridge')

  void bridge.call('desktop.ping', {
    nonce: `host-${DESKTOP_PROTOCOL_VERSION}`,
  }).then(() => {
    ctx.logger('dsh-desktop').info('desktop capability bridge connected')
  }).catch(error => {
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger('dsh-desktop').warn('desktop capability bridge unavailable: %s', message)
  })

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    const kind = event.data.reason.kind
    if (kind !== 'completed' && kind !== 'error') return
    const success = kind === 'completed'
    void bridge.call('desktop.notify', {
      title: success ? 'DSH task completed' : 'DSH task failed',
      body: success ? 'The agent finished its current turn.' : 'The agent turn ended with an error.',
      sessionId: session.id,
      level: success ? 'success' : 'error',
    }).catch(() => undefined)
  })
}
