// 平台 Key 池的内存能力快照。
// 让 config / health 不必反向 import keyvault（那会形成循环依赖），
// keyvault 每次增删改后把「每种能力有几把可用 Key」写到这里。
const counts = { text: 0, vision: 0, image: 0, video: 0 }

export function setVaultCounts(next) {
  for (const key of Object.keys(counts)) counts[key] = Number(next?.[key] || 0)
}

export function vaultHas(capability) {
  return Number(counts[capability] || 0) > 0
}

export function vaultAny() {
  return Object.values(counts).some((n) => n > 0)
}

export function vaultCounts() {
  return { ...counts }
}
