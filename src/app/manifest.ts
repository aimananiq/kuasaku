import type { MetadataRoute } from 'next';

/**
 * Makes KuasaIO installable from the website: its own icon and window on phones and laptops.
 * The icons are listed in src/proxy.ts so they load without the session check.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'KuasaIO',
    short_name: 'KuasaIO',
    description: 'The community-built, open-source operating system for your business.',
    start_url: '/command',
    scope: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#007a55',
    categories: ['business', 'productivity'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
