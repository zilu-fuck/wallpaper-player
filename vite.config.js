import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import sharedAliases from './scripts/shared-aliases.cjs'

export default defineConfig({
  plugins: [react()],
  base: './',
  root: '.',
  resolve: { alias: sharedAliases },
  optimizeDeps: {
    include: Object.keys(sharedAliases)
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rolldownOptions: {
      input: path.resolve(__dirname, 'index.html')
    }
  }
})
