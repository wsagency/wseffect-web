import { defineConfig } from 'vite'
import { foldkit } from '@wsagency/wseffect-vite-plugin'

export default defineConfig({ plugins: [foldkit()] })
