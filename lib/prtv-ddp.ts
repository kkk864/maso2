import crypto from 'crypto'
import https from 'https'
import type { PrtvSlide, PrtvSlideElement, PrtvSlideshow } from './prtv-types'

export interface PrtvCredentials {
  email?: string
  password?: string
  resumeToken?: string
}

export interface PrtvElementUpdateInput {
  elementId: string
  text: string
  textAlign?: string
  lineHeight?: number
  letterSpacing?: number
  padding?: number
}

interface DdpFrame {
  msg: string
  id?: string
  method?: string
  params?: unknown[]
  name?: string
  collection?: string
  fields?: Record<string, unknown>
  cleared?: string[]
  result?: unknown
  error?: { error?: string | number; reason?: string; message?: string }
  subs?: string[]
}

function randomServerId(): string {
  return String(Math.floor(100 + Math.random() * 899))
}

function randomSessionId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  for (let i = 0; i < 12; i++) {
    out += chars[Math.floor(Math.random() * chars.length)]
  }
  return out
}

export function extractSlideshowIdentifier(raw?: string): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  try {
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      const url = new URL(trimmed)
      const parts = url.pathname.split('/').filter(Boolean)
      return parts[parts.length - 1] || null
    }
  } catch {
    // ignore URL parse error
  }
  return trimmed
}

/**
 * Выполняет HTTPS POST к SockJS эндпоинтам prtv.su (/sockjs/<srv>/<sess>/xhr и /xhr_send).
 * На prtv.su Nginx проксирует именно /sockjs/*, тогда как прямой /websocket отдаёт статический HTML (200 OK).
 */
function sockJsHttpsPost(
  urlStr: string,
  body: string,
  timeoutMs = 15000
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr)
    const bodyBuf = Buffer.from(body, 'utf8')

    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'POST',
        rejectUnauthorized: false,
        headers: {
          'Content-Type': 'text/plain;charset=UTF-8',
          'Content-Length': bodyBuf.length,
          Origin: 'https://prtv.su',
          Referer: 'https://prtv.su/',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          resolve({ status: res.statusCode || 0, text })
        })
      }
    )

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('Таймаут HTTPS-соединения с prtv.su/sockjs'))
    })

    req.on('error', (err) => {
      reject(err)
    })

    req.write(bodyBuf)
    req.end()
  })
}

function translateMeteorError(rawReason?: string, rawCode?: string | number): string {
  const text = (rawReason || '').trim()
  if (/user not found/i.test(text)) {
    return 'Пользователь с таким email/логином не найден на prtv.su (403)'
  }
  if (/incorrect password/i.test(text)) {
    return 'Неверный пароль от аккаунта prtv.su (403)'
  }
  if (/you've been logged out|token expired/i.test(text)) {
    return 'Срок действия Meteor.loginToken истёк — войдите по email и паролю'
  }
  if (text) return text
  return `Ошибка метода DDP (${rawCode ?? 'unknown'})`
}

/**
 * Клиент Meteor DDP поверх SockJS HTTPS XHR (https://prtv.su/sockjs/<srv>/<session>/xhr).
 * Работает через стандартные HTTPS POST запросы на порт 443 без необходимости WebSocket Upgrade.
 */
export class PrtvDdpClient {
  private serverId = randomServerId()
  private sessionId = randomSessionId()
  private msgId = 1
  private isClosed = false
  private sendQueue: Promise<void> = Promise.resolve()

  private collections: Record<string, Map<string, Record<string, unknown>>> = {
    slideshows: new Map(),
    slides: new Map(),
    slideElements: new Map(),
  }

  private pendingMethods = new Map<
    string,
    { resolve: (res: unknown) => void; reject: (err: Error) => void }
  >()
  private pendingSubs = new Map<
    string,
    { resolve: () => void; reject: (err: Error) => void }
  >()

  private onConnectedOnce: (() => void) | null = null
  private onConnectErrorOnce: ((err: Error) => void) | null = null

  private get xhrUrl(): string {
    return `https://prtv.su/sockjs/${this.serverId}/${this.sessionId}/xhr`
  }

