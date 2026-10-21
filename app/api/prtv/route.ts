import { promises as fs } from 'fs'
import path from 'path'
import { NextResponse } from 'next/server'
import {
  fetchPrtvSlideshowData,
  updatePrtvElements,
  type PrtvCredentials,
  type PrtvElementUpdateInput,
} from '@/lib/prtv-ddp'
import type { PrtvSlide, PrtvSlideElement, PrtvSlideshow } from '@/lib/prtv-types'

const SESSION_FILE_PATH = path.join(process.cwd(), '.prtv-session.json')

export interface SavedLocalPrtvSession {
  email?: string
  resumeToken?: string
  activeSlideshowId?: string | null
  slideshows?: PrtvSlideshow[]
  slides?: PrtvSlide[]
  elements?: PrtvSlideElement[]
  updatedAt?: string
}

async function readLocalSession(): Promise<SavedLocalPrtvSession | null> {
  try {
    const raw = await fs.readFile(SESSION_FILE_PATH, 'utf8')
    const parsed = JSON.parse(raw) as SavedLocalPrtvSession
    if (parsed && (parsed.resumeToken || parsed.email)) {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

async function writeLocalSession(session: SavedLocalPrtvSession): Promise<void> {
  try {
    const prev = (await readLocalSession()) || {}
    const merged: SavedLocalPrtvSession = {
      ...prev,
      ...session,
      updatedAt: new Date().toISOString(),
    }
    await fs.writeFile(SESSION_FILE_PATH, JSON.stringify(merged, null, 2), 'utf8')
  } catch {
    // В read-only облачной среде запись файла может быть недоступна — там работает localStorage
  }
}

export async function GET() {
  const session = await readLocalSession()
  return NextResponse.json({
    ok: true,
    session,
  })
}

export async function DELETE() {
  try {
    await fs.unlink(SESSION_FILE_PATH)
  } catch {
    // ignore if file does not exist
  }
  return NextResponse.json({ ok: true })
}

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { action, credentials, slideshowId, updates, sessionSnapshot } = body as {
      action: 'fetch' | 'update' | 'save-session'
      credentials?: PrtvCredentials
      slideshowId?: string
      updates?: PrtvElementUpdateInput[]
      sessionSnapshot?: SavedLocalPrtvSession
    }

    if (action === 'save-session' && sessionSnapshot) {
      await writeLocalSession(sessionSnapshot)
      return NextResponse.json({ ok: true })
    }

    const saved = await readLocalSession()
    const effectiveCreds: PrtvCredentials = {
      email: credentials?.email || saved?.email,
      password: credentials?.password,
      resumeToken: credentials?.resumeToken || saved?.resumeToken,
    }

    if (!effectiveCreds.email && !effectiveCreds.resumeToken) {
      return NextResponse.json({
        ok: false,
        error: 'Не переданы данные авторизации prtv.su',
      })
    }

    if (action === 'fetch') {
      const data = await fetchPrtvSlideshowData(
        effectiveCreds,
        slideshowId || saved?.activeSlideshowId || undefined
      )
      await writeLocalSession({
        email: effectiveCreds.email,
        resumeToken: data.token || effectiveCreds.resumeToken,
        activeSlideshowId: data.activeSlideshowId,
        slideshows: data.slideshows,
        slides: data.slides,
        elements: data.elements,
      })
      return NextResponse.json({
        ok: true,
        ...data,
      })
    }

    if (action === 'update') {
      if (!Array.isArray(updates) || updates.length === 0) {
        return NextResponse.json({
          ok: false,
          error: 'Список изменений пуст',
        })
      }
      const res = await updatePrtvElements(effectiveCreds, updates)
      if (res.token) {
        await writeLocalSession({
          email: effectiveCreds.email,
          resumeToken: res.token,
        })
      }
      return NextResponse.json({
        ok: true,
        ...res,
      })
    }

    return NextResponse.json({ ok: false, error: 'Неизвестное действие' })
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Неизвестная ошибка при обращении к prtv.su'
    return NextResponse.json({ ok: false, error: message })
  }
}
