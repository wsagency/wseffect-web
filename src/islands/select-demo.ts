import { Option, Schema } from 'effect'
import { defineMessageUnion } from '@wsagency/wseffect-foldkit/message'
import { makeElement } from '@wsagency/wseffect-foldkit/runtime'
import { inertHtml, type HtmlBuilder } from '@wsagency/wseffect-foldkit/html'
import * as Select from '@wsagency/wseffect-themes/components/select'

const Picker = Select.create<string>()
const Model = Schema.Struct({ picker: Picker.Model, selectedValue: Schema.Option(Schema.String) })
const Message = defineMessageUnion({ SelectEvent: { message: Picker.Message } })
type Model = typeof Model.Type
type Message = typeof Message.Type

const entries = [
  { value: 'blue', label: 'Blue' },
  { value: 'jade', label: 'Jade' },
  { value: 'amber', label: 'Amber' },
]
const config = <M>(selectedValue: Option.Option<string>, h: HtmlBuilder<M>) => ({
  id: 'docs-color-select', selectedValue,
  items: entries.map(({ value, label }) => ({ value, textValue: label, isDisabled: false, content: h.span([], [label]) })),
  position: 'popper' as const, isModal: false as const,
  props: { variant: 'surface' as const, placeholder: 'Choose a color' },
})
const fold = Picker.fold<Model, Message, never>({
  read: model => Option.some(model.picker),
  write: (model, picker) => ({ ...model, picker }),
  toParentMessage: message => Message.SelectEvent({ message }),
  foldOutMessage: outMessage => model => ({ model: { ...model, selectedValue: Option.some(outMessage.value) } }),
})

export function selectEntry(host: HTMLElement) {
  return makeElement({
    container: host,
    Model,
    init: () => ({ model: { picker: Picker.init(config(Option.some('blue'), inertHtml)), selectedValue: Option.some('blue') } }),
    update: (model: Model, message: Message) => Message.match(message, {
      SelectEvent: ({ message: child }) => fold(model, child),
    }),
    view: (model: Model, h: HtmlBuilder<Message>) => h.div([], [
      Picker.embed(h, {
        slotId: 'docs-color-select', model: model.picker,
        toParentMessage: message => Message.SelectEvent({ message }),
        viewInputs: config(model.selectedValue, h),
      }),
      h.p([h.AriaLive('polite'), h.DataAttribute('selected-value', Option.getOrElse(model.selectedValue, () => ''))], [
        `Selected color: ${Option.getOrElse(model.selectedValue, () => 'none')}`,
      ]),
    ]),
  })
}
