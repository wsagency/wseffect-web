import { Option, Schema } from 'effect'
import { defineMessageUnion } from '@wsagency/wseffect-foldkit/message'
import { makeElement } from '@wsagency/wseffect-foldkit/runtime'
import type { HtmlBuilder } from '@wsagency/wseffect-foldkit/html'
import * as Tabs from '@wsagency/wseffect-themes/components/tabs'

const TabSet = Tabs.create<'Overview' | 'Details' | 'Usage'>()
const Model = Schema.Struct({ tabs: TabSet.Model, selected: Schema.Literals(['Overview', 'Details', 'Usage']) })
const Message = defineMessageUnion({ TabsEvent: { message: TabSet.Message } })
type Model = typeof Model.Type
type Message = typeof Message.Type
const fold = TabSet.fold<Model, Message, never>({
  read: model => Option.some(model.tabs),
  write: (model, tabs) => ({ ...model, tabs }),
  toParentMessage: message => Message.TabsEvent({ message }),
  foldOutMessage: outMessage => model => ({ model: { ...model, selected: outMessage.value } }),
})
export function tabsEntry(host: HTMLElement) {
  return makeElement({
    container: host,
    Model,
    init: () => ({ model: { tabs: TabSet.init({ id: 'docs-tabs' }), selected: 'Overview' as const } }),
    update: (model: Model, message: Message) => Message.match(message, {
      TabsEvent: ({ message: child }) => fold(model, child),
    }),
    view: (model: Model, h: HtmlBuilder<Message>) => TabSet.embed(h, {
      slotId: 'docs-tabs', model: model.tabs,
      toParentMessage: message => Message.TabsEvent({ message }),
      viewInputs: {
        tabs: ['Overview', 'Details', 'Usage'], selectedValue: model.selected,
        ariaLabel: 'Demo content sections',
        tabToLabel: value => h.span([], [value]),
        tabToPanel: value => [h.p([], [
          value === 'Overview' ? 'The overview panel is selected.' : value === 'Details' ? 'The details panel is selected.' : 'The usage panel is selected.',
        ])],
      },
    }),
  })
}
