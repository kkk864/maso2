'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  Tv,
  RefreshCw,
  Save,
  Layers,
  CheckCircle2,
  AlertCircle,
  RotateCcw,
  LogOut,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  enrichSlideElements,
  replaceTextPreservingHtml,
  type PrtvSlide,
  type PrtvSlideElement,
  type PrtvSlideshow,
} from '@/lib/prtv-types'
import { PrtvSlidePreview } from './prtv-slide-preview'
import {
  fetchPrtvFromBrowserSockJs,
  updatePrtvFromBrowserSockJs,
} from '@/lib/prtv-browser-ddp'

const LOCAL_STORAGE_KEY = 'prtv_saved_session_v1'

interface StoredSessionData {
  email?: string
  resumeToken?: string
  activeSlideshowId?: string | null
  slideshows?: PrtvSlideshow[]
  slides?: PrtvSlide[]
  elements?: PrtvSlideElement[]
}

function readBrowserStorage(): StoredSessionData | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(LOCAL_STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as StoredSessionData
  } catch {
    return null
  }
}

function writeBrowserStorage(next: StoredSessionData): void {
  if (typeof window === 'undefined') return
  try {
    const prev = readBrowserStorage() || {}
    window.localStorage.setItem(
      LOCAL_STORAGE_KEY,
      JSON.stringify({ ...prev, ...next })
    )
  } catch {
    // ignore storage quota errors
  }
}

