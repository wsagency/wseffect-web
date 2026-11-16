import { parseHTML } from 'linkedom'
import TurndownService from 'turndown'

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim()
}

function tableMarkdown(table: Element, turndown: TurndownService): string {
  const rows = [...table.querySelectorAll('tr')].map((row) => [...row.querySelectorAll(':scope > th, :scope > td')])
  if (!rows.length) return ''
  const headerIndex = rows.findIndex((row) => row.some((cell) => cell.tagName === 'TH'))
  if (headerIndex < 0) return rows.map((row) => row.map((cell) => escapeCell(turndown.turndown(cell.innerHTML))).join(' | ')).join('\n')
  const header = rows[headerIndex].map((cell) => escapeCell(turndown.turndown(cell.innerHTML)))
  const body = rows.filter((_, index) => index !== headerIndex).map((row) => header.map((_, index) => escapeCell(turndown.turndown(row[index]?.innerHTML ?? ''))))
  return [header.join(' | '), header.map(() => '---').join(' | '), ...body.map((row) => row.join(' | '))].join('\n')
}

export function htmlToMarkdown(html: string): string {
  const { document } = parseHTML(html)
  const main = document.querySelector('main#main-content') ?? document.body
  for (const element of main.querySelectorAll('script, style, noscript, nav, header, footer, aside, form, button, [aria-hidden="true"]')) element.remove()
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
