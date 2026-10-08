// 云状态合并/历史（第1项加固）纯函数单测：
//  - 并集不丢任何一侧的项目/布局/文件夹/绑定
//  - 同 id 冲突按"谁更新"决定
//  - history 保留最近 N 份、内容未变不重复压
//  - 合并幂等
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const require = createRequire(new URL('../01_content/package.json', import.meta.url))
const { buildSync } = require('esbuild')
function sourceModule(rel) {
  const code = buildSync({
    entryPoints: [fileURLToPath(new URL(rel, import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs',
  }).outputFiles[0].text
  const module = { exports: {} }
  runInNewContext(code, { module, exports: module.exports })
  return module.exports
}
const C = sourceModule('../01_content/src/client/cloudState.ts')
// 跨 VM 上下文的对象原型不同，deepStrictEqual 会误报 → 统一 plain 化再比
const plain = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)))
const deep = (a, b, msg) => assert.deepStrictEqual(plain(a), plain(b), msg)

const L = (id, title) => ({ id, title, main: [] })
const base = (over = {}) => ({
  order: [], lastUsed: {}, hidden: [], nameOverrides: {}, iconOverrides: {}, removed: [],
  views: {}, shortcuts: [], layouts: [], bindings: {}, folders: {}, ...over,
})

test('空云端 → 原样返回本机状态，无历史', () => {
  const local = { view: { orderBy: 'manual' }, projects: base({ layouts: [L('a', 'A')] }), bindings: {} }
  const out = C.mergeCloudState(null, local, '2026-10-09T00:00:00Z')
  deep(out.projects.layouts.map((x) => x.id), ['a'])
  deep(out.history, [])
  assert.equal(out.updatedAt, '2026-10-09T00:00:00Z')
})

test('并集不丢：两侧独有布局/文件夹/隐藏项/绑定都保留', () => {
  const local = { projects: base({ layouts: [L('a', 'A')], folders: { a: '/p/a' }, hidden: ['h1'] }), bindings: { p1: { pane1: { enabled: true } } } }
  const remote = { updatedAt: '2026-10-08T00:00:00Z', projects: base({ layouts: [L('b', 'B')], folders: { b: '/p/b' }, hidden: ['h2'] }), bindings: { p2: { pane2: { enabled: true } } } }
  const out = C.mergeCloudState(remote, local, '2026-10-09T00:00:00Z')
  deep(out.projects.layouts.map((x) => x.id).sort(), ['a', 'b'])
  deep(Object.keys(out.projects.folders).sort(), ['a', 'b'])
  deep(out.projects.hidden.sort(), ['h1', 'h2'])
  deep(Object.keys(out.bindings).sort(), ['p1', 'p2'])
})

test('同 id 冲突：云端更新则以云端为准，否则以本机为准', () => {
  const local = { projects: base({ layouts: [L('dup', '本机版')] }), bindings: {} }
  const remote = { updatedAt: '2026-10-08T00:00:00Z', projects: base({ layouts: [L('dup', '云端版')] }), bindings: {} }
  const localWins = C.mergeCloudState(remote, local, '2026-10-09T00:00:00Z')
  assert.equal(localWins.projects.layouts[0].title, '本机版')
  const remoteWins = C.mergeCloudState(remote, local, '2026-10-07T00:00:00Z')   // 本机时间戳比云端旧
  assert.equal(remoteWins.projects.layouts[0].title, '云端版')
})

test('order 并集：优先一侧在前，另一侧独有项追加', () => {
  const local = { projects: base({ order: ['a', 'b'] }), bindings: {} }
  const remote = { updatedAt: '2026-10-08T00:00:00Z', projects: base({ order: ['b', 'c'] }), bindings: {} }
  const out = C.mergeCloudState(remote, local, '2026-10-09T00:00:00Z')
  deep(out.projects.order, ['a', 'b', 'c'])
})

test('绑定并集：本地已 revoke 的不被云端旧记录复活（本地优先）', () => {
  const local = { projects: base(), bindings: { P: { pane1: { enabled: false } } } }
  const remote = { updatedAt: '2026-10-08T00:00:00Z', projects: base(), bindings: { P: { pane1: { enabled: true }, pane9: { enabled: true } } } }
  const out = C.mergeCloudState(remote, local, '2026-10-09T00:00:00Z')
  assert.equal(out.bindings.P.pane1.enabled, false, '本地 revoke 必须保留')
  assert.equal(out.bindings.P.pane9.enabled, true, '云端独有 pane 必须补齐')
})

