import { Analytics } from '@vercel/analytics/react'
import { SpeedInsights } from '@vercel/speed-insights/next'
import type { Metadata } from 'next'
import './globals.css'
import Header from './layout/header'
import Footer from './layout/footer'

// Safari keeps a favicon store keyed on the icon URL and consults it before
// any HTTP cache — Cache-Control and ETag never get a say — so a tab that
// once saw an old mark keeps drawing it forever while the bytes at the same
// path change underneath. Versioning the URLs is the only way to force a
// refetch. **Bump this whenever the icon artwork changes.**
const ICON_VERSION = '2'
const icon = (path: string) => `${path}?v=${ICON_VERSION}`

export const metadata: Metadata = {
  title: 'Edencom Link',
  // Stop mobile browsers from turning long numeric IDs into "tap to dial" links.
  formatDetection: { telephone: false },
  icons: {
    icon: [
      { url: icon('/favicon.ico'), sizes: '16x16 32x32 48x48' },
      { url: icon('/favicon.svg'), type: 'image/svg+xml' },
    ],
    apple: icon('/apple-touch-icon.png'),
    other: [
      {
        type: 'image/png',
        sizes: '16x16',
        url: icon('/favicon-16x16.png'),
      },
      {
        type: 'image/png',
        sizes: '32x32',
        url: icon('/favicon-32x32.png'),
      },
      // Scrapers that want a larger tile — Google's s2 favicon service,
      // which is what Claude renders next to the MCP connector — pick the
      // biggest linked icon, so give them one rather than a blurry upscale
      // of the 32.
      {
        type: 'image/png',
        sizes: '48x48',
        url: icon('/favicon-48x48.png'),
      },
      {
        type: 'image/png',
        sizes: '192x192',
        url: icon('/android-chrome-192x192.png'),
      },
    ],
  },
}

const RootLayout = ({
  children,
}: Readonly<{
  children: React.ReactNode
}>) => {
  return (
    <html lang="en">
      <body>
        <Header />
        <hr />
        {children}
        <Footer />
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  )
}

export default RootLayout