  private get xhrSendUrl(): string {
    return `https://prtv.su/sockjs/${this.serverId}/${this.sessionId}/xhr_send`
  }

  async connect(timeoutMs = 12000): Promise<void> {
    // 1. Открываем сессию SockJS XHR — сервер prtv.su возвращает фрейм "o\n"
    const openRes = await sockJsHttpsPost(this.xhrUrl, '', timeoutMs)
    const trimmed = openRes.text.trim()
    if (!trimmed.startsWith('o')) {
      throw new Error(
        `Неожиданный ответ SockJS от prtv.su (HTTP ${openRes.status}): ${trimmed.slice(0, 100)}`
      )
    }

    // 2. Запускаем фоновый цикл чтения фреймов /xhr и отправляем DDP connect
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.close()
        reject(new Error('Таймаут DDP-рукопожатия с prtv.su/sockjs'))
      }, timeoutMs)

      this.onConnectedOnce = () => {
        clearTimeout(timer)
        resolve()
      }

      this.onConnectErrorOnce = (err) => {
        clearTimeout(timer)
        reject(err)
      }

      void this.pollLoop()
      void this.sendDdp({
        msg: 'connect',
        version: '1',
        support: ['1', 'pre2', 'pre1'],
      }).catch((err) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      })
    })
  }

  private async pollLoop(): Promise<void> {
    while (!this.isClosed) {
      try {
        const res = await sockJsHttpsPost(this.xhrUrl, '', 20000)
        if (this.isClosed) break

        const lines = res.text
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)

        for (const line of lines) {
          if (line === 'o' || line === 'h') continue
          if (line.startsWith('c[')) {
            this.isClosed = true
            break
          }
          if (line.startsWith('a[')) {
            let frames: string[] = []
            try {
              frames = JSON.parse(line.slice(1))
            } catch {
              continue
            }
            for (const rawFrame of frames) {
              try {
                const ddp: DdpFrame = JSON.parse(rawFrame)
                this.handleDdpFrame(ddp)
              } catch {
                // ignore malformed frame
              }
            }
          }
        }
      } catch (err) {
        if (this.isClosed) break
        if (this.onConnectErrorOnce) {
          const cb = this.onConnectErrorOnce
          this.onConnectErrorOnce = null
          cb(err instanceof Error ? err : new Error(String(err)))
        }
        break
      }
    }
  }

  private sendDdp(payload: Record<string, unknown>): Promise<void> {
    this.sendQueue = this.sendQueue.then(async () => {
      if (this.isClosed) return
      const body = JSON.stringify([JSON.stringify(payload)])
      const res = await sockJsHttpsPost(this.xhrSendUrl, body, 10000)
      if (res.status >= 400) {
        throw new Error(`Ошибка отправки команды в SockJS (HTTP ${res.status})`)
      }
    })
    return this.sendQueue
  }

  private handleDdpFrame(data: DdpFrame): void {
    if (data.msg === 'ping') {
      void this.sendDdp({ msg: 'pong', ...(data.id ? { id: data.id } : {}) })
      return
    }

    if (data.msg === 'connected') {
      if (this.onConnectedOnce) {
        const cb = this.onConnectedOnce
        this.onConnectedOnce = null
        this.onConnectErrorOnce = null
        cb()
      }
      return
    }

    if (data.msg === 'failed') {
      if (this.onConnectErrorOnce) {
        const cb = this.onConnectErrorOnce
        this.onConnectErrorOnce = null
        cb(new Error('Сервер prtv.su отклонил версию протокола DDP'))
      }
      return
    }

    if (data.msg === 'added' && data.collection && data.id) {
      if (!this.collections[data.collection]) {
        this.collections[data.collection] = new Map()
      }
      const existing = this.collections[data.collection].get(data.id) || {}
      const incoming = data.fields || {}
      const mergedStyles =
        existing.styles || incoming.styles
          ? {
              ...(typeof existing.styles === 'object' && existing.styles ? existing.styles : {}),
              ...(typeof incoming.styles === 'object' && incoming.styles ? incoming.styles : {}),
            }
          : undefined
      this.collections[data.collection].set(data.id, {
        ...existing,
        _id: data.id,
        ...incoming,
        ...(mergedStyles ? { styles: mergedStyles } : {}),
      })
      return
    }

    if (data.msg === 'changed' && data.collection && data.id) {
      const col = this.collections[data.collection]
      if (col) {
        const existing = col.get(data.id) || { _id: data.id }
        const incoming = data.fields || {}
        const mergedStyles =
          existing.styles || incoming.styles
            ? {
                ...(typeof existing.styles === 'object' && existing.styles ? existing.styles : {}),
                ...(typeof incoming.styles === 'object' && incoming.styles ? incoming.styles : {}),
              }
            : undefined
        col.set(data.id, {
          ...existing,
          ...incoming,
          ...(mergedStyles ? { styles: mergedStyles } : {}),
        })
      }
      return
    }

    if (data.msg === 'ready' && Array.isArray(data.subs)) {
      for (const subId of data.subs) {
        const pending = this.pendingSubs.get(subId)
        if (pending) {
          this.pendingSubs.delete(subId)
          pending.resolve()
        }
      }
      return
    }

    if (data.msg === 'nosub' && data.id) {
      const pending = this.pendingSubs.get(data.id)
      if (pending) {
        this.pendingSubs.delete(data.id)
        if (data.error) {
          pending.reject(
            new Error(translateMeteorError(data.error.reason || data.error.message, data.error.error))
          )
        } else {
          pending.resolve()
        }
      }
      return
    }

    if (data.msg === 'result' && data.id) {
      const pending = this.pendingMethods.get(data.id)
      if (pending) {
        this.pendingMethods.delete(data.id)
        if (data.error) {
          pending.reject(
            new Error(translateMeteorError(data.error.reason || data.error.message, data.error.error))
          )
        } else {
          pending.resolve(data.result)
        }
      }
    }
  }

  async callMethod<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    const id = String(this.msgId++)
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingMethods.delete(id)
        reject(new Error(`Таймаут вызова метода ${method}`))
      }, 12000)

      this.pendingMethods.set(id, {
        resolve: (res) => {
          clearTimeout(timer)
          resolve(res as T)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
      })

      this.sendDdp({
        msg: 'method',
        method,
        params,
        id,
      }).catch((err) => {
        clearTimeout(timer)
        this.pendingMethods.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      })
    })
  }

  async subscribe(name: string, params: unknown[] = [], timeoutMs = 8000): Promise<void> {
    const id = `sub_${this.msgId++}`
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingSubs.delete(id)
        resolve()
      }, timeoutMs)

      this.pendingSubs.set(id, {
        resolve: () => {
          clearTimeout(timer)
          resolve()
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
      })

      this.sendDdp({
        msg: 'sub',
        id,
        name,
        params,
      }).catch((err) => {
        clearTimeout(timer)
        this.pendingSubs.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      })
    })
  }

  async login(creds: PrtvCredentials): Promise<{ userId: string; token: string }> {
    if (creds.resumeToken?.trim()) {
      try {
        const res = await this.callMethod<{ id: string; token: string }>('login', [
          { resume: creds.resumeToken.trim() },
        ])
        return { userId: res.id, token: res.token }
      } catch (resumeErr) {
        if (!creds.email?.trim() || !creds.password) {
          throw resumeErr
        }
      }
    }

    const emailOrUser = creds.email?.trim() || ''
    const password = creds.password || ''

    if (!emailOrUser || !password) {
      throw new Error('Укажите email и пароль от prtv.su')
    }

    const digest = crypto.createHash('sha256').update(password, 'utf8').digest('hex')
    const userField = emailOrUser.includes('@')
      ? { email: emailOrUser }
      : { username: emailOrUser }

    const res = await this.callMethod<{ id: string; token: string }>('login', [
      {
        user: userField,
        password: {
          digest,
          algorithm: 'sha-256',
        },
      },
    ])

    return { userId: res.id, token: res.token }
  }

  getCollectionDocs<T>(name: string): T[] {
    const map = this.collections[name]
    if (!map) return []
    return Array.from(map.values()) as T[]
  }

  close(): void {
    this.isClosed = true
    this.pendingMethods.clear()
    this.pendingSubs.clear()
  }
}

