// 作品「存成模板」：这一版做完的东西沉淀回模板库，下一条作品从它开始。
//
// 纯函数：不读盘、不写盘。路由拿到 spec 之后交给 templates.mjs 落库，单测只测这里的分寸。
//
// 三条边界：
//  1. 只沉淀看得见的东西：脚本是这一版自己的（或模板那份），分镜沿用绑定模板的取景文字；
//     原片的作者、链接、互动数据与帧图都不复制——它们属于那条视频，不属于这一版。
//  2. 没有分镜就不给存：模板要能再被改编（改编要脚本 + 分镜两个都有着落），
//     存一条光有脚本的模板，等于把人引到一个点开就报错的入口；从画布起的作品用画布里的「另存为模板」。
//  3. 脚本还是模板那份就先把话说清：存出来会是一条和原模板几乎一样的条目，不是骗人，但要让人知道。

/** 「存成模板」的前置判断：能不能存、存的是哪几段、要不要提醒它跟原模板一样。 */
export function projectTemplateSpec({ project = null, template = null, script = null } = {}) {
  if (!project) {
    return { status: 404, body: { error: '作品不存在或已被删除', code: 'PROJECT_NOT_FOUND' } }
  }
  const beats = Array.isArray(script?.structure) ? script.structure : []
  if (!beats.length) {
    return {
      status: 400,
      body: {
        error: '这条作品还没有脚本段落：先在作品页写一条脚本（或让智能体写），再把它存成模板',
        code: 'SCRIPT_REQUIRED',
      },
    }
  }
  const shots = Array.isArray(template?.storyboard) ? template.storyboard : []
  if (!template || !shots.length) {
    return {
      status: 400,
      body: {
        error: '这条作品没有分镜（它不是从模板起的）：模板要能被再改编，分镜得有着落。从画布起的作品，用画布里的「另存为模板」。',
        code: 'STORYBOARD_REQUIRED',
      },
    }
  }
  return {
    status: 200,
    body: {
      title: String(project.title || '').slice(0, 120),
      beats: beats.length,
      shots: shots.length,
      // 脚本还是模板那份（没改过）：存出来会是一条几乎一样的模板，界面要先把这句话说出来
      sameAsTemplate: script?.source !== 'project',
      source: {
        id: template.id,
        title: String(template.title || ''),
        contentType: String(template.contentType || '脚本'),
        durationSec: Number(template.durationSec) || 0,
      },
      script: {
        hook: String(script?.hook || ''),
        structure: beats,
        source: String(script?.source || ''),
      },
    },
  }
}

/** 落库之后回给界面的一句话：哪条作品、第几版、几段几镜。 */
export function projectTemplateReply({ template = null, project = null, script = null } = {}) {
  if (!template || !project) return null
  return {
    id: template.id,
    title: template.title,
    kind: template.kind,
    origin: template.origin || '',
    adaptedFrom: template.adaptedFrom || '',
    projectId: project.id,
    projectTitle: project.title,
    projectVersion: Number(project.version) || 0,
    beats: Array.isArray(template.structure) ? template.structure.length : 0,
    shots: Array.isArray(template.storyboard) ? template.storyboard.length : 0,
    scriptSource: String(script?.source || ''),
  }
}
