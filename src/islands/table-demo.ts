import { Schema } from 'effect'
import { Command, Submodel } from '@wsagency/wseffect-foldkit'
import { defineMessageUnion } from '@wsagency/wseffect-foldkit/message'
import { makeElement } from '@wsagency/wseffect-foldkit/runtime'
import { inertHtml, type HtmlBuilder } from '@wsagency/wseffect-foldkit/html'
import * as DataTable from '@wsagency/wseffect-themes/components/data-table'

const RowSchema = Schema.Struct({ id: Schema.String, name: Schema.String, status: Schema.Literals(['Active', 'Pending']) })
type Row = typeof RowSchema.Type
const rows: ReadonlyArray<Row> = [
  { id: 'row-1', name: 'Northstar', status: 'Active' },
  { id: 'row-2', name: 'Fieldnotes', status: 'Pending' },
  { id: 'row-3', name: 'Waypoint', status: 'Active' },
]
const columns: ReadonlyArray<DataTable.Column<Row>> = [
  { id: 'name', header: inertHtml.span([], ['Name']), accessor: row => row.name, isSortable: true, searchText: row => row.name },
  { id: 'status', header: inertHtml.span([], ['Status']), accessor: row => row.status, isSortable: true, searchText: row => row.status },
]
const config = (selectedRowIds: ReadonlyArray<string>): DataTable.Config<Row> => ({
  id: 'docs-data-table', rows, getRowId: row => row.id, columns,
  caption: inertHtml.span([], ['Demo project records']), selectedRowIds: new Set(selectedRowIds),
  isGrid: true, rowHeight: 40, viewportHeight: 220, overscanRows: 3,
})
type TableViewInputs = { selectedRowIds: ReadonlyArray<string> }
const tableView = Submodel.defineView<DataTable.Model, DataTable.Message, TableViewInputs>(
  (model, inputs, h) => DataTable.view(model, config(inputs.selectedRowIds), h),
)
const Model = Schema.Struct({ table: DataTable.Model, selectedRowIds: Schema.Array(Schema.String) })
const Message = defineMessageUnion({ TableEvent: { message: DataTable.Message } })
type Model = typeof Model.Type
type Message = typeof Message.Type
export function tableEntry(host: HTMLElement) {
  return makeElement({
    container: host,
    Model,
    init: () => ({ model: { table: DataTable.init(config([])), selectedRowIds: [] } }),
    update: (model: Model, message: Message) => Message.match(message, {
      TableEvent: ({ message: child }) => {
        const result = DataTable.update(model.table, config(model.selectedRowIds), child)
        const selectedRowIds = result.outMessage?._tag === 'SelectionChanged' ? result.outMessage.ids : model.selectedRowIds
        return {
          model: { table: result.model, selectedRowIds },
          commands: result.commands?.map(command => Command.mapMessage(command, message => Message.TableEvent({ message }))) ?? [],
        }
      },
    }),
    view: (model: Model, h: HtmlBuilder<Message>) => h.div([h.DataAttribute('testid', 'records-table')], [
      h.label([], [
        'Filter rows',
        h.input([
          h.Type('search'), h.AriaLabel('Filter rows'), h.Value(model.table.filter),
          h.OnInput(value => Message.TableEvent({ message: DataTable.Message.FilterChanged({ value }) })),
        ]),
      ]),
      h.output([], [`${model.table.orderedRowIds.length} rows shown`]),
      h.p([h.AriaLive('polite')], [`${model.selectedRowIds.length} rows selected`]),
      h.submodel({
        slotId: 'docs-data-table',
        model: model.table,
        view: tableView,
        viewInputs: { selectedRowIds: model.selectedRowIds },
        toParentMessage: childMessage => Message.TableEvent({ message: childMessage }),
      }),
    ]),
  })
}
