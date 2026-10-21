'use client'

import type { PrtvSlide, PrtvSlideElement, PrtvSlideshow } from './prtv-types'
import type { PrtvCredentials } from './prtv-ddp'

interface DdpMessage {
  msg?: string
  id?: string
  collection?: string
  fields?: Record<string, unknown>
  cleared?: string[]
  result?: unknown
  error?: { error?: string | number; reason?: string; message?: string }
  subs?: string[]
}

async function sha256HexBrowser(input: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(input)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Прямой браузерный DDP-клиент поверх SockJS WebSocket / Native WebSocket.
 * Используется как дополнительный канал связи напрямую из браузера пользователя.
 */
class BrowserSockJsDdpClient {
  private ws: WebSocket | null = null
  private isSockJs = true
  private msgCounter = 1
  private pendingCalls = new Map<
    string,
    { resolve: (res: unknown) => void; reject: (err: Error) => void }
  >()
  private pendingSubs = new Map<
    string,
    { resolve: () => void; reject: (err: Error) => void }
  >()

  public collections: Record<string, Map<string, Record<string, unknown>>> = {
    slideshows: new Map(),
    slides: new Map(),
    slideElements: new Map(),
  }

  async connect(timeoutMs = 9000): Promise<void> {
    const serverId = Math.floor(100 + Math.random() * 899)
    const sessionId = Math.random().toString(36).slice(2, 10)
    const sockJsWsUrl = `wss://prtv.su/sockjs/${serverId}/${sessionId}/websocket`
    await this.connectToEndpoint(sockJsWsUrl, true, timeoutMs)
  }

  private connectToEndpoint(url: string, sockJs: boolean, timeoutMs: number): Promise<void> {
    this.isSockJs = sockJs
    return new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          this.close()
          reject(new Error(`Таймаут подключения к ${url}`))
        }
      }, timeoutMs)

      try {
        this.ws = new WebSocket(url)
      } catch (err) {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error('Ошибка создания WebSocket'))
        return
      }

      this.ws.onopen = () => {
        if (!this.isSockJs) {
          this.sendRaw({
            msg: 'connect',
            version: '1',
            support: ['1', 'pre2', 'pre1'],
          })
        }
      }

      this.ws.onmessage = (event) => {
        const raw = typeof event.data === 'string' ? event.data : ''
        if (!raw) return

        if (this.isSockJs) {
          if (raw === 'o') {
            this.sendRaw({
              msg: 'connect',
              version: '1',
              support: ['1', 'pre2', 'pre1'],
            })
            return
          }
          if (raw === 'h') return
          if (raw.startsWith('c[')) {
            if (!settled) {
              settled = true
              clearTimeout(timer)
              reject(new Error('Сервер закрыл SockJS-соединение'))
            }
            return
          }
          if (raw.startsWith('a[')) {
            try {
              const frames: string[] = JSON.parse(raw.slice(1))
              for (const f of frames) {
                const msg: DdpMessage = JSON.parse(f)
                this.handleDdpMessage(msg, () => {
                  if (!settled) {
                    settled = true
                    clearTimeout(timer)
                    resolve()
                  }
                })
              }
            } catch {
              // ignore
            }
          }
          return
        }

        try {
          const msg: DdpMessage = JSON.parse(raw)
          this.handleDdpMessage(msg, () => {
            if (!settled) {
              settled = true
              clearTimeout(timer)
              resolve()
            }
          })
        } catch {
          // ignore
        }
      }

      this.ws.onerror = () => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(new Error(`Ошибка WebSocket (${url})`))
        }
      }

      this.ws.onclose = () => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(new Error(`WebSocket закрыт (${url})`))
        }
      }
    })
  }

  private sendRaw(payload: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    const str = JSON.stringify(payload)
    this.ws.send(this.isSockJs ? JSON.stringify([str]) : str)
  }

  private handleDdpMessage(msg: DdpMessage, onConnected: () => void): void {
    if (msg.msg === 'ping') {
      this.sendRaw({ msg: 'pong', ...(msg.id ? { id: msg.id } : {}) })
      return
    }
    if (msg.msg === 'connected') {
      onConnected()
      return
    }
    if (msg.msg === 'added' && msg.collection && msg.id) {
      if (!this.collections[msg.collection]) {
        this.collections[msg.collection] = new Map()
      }
      const prev = this.collections[msg.collection].get(msg.id) || {}
      const incoming = msg.fields || {}
      const mergedStyles =
        prev.styles || incoming.styles
          ? {
              ...(typeof prev.styles === 'object' && prev.styles ? prev.styles : {}),
              ...(typeof incoming.styles === 'object' && incoming.styles ? incoming.styles : {}),
            }
          : undefined
      this.collections[msg.collection].set(msg.id, {
        ...prev,
        _id: msg.id,
        ...incoming,
        ...(mergedStyles ? { styles: mergedStyles } : {}),
      })
      return
    }
    if (msg.msg === 'changed' && msg.collection && msg.id) {
      const col = this.collections[msg.collection]
      if (col) {
        const prev = col.get(msg.id) || { _id: msg.id }
        const incoming = msg.fields || {}
        const mergedStyles =
          prev.styles || incoming.styles
            ? {
                ...(typeof prev.styles === 'object' && prev.styles ? prev.styles : {}),
                ...(typeof incoming.styles === 'object' && incoming.styles ? incoming.styles : {}),
              }
            : undefined
        const next: Record<string, unknown> = {
          ...prev,
          ...incoming,
          ...(mergedStyles ? { styles: mergedStyles } : {}),
        }
        if (Array.isArray(msg.cleared)) {
          for (const k of msg.cleared) delete next[k]
        }
        col.set(msg.id, next)
      }
      return
    }
    if (msg.msg === 'removed' && msg.collection && msg.id) {
      this.collections[msg.collection]?.delete(msg.id)
      return
    }
    if (msg.msg === 'result' && msg.id) {
      const pending = this.pendingCalls.get(msg.id)
      if (pending) {
        this.pendingCalls.delete(msg.id)
        if (msg.error) {
          pending.reject(
            new Error(
              msg.error.reason ||
                msg.error.message ||
                `Ошибка Meteor (${String(msg.error.error || 'unknown')})`
            )
          )
        } else {
          pending.resolve(msg.result)
        }
      }
      return
    }
    if (msg.msg === 'ready' && Array.isArray(msg.subs)) {
      for (const subId of msg.subs) {
        const sub = this.pendingSubs.get(subId)
        if (sub) {
          this.pendingSubs.delete(subId)
          sub.resolve()
        }
      }
      return
    }
    if (msg.msg === 'nosub' && msg.id) {
      const sub = this.pendingSubs.get(msg.id)
      if (sub) {
        this.pendingSubs.delete(msg.id)
        sub.resolve()
      }
    }
  }

  call<T = unknown>(method: string, params: unknown[] = [], timeoutMs = 9000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = `call_${this.msgCounter++}`
      const timer = setTimeout(() => {
        this.pendingCalls.delete(id)
        reject(new Error(`Таймаут вызова метода ${method}`))
      }, timeoutMs)

      this.pendingCalls.set(id, {
        resolve: (res) => {
          clearTimeout(timer)
          resolve(res as T)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
      })

      this.sendRaw({
        msg: 'method',
        method,
        params,
        id,
      })
    })
  }

  subscribe(name: string, params: unknown[] = [], timeoutMs = 6000): Promise<string> {
    return new Promise<string>((resolve) => {
      const id = `sub_${this.msgCounter++}`
      const timer = setTimeout(() => {
        this.pendingSubs.delete(id)
        resolve(id)
      }, timeoutMs)

      this.pendingSubs.set(id, {
        resolve: () => {
          clearTimeout(timer)
          resolve(id)
        },
        reject: () => {
          clearTimeout(timer)
          resolve(id)
        },
      })

      this.sendRaw({
        msg: 'sub',
        id,
        name,
        params,
      })
    })
  }

  async login(creds: PrtvCredentials): Promise<{ id: string; token: string }> {
    if (creds.resumeToken?.trim()) {
      try {
        return await this.call<{ id: string; token: string }>('login', [
          { resume: creds.resumeToken.trim() },
        ])
      } catch (resumeErr) {
        if (!creds.email || !creds.password) {
          throw resumeErr
        }
      }
    }

    if (creds.email && creds.password) {
      const email = creds.email.trim()
      const digest = await sha256HexBrowser(creds.password)
      const userField = email.includes('@') ? { email } : { username: email }

      return await this.call<{ id: string; token: string }>('login', [
        {
          user: userField,
          password: {
            digest,
            algorithm: 'sha-256',
          },
        },
      ])
    }

    throw new Error('Укажите Email + пароль от prtv.su')
  }

  close(): void {
    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        // ignore
      }
      this.ws = null
    }
    this.pendingCalls.clear()
    this.pendingSubs.clear()
  }
}

