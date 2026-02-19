import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import { devComponentIdPlugin } from './__phantom_dev_tools.mjs';


// https://astro.build/config
// Note: Set your 'site' URL in SEO Settings to enable sitemap generation
export default defineConfig({
  integrations: [mdx(), sitemap(), react()],
  image: {
    // Use Sharp for image optimization (converts to WebP/AVIF, resizes)
    service: { entrypoint: 'astro/assets/services/sharp' },
  },
  server: {
    // Bind to all interfaces so Codespaces port forwarding can reach the dev server
    host: true,
    // Allow Codespaces reverse proxy hostname (Vite 6.2+ rejects unknown hosts by default)
    allowedHosts: ['.app.github.dev'],
  },
  vite: {
    plugins: [tailwindcss(), devComponentIdPlugin()],
    server: {
      headers: {
        // Allow iframe embedding in development only (for IDE preview)
        // Note: vite.server.headers only applies to dev server, not production builds
        'Content-Security-Policy': "frame-ancestors *",
      },
      // HMR configuration for GitHub Codespaces
      hmr: {
        clientPort: 443,
        protocol: 'wss',
      },
      // File watching configuration
      watch: {
        // Use native file watchers (faster than polling)
        // If you experience issues in containers, set usePolling: true
        ignored: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/.output/**'],
      },
    },
  },
});
