// 上线就绪：把「还差什么才能对外收费」从文档搬进后台，一屏可读。
//
// 三条边界：
//   1) 每一条都来自真实配置或文件（邮件通道、告警通道、备份状态、档位、额度、公示信息），
//      不写「建议」「最佳实践」，也不估算；
//   2) 没有的值写「未配置 / 未设」，不假装就绪；有一条未就绪，这一屏就不会说「可以收费了」；
//   3) 每条都给出「去哪里填」，后台点一下就到对应页——用户不需要回来问我在哪配。
//
// 纯函数 readinessGates 负责判定，launchReadiness 只负责取数：判定逻辑可以单测，
// 取数失败按「未配置」算（宁可少报就绪，也不要报一个假的绿）。
import { mailView } from './mail-config.mjs'
import { channelView } from './alert-channel.mjs'
import { backupSummary } from './backup-status.mjs'
import { listPlans } from './plans.mjs'
import { quotaConfig } from './quota.mjs'
import { resolveSiteInfo } from './site-info.mjs'

/** 六道门：收钱、合规、邮件、告警、备份、额度。 */
export function readinessGates({ mail = null, channel = null, backup = null, plans = null, quota = null, site = null } = {}) {
  const planTotal = Number(plans?.total || 0)
  const planEnabled = Number(plans?.enabled || 0)
  const limit = Number(quota?.monthlyLimit || 0)
  const siteMissing = Array.isArray(site?.missing) ? site.missing : []
  const siteAny = Boolean(site?.icp || site?.operator || site?.supportEmail || site?.address || site?.creditCode || site?.complaint)
  const gates = [
    {
      key: 'pricing',
      label: '定价与支付',
      state: planTotal > 0 ? 'partial' : 'todo',
      summary:
        planTotal > 0
          ? '档位 ' + planTotal + ' 个（启用 ' + planEnabled + ' 个）；支付通道未接入，下单仍返回 501，目前只能「申请 → 管理员发放」'
          : '还没有定价档位：设置页没有可申请的方案，收不了钱',
      action: { label: planTotal > 0 ? '看档位' : '去定价位', section: 'billing' },
    },
    {
      key: 'site',
      label: '备案与主体',
      state: site?.complete ? 'ready' : siteAny ? 'partial' : 'todo',
      summary: site?.complete
        ? '备案号、运营主体、客服邮箱都齐了；页脚、登录页、条款与隐私说明会显示'
        : siteAny
          ? '还缺：' + (siteMissing.join('、') || '地址 / 信用代码（选填）')
          : '页脚没有备案号、隐私说明没有运营主体：境内对外运营前必须补',
      action: { label: siteAny ? '去补公示信息' : '去填公示信息', section: 'system' },
    },
    {
      key: 'mail',
      label: '找回密码邮件',
      state: mail?.configured ? 'ready' : 'todo',
      summary: mail?.configured
        ? '邮件通道已配（' + (mail.source === 'env' ? '环境变量' : '后台') + '）：忘记口令可以自助重置'
        : '没有邮件通道：忘记口令只能找管理员重置',
      action: { label: mail?.configured ? '看邮件通道' : '去配邮件通道', section: 'system' },
    },
    {
      key: 'alerts',
      label: '告警外推',
      state: channel?.configured ? 'ready' : 'todo',
      summary: channel?.configured
        ? '外推通道已配（' + (channel.source === 'env' ? '环境变量' : '后台') + '）：5xx / 上游失败 / 磁盘不足会推出去'
        : '只有站内队列：夜里挂了没人知道，要有人主动翻后台',
      action: { label: channel?.configured ? '看告警通道' : '去配告警通道', section: 'system' },
    },
    {
      key: 'backup',
      label: '异地备份',
      state: backup?.offsiteConfigured ? 'ready' : 'todo',
      summary: backup?.offsiteConfigured
        ? '异地副本已配：整机故障时数据还在别处'
        : '备份与数据在同一块盘：整机或分区故障会一起丢',
      action: { label: '看备份状态', section: 'system' },
    },
    {
      key: 'quota',
      label: '每月额度',
      state: limit > 0 ? 'ready' : 'partial',
      summary:
        limit > 0
          ? '默认每月 ' + limit + ' 积分：超了返回 429，不扣积分也不调上游'
          : '默认不限（0）：只有按账号设了覆盖才会拦，单账号刷量全靠自觉',
      action: { label: limit > 0 ? '看额度' : '去设额度', section: 'billing' },
    },
  ]
  const counts = { ready: 0, partial: 0, todo: 0 }
  for (const gate of gates) counts[gate.state] += 1
  return {
    gates,
    totals: { total: gates.length, ...counts },
    // 一句话结论：只有全部 ready 才说「可以对外收费」
    verdict: counts.todo || counts.partial ? 'not-ready' : 'ready',
    verdictText:
      counts.todo === 0 && counts.partial === 0
        ? '六项都就绪'
        : counts.todo > 0
          ? '还有 ' + counts.todo + ' 项没配'
          : '还有 ' + counts.partial + ' 项只做了一半',
  }
}

const safe = async (run) => {
  try {
    return await run()
  } catch {
    return null
  }
}

/** 取真实状态再判定；任何一处读取失败都按「未配置」算，不把异常算成就绪。 */
export async function launchReadiness() {
  const [mail, channel, backup, site] = await Promise.all([
    safe(() => mailView()),
    safe(() => channelView()),
    safe(() => backupSummary()),
    safe(() => resolveSiteInfo()),
  ])
  let plans = { total: 0, enabled: 0 }
  try {
    const list = listPlans()
    plans = { total: list.length, enabled: list.filter((plan) => plan.enabled !== false).length }
  } catch {
    plans = { total: 0, enabled: 0 }
  }
  let quota = { monthlyLimit: 0 }
  try {
    const config = quotaConfig()
    quota = { monthlyLimit: Number(config.monthlyLimit) || 0 }
  } catch {
    quota = { monthlyLimit: 0 }
  }
  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    ...readinessGates({ mail, channel, backup, plans, quota, site }),
  }
}
