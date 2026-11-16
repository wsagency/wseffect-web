import { Option, Schema } from 'effect'
import { Submodel } from '@wsagency/wseffect-foldkit'
import { defineMessageUnion } from '@wsagency/wseffect-foldkit/message'
import type { HtmlBuilder } from '@wsagency/wseffect-foldkit/html'
import * as Button from '@wsagency/wseffect-themes/components/button'
import * as Dialog from '@wsagency/wseffect-themes/components/dialog'
import * as Heading from '@wsagency/wseffect-themes/components/heading'
import * as Select from '@wsagency/wseffect-themes/components/select'
import * as Text from '@wsagency/wseffect-themes/components/text'
import * as TextField from '@wsagency/wseffect-themes/components/text-field'
import { pageContract } from '@wsagency/wseffect-app'

const Picker = Select.create<string>()
const homePage = pageContract<Record<string, never>, never>({ OutMessage: Schema.Never })

export const Model = Schema.Struct({
  name: Schema.String,
  selected: Schema.Option(Schema.String),
  select: Picker.Model,
  dialog: Dialog.Model,
})
export const Message = defineMessageUnion({
  NameChanged: { value: Schema.String },
  OpenDialog: {},
  SelectEvent: { message: Picker.Message },
  DialogEvent: { message: Dialog.Message },
})
type Model = typeof Model.Type
type Message = typeof Message.Type

const foldSelect = Picker.fold<Model, Message, never>({
  read: (model) => Option.some(model.select),
  write: (model, select) => ({ ...model, select }),
  toParentMessage: (message) => Message.SelectEvent({ message }),
  foldOutMessage: (outMessage) => (model) => ({ model: { ...model, selected: Option.some(outMessage.value) } }),
})
const foldDialog = Dialog.fold<Model, Message, never>({
  read: (model) => Option.some(model.dialog),
  write: (model, dialog) => ({ ...model, dialog }),
  toParentMessage: (message) => Message.DialogEvent({ message }),
  foldOutMessage: () => (model) => ({ model }),
})
const options = [
  { value: 'indigo', label: 'Indigo' },
  { value: 'blue', label: 'Blue' },
]
const selectConfig = (selectedValue: Option.Option<string>, h: HtmlBuilder<Message>) => ({
  id: 'starter-color-select',
  selectedValue,
  items: options.map(({ value, label }) => ({
    value,
    textValue: label,
    isDisabled: false,
    content: h.span([], [label]),
  })),
  position: 'popper' as const,
  isModal: false as const,
  props: { variant: 'surface' as const, placeholder: 'Choose a color' },
})

export const page = homePage.definePage({
  Model,
  Message,
  init: () => ({
    model: {
      name: '',
      selected: Option.none(),
      select: Picker.init({
        id: 'starter-color-select',
        selectedValue: Option.some('indigo'),
        items: [],
        position: 'popper',
        isModal: false,
        props: { variant: 'surface', placeholder: 'Choose a color' },
      }),
      dialog: Dialog.init({ id: 'starter-dialog' }),
    },
  }),
  update: (model: Model, message: Message) => Message.match(message, {
    NameChanged: ({ value }) => ({ model: { ...model, name: value } }),
    OpenDialog: () => foldDialog(model, Dialog.Message.RequestedOpen()),
    SelectEvent: ({ message: child }) => foldSelect(model, child),
    DialogEvent: ({ message: child }) => foldDialog(model, child),
  }),
  view: Submodel.defineView<Model, Message, Record<string, never>>((model, _inputs, h) => {
    const selectedLabel = Option.getOrElse(model.selected, () => 'No color selected')
    return h.div([h.Class('starter-page')], [
      Heading.view({ as: 'h2', size: '6' }, ['Build your first wseffect app'], h),
      Text.view({ as: 'p', size: '3' }, ['A lazy-loaded page with live, model-driven Themes controls.'], h),
      TextField.view({
        id: 'name-field',
        label: 'Your name',
        type: 'text',
        value: model.name,
        placeholder: 'Type your name',
        onInput: (value) => Message.NameChanged({ value }),
      }, [], h),
      h.p([h.Id('greeting')], [model.name ? `Hello, ${model.name}!` : 'Your greeting will appear here.']),
      h.section([], [
        Heading.view({ as: 'h3', size: '3' }, ['Favorite color'], h),
        h.p([h.Id('selected-color')], [selectedLabel]),
        Picker.embed(h, {
          slotId: 'starter-select',
          model: model.select,
          toParentMessage: (message) => Message.SelectEvent({ message }),
          viewInputs: selectConfig(model.selected, h),
        }),
      ]),
      Button.view({ onClick: Message.OpenDialog() }, ['Open dialog'], h),
      Dialog.embed(h, {
        slotId: 'starter-dialog',
        model: model.dialog,
        toParentMessage: (message) => Message.DialogEvent({ message }),
        title: 'Hello from a Dialog',
        description: 'This dialog is controlled by the page Model and Message union.',
        content: (builder) => [builder.p([], ['Close with Escape or the close control.'])],
      }),
    ])
  }),
})
