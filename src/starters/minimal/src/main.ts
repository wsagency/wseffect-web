import '@wsagency/wseffect-themes/styles.css'
import './styles.css'
import { Schema } from 'effect'
import type { HtmlBuilder } from '@wsagency/wseffect-foldkit/html'
import { makeElement, run } from '@wsagency/wseffect-foldkit/runtime'
import * as Theme from '@wsagency/wseffect-themes/components/theme'
import * as Heading from '@wsagency/wseffect-themes/components/heading'
import * as Button from '@wsagency/wseffect-themes/components/button'
import * as Text from '@wsagency/wseffect-themes/components/text'

const Model = Schema.Struct({ count: Schema.Number })
type Model = typeof Model.Type
const Message = {
  Increment: { _tag: 'Increment' as const },
  Decrement: { _tag: 'Decrement' as const },
  Reset: { _tag: 'Reset' as const },
}
type Message = typeof Message[keyof typeof Message]

const app = makeElement<Model, Message>({
  Model,
  init: () => ({ model: { count: 0 } }),
  update: (model, message) => ({
    model: {
      count: message._tag === 'Increment' ? model.count + 1
        : message._tag === 'Decrement' ? model.count - 1
          : 0,
    },
  }),
  view: (model: Model, h: HtmlBuilder<Message>) => Theme.view(
    { settings: Theme.defaults, isRoot: true },
    [
      h.main([h.Class('counter')], [
        Heading.view({ as: 'h1', size: '6' }, ['A Foldkit counter'], h),
        Text.view({ as: 'p', size: '3' }, ['The displayed value is application state updated by Foldkit.'], h),
        h.output([h.Id('count'), h.Class('count')], [String(model.count)]),
        h.div([h.Class('actions')], [
          Button.view({ onClick: Message.Decrement }, ['−'], h),
          Button.view({ onClick: Message.Increment }, ['+'], h),
          Button.view({ onClick: Message.Reset }, ['Reset'], h),
        ]),
      ]),
    ],
    h,
  ),
  container: document.getElementById('app'),
})

run(app)
