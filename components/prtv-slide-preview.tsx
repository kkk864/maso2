'use client'

import React, { useEffect, useState } from 'react'
import {
  findAnyImageInObject,
  resolvePrtvImageUrl,
  resolveProxiedPrtvImageUrl,
  type EnrichedTextElement,
  type PrtvSlide,
  type PrtvSlideElement,
} from '@/lib/prtv-types'

interface PrtvSlidePreviewProps {
  slide: PrtvSlide | undefined
  allSlides?: PrtvSlide[]
  elements: EnrichedTextElement[]
  rawElements?: PrtvSlideElement[]
  draftTexts: Record<string, string>
  selectedElementId: string | null
  onSelectElement: (id: string) => void
}

function SmartPrtvImage({
  rawUrl,
  alt,
  className,
  onReady,
}: {
  rawUrl: string | null | undefined
  alt: string
  className?: string
  onReady?: () => void
}) {
  const directUrl = resolvePrtvImageUrl(rawUrl)
  const proxiedUrl = resolveProxiedPrtvImageUrl(rawUrl)
  const [useProxy, setUseProxy] = useState(false)

  useEffect(() => {
    setUseProxy(false)
  }, [rawUrl])

  if (!directUrl) return null
  const srcToUse = useProxy && proxiedUrl ? proxiedUrl : directUrl

  return (
    <img
      key={srcToUse}
      src={srcToUse}
      alt={alt}
      loading="eager"
      decoding="async"
      referrerPolicy="no-referrer"
      onLoad={() => {
        onReady?.()
      }}
      onError={() => {
        if (!useProxy && proxiedUrl && proxiedUrl !== directUrl) {
          setUseProxy(true)
        } else {
          onReady?.()
        }
      }}
      className={className}
    />
  )
}

function extractInlineStylesFromHtml(html?: string): {
  fontSizePx: number | null
  color: string | null
  textAlign: 'left' | 'center' | 'right' | null
} {
  if (!html) return { fontSizePx: null, color: null, textAlign: null }

  const sizeMatch = html.match(/font-size:\s*(\d+(?:\.\d+)?)\s*(px|pt)/i)
  let fontSizePx: number | null = null
  if (sizeMatch) {
    const val = parseFloat(sizeMatch[1])
    fontSizePx = sizeMatch[2].toLowerCase() === 'pt' ? Math.round(val * 1.333) : val
  }

  const colorMatch = html.match(/(?:^|[;\s"'])color:\s*([^;'">]+)/i)
  const alignMatch = html.match(/text-align:\s*(left|center|right)/i)

  return {
    fontSizePx,
    color: colorMatch ? colorMatch[1].trim() : null,
    textAlign: alignMatch ? (alignMatch[1].toLowerCase() as 'left' | 'center' | 'right') : null,
  }
}

