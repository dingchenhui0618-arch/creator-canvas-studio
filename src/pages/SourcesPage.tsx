// 素材来源与下架通道（v0.9.82，C4）：公开可读，不登录也能看、也能提交下架申请。
//
// 这一页存在的理由：公共模板里放着别人平台上的封面、标题与作者名。对外收费之前，
// 被收录的人得有一条能走完的路——不用注册、不用先找到模板编号、也不用猜我们存了什么。
//
// 两条硬规矩写进页面，不是口号：
//   1. 数字现算（/api/sources/summary），文案里不写死「25 条」这种会过期的数；
//   2. 没点名具体模板也能提交（target.kind = material），后台当举报处理，人工找到那条再收回。
import { useEffect, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, Flag, Minus } from 'lucide-react'
import { navigate } from '../router'
import { useSiteInfo } from '../api/app'
import { getSourcesSummary, type SourcesSummary } from '../api/sources'
import { ReportModal } from '../components/ReportModal'
import '../styles/shell.css'

const WHERE: { no: string; title: string; body: string; keeps: string }[] = [
  {
    no: '01',
    title: '平台公开页面（检索与爆款雷达）',
    body: '按关键词把公开作品的数据取回来：标题、作者、互动数、封面与原作品地址。点「加入模板库」时只落这几项，不下载视频、不转存到自己的空间。',
    keeps: '存：原作品地址、标题、作者、平台、互动数、封面',
  },
  {
    no: '02',
    title: '你自己提交的素材（复刻与评审）',
    body: '你给一条链接或一张图，平台按它抽少量帧、读出画面与节奏。抽出来的帧图留在服务器上，用于这一次与之后重看同一条。',
    keeps: '存：你提交的链接或图片、抽出的帧图、拆出来的脚本与分镜',
  },
  {
    no: '03',
    title: '画布生成的画面（模型产出）',
    body: '画布出图与出视频由模型按提示词生成，素材来源与上面两类无关；请求里只有提示词、尺寸等参数。',
    keeps: '存：提示词、模型名、生成结果与本条运行记录',
  },
]

const STORED = [
  '原作品地址（点得回原片）与平台名',
  '标题、作者名与发布时的互动数',
  '封面缩略图；解析过的再存抽帧图',
  '拆出来的脚本、分镜与评审结论',
]

const NOT_STORED = [
  '来源平台的原始视频文件',
  '别人的账号、私信或非公开内容',
  '举报人的联系方式（只给处理人看）',
  '被下架内容的删除记录（收回但留证据）',
]

const STEPS = [
  { no: '01', title: '提交', body: '用下面的表单说明是哪条内容、你与它的关系。不知道具体是哪一条也可以——写清平台、作者或片中特征。' },
  { no: '02', title: '受理', body: '提交后会拿到一个受理编号，这条进后台的处理队列；留了联系方式的会收到处理结果。' },
  { no: '03', title: '处理', body: '核实后我们把那条从公共模板收回、停掉已发出的分享链接，并把处理人与时间记进审计。' },
]

