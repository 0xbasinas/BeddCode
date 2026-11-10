import path from 'node:path'
import { defineConfig } from 'vitest/config'

const root = path.resolve(__dirname)

export default defineConfig({
  root,
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: { '@': path.resolve(root, 'src') },
  },
})
