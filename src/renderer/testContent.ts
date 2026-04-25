// Hardcoded sample exercising headings, bold, code blocks, links, and lists
// so we can eyeball Monaco's Markdown highlighting until real file I/O lands.
export const TEST_MARKDOWN = `# rAIse Editor

A sample document for verifying **Markdown syntax highlighting** in the
Monaco source view.

## Inline formatting

This paragraph mixes **bold**, *italic*, and \`inline code\` with a
[link to Rise](https://www.risepeople.com).

## Lists

Unordered:

- First item
- Second item
  - Nested item
- Third item

Ordered:

1. Step one
2. Step two
3. Step three

## Code block

\`\`\`typescript
function greet(name: string): string {
  return \`Hello, \${name}!\`;
}

console.log(greet('rAIse'));
\`\`\`

## Blockquote

> "The best way to predict the future is to invent it." — Alan Kay

---

Happy editing!
`;
