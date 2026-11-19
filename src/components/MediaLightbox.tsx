import type { ReactNode, RefObject } from 'react'
import { X } from 'lucide-react'
import '../styles/media-lightbox.css'

/**
 * 看大图浮层（r262）：快捷创作与作品流共用同一个。
 *
 * 为什么抽出来：同一件事（点开看大图）之前有两套实现——快捷创作那套按视口缩放、
 * 作品流那套固定 max-width 880px 且没有卡片底，图一放大就和背后的卡片文字叠在一起。
 * 「看大图」在全产品只该有一种样子：整页压暗、卡片跟着图收窄、图按视口高度缩放、
 * Esc 或点空白关、底部一行说明与动作。
 */
export default function MediaLightbox({
  kind,
  src,
  alt = '',
  head = null,
  note = null,
  caption = null,
  actions = null,
  onClose,
  closeRef,
  videoAutoPlay = true,
}: {
  kind: 'image' | 'video'
  src: string
  alt?: string
  /** 卡片顶部左边那行：这条是什么、多大 */
  head?: ReactNode
  /** 卡片顶部右边的小字：来源、模型名之类 */
  note?: ReactNode
  /** 图下面那段文字：提示词或标题，最多三行 */
  caption?: ReactNode
  actions?: ReactNode
  onClose: () => void
  closeRef?: RefObject<HTMLButtonElement | null>
  /** 视频点开就播（静音自动播，浏览器才不拦）；用户要声音自己按喇叭 */
  videoAutoPlay?: boolean
}) {
  return (
    <div
      className="vq-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={kind === 'image' ? '查看大图' : '查看视频'}
      onClick={onClose}
    >
      <figure className="vq-lightbox-card" onClick={(event) => event.stopPropagation()}>
        <div className="vq-lightbox-head">
          <span>{head}</span>
          {note ? <span className="vq-lightbox-note">{note}</span> : null}
          <button
            ref={closeRef}
            type="button"
            className="vq-lightbox-close"
            onClick={onClose}
            aria-label="关闭"
            title="关闭（Esc）"
          >
            <X size={16} />
          </button>
        </div>
        <div className={'vq-lightbox-stage' + (kind === 'image' ? '' : ' is-video')}>
          {kind === 'image' ? (
            <img src={src} alt={alt} />
          ) : (
            <video src={src} controls playsInline preload="metadata" autoPlay={videoAutoPlay} muted={videoAutoPlay} />
          )}
        </div>
        {caption || actions ? (
          <figcaption className="vq-lightbox-caption">
            {caption ? <p>{caption}</p> : null}
            {actions ? <div className="vq-lightbox-actions">{actions}</div> : null}
          </figcaption>
        ) : null}
      </figure>
    </div>
  )
}
