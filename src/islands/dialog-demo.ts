import { Option, Schema } from 'effect'
import { defineMessageUnion } from '@wsagency/wseffect-foldkit/message'
import { makeElement } from '@wsagency/wseffect-foldkit/runtime'
import type { HtmlBuilder } from '@wsagency/wseffect-foldkit/html'
import * as Dialog from '@wsagency/wseffect-themes/components/dialog'

const Model = Schema.Struct({ dialog: Dialog.Model })
const Message = defineMessageUnion({ OpenDialog: {}, DialogEvent: { message: Dialog.Message } })
type Model = typeof Model.Type
type Message = typeof Message.Type
const fold = Dialog.fold<Model, Message, never>({
  read: model => Option.some(model.dialog),
  write: (model, dialog) => ({ ...model, dialog }),
  toParentMessage: message => Message.DialogEvent({ message }),
  foldOutMessage: () => model => ({ model }),
})
export function dialogEntry(host: HTMLElement) {
  return makeElement({
    container: host,
    Model,
    init: () => ({ model: { dialog: Dialog.init({ id: 'docs-dialog' }) } }),
    update: (model: Model, message: Message) => Message.match(message, {
      OpenDialog: () => fold(model, Dialog.Message.RequestedOpen()),
      DialogEvent: ({ message: child }) => fold(model, child),
    }),
    view: (model: Model, h: HtmlBuilder<Message>) => h.div([], [
      h.button([h.Type('button'), h.Class('demo-control'), h.OnClick(Message.OpenDialog()), h.DataAttribute('testid', 'dialog-open')], ['Open dialog']),
      Dialog.embed(h, {
        slotId: 'docs-dialog', model: model.dialog,
        toParentMessage: message => Message.DialogEvent({ message }),
        title: 'A dialog that returns focus', description: 'This dialog can be closed with Escape.',
        content: builder => [builder.p([], ['The dialog is managed by a Foldkit Dialog model. Press Escape to close it and return to the trigger.'])],
      }),
    ]),
  })
}