export async function fetchPrtvFromBrowserSockJs(
  creds: PrtvCredentials,
  targetSlideshowId?: string
): Promise<{
  userId: string
  token: string
  slideshows: PrtvSlideshow[]
  activeSlideshowId: string | null
  slides: PrtvSlide[]
  elements: PrtvSlideElement[]
}> {
  const client = new BrowserSockJsDdpClient()
  try {
    await client.connect()
    const authResult = await client.login(creds)

    await client.subscribe('slideshow.myList', [], 4500)
    if (client.collections.slideshows.size === 0) {
      await client.subscribe('slideshow.myList', [{}], 3000)
    }

    let slideshows = Array.from(client.collections.slideshows.values()).map((doc) => ({
      _id: String(doc._id),
      name: String(doc.name || `Слайд-шоу #${doc.numId || doc._id}`),
      numId: doc.numId ? String(doc.numId) : undefined,
      orientation: doc.orientation ? String(doc.orientation) : 'LANDSCAPE',
    }))

    let chosenId: string | null = null
    if (targetSlideshowId && targetSlideshowId.trim()) {
      const cleanTarget = targetSlideshowId.trim()
      const matched = slideshows.find(
        (s) => s._id === cleanTarget || s.numId === cleanTarget
      )
      if (matched) {
        chosenId = matched._id
      } else if (/^\d+$/.test(cleanTarget)) {
        try {
          const resolvedId = await client.call<string>('slideshow.getIdByNumber', [
            cleanTarget,
          ])
          chosenId = resolvedId || cleanTarget
        } catch {
          chosenId = cleanTarget
        }
      } else {
        chosenId = cleanTarget
      }
    } else if (slideshows.length > 0) {
      chosenId = slideshows[0]._id
    }

    if (chosenId) {
      await client.subscribe('slideshow.oneFull', [chosenId], 5000)
      const hasSlides = Array.from(client.collections.slides.values()).some(
        (doc) => String(doc.slideshowId) === chosenId
      )
      if (!hasSlides) {
        await client.subscribe('slideshow.oneFullShow', [chosenId], 3500)
      }
    }

    slideshows = Array.from(client.collections.slideshows.values()).map((doc) => ({
      _id: String(doc._id),
      name: String(doc.name || `Слайд-шоу #${doc.numId || doc._id}`),
      numId: doc.numId ? String(doc.numId) : undefined,
      orientation: doc.orientation ? String(doc.orientation) : 'LANDSCAPE',
    }))

    if (chosenId && slideshows.length > 0) {
      const matchedAfter = slideshows.find(
        (s) => s._id === chosenId || s.numId === chosenId
      )
      if (matchedAfter) chosenId = matchedAfter._id
    }

    const activeShowDoc = chosenId
      ? client.collections.slideshows.get(chosenId)
      : undefined
    const showDefaultBg =
      (activeShowDoc?.styles as Record<string, unknown> | undefined)
        ?.slideBackgroundImage ||
      (activeShowDoc?.styles as Record<string, unknown> | undefined)
        ?.backgroundImage ||
      activeShowDoc?.slideBackgroundImage ||
      activeShowDoc?.backgroundImage

    const slides: PrtvSlide[] = Array.from(client.collections.slides.values())
      .filter((doc) => !chosenId || String(doc.slideshowId) === chosenId)
      .map((doc, idx) => {
        const rawStyles = ((doc.styles as PrtvSlide['styles']) || {}) as PrtvSlide['styles']
        const mergedStyles: PrtvSlide['styles'] =
          showDefaultBg &&
          typeof showDefaultBg === 'string' &&
          !rawStyles?.slideBackgroundImage &&
          !rawStyles?.backgroundImage
            ? {
                ...rawStyles,
                slideBackgroundImage: showDefaultBg,
                backgroundImage: showDefaultBg,
              }
            : rawStyles

        return {
          ...(doc as unknown as PrtvSlide),
          _id: String(doc._id),
          slideshowId: String(doc.slideshowId || chosenId || ''),
          position: typeof doc.position === 'number' ? doc.position : idx + 1,
          styles: mergedStyles,
        }
      })
      .sort((a, b) => a.position - b.position)

    const elements: PrtvSlideElement[] = Array.from(client.collections.slideElements.values())
      .filter((doc) => !chosenId || String(doc.slideshowId) === chosenId)
      .map((doc) => ({
        ...(doc as unknown as PrtvSlideElement),
        _id: String(doc._id),
        slideshowId: String(doc.slideshowId || chosenId || ''),
        slideId: String(doc.slideId || ''),
        type: String(doc.type || 'TEXT'),
        text: typeof doc.text === 'string' ? doc.text : undefined,
        top: Number(doc.top ?? 0),
        left: Number(doc.left ?? 0),
        width: Number(doc.width ?? 1920),
        height: Number(doc.height ?? 1080),
        zIndex: Number(doc.zIndex ?? 0),
        opacity: typeof doc.opacity === 'number' ? doc.opacity : undefined,
        fontSize: typeof doc.fontSize === 'number' ? doc.fontSize : undefined,
        textColor: typeof doc.textColor === 'string' ? doc.textColor : undefined,
        fontFamily: typeof doc.fontFamily === 'string' ? doc.fontFamily : undefined,
        backgroundColor:
          typeof doc.backgroundColor === 'string' ? doc.backgroundColor : undefined,
        backgroundImage:
          typeof doc.backgroundImage === 'string' ? doc.backgroundImage : undefined,
        backgroundImageDisplay:
          typeof doc.backgroundImageDisplay === 'string'
            ? doc.backgroundImageDisplay
            : undefined,
        textAlign: typeof doc.textAlign === 'string' ? doc.textAlign : 'left',
        lineHeight: typeof doc.lineHeight === 'number' ? doc.lineHeight : 1.2,
        letterSpacing: typeof doc.letterSpacing === 'number' ? doc.letterSpacing : 0,
        padding: typeof doc.padding === 'number' ? doc.padding : 0,
        permanent: Boolean(doc.permanent),
        permanentAtAll:
          typeof doc.permanentAtAll === 'boolean' ? doc.permanentAtAll : undefined,
        permanentOnSlides: Array.isArray(doc.permanentOnSlides)
          ? (doc.permanentOnSlides as string[])
          : undefined,
      }))

    return {
      userId: authResult.id,
      token: authResult.token,
      slideshows,
      activeSlideshowId: chosenId,
      slides,
      elements,
    }
  } finally {
    client.close()
  }
}

export async function updatePrtvFromBrowserSockJs(
  creds: PrtvCredentials,
  updates: Array<{
    elementId: string
    text: string
    textAlign?: string
    lineHeight?: number
    letterSpacing?: number
    padding?: number
  }>
): Promise<{
  ok: boolean
  updatedCount: number
  token: string
}> {
  const client = new BrowserSockJsDdpClient()
  try {
    await client.connect()
    const authResult = await client.login(creds)

    let updatedCount = 0
    for (const item of updates) {
      await client.call('slideshow.updateElement', [
        item.elementId,
        {
          text: item.text,
          textAlign: item.textAlign ?? 'left',
          lineHeight: item.lineHeight ?? 1.2,
          letterSpacing: item.letterSpacing ?? 0,
          padding: item.padding ?? 0,
        },
      ])
      updatedCount += 1
    }

    return {
      ok: true,
      updatedCount,
      token: authResult.token,
    }
  } finally {
    client.close()
  }
}
