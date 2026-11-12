// 快速跳转（Ctrl / ⌘ + K）。
// 导航从 7 项收敛成 4 项 + 工具区之后，键盘跳转是「工具不在一级也够快」的前提：
// 命令清单直接复用 src/nav.ts 的导航真源，不另抄一份，改导航这里跟着变。
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CornerDownLeft, Search } from 'lucide-react'
import { matchCommands, type PaletteCommand } from '../domain/commands'
import '../styles/command-palette.css'

export function CommandPalette({ commands, onClose }: { commands: PaletteCommand[]; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const restoreRef = useRef<Element | null>(null)

  const results = useMemo(() => matchCommands(commands, query), [commands, query])

  // 分组标题只在「这一组的第一行」出现；逐行和上一行比，渲染时不改任何变量。
  const rows = useMemo(
    () =>
      results.map((command, index) => ({
        command,
        heading: index > 0 && results[index - 1].group === command.group ? '' : command.group,
      })),
    [results],
  )

  // 打开时把焦点收进输入框、锁住背景滚动；关闭时把焦点还给打开它的控件。
  useEffect(() => {
    restoreRef.current = document.activeElement
    inputRef.current?.focus()
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
      if (restoreRef.current instanceof HTMLElement && restoreRef.current.isConnected) restoreRef.current.focus()
    }
  }, [])

  // 键盘选到看不见的项时，列表自己滚到那一行。
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-cursor="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const runAt = useCallback(
    (index: number) => {
      const command = results[index]
      if (!command) return
      onClose()
      command.run()
    },
    [results, onClose],
  )

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setCursor((value) => (results.length ? (value + 1) % results.length : 0))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setCursor((value) => (results.length ? (value - 1 + results.length) % results.length : 0))
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      runAt(cursor)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }

  return (
    <div className="cp-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="cp-panel"
        role="dialog"
        aria-modal="true"
        aria-label="快速跳转"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="cp-field">
          <Search size={16} aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              // 换了关键词，选中的那一行回到第一条：光标不会停在一个已经不在列表里的位置
              setCursor(0)
            }}
            onKeyDown={onKeyDown}
            placeholder="跳到哪？输入页面或动作名"
            aria-label="快速跳转"
            aria-controls="cp-list"
            aria-activedescendant={results[cursor] ? 'cp-' + results[cursor].id : undefined}
            role="combobox"
            aria-expanded="true"
            autoComplete="off"
            spellCheck={false}
          />
          <kbd>Esc</kbd>
        </div>

        <div className="cp-list" id="cp-list" role="listbox" aria-label="跳转目标" ref={listRef}>
          {results.length === 0 ? (
            <p className="cp-empty">没有匹配的页面或动作。试试「作品」「画布」「新建」。</p>
          ) : null}
          {rows.map(({ command, heading }, index) => {
            const Icon = command.icon
            return (
              <Fragment key={command.id}>
                {heading ? (
                  <div className="cp-group-label" role="presentation">
                    {heading}
                  </div>
                ) : null}
                <button
                  type="button"
                  id={'cp-' + command.id}
                  role="option"
                  aria-selected={index === cursor}
                  data-cursor={index === cursor}
                  className={'cp-item' + (index === cursor ? ' is-active' : '')}
                  onMouseMove={() => setCursor(index)}
                  onClick={() => runAt(index)}
                >
                  <Icon size={15} strokeWidth={1.5} aria-hidden="true" />
                  <span className="cp-item-copy">
                    <strong>{command.label}</strong>
                    {command.hint ? <small>{command.hint}</small> : null}
                  </span>
                  {index === cursor ? <CornerDownLeft size={13} className="cp-item-enter" aria-hidden="true" /> : null}
                </button>
              </Fragment>
            )
          })}
        </div>

        <footer className="cp-foot">
          <span>↑↓ 选择 · Enter 打开 · Esc 关闭</span>
          <span className="cp-foot-key">Ctrl / ⌘ + K</span>
        </footer>
      </div>
    </div>
  )
}
