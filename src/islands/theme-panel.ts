import { Schema } from 'effect'
import { defineMessageUnion } from '@wsagency/wseffect-foldkit/message'
import { makeElement } from '@wsagency/wseffect-foldkit/runtime'
import type { HtmlBuilder } from '@wsagency/wseffect-foldkit/html'
import * as Theme from '@wsagency/wseffect-themes/components/theme'

const Settings = Schema.Struct({
  accentColor: Schema.Literals(['blue', 'jade', 'amber']),
  radius: Schema.Literals(['small', 'medium', 'large']),
  appearance: Schema.Literals(['light', 'dark']),
})
type Settings = typeof Settings.Type
const Message = defineMessageUnion({ AccentChanged: { value: Schema.String }, RadiusChanged: { value: Schema.String }, AppearanceChanged: { value: Schema.String } })
type Message = typeof Message.Type
type GeneratedThemeNode = { data?: { attrs?: Record<string, unknown>; class?: Record<string, boolean> } }

function applyGeneratedTheme(settings: Settings, h: HtmlBuilder<Message>): void {
  const root = document.getElementById('wseffect-docs-theme')
  if (!root) return
  const generated = Theme.view({ settings, isRoot: true, id: 'wseffect-docs-theme' }, [], h) as GeneratedThemeNode
  const attrs = generated.data?.attrs ?? {}
  const managed = new Set(Object.keys(attrs))
  for (const attribute of Array.from(root.attributes)) {
    if (attribute.name.startsWith('data-') && !managed.has(attribute.name)) root.removeAttribute(attribute.name)
  }
  for (const [name, value] of Object.entries(attrs)) root.setAttribute(name, String(value))
  if (generated.data?.class) {
    root.className = Object.entries(generated.data.class).filter(([, enabled]) => enabled).map(([name]) => name).join(' ')
  }
}

export function themePanelEntry(host: HTMLElement) {
  return makeElement({
    container: host,
    Model: Settings,
    init: () => ({ model: { accentColor: 'blue', radius: 'medium', appearance: 'light' } as Settings }),
    update: (model: Settings, message: Message) => Message.match(message, {
      AccentChanged: ({ value }) => ({ model: { ...model, accentColor: value as Settings['accentColor'] } }),
      RadiusChanged: ({ value }) => ({ model: { ...model, radius: value as Settings['radius'] } }),
      AppearanceChanged: ({ value }) => ({ model: { ...model, appearance: value as Settings['appearance'] } }),
    }),
    view: (model: Settings, h: HtmlBuilder<Message>) => {
      applyGeneratedTheme(model, h)
      const options = (selected: string, toMessage: (value: string) => Message) => [
        h.Value(selected), h.OnInput(toMessage),
      ]
      return h.div([h.Class('theme-controls')], [
        h.label([], ['Accent color', h.select(options(model.accentColor, value => Message.AccentChanged({ value })), [
          h.option([h.Value('blue')], ['Blue']), h.option([h.Value('jade')], ['Jade']), h.option([h.Value('amber')], ['Amber']),
        ])]),
        h.label([], ['Corner radius', h.select(options(model.radius, value => Message.RadiusChanged({ value })), [
          h.option([h.Value('small')], ['Small']), h.option([h.Value('medium')], ['Medium']), h.option([h.Value('large')], ['Large']),
        ])]),
        h.label([], ['Appearance', h.select(options(model.appearance, value => Message.AppearanceChanged({ value })), [
          h.option([h.Value('light')], ['Light']), h.option([h.Value('dark')], ['Dark']),
        ])]),
      ])
    },
  })
}
