'use client'

import { useState } from 'react'

// An unused invite code rendered as its shareable sign-up link. The copy
// button builds the absolute URL from window.location.origin so it's correct
// on any deployment (previews included) without env plumbing; the visible
// href stays relative so the server-rendered markup is stable.
const CopyLink = ({ code }: { code: string }) => {
  const [copied, setCopied] = useState(false)
  const path = `/account/register?invite=${code}`

  const copy = async () => {
    await navigator.clipboard.writeText(`${window.location.origin}${path}`)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <>
      <a href={path}>
        <code>{code}</code>
      </a>{' '}
      <button type="button" onClick={copy}>
        {copied ? 'Copied!' : 'Copy link'}
      </button>
    </>
  )
}

export default CopyLink
