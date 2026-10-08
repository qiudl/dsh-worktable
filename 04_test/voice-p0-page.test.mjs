/**
 * REQ-20261008-0010 P0（23113 · 页面）最小单测：直接从 `日记工作台.html` 抽 `<script>`，
 * 再按函数名抽出本 REQ 新增的那几个函数，在 vm 里跑断言。
 *
 * 覆盖：
 *  - 提示条同时点明两条路径，且逐字含判据串「0 外部语音费用」
 *  - 成本边界三条锚点逐字存在
 *  - 「📥 取输入框草稿」的埋点：POST /api/worktable/user-memory body {"draftTake":1}、静默、先于主流程
 *  - 旧提示已改为不与主路径冲突（保留但不再互相矛盾）
 *  - F3 自检状态行 / F5 开关状态行的取值分支
 *
 * 用法：node ../04_test/voice-p0-page.test.mjs
 *      WT_HTML=<路径> node ../04_test/voice-p0-page.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { runInNewContext, Script } from 'node:vm'

const HTML = process.env.WT_HTML || '/Users/johnq/Documents/m1book/obs/Diary-HUB/日记工作台.html'
if (!existsSync(HTML)) throw new Error('找不到工作台页面（用 WT_HTML=<路径> 指定）：' + HTML)
const html = readFileSync(HTML, 'utf8')
const m = /<script>([\s\S]*?)<\/script>/.exec(html)
assert.ok(m, '页面里应有 <script> 块')
const src = m[1]

/** 按函数声明名抽出源码（跳过字符串/模板串/注释，避免花括号计数被干扰） */
function extractFn(code, name) {
  const re = new RegExp('function\\s+' + name + '\\s*\\(')
  const hit = re.exec(code)
  if (!hit) throw new Error('页面里找不到函数：' + name)
  const open = code.indexOf('{', hit.index + hit[0].length - 1)
  if (open < 0) throw new Error('函数没有函数体：' + name)
  let depth = 0
  for (let i = open; i < code.length; i++) {
    const c = code[i]
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < code.length; i++) {
        if (code[i] === '\\') { i++; continue }
        if (code[i] === c) break
      }
      continue
    }
    if (c === '/' && code[i + 1] === '/') { while (i < code.length && code[i] !== '\n') i++; continue }
    if (c === '/' && code[i + 1] === '*') { i = code.indexOf('*/', i + 2) + 1; continue }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return code.slice(hit.index, i + 1) }
  }
  throw new Error('函数体没有闭合：' + name)
}

