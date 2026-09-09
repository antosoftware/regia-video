import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import tailwindcss from 'tailwindcss'
import autoprefixer from 'autoprefixer'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Wiring esplicito di PostCSS/Tailwind qui, invece di affidarsi al solo
  // rilevamento automatico di postcss.config.js: così funziona in modo
  // affidabile indipendentemente dalla versione/variante di Vite in uso
  css: {
    postcss: {
      plugins: [tailwindcss(), autoprefixer()],
    },
  },
})