export async function fetchPrtvSlideshowData(
  creds: PrtvCredentials,
  targetSlideshowIdOrNum?: string
): Promise<{
  token: string
  transport: string
  slideshows: PrtvSlideshow[]
  activeSlideshowId: string | null
  slides: PrtvSlide[]
  elements: PrtvSlideElement[]
}> {
  const client = new PrtvDdpClient()
  try {
    await client.connect()
    const auth = await client.login(creds)

    await client.subscribe('slideshow.myList', [])
    const slideshows = client.getCollectionDocs<PrtvSlideshow>('slideshows')

    let activeId = extractSlideshowIdentifier(targetSlideshowIdOrNum)

    if (activeId) {
      const matchByIdOrNum = slideshows.find(
        (s) => s._id === activeId || String(s.numId) === activeId
      )
      if (matchByIdOrNum) {
        activeId = matchByIdOrNum._id
      } else if (/^\d+$/.test(activeId)) {
        try {
          const resolvedId = await client.callMethod<string>('slideshow.getIdByNumber', [
            activeId,
          ])
          if (resolvedId) activeId = resolvedId
        } catch {
          // keep activeId as is
        }
      }
    }

    if (!activeId && slideshows.length > 0) {
      activeId = slideshows[0]._id
    }

    if (activeId) {
      await client.subscribe('slideshow.oneFull', [activeId], 6000)
      const currentSlidesCount = client
        .getCollectionDocs<PrtvSlide>('slides')
        .filter((s) => s.slideshowId === activeId).length
      if (currentSlidesCount === 0) {
        await client.subscribe('slideshow.oneFullShow', [activeId], 4000)
      }
    }

    const allSlideshows = client.getCollectionDocs<PrtvSlideshow>('slideshows')
    const activeShowDoc = client
      .getCollectionDocs<Record<string, unknown>>('slideshows')
      .find((s) => s._id === activeId)
    const showDefaultBg =
      (activeShowDoc?.styles as Record<string, unknown> | undefined)
        ?.slideBackgroundImage ||
      (activeShowDoc?.styles as Record<string, unknown> | undefined)
        ?.backgroundImage ||
      activeShowDoc?.slideBackgroundImage ||
      activeShowDoc?.backgroundImage

    const slides = client
      .getCollectionDocs<PrtvSlide>('slides')
      .filter((s) => !activeId || s.slideshowId === activeId)
      .map((s) => {
        if (
          showDefaultBg &&
          typeof showDefaultBg === 'string' &&
          !s.styles?.slideBackgroundImage &&
          !s.styles?.backgroundImage &&
          !s.slideBackgroundImage &&
          !s.backgroundImage
        ) {
          return {
            ...s,
            styles: {
              ...(s.styles || {}),
              slideBackgroundImage: showDefaultBg,
              backgroundImage: showDefaultBg,
            },
          }
        }
        return s
      })
      .sort((a, b) => (a.position || 0) - (b.position || 0))

    const elements = client
      .getCollectionDocs<PrtvSlideElement>('slideElements')
      .filter((e) => !activeId || e.slideshowId === activeId)

    return {
      token: auth.token,
      transport: 'SockJS HTTPS XHR (prtv.su/sockjs)',
      slideshows: allSlideshows,
      activeSlideshowId: activeId,
      slides,
      elements,
    }
  } finally {
    client.close()
  }
}

export async function updatePrtvElements(
  creds: PrtvCredentials,
  updates: PrtvElementUpdateInput[]
): Promise<{ updatedCount: number; token: string; transport: string }> {
  const client = new PrtvDdpClient()
  try {
    await client.connect()
    const auth = await client.login(creds)

    let updatedCount = 0
    for (const item of updates) {
      await client.callMethod('slideshow.updateElement', [
        item.elementId,
        {
          text: item.text,
          textAlign: item.textAlign,
          lineHeight: item.lineHeight,
          letterSpacing: item.letterSpacing,
          padding: item.padding,
        },
      ])
      updatedCount++
    }

    return {
      updatedCount,
      token: auth.token,
      transport: 'SockJS HTTPS XHR (prtv.su/sockjs)',
    }
  } finally {
    client.close()
  }
}