export function PrtvDashboard() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [resumeToken, setResumeToken] = useState('')

  const [slideshows, setSlideshows] = useState<PrtvSlideshow[]>([])
  const [activeSlideshowId, setActiveSlideshowId] = useState<string>('')
  const [slides, setSlides] = useState<PrtvSlide[]>([])
  const [elements, setElements] = useState<PrtvSlideElement[]>([])
  const [activeSlideId, setActiveSlideId] = useState<string>('')

  const [selectedElementId, setSelectedElementId] = useState<string | null>(null)
  const [draftTexts, setDraftTexts] = useState<Record<string, string>>({})

  const [isLoading, setIsLoading] = useState<boolean>(false)
  const [isSaving, setIsSaving] = useState<boolean>(false)
  const [statusBanner, setStatusBanner] = useState<{
    type: 'success' | 'error'
    text: string
  } | null>(null)

  const didAutoRestoreRef = useRef(false)

  const enrichedElements = useMemo(() => enrichSlideElements(elements), [elements])

  const currentSlide = useMemo(
    () => slides.find((s) => s._id === activeSlideId) || slides[0],
    [slides, activeSlideId]
  )

  const currentSlideElements = useMemo(
    () => enrichedElements.filter((el) => el.slideId === (currentSlide?._id || activeSlideId)),
    [enrichedElements, currentSlide, activeSlideId]
  )

  const pendingChangesCount = useMemo(() => {
    return Object.entries(draftTexts).filter(([id, val]) => {
      const orig = enrichedElements.find((e) => e._id === id)
      return orig && val.trim() !== orig.plainText.trim()
    }).length
  }, [draftTexts, enrichedElements])

  async function persistSessionEverywhere(snapshot: StoredSessionData) {
    writeBrowserStorage(snapshot)
    try {
      await fetch('/api/prtv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'save-session',
          sessionSnapshot: snapshot,
        }),
      })
    } catch {
      // ignore if offline
    }
  }

  async function handleConnectLive(
    customSlideshowId?: string,
    overrideCreds?: { email?: string; password?: string; resumeToken?: string }
  ) {
    setIsLoading(true)
    setStatusBanner(null)

    const creds = {
      email: overrideCreds?.email !== undefined ? overrideCreds.email : email,
      password: overrideCreds?.password !== undefined ? overrideCreds.password : password,
      resumeToken:
        overrideCreds?.resumeToken !== undefined ? overrideCreds.resumeToken : resumeToken,
    }
    const targetId = customSlideshowId || undefined

    try {
      let data: {
        token: string
        transport?: string
        slideshows: PrtvSlideshow[]
        activeSlideshowId: string | null
        slides: PrtvSlide[]
        elements: PrtvSlideElement[]
      } | null = null

      let browserErr: Error | null = null

      try {
        const browserData = await fetchPrtvFromBrowserSockJs(creds, targetId)
        data = {
          ...browserData,
          transport: 'SockJS WS',
        }
      } catch (err) {
        browserErr = err instanceof Error ? err : new Error(String(err))
        if (
          browserErr.message.includes('Неверный') ||
          browserErr.message.includes('не найден') ||
          browserErr.message.includes('Укажите') ||
          browserErr.message.includes('403')
        ) {
          throw browserErr
        }
      }

      if (!data) {
        const response = await fetch('/api/prtv', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'fetch',
            credentials: creds,
            slideshowId: targetId,
          }),
        })

        const serverJson = await response.json()
        if (!serverJson.ok || serverJson.error) {
          throw new Error(
            serverJson.error ||
              browserErr?.message ||
              'Не удалось подключиться к prtv.su'
          )
        }
        data = serverJson
      }

      const nextToken = data.token || creds.resumeToken || ''
      if (nextToken) {
        setResumeToken(nextToken)
      }
      if (creds.email) {
        setEmail(creds.email)
      }
      setPassword('')

      setSlideshows(data.slideshows || [])
      setActiveSlideshowId(data.activeSlideshowId || '')
      setSlides(data.slides || [])
      setElements(data.elements || [])
      setDraftTexts({})
      if (data.slides?.length > 0) {
        setActiveSlideId(data.slides[0]._id)
      }

      await persistSessionEverywhere({
        email: creds.email || email,
        resumeToken: nextToken,
        activeSlideshowId: data.activeSlideshowId,
        slideshows: data.slideshows,
        slides: data.slides,
        elements: data.elements,
      })

      setStatusBanner({
        type: 'success',
        text: 'Слайды загружены',
      })
    } catch (err) {
      setStatusBanner({
        type: 'error',
        text: err instanceof Error ? err.message : 'Ошибка подключения к prtv.su',
      })
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    if (didAutoRestoreRef.current) return
    didAutoRestoreRef.current = true

    async function restoreSavedSession() {
      let saved = readBrowserStorage()

      try {
        const res = await fetch('/api/prtv')
        const json = await res.json()
        if (json?.ok && json.session) {
          saved = {
            ...saved,
            ...json.session,
          }
          writeBrowserStorage(saved!)
        }
      } catch {
        // ignore
      }

      if (!saved || (!saved.resumeToken && !saved.email)) return

      if (saved.email) setEmail(saved.email)
      if (saved.resumeToken) setResumeToken(saved.resumeToken)

      if (saved.slides && saved.slides.length > 0 && saved.elements) {
        if (saved.slideshows?.length) setSlideshows(saved.slideshows)
        if (saved.activeSlideshowId) setActiveSlideshowId(saved.activeSlideshowId)
        setSlides(saved.slides)
        setElements(saved.elements)
        setActiveSlideId(saved.slides[0]._id)
      }

      if (saved.resumeToken) {
        await handleConnectLive(saved.activeSlideshowId || undefined, {
          email: saved.email || '',
          resumeToken: saved.resumeToken,
        })
      }
    }

    restoreSavedSession()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleLogout() {
    setResumeToken('')
    setPassword('')
    setDraftTexts({})
    setSlideshows([])
    setActiveSlideshowId('')
    setSlides([])
    setElements([])
    setActiveSlideId('')
    setStatusBanner(null)

    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(LOCAL_STORAGE_KEY)
    }
    try {
      await fetch('/api/prtv', { method: 'DELETE' })
    } catch {
      // ignore
    }
  }

  function handleDraftChange(elementId: string, value: string) {
    setDraftTexts((prev) => ({
      ...prev,
      [elementId]: value,
    }))
  }

  async function handleSaveUpdates(singleElementId?: string) {
    const targetIds = singleElementId ? [singleElementId] : Object.keys(draftTexts)
    const updatesToRun = targetIds
      .map((id) => {
        const orig = enrichedElements.find((e) => e._id === id)
        const draft = draftTexts[id]
        if (!orig || draft === undefined || draft.trim() === orig.plainText.trim()) {
          return null
        }
        const newHtml = replaceTextPreservingHtml(orig.text, draft, 'smart-price')
        return {
          elementId: orig._id,
          newPlainText: draft,
          text: newHtml,
          textAlign: orig.textAlign,
          lineHeight: orig.lineHeight,
          letterSpacing: orig.letterSpacing,
          padding: orig.padding,
        }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)

    if (updatesToRun.length === 0) return

    setIsSaving(true)
    setStatusBanner(null)

    try {
      let updatedToken = resumeToken
      const creds = { email, password, resumeToken }

      let savedViaBrowser = false
      try {
        const browserRes = await updatePrtvFromBrowserSockJs(creds, updatesToRun)
        if (browserRes.token) {
          updatedToken = browserRes.token
          setResumeToken(browserRes.token)
        }
        savedViaBrowser = true
      } catch (browserErr) {
        const msg = browserErr instanceof Error ? browserErr.message : ''
        if (msg.includes('Неверный') || msg.includes('403') || msg.includes('Недостаточно прав')) {
          throw browserErr
        }
      }

      if (!savedViaBrowser) {
        const response = await fetch('/api/prtv', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'update',
            credentials: creds,
            updates: updatesToRun,
          }),
        })
        const data = await response.json()
        if (!data.ok || data.error) {
          throw new Error(data.error || 'Ошибка сохранения в prtv.su')
        }
        if (data.token) {
          updatedToken = data.token
          setResumeToken(data.token)
        }
      }

      const nextElements = elements.map((el) => {
        const found = updatesToRun.find((u) => u.elementId === el._id)
        if (!found) return el
        return {
          ...el,
          text: found.text,
          updatedAt: new Date().toISOString(),
        }
      })

      setElements(nextElements)

      await persistSessionEverywhere({
        email,
        resumeToken: updatedToken,
        activeSlideshowId,
        slideshows,
        slides,
        elements: nextElements,
      })

      setDraftTexts((prev) => {
        const copy = { ...prev }
        for (const u of updatesToRun) {
          delete copy[u.elementId]
        }
        return copy
      })

      setStatusBanner({
        type: 'success',
        text: 'Сохранено',
      })
    } catch (err) {
      setStatusBanner({
        type: 'error',
        text: err instanceof Error ? err.message : 'Ошибка при сохранении',
      })
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Tv className="h-4 w-4" />
            </div>
            <h1 className="text-base font-semibold tracking-tight">PRTV</h1>
          </div>

          {pendingChangesCount > 0 && (
            <Button
              size="sm"
              onClick={() => handleSaveUpdates()}
              disabled={isSaving}
              className="gap-1.5 font-medium"
            >
              <Save className="h-4 w-4" />
              {isSaving ? 'Сохранение...' : `Сохранить всё (${pendingChangesCount})`}
            </Button>
          )}
        </div>
      </header>

      <main className="mx-auto flex max-w-7xl flex-col gap-5 px-4 py-5 sm:px-6">
        <section className="rounded-xl border border-border bg-card p-4">
          {resumeToken ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm">
                <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" />
                <span className="font-medium">{email || 'Сессия активна'}</span>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => handleConnectLive(activeSlideshowId || undefined)}
                  disabled={isLoading}
                  className="gap-1.5"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} />
                  {isLoading ? 'Обновление...' : 'Обновить слайды'}
                </Button>

                <Button
                  size="sm"
                  variant="ghost"
                  onClick={handleLogout}
                  className="gap-1.5 text-muted-foreground hover:text-foreground"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  Выйти
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="grid flex-1 grid-cols-1 gap-2.5 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">
                    Email
                  </label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="user@example.ru"
                    className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus:border-primary"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">
                    Пароль
                  </label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={(e) => {
                      if (
                        e.key === 'Enter' &&
                        !e.nativeEvent.isComposing &&
                        e.keyCode !== 229
                      ) {
                        handleConnectLive()
                      }
                    }}
                    placeholder="••••••••"
                    className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus:border-primary"
                  />
                </div>
              </div>

              <Button
                onClick={() => handleConnectLive()}
                disabled={isLoading}
                className="gap-1.5"
              >
                <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
                {isLoading ? 'Загрузка...' : 'Загрузить слайды'}
              </Button>
            </div>
          )}

          {statusBanner && (
            <div
              className={`mt-3 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${
                statusBanner.type === 'success'
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                  : 'border-destructive/40 bg-destructive/10 text-red-300'
              }`}
            >
              {statusBanner.type === 'error' ? (
                <AlertCircle className="h-4 w-4 shrink-0" />
              ) : (
                <CheckCircle2 className="h-4 w-4 shrink-0" />
              )}
              <span>{statusBanner.text}</span>
            </div>
          )}
        </section>

        {slides.length > 0 && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                {slides.map((s, idx) => {
                  const isAct = s._id === (currentSlide?._id || activeSlideId)
                  return (
                    <button
                      key={s._id}
                      type="button"
                      onClick={() => {
                        setActiveSlideId(s._id)
                        setSelectedElementId(null)
                      }}
                      className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition cursor-pointer ${
                        isAct
                          ? 'border-primary bg-primary/15 text-foreground'
                          : 'border-border bg-card text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      <Layers className="h-3.5 w-3.5 text-primary" />
                      <span>Слайд {s.position ?? idx + 1}</span>
                    </button>
                  )
                })}
              </div>

              {slideshows.length > 1 && (
                <select
                  value={activeSlideshowId}
                  onChange={(e) => {
                    const nextId = e.target.value
                    setActiveSlideshowId(nextId)
                    handleConnectLive(nextId)
                  }}
                  className="h-8 rounded-md border border-border bg-card px-2.5 text-xs"
                >
                  {slideshows.map((ss) => (
                    <option key={ss._id} value={ss._id}>
                      {ss.name}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
              <div className="flex flex-col gap-3 lg:col-span-5">
                <div className="rounded-xl border border-border bg-card p-4">
                  {pendingChangesCount > 0 && (
                    <div className="mb-3 flex items-center justify-end">
                      <button
                        type="button"
                        onClick={() => setDraftTexts({})}
                        className="inline-flex items-center gap-1 text-xs text-amber-400 hover:underline cursor-pointer"
                      >
                        <RotateCcw className="h-3 w-3" />
                        Сбросить изменения
                      </button>
                    </div>
                  )}

                  <div className="flex flex-col gap-2">
                    {currentSlideElements.length === 0 ? (
                      <div className="py-6 text-center text-sm text-muted-foreground">
                        На этом слайде нет текстовых блоков
                      </div>
                    ) : (
                      currentSlideElements.map((el, idx) => {
                        const currentVal =
                          draftTexts[el._id] !== undefined ? draftTexts[el._id] : el.plainText
                        const isModified =
                          draftTexts[el._id] !== undefined &&
                          draftTexts[el._id].trim() !== el.plainText.trim()
                        const isSelected = selectedElementId === el._id

                        return (
                          <div
                            key={el._id}
                            onClick={() => setSelectedElementId(el._id)}
                            className={`flex items-center justify-between gap-2.5 rounded-lg border px-3 py-2 transition ${
                              isSelected
                                ? 'border-primary bg-primary/5'
                                : isModified
                                  ? 'border-amber-500/50 bg-amber-500/5'
                                  : 'border-border bg-background/60 hover:border-border/90'
                            }`}
                          >
                            <span className="shrink-0 text-xs font-medium text-muted-foreground">
                              {el.pairedLabel || `#${idx + 1}`}
                            </span>

                            <div className="flex flex-1 items-center justify-end gap-2">
                              <input
                                type="text"
                                value={currentVal}
                                onChange={(e) => handleDraftChange(el._id, e.target.value)}
                                onKeyDown={(e) => {
                                  if (
                                    e.key === 'Enter' &&
                                    !e.nativeEvent.isComposing &&
                                    e.keyCode !== 229
                                  ) {
                                    handleSaveUpdates(el._id)
                                  }
                                }}
                                className={`h-9 w-full max-w-[220px] rounded-md border px-3 font-mono text-sm font-semibold outline-none transition ${
                                  isModified
                                    ? 'border-amber-400 bg-amber-500/10 text-amber-300'
                                    : 'border-border bg-background text-foreground focus:border-primary'
                                }`}
                              />

                              <Button
                                size="sm"
                                variant={isModified ? 'default' : 'secondary'}
                                disabled={!isModified || isSaving}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleSaveUpdates(el._id)
                                }}
                                className="h-9 px-3 text-xs"
                              >
                                ОК
                              </Button>
                            </div>
                          </div>
                        )
                      })
                    )}
                  </div>
                </div>
              </div>

              <div className="flex flex-col lg:col-span-7">
                <div className="sticky top-20 rounded-xl border border-border bg-card p-3">
                  <PrtvSlidePreview
                    slide={currentSlide}
                    allSlides={slides}
                    elements={currentSlideElements}
                    rawElements={elements}
                    draftTexts={draftTexts}
                    selectedElementId={selectedElementId}
                    onSelectElement={(id) => setSelectedElementId(id)}
                  />
                </div>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  )
}
