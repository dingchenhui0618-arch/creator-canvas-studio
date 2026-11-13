// 帮助中心（v0.9.61）：不登录也能看的自助说明。
// 三篇内容在 src/domain/help.ts，这里只管排版：左目录、右正文，窄屏时目录折成一排。
// 页面底部与侧栏都给「提交反馈」：这里读不到答案的人，下一步应该是找到人，而不是关掉页面。
import { useEffect, useState } from 'react'
import { ArrowLeft, ArrowRight, BookOpen, MessageSquare } from 'lucide-react'
import { navigate } from '../router'
import { useSiteInfo } from '../api/app'
import { FeedbackModal } from '../components/FeedbackModal'
import { HELP_ARTICLES, findHelpArticle, relatedArticles, type HelpArticle } from '../domain/help'
import '../styles/shell.css'

export function HelpPage({ slug }: { slug: string | null }) {
  const article = findHelpArticle(slug)
  const site = useSiteInfo()
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const page = article ? '#/help/' + article.slug : '#/help'

  // 从目录点进单篇时回到页首：否则停在半页会以为内容没换。
  useEffect(() => {
    window.scrollTo({ top: 0 })
  }, [article?.slug])

  return (
    <main className="vq-help">
      <div className="vq-help-inner">
        <aside className="vq-help-side">
          <button
            type="button"
            className="vq-help-back"
            onClick={() => navigate({ kind: 'page', page: 'overview' })}
          >
            <ArrowLeft size={13} />
            返回 VisionQA
          </button>
          <p className="vq-help-side-title">帮助 / Help</p>
          <nav className="vq-help-nav" aria-label="帮助目录">
            {HELP_ARTICLES.map((item) => {
              const active = article?.slug === item.slug
              return (
                <a
                  key={item.slug}
                  className={'vq-help-nav-item' + (active ? ' is-active' : '')}
                  href={'#/help/' + item.slug}
                  aria-current={active ? 'page' : undefined}
                >
                  <strong>{item.title}</strong>
                  <span>{item.kicker}</span>
                </a>
              )
            })}
          </nav>
          <button type="button" className="vq-help-side-cta" onClick={() => setFeedbackOpen(true)}>
            <MessageSquare size={13} />
            没解决，提一条反馈
          </button>
        </aside>

        <div className="vq-help-main">
          <article className="vq-help-card">
            {article ? (
              <ArticleBody article={article} onFeedback={() => setFeedbackOpen(true)} />
            ) : (
              <HelpIndex onFeedback={() => setFeedbackOpen(true)} />
            )}
            <footer className="vq-help-foot">
              <a className="vq-link" href="#/help">
                帮助
              </a>
              <a className="vq-link" href="#/legal/terms">
                服务条款
              </a>
              <a className="vq-link" href="#/legal/privacy">
                隐私说明
              </a>
              <span>{site.supportEmail ? '联系：' + site.supportEmail : '联系：工作区管理员'}</span>
              <span className="vq-mono">VisionQA</span>
            </footer>
          </article>
        </div>
      </div>

      {feedbackOpen ? <FeedbackModal onClose={() => setFeedbackOpen(false)} page={page} /> : null}
    </main>
  )
}

function HelpIndex({ onFeedback }: { onFeedback: () => void }) {
  return (
    <>
      <span className="vq-help-kicker vq-mono">自助 / Self-serve</span>
      <h1>先在这里找答案</h1>
      <p className="vq-help-meta">三篇说明，覆盖被问得最多的三类问题</p>
      <p className="vq-help-lead">
        没有客服邮箱之前，这三篇是回答「积分怎么算、为什么失败、素材能不能用」的地方。读完仍然卡住，就写一条反馈：管理员在后台能看到，处理状态与回复会回到「设置 → 帮助与反馈」。
      </p>
      <ul className="vq-help-index">
        {HELP_ARTICLES.map((item) => (
          <li key={item.slug}>
            <a className="vq-help-index-item" href={'#/help/' + item.slug}>
              <span className="vq-help-index-kicker vq-mono">{item.kicker}</span>
              <strong>{item.title}</strong>
              <span className="vq-help-index-summary">{item.summary}</span>
              <span className="vq-help-index-more">
                读这一篇
                <ArrowRight size={13} />
              </span>
            </a>
          </li>
        ))}
      </ul>
      <div className="vq-help-cta">
        <BookOpen size={16} strokeWidth={1.5} />
        <div>
          <strong>还是没解决？</strong>
          <span>写清时间、操作和界面上的编号，管理员才能定位到那一次调用。</span>
        </div>
        <button type="button" className="vq-button vq-button--ghost vq-button--sm" onClick={onFeedback}>
          <MessageSquare size={13} />
          提交反馈
        </button>
      </div>
    </>
  )
}

function ArticleBody({ article, onFeedback }: { article: HelpArticle; onFeedback: () => void }) {
  const related = relatedArticles(article)
  return (
    <>
      <span className="vq-help-kicker vq-mono">{article.kicker}</span>
      <h1>{article.title}</h1>
      <p className="vq-help-meta">
        更新于 {article.updatedAt} · 共 {article.sections.length} 节
      </p>
      {article.sections.map((section) => (
        <section className="vq-help-section" key={section.heading}>
          <h2>{section.heading}</h2>
          {section.bullets?.length ? (
            <ul className="vq-help-list">
              {section.bullets.map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
          ) : null}
          {section.paragraphs?.map((text) => (
            <p key={text}>{text}</p>
          ))}
          {section.steps?.length ? (
            <ol className="vq-help-steps">
              {section.steps.map((step, index) => (
                <li className="vq-help-step" key={step.title}>
                  <span className="vq-help-step-no vq-mono">{String(index + 1).padStart(2, '0')}</span>
                  <div>
                    <strong>{step.title}</strong>
                    <span>{step.text}</span>
                  </div>
                </li>
              ))}
            </ol>
          ) : null}
        </section>
      ))}

      {related.length ? (
        <nav className="vq-help-related" aria-label="相关内容">
          <span className="vq-help-related-label">接着看</span>
          {related.map((item) => (
            <a key={item.slug} href={'#/help/' + item.slug}>
              {item.title}
            </a>
          ))}
        </nav>
      ) : null}

      <div className="vq-help-cta">
        <BookOpen size={16} strokeWidth={1.5} />
        <div>
          <strong>照这条排查还是不通？</strong>
          <span>带上编号与提示原文提交反馈，处理状态和回复会回到设置页。</span>
        </div>
        <button type="button" className="vq-button vq-button--ghost vq-button--sm" onClick={onFeedback}>
          <MessageSquare size={13} />
          提交反馈
        </button>
      </div>
    </>
  )
}
