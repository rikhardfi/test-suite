import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Deployed at the site root in dev and on Cloudflare Pages; set BASE_PATH when
// serving from a subdirectory, such as a GitHub Pages project site.
const base = process.env.BASE_PATH ?? '/'

export default defineConfig({
  base,
  plugins: [react()],
  server: { host: true },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
