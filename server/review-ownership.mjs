// 评审记录挂在哪个作品上。
//
// 评审落库时就记下了 projectId 与当时的版次（server/reviews.mjs），所以「这条评审属于哪条作品」
// 是一次纯索引：不改存储、不复制评审正文，作品改名后历史评审跟着改口。
// 和运行按 flowId 反查（server/run-ownership.mjs）是同一套做法，各按自己的键走。

/** 作品 id → 引用：只带 id 与标题，评审正文、画布指针、分享凭证都不进这个字段。 */
export function projectsById(projects = []) {
  const byId = new Map()
  for (const project of Array.isArray(projects) ? projects : []) {
    if (!project?.id) continue
    byId.set(String(project.id), {
      id: String(project.id),
      title: String(project.title || '未命名作品'),
    })
  }
  return byId
}

/** 一条评审记在哪条作品上：普通评审（模板首帧、粘贴地址）没带 projectId，认不出来就是 null。 */
export function reviewProjectRef(byId, projectId) {
  if (!projectId || !(byId instanceof Map)) return null
  return byId.get(String(projectId)) || null
}

/** 给一页评审记录逐条挂上作品：只加一个字段，原有的字段一个字都不动。 */
export function withReviewProject(reviews = [], byId = new Map()) {
  return (Array.isArray(reviews) ? reviews : []).map((review) => ({
    ...review,
    project: reviewProjectRef(byId, review?.projectId),
  }))
}
