import { parseHTML } from 'linkedom'
import TurndownService from 'turndown'

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim()
}

function tableRow(cells: string[]): string {
  return `| ${cells.join(' | ')} |`
}

function tableMarkdown(table: Element, turndown: TurndownService): string {
  const rows: Element[][] = []
  const rowCollection = table.getElementsByTagName('tr')
  for (let rowIndex = 0; rowIndex < rowCollection.length; rowIndex++) {
    const row = rowCollection[rowIndex]
    let parent = row.parentElement
    while (parent && parent.nodeName !== 'TABLE') parent = parent.parentElement
    if (parent !== table) continue
    const cells: Element[] = []
    for (let childIndex = 0; childIndex < row.childNodes.length; childIndex++) {
      const child = row.childNodes[childIndex]
      if (child?.nodeType === 1 && (child.nodeName === 'TH' || child.nodeName === 'TD')) cells.push(child as Element)
    }
    rows.push(cells)
  }
  if (!rows.length) return ''
  const headerIndex = rows.findIndex((row) => row.some((cell) => cell.tagName === 'TH'))
  if (headerIndex < 0) return rows.map((row) => tableRow(row.map((cell) => escapeCell(turndown.turndown(cell.innerHTML))))).join('\n')
  const header = rows[headerIndex].map((cell) => escapeCell(turndown.turndown(cell.innerHTML)))
  const body = rows.filter((_, index) => index !== headerIndex).map((row) => header.map((_, index) => escapeCell(turndown.turndown(row[index]?.innerHTML ?? ''))))
  const divider = header.map(() => '---')
  return [tableRow(header), tableRow(divider), ...body.map(tableRow)].join('\n')
}

export function htmlToMarkdown(html: string): string {
  const { document } = parseHTML(html)
  const main = document.querySelector('main#main-content') ?? document.body
  for (const element of main.querySelectorAll('script, style, header, footer, aside, form, [aria-hidden="true"]')) element.remove()
  for (const button of main.querySelectorAll('button')) {
    if (!button.closest('table')) button.remove()
  }
  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', emDelimiter: '*' })
  turndown.addRule('languageCodeBlock', {
    filter: (node) => node.nodeName === 'PRE',
    replacement: (_content, node) => {
      const pre = node as HTMLElement
      const code = pre.querySelector('code')
      const languageClass = `${pre.className} ${code?.className ?? ''}`.match(/(?:language|lang)-([\w+-]+)/)?.[1]
      const language = pre.getAttribute('data-language') ?? code?.getAttribute('data-language') ?? languageClass ?? ''
      const text = (code?.textContent ?? pre.textContent ?? '').replace(/\n+$/, '')
      return `\n\n\`\`\`${language}\n${text}\n\`\`\`\n\n`
    },
  })
  turndown.addRule('semanticTables', {
    filter: (node) => node.nodeName === 'TABLE',
    replacement: (_content, node) => `\n\n${tableMarkdown(node as Element, turndown)}\n\n`,
  })
  return turndown.turndown(main.innerHTML).replace(/\n{3,}/g, '\n\n').trim() + '\n'
}
