'use client'

import { useEffect } from 'react'

// Graceful migration off the old `?share=<shareId>.<signature>` links, which
// repeated an id the path already carries (a link's worst case:
// /link/<id>?share=<id>.<sig>). Rendered only by a page that has ALREADY
// resolved the share server-side, it rewrites the address bar to the short
// `?share=<signature>` form the resolvers now also accept — so the URL a
// visitor copies onward, or bookmarks, is the clean one.
//
// history.replaceState rather than a redirect: no round trip, no re-render, no
// entry added to the back stack, and a share that resolved stays resolved.
export const ShareUrlCleanup = () => {
  useEffect(() => {
    const url = new URL(window.location.href)
    const share = url.searchParams.get('share')
    if (share === null) return
    const dot = share.indexOf('.')
    if (dot < 0) return
    url.searchParams.set('share', share.slice(dot + 1))
    window.history.replaceState(window.history.state, '', url)
  }, [])
  return null
}
