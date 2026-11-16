import { Schema } from 'effect'
import { defineMessageUnion } from '@wsagency/wseffect-foldkit/message'
import { makeElement } from '@wsagency/wseffect-foldkit/runtime'
import type { HtmlBuilder } from '@wsagency/wseffect-foldkit/html'
import * as TextField from '@wsagency/wseffect-themes/components/text-field'

const Model = Schema.Struct({ value: Schema.String })
const Message = defineMessageUnion({ Changed: { value: Schema.String } })
type Model = typeof Model.Type
type Message = typeof Message.Type
export function textFieldEntry(host: HTMLElement) {
  return makeElement({
    container: host,
    Model,
    init: () => ({ model: { value: '' } }),
    update: (_model: Model, message: Message) => Message.match(message, {
      Changed: ({ value }) => ({ model: { value } }),
    }),
    view: (model: Model, h: HtmlBuilder<Message>) => h.div([], [
      TextField.view({
        id: 'docs-email-address', label: 'Email address', type: 'email',
        value: model.value, placeholder: 'name@example.com', variant: 'surface',
        onInput: value => Message.Changed({ value }),
      }, ['Enter an email address.'], h),
      h.p([h.AriaLive('polite'), h.DataAttribute('testid', 'field-value')], [model.value ? `Current value: ${model.value}` : 'No email entered yet.']),
    ]),
  })
}
