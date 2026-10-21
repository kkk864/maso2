import { NextRequest, NextResponse } from 'next/server'

export async function GET(req: NextRequest) {
  const rawUrl = req.nextUrl.searchParams.get('url')
  if (!rawUrl) {
    return new NextResponse('Missing url parameter', { status: 400 })
  }

  let targetUrl = rawUrl.trim()
  if (targetUrl.startsWith('//')) {
    targetUrl = `https:${targetUrl}`
  } else if (targetUrl.startsWith('/')) {
    targetUrl = `https://prtv.su${targetUrl}`
  } else if (!/^https?:\/\//i.test(targetUrl)) {
    targetUrl = `https://prtv.su/${targetUrl.replace(/^\/+/, '')}`
  }

  try {
    const parsed = new URL(targetUrl)
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return new NextResponse('Invalid protocol', { status: 400 })
    }

    const upstream = await fetch(parsed.toString(), {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Referer: 'https://prtv.su/',
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      },
      cache: 'force-cache',
    })

    if (!upstream.ok) {
      return new NextResponse(`Upstream error: ${upstream.status}`, {
        status: upstream.status,
      })
    }

    const contentType = upstream.headers.get('content-type') || 'image/jpeg'
    const arrayBuffer = await upstream.arrayBuffer()

    return new NextResponse(arrayBuffer, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600, s-maxage=3600',
      },
    })
  } catch (err) {
    return new NextResponse(
      err instanceof Error ? err.message : 'Failed to proxy image',
      { status: 502 }
    )
  }
}
