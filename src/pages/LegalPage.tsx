// 服务条款与隐私说明：公开可读（不需要登录），登录页页脚能直接点进来。
// 内容只写平台真的怎么做：账号、图片与视频、第三方模型、删除后的保留范围都不含糊。
// 备案号与客服邮箱由服务端按环境变量下发，没配置就不显示，不编造。
import { ArrowLeft } from 'lucide-react'
import { navigate } from '../router'
import { useSiteInfo } from '../api/app'
import '../styles/shell.css'

type Props = { doc: 'terms' | 'privacy' }

const TITLE: Record<Props['doc'], string> = { terms: '服务条款', privacy: '隐私说明' }

export function LegalPage({ doc }: Props) {
  const site = useSiteInfo()
  return (
    <main className="vq-legal">
      <div className="vq-legal-inner">
        <button type="button" className="vq-link vq-legal-back" onClick={() => navigate({ kind: 'page', page: 'overview' })}>
          <ArrowLeft size={13} />
          返回 VisionQA
        </button>
        <h1>{TITLE[doc]}</h1>
        <p className="vq-legal-meta">
          最后更新：{site.termsUpdatedAt || '2026-11-12'}
          {site.termsVersion ? ' · 版本 v' + site.termsVersion : ''}
        </p>
        {doc === 'terms' ? <Terms /> : <Privacy />}
        <footer className="vq-legal-foot">
          <a className="vq-link" href="#/legal/terms">服务条款</a>
          <a className="vq-link" href="#/legal/privacy">隐私说明</a>
          {site.supportEmail ? <span>联系：{site.supportEmail}</span> : <span>联系：工作区管理员</span>}
          {site.icp ? <span>{site.icp}</span> : null}
          <span>VisionQA</span>
        </footer>
      </div>
    </main>
  )
}

function Terms() {
  return (
    <>
      <h2>一、这是什么</h2>
      <p>VisionQA 是一个做画面评审与内容复用的工作台：检索公开平台上的内容数据、把一条爆款拆成可拍的脚本与分镜、对画面给出带证据的评审结论。</p>
      <h2>二、账号</h2>
      <p>账号可以由管理员开通，也可以在开放自助注册时自己创建。自助注册需要勾选同意本条款与隐私说明，平台会在这个账号上记下同意的版本与时间；条款改版后再次确认的记录也会保留。请保管好自己的口令；多人共用账号会被限制，因为积分、模板与运行记录都按账号隔离。</p>
      <h2>三、积分与使用限制</h2>
      <p>检索、复刻、评审与对话都按次消耗积分，失败的请求会原路退回。积分目前由管理员发放，充值通道尚未开通；积分不是货币，不能提现或转赠。同一账号的并发请求有上限，用来保护上游额度。</p>
      <h2>四、你上传的内容</h2>
      <p>使用复刻与评审时，你会提交平台链接或图片。请确保你有权使用这些素材；平台不保存来源平台的原始视频文件，只保存链接、互动数据与解析出来的脚本分镜。</p>
      <h2>五、可用性与变更</h2>
      <p>平台仍在迭代，功能可能调整或下线。涉及计费、数据保留与第三方处理方式的变化，会在本页更新，并在产品内提示。</p>
      <h2>六、责任边界</h2>
      <p>评审结论是辅助判断，不构成对投放效果、合规性或销量的承诺；最终发布前请自行复核画面与文案。</p>
    </>
  )
}

function Privacy() {
  return (
    <>
      <h2>一、我们收集什么</h2>
      <p>账号：邮箱、显示名、口令的单向哈希（scrypt）、会话凭据、积分流水。使用记录：检索关键词与结果条数、模板与画布内容、评审请求与结论。这些是为了让功能能用、让积分可核对。</p>
      <h2>二、图片与视频怎么处理</h2>
      <p>复刻时，平台通过链接获取视频并抽取少量帧图，帧图保存在平台服务器上用于视觉分析；评审时，你提交的图片或模板首帧会发送给平台所配置的模型服务商做识别与判断。图片用于本次分析，不用于对外展示。</p>
      <h2>三、第三方</h2>
      <p>检索数据由第三方内容检索服务提供；视觉与文本分析由平台配置的大模型服务商完成。这些服务商按其自身政策处理请求内容，平台不向其提供你的口令与会话凭据。</p>
      <h2>四、保存多久</h2>
      <p>模板、画布、运行记录与评审结果会一直保留，直到你或管理员删除。帧图与临时文件按任务保留，可在模板删除时一并清理。</p>
      <h2>五、删除账号</h2>
      <p>删除账号会清掉登录凭据、会话与积分记录；该账号创建过的模板、画布与运行记录会保留（不再有登录主人）。如果需要连内容一起删除，请在删除前联系管理员处理。</p>
      <h2>六、你的选择</h2>
      <p>你可以随时修改口令、退出全部设备，或联系管理员停用账号。对数据有疑问时，通过本页底部的联系方式找到我们。</p>
    </>
  )
}