export function SourcesPage() {
  const site = useSiteInfo()
  const [data, setData] = useState<SourcesSummary | null>(null)
  const [failed, setFailed] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)
  const [toast, setToast] = useState('')

  useEffect(() => {
    let alive = true
    void getSourcesSummary()
      .then((next) => {
        if (alive) setData(next)
      })
      .catch(() => {
        if (alive) setFailed(true)
      })
    return () => {
      alive = false
    }
  }, [])

  // 提交完直接把受理编号留在页面顶上：不弹一个 3 秒就消失的 toast 就算完事
  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 6000)
    return () => window.clearTimeout(timer)
  }, [toast])

  const stats = data?.public
  const contact = site.complaint || site.supportEmail

  return (
    <main className="vq-src">
      <div className="vq-src-inner">
        <button type="button" className="vq-src-back" onClick={() => navigate({ kind: 'page', page: 'overview' })}>
          <ArrowLeft size={13} />
          返回 VisionQA
        </button>

        <span className="vq-src-kicker vq-mono">合规 / Provenance</span>
        <h1>素材来源与下架通道</h1>
        <p className="vq-src-lead">
          公共模板里的画面、标题与作者名来自各平台的公开页面。这一页写清三件事：从哪来、我们存了什么、怎么要求下架。
          不用登录就能看，也能直接提交。
        </p>

        {toast ? (
          <p className="vq-src-toast" role="status">
            <Check size={14} />
            {toast}
          </p>
        ) : null}

        <section className="vq-src-section" aria-labelledby="src-where">
          <h2 id="src-where">一、素材从哪来</h2>
          <p className="vq-src-text">
            公共模板是「这条为什么会火」的参考样本：看它的开场、节奏与画面。我们不转载原片，也不代替任何人发布。
            每一条公共模板都要留着原作品地址——点得回原片，才有讨论版权的基础。
          </p>
          <div className="vq-src-grid">
            {WHERE.map((item) => (
              <article key={item.no} className="vq-src-card">
                <span className="vq-src-card-no vq-mono">{item.no}</span>
                <strong>{item.title}</strong>
                <p>{item.body}</p>
                <span className="vq-src-card-keeps">{item.keeps}</span>
              </article>
            ))}
          </div>
        </section>

        <section className="vq-src-section" aria-labelledby="src-store">
          <h2 id="src-store">二、存了什么，不存什么</h2>
          <div className="vq-src-columns">
            <div className="vq-src-col">
              <span className="vq-src-col-label vq-mono">存 / Stored</span>
              <ul>
                {STORED.map((line) => (
                  <li key={line}>
                    <Check size={13} />
                    {line}
                  </li>
                ))}
              </ul>
            </div>
            <div className="vq-src-col vq-src-col--mute">
              <span className="vq-src-col-label vq-mono">不存 / Not stored</span>
              <ul>
                {NOT_STORED.map((line) => (
                  <li key={line}>
                    <Minus size={13} />
                    {line}
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <p className="vq-src-note">
            「收回但留证据」是有意的：下架是把内容从公共位置撤掉，处理记录要留着，才能在有人追问时说清当时是谁、什么时候、按什么理由处理的。
          </p>
        </section>

        <section className="vq-src-section" aria-labelledby="src-numbers">
          <h2 id="src-numbers">三、现在库里有多少</h2>
          {failed ? (
            <p className="vq-src-note">
              数字没读到（/api/sources/summary 没有响应）。下面的口径与处理流程不受影响。
            </p>
          ) : !stats ? (
            <p className="vq-src-note">正在数…</p>
          ) : (
            <>
              <div className="vq-src-stats">
                <div>
                  <strong>{stats.total}</strong>
                  <span>条公共模板</span>
                </div>
                <div>
                  <strong>
                    {stats.withSourceUrl}/{stats.total}
                  </strong>
                  <span>留着原作品地址</span>
                </div>
                <div>
                  <strong>
                    {stats.withAuthor}/{stats.total}
                  </strong>
                  <span>记着作者</span>
                </div>
                <div>
                  <strong>{data.takedown.handled}</strong>
                  <span>条已处理下架</span>
                </div>
              </div>
              <div className="vq-src-platforms">
                <span className="vq-src-col-label vq-mono">平台 / Platform</span>
                {stats.platforms.length ? (
                  stats.platforms.map((row) => (
                    <span key={row.key} className="vq-src-pill">
                      {row.label}
                      <em>{row.count}</em>
                    </span>
                  ))
                ) : (
                  <span className="vq-src-note">公共模板现在是空的。</span>
                )}
                <span className="vq-src-pill vq-src-pill--quiet">
                  解析过 <em>{stats.parsed}</em>
                </span>
                <span className="vq-src-pill vq-src-pill--quiet">
                  只存链接 <em>{stats.linkOnly}</em>
                </span>
              </div>
              <p className="vq-src-note">
                数字从库里现算{stats.addedFrom ? '（' + stats.addedFrom + ' 至 ' + stats.addedTo + ' 之间加入）' : ''}，
                所以不会出现「页面上写 25 条、库里其实 31 条」。
                这里只回计数与平台分布：逐条的标题、作者与原链接要登录后进模板库看，那里每条都能直接举报。
              </p>
            </>
          )}
        </section>

        <section className="vq-src-section" aria-labelledby="src-ask">
          <h2 id="src-ask">四、要求下架</h2>
          <p className="vq-src-text">
            是这条内容的主人、或者受它影响的人，都可以要求把它撤下来。不需要先注册账号，也不需要先找到它在库里的编号。
          </p>
          <ol className="vq-src-steps">
            {STEPS.map((step) => (
              <li key={step.no}>
                <span className="vq-src-step-no vq-mono">{step.no}</span>
                <div>
                  <strong>{step.title}</strong>
                  <span>{step.body}</span>
                </div>
              </li>
            ))}
          </ol>
          <div className="vq-src-actions">
            <button type="button" className="vq-button vq-button--primary" onClick={() => setReportOpen(true)}>
              <Flag size={13} />
              提交下架申请
            </button>
            <button type="button" className="vq-button vq-button--ghost" onClick={() => navigate({ kind: 'page', page: 'templates' })}>
              我在模板库里看到了那一条
              <ArrowRight size={13} />
            </button>
          </div>
          <p className="vq-src-note">
            {contact ? (
              <>
                也可以发到 <strong>{contact}</strong>，写明链接与被侵权的作品，同样会进队列。
              </>
            ) : (
              <>还没有对外邮箱的部署里，就用上面的表单（留联系方式），或在工作台的「设置 → 帮助与反馈」里提交。</>
            )}
          </p>
        </section>

        <section className="vq-src-section" aria-labelledby="src-after">
          <h2 id="src-after">五、处理之后会怎样</h2>
          <ul className="vq-src-list">
            <li>那条从公共模板里收回：所有人（包括管理员自己）在模板库里都看不到了。</li>
            <li>已经发出去的分享链接立刻失效，打开的人只看到「链接已停用」。</li>
            <li>处理人、处理时间与理由进审计；举报人的联系方式不会展示给其他人。</li>
            <li>如果判定是合理使用（例如评述、教学场景），会回一条说明而不下架，处理结果同样记录在案。</li>
          </ul>
          <p className="vq-src-note">
            这一页只讲公共模板这一面。你自己上传与生成的素材，删除与保留口径在
            <a className="vq-link" href="#/legal/privacy"> 隐私说明 </a>
            里，按那条走。
          </p>
        </section>

        <footer className="vq-src-foot">
          <a className="vq-link" href="#/help">
            帮助
          </a>
          <a className="vq-link" href="#/legal/terms">
            服务条款
          </a>
          <a className="vq-link" href="#/legal/privacy">
            隐私说明
          </a>
          <a className="vq-link" href="#/sources">
            素材来源与下架
          </a>
          <span>{site.supportEmail ? '联系：' + site.supportEmail : '联系：工作区管理员'}</span>
          <span className="vq-mono">VisionQA</span>
        </footer>
      </div>

      {reportOpen ? (
        <ReportModal
          target={{ kind: 'material', id: 'sources-index', title: '素材来源页 · 未指名具体条目' }}
          onClose={() => setReportOpen(false)}
          // 不自动关弹窗：受理编号只在那张卡上，关了就得回去翻反馈记录。
          // 让提交人自己按「关闭」，编号能看清、能抄下来。
          onDone={(message) => setToast(message)}
        />
      ) : null}
    </main>
  )
}
