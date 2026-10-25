import { defineConfig, loadEnv } from 'vite'
import { cwd } from 'node:process'
import react from '@vitejs/plugin-react'
import { assertPublicEnvironment, assetSecurityPlugin } from './scripts/assetSecurity.mjs'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  assertPublicEnvironment(loadEnv(mode, cwd(), 'VITE_'))
  return {
    plugins: [react(), assetSecurityPlugin()],
    build: {
      outDir: 'build', // Change output directory to 'build'
    },
  }
})
