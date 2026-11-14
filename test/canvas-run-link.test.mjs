import test from 'node:test'
import assert from 'node:assert/strict'
import {
  canvasRunLinkFromSegments,
  canvasRunLinkHash,
  canvasRunViewLinkHash,
} from '../src/domain/canvas-run-link.ts'

// 画布地址里点名一条运行（v0.9.104 / v0.9.106）：
//   续跑 #/canvas/<flowId>/resume/<runId>
//   查看 #/canvas/<flowId>/run/<runId>
// 这组用例只钉住地址语法本身：拼出来的地址必须能被同一条规则拆回来，
// 少一段 / 多一段 / 不是画布 / 认不出的模式都必须退回普通画布，不能让坏链接把画布挡住。

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

test('查看地址：和续跑分开，拼出来能拆回 viewRunId', () => {
  const hash = canvasRunViewLinkHash('flow_7c68', 'run_6a8e')
  assert.equal(hash, '#/canvas/flow_7c68/run/run_6a8e')
  assert.deepEqual(canvasRunLinkFromSegments(['canvas', 'flow_7c68', 'run', 'run_6a8e']), {
    flowId: 'flow_7c68',
    viewRunId: 'run_6a8e',
  })

  const encoded = canvasRunViewLinkHash('flow_a/b', 'run_1?x')
  assert.equal(encoded, '#/canvas/flow_a%2Fb/run/run_1%3Fx')
})

test('运行地址：不是画布 / 缺段 / 多段 / 认不出的模式都退回 null', () => {
  assert.equal(canvasRunLinkFromSegments(['projects', 'p1', 'resume', 'r1']), null)
  assert.equal(canvasRunLinkFromSegments(['canvas', 'flow_1', 'resume']), null)
  assert.equal(canvasRunLinkFromSegments(['canvas', 'flow_1', 'resume', '']), null)
  assert.equal(canvasRunLinkFromSegments(['canvas', 'flow_1']), null)
  assert.equal(canvasRunLinkFromSegments(['canvas', 'flow_1', 'resume', 'r1', 'extra']), null)
  assert.equal(canvasRunLinkFromSegments(['canvas', 'flow_1', 'run']), null)
  assert.equal(canvasRunLinkFromSegments(['canvas', 'flow_1', 'run', '']), null)
  assert.equal(canvasRunLinkFromSegments(['canvas', 'flow_1', 'watch', 'r1']), null)
  // 画布项目地址（#/canvas/project/<id>）不能被误认成运行地址
  assert.equal(canvasRunLinkFromSegments(['canvas', 'project', 'canvas_1']), null)
})