test('history：内容未变不重复压；变化则压入上一份；上限裁剪保留最新', () => {
  const local = { projects: base({ layouts: [L('a', 'A')] }), bindings: {} }
  const remoteSame = { updatedAt: '2026-10-08T00:00:00Z', projects: base({ layouts: [L('a', 'A')] }), bindings: {} }
  const same = C.mergeCloudState(remoteSame, local, '2026-10-09T00:00:00Z', 5)
  deep(same.history, [], '内容相同不压历史')

  const remoteDiff = { updatedAt: '2026-10-08T00:00:00Z', projects: base({ layouts: [L('b', 'B')] }), bindings: {}, history: [] }
  const changed = C.mergeCloudState(remoteDiff, local, '2026-10-09T00:00:00Z', 5)
  assert.equal(changed.history.length, 1)
  assert.equal(changed.history[0].updatedAt, '2026-10-08T00:00:00Z')
  deep(changed.history[0].projects.layouts.map((x) => x.id), ['b'])

  let acc = { updatedAt: '2026-10-01T00:00:00Z', projects: base({ layouts: [L('x0', 'X0')] }), bindings: {}, history: [] }
  for (let i = 1; i <= 8; i++) {
    acc = C.mergeCloudState(acc, { projects: base({ layouts: [L('x' + i, 'X' + i)] }), bindings: {} }, '2026-10-0' + (i + 1) + 'T00:00:00Z', 3)
  }
  assert.equal(acc.history.length, 3, '上限 3 生效')
  // history 存的是「每次写入前的快照」，当前这份不在其中；上限 3 时保留最近三份
  deep(acc.history.map((h) => h.updatedAt), ['2026-10-08T00:00:00Z', '2026-10-07T00:00:00Z', '2026-10-06T00:00:00Z'])
})

test('不变量：合并结果包含两侧全部 id，且合并幂等', () => {
  const local = { projects: base({ layouts: [L('a', 'A'), L('c', 'C')], folders: { a: '/a', c: '/c' }, removed: ['r1'] }), bindings: { P: { p1: { enabled: true } } } }
  const remote = { updatedAt: '2026-10-08T00:00:00Z', projects: base({ layouts: [L('b', 'B'), L('c', 'C2')], folders: { b: '/b', c: '/c2' }, removed: ['r2'] }), bindings: { P: { p2: { enabled: true } } } }
  const once = C.mergeCloudState(remote, local, '2026-10-09T00:00:00Z')
  const ids = once.projects.layouts.map((x) => x.id).sort()
  for (const want of ['a', 'b', 'c']) assert.ok(ids.includes(want), '缺 id ' + want)
  deep(once.projects.removed.sort(), ['r1', 'r2'])
  const twice = C.mergeCloudState({ ...once, updatedAt: '2026-10-09T00:00:00Z' }, { projects: once.projects, bindings: once.bindings, view: once.view }, '2026-10-09T00:00:00Z')
  deep(twice.projects, once.projects, '幂等：再合一次不变')
  deep(twice.bindings, once.bindings)
})

test('mergeIntoLocal：本地为空时用云端，本地有内容时并集且本地 view 优先', () => {
  const remote = { updatedAt: '2026-10-08T00:00:00Z', view: { orderBy: 'recent' }, projects: base({ layouts: [L('a', 'A')] }), bindings: { P: { p1: { enabled: true } } } }
  const empty = C.mergeIntoLocal(remote, { view: null, projects: base(), bindings: {} })
  deep(empty.projects.layouts.map((x) => x.id), ['a'], '本地为空 → 用云端布局')
  assert.equal(empty.view.orderBy, 'recent')
  assert.equal(empty.bindings.P.p1.enabled, true)
  const local = { view: { orderBy: 'manual' }, projects: base({ layouts: [L('b', 'B')] }), bindings: {} }
  const both = C.mergeIntoLocal(remote, local)
  deep(both.projects.layouts.map((x) => x.id).sort(), ['a', 'b'])
  assert.equal(both.view.orderBy, 'manual', '本地 view 优先')
})
