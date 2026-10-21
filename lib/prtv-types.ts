export interface PrtvSlideshow {
  _id: string
  name: string
  numId?: string
  orientation?: string
}

export interface PrtvSlide {
  _id: string
  slideshowId: string
  position: number
  styles?: {
    backgroundColor?: string
    backgroundImage?: string
    backgroundImageDisplay?: string
    slideBackgroundColor?: string
    slideBackgroundImage?: string
    slideBackgroundImageDisplay?: string
    elementBackgroundColor?: string
    elementBackgroundImage?: string
    elementBackgroundImageDisplay?: string
    image?: string
    src?: string
  }
  slideBackgroundImage?: string
  backgroundImage?: string
  image?: string
}

export interface PrtvSlideElement {
  _id: string
  slideshowId: string
  slideId: string
  type: string
  text?: string
  top: number
  left: number
  width: number
  height: number
  zIndex: number
  opacity?: number
  fontSize?: number
  textColor?: string
  fontFamily?: string
  backgroundColor?: string
  backgroundImage?: string
  backgroundImageDisplay?: string
  elementBackgroundImage?: string
  slideBackgroundImage?: string
  image?: string
  src?: string
  url?: string
  link?: string
  styles?: {
    backgroundColor?: string
    backgroundImage?: string
    backgroundImageDisplay?: string
    slideBackgroundImage?: string
    elementBackgroundImage?: string
  }
  textAlign?: string
  lineHeight?: number
  letterSpacing?: number
  padding?: number
  permanent?: boolean
  permanentAtAll?: boolean
  permanentOnSlides?: string[]
  updatedAt?: string
}

