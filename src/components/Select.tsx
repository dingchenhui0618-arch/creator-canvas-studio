import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Check, ChevronDown } from 'lucide-react'

export type SelectOption = { value: string; label: string }

/**
 * 统一的下拉选择：自绘面板 + 圆角触发框。
 * 不用原生 <select> 的两个原因：展开时是操作系统弹窗（蓝色高亮、字重字号都不受控），
 * 聚焦时浏览器会画一圈直角黑框，和全站 10px 圆角 + 发丝线冲突。
 */
export function Select({
  value,
  options,
  onChange,
  label,
  size = 'md',
  disabled,
  className,
}: {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  /** 无障碍名称，也用于触发器未命中选项时的占位 */
  label: string
  size?: 'sm' | 'md'
  disabled?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)
  const listId = useId()

  const selectedIndex = options.findIndex((option) => option.value === value)
  const current = selectedIndex >= 0 ? options[selectedIndex] : undefined

  // 打开时从当前值开始（在事件里设，不放 effect：effect 里同步 setState 会多渲染一轮）
  const openPanel = () => {
    setActive(selectedIndex >= 0 ? selectedIndex : 0)
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  // 键盘移动时把高亮项滚进可视区，长列表（流程名）不会跑出去
  useEffect(() => {
    if (!open) return
    const node = listRef.current?.querySelector<HTMLElement>('[data-index="' + active + '"]')
    node?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  const commit = (index: number) => {
    const next = options[index]
    if (next && next.value !== value) onChange(next.value)
    setOpen(false)
    triggerRef.current?.focus()
  }

  const onTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) {
        openPanel()
        return
      }
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive((index) => (index + step + options.length) % options.length)
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (open) commit(active)
      else openPanel()
      return
    }
    if (event.key === 'Tab') setOpen(false)
  }

  return (
    <div
      ref={rootRef}
      className={'vq-select' + (size === 'sm' ? ' vq-select--sm' : '') + (open ? ' is-open' : '') + (className ? ' ' + className : '')}
    >
      <button
        ref={triggerRef}
        type="button"
        className="vq-select__trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={label}
        onClick={() => (open ? setOpen(false) : openPanel())}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="vq-select__value">{current?.label ?? label}</span>
        <ChevronDown size={14} strokeWidth={1.75} className="vq-select__chevron" />
      </button>
      {open ? (
        <ul className="vq-select__panel" role="listbox" id={listId} ref={listRef} aria-label={label}>
          {options.map((option, index) => (
            <li
              key={option.value}
              data-index={index}
              role="option"
              aria-selected={option.value === value}
              className={'vq-select__option' + (index === active ? ' is-active' : '')}
              onMouseEnter={() => setActive(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => commit(index)}
            >
              <span>{option.label}</span>
              {option.value === value ? <Check size={14} strokeWidth={2} /> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
