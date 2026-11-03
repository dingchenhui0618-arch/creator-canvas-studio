// VisionQA 品牌标记：来自 D:\Projects\VisionQA\web\public\brand\visionqa-mark.svg（C3: VQ 字母 + 局部检视框）
type Props = { size?: number; className?: string; title?: string }

export function VisionQaMark({ size = 24, className, title = 'VisionQA' }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 256 256"
      role="img"
      aria-label={title}
      className={className}
      fill="none"
    >
      <path d="M38 78V38h40v16H54v24Z" fill="currentColor" />
      <path d="M178 178h24v-24h16v40h-40Z" fill="currentColor" />
      <circle cx="136" cy="116" r="49" stroke="currentColor" strokeOpacity="0.45" strokeWidth="20" />
      <path d="M48 82h27l37 59 37-59h27l-52 90h-24Z" fill="currentColor" />
      <path d="M151 149l39 39-15 15-39-39Z" fill="currentColor" />
    </svg>
  )
}

export function VisionQaLockup({ className }: { className?: string }) {
  return (
    <span className={className ? 'vq-lockup ' + className : 'vq-lockup'}>
      <VisionQaMark size={22} />
      <span className="vq-lockup-text">
        <strong>VisionQA</strong>
        <small>Workbench</small>
      </span>
    </span>
  )
}
