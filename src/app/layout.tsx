import { Analytics } from '@vercel/analytics/react'
import { SpeedInsights } from '@vercel/speed-insights/next'
// import { GoogleAnalytics } from '@next/third-parties/google'
import type { Metadata } from 'next'
import './globals.css'
import Header from './layout/header'
import Footer from './layout/footer'

export const metadata: Metadata = {
  title: 'Edencom Link',
  // Stop mobile browsers from turning long numeric IDs into "tap to dial" links.
  formatDetection: { telephone: false },
  icons: {
    icon: '/favicon.ico',
    apple: '/apple-touch-icon.png',
    other: [
      {
        type: 'image/png',
        sizes: '16x16',
        url: '/favicon-16x16.png',
      },
      {
        type: 'image/png',
        sizes: '32x32',
        url: '/favicon-32x32.png',
      },
    ],
  },
}

const RootLayout = async ({
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
      {/* <GoogleAnalytics gaId="{ process.env.NEXT_PUBLIC_GOOGLE_ANALYTICS_ID }" /> */}
    </html>
  )
}

export default RootLayout