export function findAnyImageInObject(obj: unknown): string | null {
  if (!obj || typeof obj !== 'object') return null
  const rec = obj as Record<string, unknown>

  const directKeys = [
    'slideBackgroundImage',
    'backgroundImage',
    'elementBackgroundImage',
    'image',
    'src',
    'url',
    'fileUrl',
    'picture',
    'bgImage',
    'backgroundUrl',
  ]
  for (const key of directKeys) {
    const val = rec[key]
    if (typeof val === 'string' && val.trim() && val.trim() !== 'none') {
      return val.trim()
    }
  }

  if (rec.styles && typeof rec.styles === 'object') {
    const styleRec = rec.styles as Record<string, unknown>
    for (const key of directKeys) {
      const val = styleRec[key]
      if (typeof val === 'string' && val.trim() && val.trim() !== 'none') {
        return val.trim()
      }
    }
    for (const [k, val] of Object.entries(styleRec)) {
      if (
        typeof val === 'string' &&
        (k.toLowerCase().includes('image') || k.toLowerCase().includes('bg')) &&
        /^https?:\/\//i.test(val.trim())
      ) {
        return val.trim()
      }
    }
  }

  if (typeof rec.text === 'string') {
    const imgTagMatch = rec.text.match(/<img[^>]+src=(['"])(.*?)\1/i)
    if (imgTagMatch?.[2]) return imgTagMatch[2].trim()
    const bgStyleMatch = rec.text.match(/background(?:-image)?\s*:\s*[^;]*url\((['"]?)(.*?)\1\)/i)
    if (bgStyleMatch?.[2]) return bgStyleMatch[2].trim()
  }

  return null
}

export function resolvePrtvImageUrl(raw?: string | null): string | null {
  if (!raw || typeof raw !== 'string') return null
  let cleaned = raw.trim()
  if (!cleaned || cleaned === 'none') return null

  const urlMatch = cleaned.match(/url\((['"]?)(.*?)\1\)/i)
  if (urlMatch?.[2]) {
    cleaned = urlMatch[2].trim()
  }

  if (!cleaned || cleaned === 'none') return null
  if (cleaned.startsWith('data:') || cleaned.startsWith('blob:')) return cleaned

  let fullUrl = cleaned
  if (cleaned.startsWith('//')) {
    fullUrl = `https:${cleaned}`
  } else if (cleaned.startsWith('/')) {
    fullUrl = `https://prtv.su${cleaned}`
  } else if (!/^https?:\/\//i.test(cleaned)) {
    fullUrl = `https://prtv.su/${cleaned.replace(/^\/+/, '')}`
  } else if (fullUrl.startsWith('http://prtv.su')) {
    fullUrl = fullUrl.replace(/^http:\/\//i, 'https://')
  }

  return fullUrl
}

export function resolveProxiedPrtvImageUrl(raw?: string | null): string | null {
  const direct = resolvePrtvImageUrl(raw)
  if (!direct) return null
  if (direct.startsWith('data:') || direct.startsWith('blob:')) return direct
  return `/api/prtv-image?url=${encodeURIComponent(direct)}`
}

export interface EnrichedTextElement extends PrtvSlideElement {
  plainText: string
  detectedPrice: string | null
  isLikelyPrice: boolean
  pairedLabel: string | null
  pairedElementId: string | null
}

export function stripHtml(html?: string): string {
  if (!html) return ''
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>\s*<p[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

export function detectPriceInText(plainText: string): {
  isLikelyPrice: boolean
  detectedPrice: string | null
} {
  const cleaned = plainText.trim()
  if (!cleaned) return { isLikelyPrice: false, detectedPrice: null }

  const strictPriceRegex =
    /^(?:от\s*)?(\d{1,3}(?:[\s.,]\d{3})*|\d+)(?:[.,]\d{1,2})?\s*(?:₽|руб\.?|р\.?|р|₸|BYN|\$|€|-\.)?(?:\s*\/\s*(?:кг|г|гр|шт|порц|л|мл|уп|м|см)\.?)?$/i
  const strictMatch = cleaned.match(strictPriceRegex)
  if (strictMatch) {
    return {
      isLikelyPrice: true,
      detectedPrice: strictMatch[1].replace(/\s+/g, ' '),
    }
  }

  const inlinePriceRegex =
    /(\d{1,3}(?:[\s]\d{3})*|\d+)\s*(?:₽|руб\.?|р\.?)(?:\s*\/\s*(?:кг|г|гр|шт|порц|л|мл))?/i
  const inlineMatch = cleaned.match(inlinePriceRegex)
  if (inlineMatch) {
    return {
      isLikelyPrice: true,
      detectedPrice: inlineMatch[1],
    }
  }

  return { isLikelyPrice: false, detectedPrice: null }
}

export function replaceTextPreservingHtml(
  originalHtml: string | undefined,
  newValue: string,
  mode: 'smart-price' | 'full-text' = 'smart-price'
): string {
  if (!originalHtml) {
    return `<p>${newValue}</p>`
  }

  const trimmedNew = newValue.trim()

  if (mode === 'smart-price') {
    const plain = stripHtml(originalHtml)
    const { detectedPrice } = detectPriceInText(plain)

    const newIsJustNumber = /^\d+(?:[\s.,]\d+)?$/.test(trimmedNew)
    if (detectedPrice && newIsJustNumber) {
      const escapedOld = detectedPrice.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const numRegex = new RegExp(`(?<!\\d|#)${escapedOld}(?!\\d)`, 'g')
      let replacedInNode = false
      const updatedHtml = originalHtml.replace(/>([^<]+)</g, (full, textContent) => {
        if (!replacedInNode && numRegex.test(textContent)) {
          replacedInNode = true
          return `>${textContent.replace(numRegex, trimmedNew)}<`
        }
        return full
      })
      if (replacedInNode) return updatedHtml
    }
  }

  let replaced = false
  const preservedWrapper = originalHtml.replace(/>([^<>]+)</g, (full, innerText) => {
    if (!replaced && innerText.trim().length > 0) {
      replaced = true
      return `>${trimmedNew}<`
    }
    return full
  })

  if (replaced) {
    return preservedWrapper
  }

  return trimmedNew
}

export function enrichSlideElements(elements: PrtvSlideElement[]): EnrichedTextElement[] {
  const textElements = elements.filter(
    (el) => el.type === 'TEXT' || typeof el.text === 'string'
  )

  const parsed = textElements.map((el) => {
    const plainText = stripHtml(el.text)
    const { isLikelyPrice, detectedPrice } = detectPriceInText(plainText)
    return {
      ...el,
      plainText,
      isLikelyPrice,
      detectedPrice,
      pairedLabel: null as string | null,
      pairedElementId: null as string | null,
    }
  })

  const nonPriceElements = parsed.filter((el) => !el.isLikelyPrice && el.plainText.length > 1)

  for (const item of parsed) {
    if (!item.isLikelyPrice) continue
    let bestCandidate: (typeof parsed)[0] | null = null
    let bestScore = Infinity

    for (const candidate of nonPriceElements) {
      if (candidate.slideId !== item.slideId) continue
      const dy = Math.abs(candidate.top - item.top)
      const dx = item.left - candidate.left

      if (dy <= 65 && dx > -50) {
        const score = dy * 3 + Math.abs(dx) * 0.25
        if (score < bestScore) {
          bestScore = score
          bestCandidate = candidate
        }
      }
      const verticalDy = item.top - candidate.top
      const horizontalDist = Math.abs(candidate.left - item.left)
      if (verticalDy > 0 && verticalDy <= 160 && horizontalDist <= 180) {
        const score = verticalDy * 1.5 + horizontalDist
        if (score < bestScore) {
          bestScore = score
          bestCandidate = candidate
        }
      }
    }

    if (bestCandidate) {
      item.pairedLabel = bestCandidate.plainText
      item.pairedElementId = bestCandidate._id
    }
  }

  return parsed.sort((a, b) => {
    if (Math.abs(a.top - b.top) > 25) return a.top - b.top
    return a.left - b.left
  })
}
