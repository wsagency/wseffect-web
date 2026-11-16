import '@wsagency/wseffect-themes/styles.css'
import './styles.css'
import { Command } from '@wsagency/wseffect-foldkit'
import type { HtmlBuilder } from '@wsagency/wseffect-foldkit/html'
import type { UrlRequest } from '@wsagency/wseffect-foldkit/navigation'
import type { Url } from '@wsagency/wseffect-foldkit/url'
import { run } from '@wsagency/wseffect-foldkit/runtime'
import { Schema } from 'effect'
import { initKit, kitStateSchema, makeApp } from '@wsagency/wseffect-app'
import type { KitBinding } from '@wsagency/wseffect-app'
import * as Theme from '@wsagency/wseffect-themes/components/theme'
import * as Heading from '@wsagency/wseffect-themes/components/heading'
import { KitMessage, kit, pages } from './pages.gen.js'
import type { Pages } from './pages.gen.js'

const Model = Schema.Struct({
  path: Schema.String,
  kit: kitStateSchema(pages),
})
type Model = typeof Model.Type
type KitMessageType = typeof KitMessage.Type & { readonly _tag: string }
type Message =
  | { readonly _tag: 'ChangedUrl'; readonly path: string }
  | { readonly _tag: 'GotKitMessage'; readonly message: KitMessageType }
const Message = {
  ChangedUrl: (fields: { path: string }) => ({ _tag: 'ChangedUrl' as const, ...fields }),
  GotKitMessage: (fields: { message: KitMessageType }) => ({ _tag: 'GotKitMessage' as const, ...fields }),
}
const binding = kit as KitBinding<Pages, KitMessageType>

const enterRoute = (model: Model, path: string) => {
  const result = binding.update(model.kit, KitMessage.EnteredRoute({ keys: path === '/' ? ['home'] : [] }))
  return {
    model: { ...model, path, kit: result.model },
    commands: result.commands?.map((command) => Command.mapMessage(command, (message) => Message.GotKitMessage({ message }))) ?? [],
  }
}
const init = (url: Url) => enterRoute({ path: url.pathname, kit: initKit(pages, []) }, url.pathname)
const update = (model: Model, message: Message) => {
  if (message._tag === 'ChangedUrl') return enterRoute(model, message.path)
  const result = binding.update(model.kit, message.message)
  return {
    model: { ...model, kit: result.model },
    commands: result.commands?.map((command) => Command.mapMessage(command, (next) => Message.GotKitMessage({ message: next }))) ?? [],
  }
}
const view = (model: Model, h: HtmlBuilder<Message>) => {
  const activePages = model.kit.activeKeys.map((key) => h.submodel({
    slotId: `page-${key}`,
    model: model.kit,
    view: binding.view,
    viewInputs: { key, inputs: {} },
    toParentMessage: (message) => Message.GotKitMessage({ message }),
  }))
  return {
    title: 'wseffect full starter',
    body: Theme.view({ settings: Theme.defaults, isRoot: true }, [
      h.main([h.Class('starter-main')], [
        Heading.view({ as: 'h1', size: '5' }, ['WS Agency wseffect app starter'], h),
        ...activePages,
      ]),
    ], h),
  }
}
const onUrlRequest = (request: UrlRequest): Message => request._tag === 'Internal'
  ? Message.ChangedUrl({ path: request.url.pathname })
  : Message.ChangedUrl({ path: location.pathname })
const onUrlChange = (url: Url): Message => Message.ChangedUrl({ path: url.pathname })

const application = makeApp<Model, Message, Pages, KitMessageType>({
  Model,
  init,
  update,
  view,
  container: document.getElementById('app')!,
  routing: { onUrlRequest, onUrlChange },
  kit: {
    binding,
    read: (model) => model.kit,
    toParentMessage: (message) => Message.GotKitMessage({ message }),
  },
})

run(application)
