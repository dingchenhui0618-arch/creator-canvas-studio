// Markdown 渲染（r220）：解析在 markdown.ts，这里只把数据画成 React 节点。
// 快捷创作与自建智能体共用同一套，避免「一个地方支持表格、另一个地方原样吐出 ** 星号」。
import type { ReactNode } from 'react'
import { parseInline, parseMarkdown } from './markdown-parse'

export function renderInline(text: string, keyBase: string): ReactNode[] {
  return parseInline(text).map((token, index) => {
    const key = keyBase + '-' + index
    if (token.kind === 'strong') return <strong key={key}>{token.text}</strong>
    if (token.kind === 'code') return <code key={key}>{token.text}</code>
    if (token.kind === 'link') {
      return (
        <a key={key} href={token.href} target="_blank" rel="noreferrer noopener">
          {token.text}
        </a>
      )
    }
    return token.text
  })
}

export function renderMarkdown(source: string): ReactNode[] {
  const blocks = parseMarkdown(source)
  const nodes: ReactNode[] = []
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    if (block.kind === 'code') {
      nodes.push(
        <pre className="agx-md-code" key={'code-' + index}>
          <code>{block.text}</code>
        </pre>,
      )
      continue
    }
    if (block.kind === 'table') {
      nodes.push(
        <div className="agx-md-table" key={'table-' + index}>
          <table>
            <thead>
              <tr>
                {block.header.map((cell, cellIndex) => (
                  <th key={cellIndex}>{renderInline(cell, 'th-' + index + '-' + cellIndex)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    // data-label 只在手机（≤560）用得上：表格在那里改成一格一行的卡片，
                    // 每格前面得重新写上它属于哪一列，否则「16-21s」孤零零一行看不出是什么（r224）
                    <td key={cellIndex} data-label={block.header[cellIndex] || ''}>
                      {renderInline(cell, 'td-' + index + '-' + rowIndex + '-' + cellIndex)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      )
      continue
    }
    if (block.kind === 'heading') {
      const Tag = block.level <= 2 ? 'h3' : 'h4'
      nodes.push(
        <Tag className="agx-md-heading" key={'h-' + index}>
          {renderInline(block.text, 'h-' + index)}
        </Tag>,
      )
      continue
    }
    if (block.kind === 'rule') {
      nodes.push(<hr className="agx-md-rule" key={'hr-' + index} />)
      continue
    }
    if (block.kind === 'quote') {
      nodes.push(
        <blockquote className="agx-md-quote" key={'q-' + index}>
          {block.lines.map((line, lineIndex) => (
            <p key={lineIndex}>
              {renderInline(line, 'q-' + index + '-' + lineIndex)}
              {lineIndex < block.lines.length - 1 ? <br /> : null}
            </p>
          ))}
        </blockquote>,
      )
      continue
    }
    if (block.kind === 'list') {
      const items = block.items.map((item, itemIndex) => (
        <li key={itemIndex}>{renderInline(item, 'li-' + index + '-' + itemIndex)}</li>
      ))
      nodes.push(
        block.ordered ? (
          <ol className="agx-md-list" key={'ol-' + index}>
            {items}
          </ol>
        ) : (
          <ul className="agx-md-list" key={'ul-' + index}>
            {items}
          </ul>
        ),
      )
      continue
    }
    nodes.push(
      <p key={'p-' + index}>
        {block.lines.map((line, lineIndex) => (
          <span key={lineIndex}>
            {renderInline(line, 'p-' + index + '-' + lineIndex)}
            {lineIndex < block.lines.length - 1 ? <br /> : null}
          </span>
        ))}
      </p>,
    )
  }
  return nodes
}