/** 把指定函数抽出来放进 vm 跑，返回可调用对象 */
function loadFns(names, sandbox = {}) {
  const code = names.map((n) => extractFn(src, n)).join('\n') + '\nmodule.exports = { ' + names.join(', ') + ' }'
  const module = { exports: {} }
  runInNewContext(code, { module, exports: module.exports, console, ...sandbox })
  return module.exports
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/* ── F1 提示条 ────────────────────────────────────────────────────────────── */

test('提示条：逐字含判据串「0 外部语音费用」，且同时点明两条路径', () => {
  assert.ok(html.split('0 外部语音费用').length - 1 >= 1, 'HTML 里必须出现判据串「0 外部语音费用」')
  const { voiceBannerHtml } = loadFns(['voiceCheckLine', 'voiceSwitchLine', 'voiceBannerHtml'], { esc, voiceCheck: null, voiceCfg: null })
  const out = voiceBannerHtml()
  assert.ok(out.includes('0 外部语音费用'), '提示条文案必须逐字含「0 外部语音费用」')
  assert.ok(out.includes('输入框麦克风') && out.includes('记日记'), '要点明主路径：记日记 → 输入框麦克风')
  assert.ok(out.includes('duet 语音') && out.includes('对话/查东西'), '要点明辅路径：对话/查东西 → duet 语音')
  assert.ok(out.includes('按音频 token 计费'), 'duet 路径要写明计费口径')
  assert.ok(out.includes('输入框麦克风是日常记日记的主路径'))
  assert.ok(out.includes('duet 语音只用于对话/查询'))
})

test('提示条：成本边界三条锚点逐字存在（F4）', () => {
  const { voiceBannerHtml } = loadFns(['voiceCheckLine', 'voiceSwitchLine', 'voiceBannerHtml'], { esc, voiceCheck: null, voiceCfg: null })
  const out = voiceBannerHtml()
  assert.ok(out.includes('桥不减少实时语音模型的音频 token'), '锚点①')
  assert.ok(out.includes('它省的是云 ASR 的费用'), '锚点②')
  assert.ok(out.includes('真正节省来自改走主路径'), '锚点③')
  assert.equal(/桥[^。]{0,12}(省|减少)[^。]{0,12}音频 token/.test(out.replace('桥不减少实时语音模型的音频 token', '')), false, '不得出现"桥能省音频 token"的说法')
})

test('提示条插在口述页最前面（renderDictate 顶部）', () => {
  assert.ok(/var h = voiceBannerHtml\(\) \+ '<div class="dshell-card">/.test(src), 'renderDictate 应以 voiceBannerHtml() 开头')
  assert.ok(/fetchVoiceCheck\(\)\.then\(/.test(src) && /fetchVoiceConfig\(\)\.then\(/.test(src), '启动时应拉取自检与开关')
})

/* ── F1 埋点 ─────────────────────────────────────────────────────────────── */

test('埋点：POST /api/worktable/user-memory body {"draftTake":1}（fire-and-forget）', async () => {
  const calls = []
  const { reportDraftTake } = loadFns(['reportDraftTake'], {
    lastDraftTakeAt: 0, DRAFT_TAKE_DEBOUNCE_MS: 500,
    fetch: (url, opts) => { calls.push({ url, opts }); return Promise.resolve({ ok: true }) },
  })
  assert.equal(reportDraftTake(), undefined, '必须是 fire-and-forget（不返回 Promise 给调用方 await）')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/api/worktable/user-memory?name=speech.json')
  assert.equal(calls[0].opts.method, 'POST')
  assert.equal(calls[0].opts.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(calls[0].opts.body), { draftTake: 1 })
})

test('埋点：fetch 抛错 / 失败都不得影响取草稿主流程', () => {
  const { reportDraftTake } = loadFns(['reportDraftTake'], {
    lastDraftTakeAt: 0, DRAFT_TAKE_DEBOUNCE_MS: 500,
    fetch: () => { throw new Error('network down') },
  })
  assert.doesNotThrow(() => reportDraftTake(), '埋点抛错必须被吞掉')
  const body = extractFn(src, 'reportDraftTake')
  assert.ok(/\.then\(function \(\) \{\}, function \(\) \{\}\)/.test(body), 'Promise 失败分支必须静默处理')
})

test('埋点防抖（CR-23118 ②）：同一时间窗内连续多次调用只发一次 fetch', () => {
  const calls = []
  const clock = { t: 1000000 }   // 受控时钟（按引用共享 → 可直接推进）
  const sandbox = {
    lastDraftTakeAt: 0, DRAFT_TAKE_DEBOUNCE_MS: 500, Date: { now: () => clock.t },
    fetch: (url, opts) => { calls.push({ url, opts }); return Promise.resolve({ ok: true }) },
  }
  const { reportDraftTake } = loadFns(['reportDraftTake'], sandbox)
  reportDraftTake()
  assert.equal(calls.length, 1, '第一次必须上报')
  reportDraftTake(); reportDraftTake()
  assert.equal(calls.length, 1, '同一时间窗内连点不得再发（防抖生效）')
  clock.t += 499
  reportDraftTake()
  assert.equal(calls.length, 1, '窗口内（<500ms）仍不重发')
  clock.t += 2
  reportDraftTake()
  assert.equal(calls.length, 2, '窗口过后应可再次上报')
  assert.deepEqual(calls.map((c) => JSON.parse(c.opts.body)), [{ draftTake: 1 }, { draftTake: 1 }], '每次上报都是 {"draftTake":1}')
  // 防抖状态是模块级的（源码里声明），不是每次调用清零
  assert.ok(/var lastDraftTakeAt = 0/.test(src), '页面需有模块级 lastDraftTakeAt（跨调用保持）')
})

test('埋点在「取输入框草稿」的入口、先于读草稿主流程', () => {
  const take = extractFn(src, 'takeDraft')
  const beacon = take.indexOf('reportDraftTake()')
  const main = take.indexOf('hostDraft()')
  assert.ok(beacon >= 0, 'takeDraft 必须调用 reportDraftTake()')
  assert.ok(main > beacon, '埋点必须先于读草稿（点一次即计数，AC1⑥ 口径）')
})

/* ── F3 自检行 / F5 开关行 ───────────────────────────────────────────────── */

test('F3 自检行：正常态 / 命中态 / 无产物态三分支', () => {
  const mk = (voiceCheck) => loadFns(['voiceCheckLine'], { voiceCheck }).voiceCheckLine
  const hint = (s) => s.includes('静默遮蔽') + '|' + s.includes('静默计费') + '|' + s.includes('勿装回')
  const clean = mk({ exists: true, legacyLoaded: false, catalogHasLegacy: false, patchHasLegacy: false, catalogChecked: true, conclusion: 'clean' })()
  assert.ok(clean.includes('未发现回流通道') && clean.includes('clean'))
  assert.equal(clean.includes('勿装回'), false, '未命中时不应出现告警三点')
  const dirty = mk({ exists: true, legacyLoaded: true, catalogHasLegacy: true, patchHasLegacy: true, catalogChecked: true, conclusion: 'legacy-loaded' })()
  assert.ok(dirty.includes('已加载'))
  assert.equal(hint(dirty), 'true|true|true', '命中时必须写明三点：静默遮蔽 / 静默计费 / 勿装回')
  const partial = mk({ exists: true, legacyLoaded: false, catalogHasLegacy: true, patchHasLegacy: false, catalogChecked: false, conclusion: 'legacy-present' })()
  assert.ok(partial.includes('存在可装回通道') && partial.includes('catalog 未检查'))
  const none = mk({ exists: false })()
  assert.ok(none.includes('还没有产物'))
  const dead = mk(null)()
  assert.ok(dead.includes('读不到自检路由'))
})

test('F5 开关行：开 / 关 / 文件缺失 / 配置无效 / 路由不可用（CR-23118 ③ 四态）', () => {
  const mk = (voiceCfg) => loadFns(['voiceSwitchLine'], { voiceCfg }).voiceSwitchLine
  assert.ok(mk({ voiceAsrEnabled: true, exists: true, source: 'file' })().includes('true（已启用）'))
  assert.ok(mk({ voiceAsrEnabled: false, exists: true, source: 'file' })().includes('false（已停用）'))
  assert.ok(mk({ voiceAsrEnabled: true, exists: false, source: 'default' })().includes('默认值 true'))
  assert.ok(mk(null)().includes('读不到'))
  // 非法值绝不显示成「已启用」：显式告警 + 枚举
  const invalid = mk({ voiceAsrEnabled: true, exists: true, source: 'default', invalid: true, error: 'not-boolean' })()
  assert.ok(invalid.includes('⚠️ 配置无效，已按默认启用'), '非法配置必须显式提示：' + invalid)
  assert.ok(invalid.includes('not-boolean'), '要带上短枚举便于排查：' + invalid)
  assert.equal(invalid.includes('true（已启用）'), false, '非法值不得显示成「已启用」')
  const badJson = mk({ voiceAsrEnabled: true, exists: true, source: 'default', invalid: true, error: 'bad-json' })()
  assert.ok(badJson.includes('配置无效') && badJson.includes('bad-json'))
  assert.equal(badJson.includes('true（已启用）'), false)
})

/* ── 旧提示不冲突 ─────────────────────────────────────────────────────────── */

test('旧提示保留但不与主路径冲突', () => {
  assert.ok(/（辅路径[^\n]*语音直投口诀：/.test(src), '直投口诀必须标为「辅路径」')
  assert.ok(/语音直投口诀[\s\S]{0,260}?日常记日记请走上面的主路径/.test(src), '直投口诀旁要指向主路径')
  assert.ok(/主路径（本地识别）：/.test(src), '原有「主路径（本地识别）」标签仍在')
  assert.equal(/mic(rophone)? is required/.test(src), false)
})

test('页面脚本能被解析（vm.Script 编译 = node --check 等价物）', () => {
  assert.doesNotThrow(() => new Script(src), '抽出的 <script> 必须语法正确')
  const opens = (src.match(/function\s+\w+\s*\(/g) || []).length
  assert.ok(opens > 50, '页面函数数量异常：' + opens)
})
