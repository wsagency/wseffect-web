import { Effect } from 'effect'
import type { Html, HtmlBuilder } from '@wsagency/wseffect-foldkit/html'
import { renderToString } from '@wsagency/wseffect-foldkit/experimental/server'
import * as Theme from '@wsagency/wseffect-themes/components/theme'
/** Static examples are serialized by Foldkit's experimental server renderer; render failures intentionally fail the Astro build. */
export function renderStatic<Message>(view: (h: HtmlBuilder<Message>) => Html): string {
  const config = {
    init: () => ({ model: null }),
    view: (_model: null, h: HtmlBuilder<Message>) => ({ title: 'Static example', body: view(h) }),
  }
  return Effect.runSync(renderToString(config, { isHydratable: false })).html
}

/** Build the single page Theme wrapper with a unique child and split its genuine rendered markup around that slot. */
export function renderThemeShell(settings: Partial<Theme.Settings> = {}): { before: string; after: string } {
  const slot = 'wseffect-static-theme-slot-6f4a2c'
  const html = renderStatic((h) => Theme.view({ settings, isRoot: true, id: 'wseffect-docs-theme' }, [h.span([h.Id(slot)])], h))
  const marker = `id="${slot}"`
  const index = html.indexOf(marker)
  if (index < 0 || html.indexOf(marker, index + marker.length) !== -1) {
    throw new Error('Foldkit Theme output did not contain exactly one static slot')
  }
  const openStart = html.lastIndexOf('<span', index)
  const closeStart = html.indexOf('</span>', index + marker.length)
  if (openStart < 0 || closeStart < 0) throw new Error('Foldkit Theme output had an unexpected static slot shape')
  return { before: html.slice(0, openStart), after: html.slice(closeStart + '</span>'.length) }
}

