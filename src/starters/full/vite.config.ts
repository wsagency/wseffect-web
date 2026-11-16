import { defineConfig } from 'vite'
import { wseffect } from '@wsagency/wseffect-app/vite'

export default defineConfig({
  plugins: [wseffect({ primaryPages: ['home'], pwa: false })],
})