export function PrtvSlidePreview({
  slide,
  allSlides = [],
  elements,
  rawElements = [],
  draftTexts,
  selectedElementId,
  onSelectElement,
}: PrtvSlidePreviewProps) {
  const currentSlideId = slide?._id
  const rawSlideBg = findAnyImageInObject(slide)
  const bgColor =
    slide?.styles?.slideBackgroundColor ||
    slide?.styles?.backgroundColor ||
    '#111318'

  const [loadedMap, setLoadedMap] = useState<Record<string, boolean>>({})

  const slidesToRender = allSlides.length > 0 ? allSlides : slide ? [slide] : []

  const slideRawElements = rawElements.filter((el) => {
    return (
      !currentSlideId ||
      el.slideId === currentSlideId ||
      !el.slideId ||
      (el.permanent &&
        (el.permanentAtAll !== false ||
          (Array.isArray(el.permanentOnSlides) &&
            el.permanentOnSlides.includes(currentSlideId))))
    )
  })

  const visualLayerElements = slideRawElements
    .filter((el) => {
      const rawElImg = findAnyImageInObject(el)
      const hasTextContent =
        typeof el.text === 'string' &&
        el.text.replace(/<[^>]+>|&nbsp;|\s+/g, '').length > 0
      return (
        Boolean(rawElImg) ||
        (!hasTextContent && Boolean(el.backgroundColor || el.styles?.backgroundColor))
      )
    })
    .sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0))

  const currentBgKey = `${currentSlideId || 'slide'}_${rawSlideBg || ''}`
  const isCurrentBgLoading = Boolean(rawSlideBg) && !loadedMap[currentBgKey]

  return (
    <div
      className="relative w-full overflow-hidden rounded-lg border border-border shadow-inner select-none"
      style={{
        aspectRatio: '16 / 9',
        backgroundColor: bgColor,
      }}
    >
      {/* Предзагрузка и мгновенное переключение фонов всех слайдов без залипания старой картинки */}
      {slidesToRender.map((s) => {
        const sBg = findAnyImageInObject(s)
        if (!sBg) return null
        const isCurrent = s._id === currentSlideId
        const itemKey = `${s._id}_${sBg}`

        return (
          <SmartPrtvImage
            key={itemKey}
            rawUrl={sBg}
            alt={`Слайд #${s.position ?? 1}`}
            onReady={() => {
              setLoadedMap((prev) =>
                prev[itemKey] ? prev : { ...prev, [itemKey]: true }
              )
            }}
            className={`pointer-events-none absolute inset-0 h-full w-full object-fill transition-opacity duration-150 ${
              isCurrent ? 'z-0 opacity-100' : '-z-10 opacity-0'
            }`}
          />
        )
      })}

      {isCurrentBgLoading && (
        <div className="pointer-events-none absolute inset-0 z-[1] flex items-center justify-center bg-background/40 backdrop-blur-[2px]">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      )}

      {visualLayerElements.map((layer) => {
        const rawElImg = findAnyImageInObject(layer)
        const leftPct = ((layer.left ?? 0) / 1920) * 100
        const topPct = ((layer.top ?? 0) / 1080) * 100
        const widthPct = ((layer.width ?? 1920) / 1920) * 100
        const heightPct = ((layer.height ?? 1080) / 1080) * 100

        return (
          <div
            key={`layer_${currentSlideId}_${layer._id}_${rawElImg || ''}`}
            className="pointer-events-none absolute overflow-hidden"
            style={{
              left: `${leftPct}%`,
              top: `${topPct}%`,
              width: `${widthPct}%`,
              height: `${heightPct}%`,
              zIndex: layer.zIndex ?? 0,
              opacity: layer.opacity ?? 1,
              backgroundColor:
                layer.backgroundColor || layer.styles?.backgroundColor || undefined,
            }}
          >
            {rawElImg && (
              <SmartPrtvImage
                rawUrl={rawElImg}
                alt=""
                className="h-full w-full object-fill"
              />
            )}
          </div>
        )
      })}

      {elements.map((el) => {
        const leftPct = Math.max(0, Math.min(98, ((el.left ?? 0) / 1920) * 100))
        const topPct = Math.max(0, Math.min(96, ((el.top ?? 0) / 1080) * 100))
        const widthPct = Math.max(4, Math.min(100 - leftPct, ((el.width ?? 200) / 1920) * 100))
        const heightPct = el.height
          ? Math.max(3, Math.min(100 - topPct, (el.height / 1080) * 100))
          : undefined

        const isSelected = selectedElementId === el._id
        const hasDraft =
          draftTexts[el._id] !== undefined && draftTexts[el._id] !== el.plainText
        const displayValue =
          draftTexts[el._id] !== undefined ? draftTexts[el._id] : el.plainText

        const htmlStyles = extractInlineStylesFromHtml(el.text)
        const effectiveAlign =
          htmlStyles.textAlign ||
          ((el.textAlign?.toLowerCase() as 'left' | 'right' | 'center') || 'center')
        const effectiveTextColor = htmlStyles.color || el.textColor || '#ffffff'
        const effectiveBgImage = resolvePrtvImageUrl(el.backgroundImage)
        const hasNativeBgColor =
          Boolean(el.backgroundColor) &&
          el.backgroundColor !== 'transparent' &&
          el.backgroundColor !== 'rgba(0, 0, 0, 0)'

        return (
          <button
            key={el._id}
            type="button"
            onClick={() => onSelectElement(el._id)}
            style={{
              left: `${leftPct}%`,
              top: `${topPct}%`,
              width: `${widthPct}%`,
              height: heightPct ? `${heightPct}%` : undefined,
              zIndex: (el.zIndex ?? 1) + 10,
              textAlign: effectiveAlign,
              color: effectiveTextColor,
              backgroundColor: hasNativeBgColor
                ? el.backgroundColor
                : isSelected
                  ? 'rgba(59, 130, 246, 0.28)'
                  : hasDraft
                    ? 'rgba(245, 158, 11, 0.28)'
                    : el.isLikelyPrice
                      ? 'rgba(0, 0, 0, 0.45)'
                      : 'transparent',
              backgroundImage: effectiveBgImage ? `url("${effectiveBgImage}")` : undefined,
              backgroundSize: '100% 100%',
              backgroundRepeat: 'no-repeat',
            }}
            className={`group absolute flex items-center justify-center rounded-sm px-1 transition-all cursor-pointer ${
              isSelected
                ? 'ring-2 ring-white shadow-lg'
                : hasDraft
                  ? 'ring-2 ring-amber-400 shadow-md'
                  : 'hover:ring-2 hover:ring-white/80'
            }`}
          >
            <span
              className="block w-full truncate font-sans leading-none"
              style={{
                textAlign: effectiveAlign,
                fontSize: el.isLikelyPrice
                  ? 'clamp(10px, 1.25vw, 17px)'
                  : (htmlStyles.fontSizePx || el.fontSize || 24) >= 38
                    ? 'clamp(11px, 1.35vw, 19px)'
                    : 'clamp(9px, 1.05vw, 14px)',
                fontWeight:
                  el.isLikelyPrice || (htmlStyles.fontSizePx || el.fontSize || 0) >= 32
                    ? 800
                    : 600,
                textShadow: hasNativeBgColor ? 'none' : '0 1px 3px rgba(0,0,0,0.85)',
              }}
            >
              {displayValue}
            </span>
          </button>
        )
      })}
    </div>
  )
}
