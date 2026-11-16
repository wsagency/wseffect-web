import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractTypescriptExamples } from './snippets.ts'

test('TypeScript fences require one explicit classification', () => {
  const input = `Context for this runnable example.\n\n\`\`\`ts compile\nconst count: number = 1\n\`\`\`\n\nThis fragment depends on an enclosing Model.\n\n\`\`\`ts fragment\nupdate(model, message)\n\`\`\``
  const examples = extractTypescriptExamples('guide.mdx', input)
  assert.deepEqual(examples.map(({ classification }) => classification), ['compile', 'fragment'])
  assert.match(examples[1].reason, /This fragment depends on an enclosing Model/)
})

test('unclassified TypeScript fences fail instead of silently skipping compilation', () => {
  assert.throws(() => extractTypescriptExamples('guide.mdx', '\`\`\`ts\nconst value = 1\n\`\`\`'), /explicitly classified/)
})

test('fragment classification requires surrounding prose', () => {
  assert.throws(() => extractTypescriptExamples('guide.mdx', '\`\`\`ts fragment\nconst value = 1\n\`\`\`'), /explanatory prose/)
})
