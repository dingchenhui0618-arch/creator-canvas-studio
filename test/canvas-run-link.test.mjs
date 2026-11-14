import test from 'node:test'
import assert from 'node:assert/strict'
import { canvasRunLinkFromSegments, canvasRunLinkHash } from '../src/domain/canvas-run-link.ts'

// 画布地址里点名一条运行：#/canvas/<flowId>/resume/<runId>（v0.9.104）。
// 这组用例只钉住地址语法本身：拼出来的地址必须能被同一条规则拆回来，
// 少一段 / 多一段 / 不是画布都必须退回普通画布，不能让坏链接把画布挡住。

test('续跑地址：拼出来能拆回去，id 做 URL 编码', () => {
  const hash = canvasRunLinkHash('flow_7c68', 'run_6a8e')
  assert.equal(hash, '#/canvas/flow_7c68/resume/run_6a8e')
  assert.deepEqual(canvasRunLinkFromSegments(['canvas', 'flow_7c68', 'resume', 'run_6a8e']), {
    flowId: 'flow_7c68',
    resumeRunId: 'run_6a8e',
  })

  const encoded = canvasRunLinkHash('flow_a/b', 'run_1?x')
  assert.equal(encoded, '#/canvas/flow_a%2Fb/resume/run_1%3Fx')
})

test('续跑地址：不是画布 / 缺段 / 多段 / 普通画布地址都退回 null', () => {
  assert.equal(canvasRunLinkFromSegments(['projects', 'p1', 'resume', 'r1']), null)
  assert.equal(canvasRunLinkFromSegments(['canvas', 'flow_1', 'resume']), null)
  assert.equal(canvasRunLinkFromSegments(['canvas', 'flow_1', 'resume', '']), null)
  assert.equal(canvasRunLinkFromSegments(['canvas', 'flow_1']), null)
  assert.equal(canvasRunLinkFromSegments(['canvas', 'flow_1', 'run', 'r1']), null)
  assert.equal(canvasRunLinkFromSegments(['canvas', 'flow_1', 'resume', 'r1', 'extra']), null)
  // 画布项目地址（#/canvas/project/<id>）不能被误认成续跑
  assert.equal(canvasRunLinkFromSegments(['canvas', 'project', 'canvas_1']), null)
})
