import type { MetadataRoute } from 'next'

// Icon colours are the documented brand palette (docs/design.md), not invented:
//   #1C3A2A  "Dark green (primary)"
//   #F5F0E8  "On dark green: #F5F0E8 (primary)" — the light used on green throughout
//
// INVERTED FROM WHAT THE MARKETING SITE ACTUALLY SERVES, which is not what it was
// described as. Fetched 2026-09-03, margenticos.com serves an inline SVG favicon that is
// a #1C3A2A square with a white M. So a green tile with a light mark, which is what this
// was briefed as, would have been a near-duplicate of the site rather than a counterpart
// to it. The app is therefore the light tile with the green mark, and rounded where the
// site is square. At 16px the two are told apart by which one is dark.
//
// theme_color stays #1C3A2A: that is the browser chrome colour, not the tile.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'MargenticOS',
    short_name: 'MargenticOS',
    start_url: '/dashboard',
    display: 'standalone',
    background_color: '#F8F4EE',
    theme_color: '#1C3A2A',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  }
}
