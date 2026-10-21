import type { Metadata, Viewport } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'PRTV Price Control — Дистанционное управление ценами на слайдах prtv.su',
  description:
    'Панель быстрого изменения цен и текстовых блоков на слайдах prtv.su по протоколу Meteor DDP (wss://prtv.su/websocket) без входа в конструктор.',
}

export const viewport: Viewport = {
  colorScheme: 'dark light',
  themeColor: '#0c0d10',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="ru" className="dark bg-background" suppressHydrationWarning>
      <body
        className="font-sans antialiased bg-background text-foreground"
        suppressHydrationWarning
      >
        {children}
      </body>
    </html>
  )
}
