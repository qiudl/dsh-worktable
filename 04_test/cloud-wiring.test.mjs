// 云同步接线（第1/2项）回归：
//  A. 源码必须真的用上"读-合并-写"与绑定同步（防止功能被删/退化回整份覆盖）
//  B. 窗口绑定注册器 reload()：外部写入后生效；坏数据/不合法记录不得被接受
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
// 跨 VM 上下文的对象原型不同，deepStrictEqual 会误报 → 统一 plain 化再比
const plain = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)))
const deep = (a, b, msg) => assert.deepStrictEqual(plain(a), plain(b), msg)
const indexSrc = read('../01_content/src/client/index.tsx')
const localesSrc = read('../01_content/src/client/locales.ts')
const bundle = read('../01_content/lib/client.js')
const require = createRequire(new URL('../01_content/package.json', import.meta.url))
const { buildSync } = require('esbuild')
function sourceModule(rel) {
  const code = buildSync({ entryPoints: [fileURLToPath(new URL(rel, import.meta.url))], bundle: true, write: false, platform: 'node', format: 'cjs' }).outputFiles[0].text
  const module = { exports: {} }
  runInNewContext(code, { module, exports: module.exports })
  return module.exports
}

test('源码接线：读-合并-写 + 启动并集恢复 + 绑定纳入 payload', () => {
  for (const needle of [
    'mergeCloudState(remote, local as any, new Date().toISOString(), CLOUD_HISTORY_LIMIT)',
    'const merged = mergeIntoLocal(cloud, local as any)',
    'persistMergedLocally(merged.projects, local.view == null ? merged.view : undefined, merged.bindings)',
    "import { mergeCloudState, mergeIntoLocal, mergeBindings, pruneHistory, CLOUD_HISTORY_LIMIT, type CloudPayload } from './cloudState'",
    'WIDGET_BINDINGS_KEY',
    'widgetRegistry.reload()',
    'restoreCloudState(\'rollback\')',
  ]) assert.ok(indexSrc.includes(needle), '源码缺少接线：' + needle)
  // 旧的"整份覆盖"推送写法必须消失
  assert.ok(!indexSrc.includes("const content = JSON.stringify({ ...get(), updatedAt: new Date().toISOString() }, null, 1)"),
    '不应残留旧的整份覆盖推送')
  // 构建产物里两处都要在（模块被真正打进去）
  for (const c of ['mergeCloudState', 'mergeIntoLocal', 'mergeBindings']) {
    assert.ok(bundle.includes(c), '产物缺少：' + c)
  }
})

test('云卡片新增「退回上一份快照」且文案 zh/en 齐备', () => {
  assert.ok(indexSrc.includes('cloudRollbackNow'), '缺少回滚处理函数')
  assert.ok(indexSrc.includes("t('cloud.rollback')") && indexSrc.includes("t('cloud.history'"), '卡片缺少回滚/历史展示')
  for (const key of ["'cloud.rollback'", "'cloud.rolling'", "'cloud.rolled'", "'cloud.noHistory'", "'cloud.history'", "'cloud.rollbackHint'"]) {
    assert.equal((localesSrc.match(new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 2, key + ' 需要 zh/en 各一份')
  }
})

function fakeStorage(initial = {}) {
  const map = { ...initial }
  return {
    getItem: (k) => (k in map ? map[k] : null),
    setItem: (k, v) => { map[k] = String(v) },
    dump: () => map,
  }
}

test('绑定注册器 reload()：外部写入后生效，坏数据与不合法记录被拒', () => {
  const { WidgetMountRegistry, WIDGET_BINDINGS_KEY } = sourceModule('../01_content/src/client/widgetMount.ts')
  const store = fakeStorage()
  const reg = new WidgetMountRegistry(store)
  deep(reg.entries(), [], '初始为空')

  const good = { projectId: 'P', paneId: 'p1', window: '窗口1', bindingId: 'binding-abc',
    sessionId: 'session-1', folder: '/tmp/p/', enabled: true }
  store.setItem(WIDGET_BINDINGS_KEY, JSON.stringify({ P: { p1: good } }))
  reg.reload()
  assert.equal(reg.entries().length, 1, 'reload 后应读到外部写入的绑定')
  assert.equal(reg.entries()[0].bindingId, 'binding-abc')

  const bad = { ...good, paneId: 'p2', bindingId: '有中文-不合法', enabled: 'yes' }
  store.setItem(WIDGET_BINDINGS_KEY, JSON.stringify({ P: { p1: good, p2: bad } }))
  reg.reload()
  const ids = reg.entries().map((b) => b.paneId)
  deep(ids, ['p1'], '不合法记录（bindingId 非 [a-z0-9-]/enabled 非布尔）必须被拒')

  store.setItem(WIDGET_BINDINGS_KEY, '{ 坏 JSON')
  reg.reload()
  deep(reg.entries(), [], '坏 JSON 不得留下旧记录（reload 是重建而非叠加）')
})
