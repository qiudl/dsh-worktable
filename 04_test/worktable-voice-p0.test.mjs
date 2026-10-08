/**
 * REQ-20261008-0010 P0（23114 · 服务端）小函数单测。
 * 覆盖：旧插件匹配规则（`options.name` 包含，官方 id `ui-voice-input` 不误报）、
 *       自检产物字段白名单 / 只布尔与枚举 / 无凭据关键字、
 *       catalog 路径解析与静默降级、F5 开关默认值、F1 埋点增量归一。
 *
 * 用法：cd 01_content && node ../04_test/worktable-voice-p0.test.mjs
 * （被测模块从 src/index.ts 现场打包，不依赖 lib/ 是否为最新）
 */
import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, rmSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ⚠️ 先隔离 DSH_HOME 再 import 被测模块：apply() 会按 DSH_HOME 读写（自检产物 / 用户级记忆），
//    绝不能碰本机真实数据。
const TMP_HOME = mkdtempSync(join(tmpdir(), 'wt-voice-p0-'))
process.env.DSH_HOME = TMP_HOME
mkdirSync(join(TMP_HOME, 'memory', 'user'), { recursive: true })
writeFileSync(join(TMP_HOME, 'memory', 'user', 'speech.json'),
  JSON.stringify({ stats: { corrected: {} }, homophones: [], people: [], terms: [] }, null, 2))

const require = createRequire(new URL('../01_content/package.json', import.meta.url))
const { buildSync } = require('esbuild')

const INDEX_SRC = fileURLToPath(new URL('../01_content/src/index.ts', import.meta.url))
const bundleText = buildSync({
  entryPoints: [INDEX_SRC],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  external: ['@deepseek-ai/*', 'node:*', 'ws', 'node-pty'],
  loader: { '.css': 'text', '.html': 'text' },
}).outputFiles[0].text

// 现场 bundle 成临时 ESM 再 import（src/index.ts 的 cordis import 是纯类型引用，esbuild 会消除）
const badImports = bundleText.split('\n').filter((l) => /^\s*import\s/.test(l) && l.includes('@deepseek-ai/'))
assert.deepEqual(badImports, [], 'bundle 不应残留 @deepseek-ai/* 运行时 import（类型 import 必须被消除）')
const tmpFile = fileURLToPath(new URL('./.tmp-voice-p0-index.mjs', import.meta.url))
writeFileSync(tmpFile, bundleText)
const mod = await import(tmpFile)
rmSync(tmpFile, { force: true })

const {
  parseLegacyMatch, textMentionsLegacy, textMentionsLegacyEntry, stripYamlLineComment, detectLegacyLoaded,
  buildCheckPayload, pickVoiceCheckFields, VOICE_CHECK_FIELDS, VOICE_CHECK_CONCLUSIONS, LEGACY_VOICE_WARNING,
  catalogCandidates, patchCandidates, firstReadable, parseVoiceConfig, VOICE_CONFIG_ERRORS,
  voiceConfigInvalidWarning, normalizeDraftTake, withFileLock, writeFileAtomic,
} = mod

/* ── 匹配规则 ─────────────────────────────────────────────────────────────── */

test('parseLegacyMatch: 包名命中，官方 bundle 与 id 都不误报', () => {
  assert.equal(parseLegacyMatch('@deepseek-ai/dsh-client-ui-voice'), true)
  // 官方 voice-input-bundle 的 entry name（含 client-ui-voice-input，但前面多了 experimental-）
  assert.equal(parseLegacyMatch('@deepseek-ai/dsh-experimental-client-ui-voice-input'), false)
  assert.equal(parseLegacyMatch('@deepseek-ai/dsh-experimental-voice-input-bundle'), false)
  // 官方 entry id：`ui-voice-input` —— 禁止用 id 前缀 `ui-voice` 匹配（会误报）
  assert.equal(parseLegacyMatch('ui-voice-input'), false)
  assert.equal(parseLegacyMatch('ui-voice'), false)
  for (const bad of [undefined, null, 42, {}, [], '']) assert.equal(parseLegacyMatch(bad), false, String(bad))
})

test('detectLegacyLoaded: 只用 options.name，官方 id `ui-voice-input` 不误报', () => {
  const official = [
    { options: { id: 'speech-to-text', name: '@deepseek-ai/dsh-experimental-speech-to-text' } },
    { options: { id: 'ui-voice-input', name: '@deepseek-ai/dsh-experimental-client-ui-voice-input' } },
  ]
  assert.equal(detectLegacyLoaded(official), false)

  // id 是 ui-voice 但 name 不是旧包名 → 不算命中（禁止 id 前缀匹配）
  assert.equal(detectLegacyLoaded([{ options: { id: 'ui-voice', name: 'other-plugin' } }]), false)
  // name 命中 → true（数组 / Set / 生成器都行）
  const hit = { options: { id: 'ui-voice', name: '@deepseek-ai/dsh-client-ui-voice' } }
  assert.equal(detectLegacyLoaded([hit]), true)
  assert.equal(detectLegacyLoaded(new Set([hit])), true)
  assert.equal(detectLegacyLoaded((function* () { yield hit })()), true)
  // 枚举中途抛错 → 视为未命中，不外抛
  assert.equal(detectLegacyLoaded((function* () { throw new Error('boom') })()), false)
})

test('textMentionsLegacy: 只回布尔', () => {
  assert.equal(textMentionsLegacy('a dsh-client-ui-voice b'), true)
  assert.equal(textMentionsLegacy('dsh-experimental-client-ui-voice-input'), false)
  assert.equal(textMentionsLegacy(null), false)
  assert.equal(textMentionsLegacy(undefined), false)
})

test('textMentionsLegacyEntry: 只认非注释条目（注释提及不算命中）', () => {
  // 本次核心：2026-10-04 的「已摘除」注释提到包名 → 不是条目 → false
  const removalComment = [
    '# 2026-10-04 已摘除 @deepseek-ai/dsh-client-ui-voice（勿装回：静默遮蔽 + 静默云计费）',
    'plugins:',
    '  - id: other-plugin',
  ].join('\n')
  assert.equal(textMentionsLegacyEntry(removalComment), false)
  assert.equal(textMentionsLegacy(removalComment), true, '对照：原始逐字包含仍为真（故需本函数区分）')
  // 缩进 / 前导空白的注释行同样忽略；块状注释整体忽略
  assert.equal(textMentionsLegacyEntry('   # dsh-client-ui-voice'), false)
  assert.equal(textMentionsLegacyEntry('  # a\n\t# dsh-client-ui-voice\n# b'), false)

  // 非注释条目 → true（id 行 / name 行两种写法）
  assert.equal(textMentionsLegacyEntry('- id: dsh-client-ui-voice'), true)
  assert.equal(textMentionsLegacyEntry("  - name: '@deepseek-ai/dsh-client-ui-voice'"), true)
  // 注释 + 真实条目并存 → true（命中来自条目）
  assert.equal(textMentionsLegacyEntry('# dsh-client-ui-voice\n- id: dsh-client-ui-voice'), true)

  // 无提及 / 非法输入 → false；同类新插件（experimental-…-voice-input）不误报
  assert.equal(textMentionsLegacyEntry('- id: other-plugin'), false)
  assert.equal(textMentionsLegacyEntry('  - name: "@deepseek-ai/dsh-experimental-client-ui-voice-input"'), false)
  assert.equal(textMentionsLegacyEntry(''), false)
  assert.equal(textMentionsLegacyEntry('\n'), false)
  for (const bad of [null, undefined, 42, {}, []]) assert.equal(textMentionsLegacyEntry(bad), false, String(bad))
})

test('textMentionsLegacyEntry: 行内（尾随）注释也排除（CR-23118 ①）', () => {
  // CR 实测的假阳性：entry 位置为空数组，包名只出现在行内注释里
  assert.equal(textMentionsLegacyEntry('plugins: [] # note: @deepseek-ai/dsh-client-ui-voice'), false)
  assert.equal(textMentionsLegacyEntry('  plugins: [] # note: @deepseek-ai/dsh-client-ui-voice'), false)
  assert.equal(textMentionsLegacyEntry('a: 1\t# x @deepseek-ai/dsh-client-ui-voice'), false)
  // CRLF：`\r\n` 行尾残留的 `\r` 不得影响截断
  assert.equal(textMentionsLegacyEntry('plugins: [] # note: @deepseek-ai/dsh-client-ui-voice\r\nplugins: []\r\n'), false)
  // 多行混合：只有注释里出现 → false；真实条目在别行 → true
  assert.equal(textMentionsLegacyEntry('# dsh-client-ui-voice\nplugins: [] # dsh-client-ui-voice\n'), false)
  assert.equal(textMentionsLegacyEntry('plugins: [] # dsh-client-ui-voice\n- id: dsh-client-ui-voice'), true)
  // `#` 前无空白 ⇒ YAML plain scalar 的一部分，不是注释（不得截断）
  assert.equal(textMentionsLegacyEntry('- id: dsh-client-ui-voice#suffix'), true)
  // 引号内的 `#` 不是注释（引号识别生效）：值里的包名仍算命中
  assert.equal(textMentionsLegacyEntry('- note: "a # b @deepseek-ai/dsh-client-ui-voice"'), true)
  assert.equal(textMentionsLegacyEntry("- name: '@deepseek-ai/dsh-client-ui-voice' # 注释里的提及"), true)
  // 引号 + 行内注释：注释部分被截断，引号内的值保留
  assert.equal(textMentionsLegacyEntry('- name: "@deepseek-ai/dsh-experimental-client-ui-voice-input" # dsh-client-ui-voice'), false,
    '注释里的包名不得命中，引号里的官方新插件名也不得命中')
})

test('stripYamlLineComment: 只截「行首/前置空白后的 #」，引号内的 # 保留', () => {
  assert.equal(stripYamlLineComment('- id: dsh-client-ui-voice'), '- id: dsh-client-ui-voice')
  assert.equal(stripYamlLineComment('# whole line'), '')
  assert.equal(stripYamlLineComment('   # indented'), '   ')
  assert.equal(stripYamlLineComment('k: v # c'), 'k: v ')
  assert.equal(stripYamlLineComment('k: a#b'), 'k: a#b')
  assert.equal(stripYamlLineComment('k: "a # b" # c'), 'k: "a # b" ')
  assert.equal(stripYamlLineComment("k: 'a # b'"), "k: 'a # b'")
  assert.equal(stripYamlLineComment("k: 'it''s # x' # y"), "k: 'it''s # x' ")
  assert.equal(stripYamlLineComment('k: "esc \\" # still" # y'), 'k: "esc \\" # still" ')
})

/* ── 自检产物 ─────────────────────────────────────────────────────────────── */

const CRED = /(Authorization|apiKey|Bearer|token|aiproj_pk_|ark-)/

test('buildCheckPayload: 字段白名单恰好 6 个，值只允许布尔/字符串枚举', () => {
  const p = buildCheckPayload({ time: '2026-10-08T00:00:00.000Z', patchHasLegacy: true, catalogHasLegacy: false, legacyLoaded: false, catalogChecked: true })
  assert.deepEqual(Object.keys(p).sort(), [...VOICE_CHECK_FIELDS].sort())
  assert.equal(Object.keys(p).length, 6)
  for (const [k, v] of Object.entries(p)) assert.equal(typeof v === 'boolean' || typeof v === 'string', true, k + ' 类型必须是布尔/字符串')
  for (const k of ['patchHasLegacy', 'catalogHasLegacy', 'legacyLoaded', 'catalogChecked']) assert.equal(typeof p[k], 'boolean', k)
  assert.equal(p.time, '2026-10-08T00:00:00.000Z')
  assert.ok(VOICE_CHECK_CONCLUSIONS.includes(p.conclusion))
  assert.equal(p.conclusion, 'legacy-present')
})

test('buildCheckPayload: conclusion 优先级 + 非布尔一律按 false + 无凭据关键字', () => {
  const C = (i) => buildCheckPayload(i).conclusion
  assert.equal(C({ legacyLoaded: true, patchHasLegacy: true, catalogHasLegacy: true, catalogChecked: true }), 'legacy-loaded')
  assert.equal(C({ catalogHasLegacy: true, catalogChecked: true }), 'legacy-present')
  assert.equal(C({ patchHasLegacy: true, catalogChecked: true }), 'legacy-present')
  assert.equal(C({ catalogChecked: true }), 'clean')
  assert.equal(C({}), 'catalog-unchecked')
  // 传字符串 "true" / 1 都不算命中（异常不得翻真）
  const coerced = buildCheckPayload({ patchHasLegacy: 'true', catalogHasLegacy: 1, legacyLoaded: 'yes', catalogChecked: 'no' })
  assert.deepEqual(coerced, {
    time: coerced.time,
    patchHasLegacy: false, catalogHasLegacy: false, legacyLoaded: false, catalogChecked: false,
    conclusion: 'catalog-unchecked',
  })
  assert.match(coerced.time, /^\d{4}-\d{2}-\d{2}T/)
  // 产物全文凭据关键字 = 0（AC7④）
  const json = JSON.stringify(buildCheckPayload({ time: 'x', patchHasLegacy: true, catalogHasLegacy: true, legacyLoaded: true, catalogChecked: true }))
  assert.equal(CRED.test(json), false, '产物不得含凭据关键字：' + json)
  assert.equal(json.split(CRED).length - 1, 0)
})

test('pickVoiceCheckFields: 只透出白名单字段（防篡改回显）', () => {
  const dirty = { time: 't', patchHasLegacy: true, catalogHasLegacy: false, legacyLoaded: true, catalogChecked: true, conclusion: 'legacy-loaded', secret: 'aiproj_pk_deadbeef', extra: 'ark-xyz' }
  const picked = pickVoiceCheckFields(dirty)
  assert.deepEqual(Object.keys(picked).sort(), [...VOICE_CHECK_FIELDS].sort())
  assert.equal(JSON.stringify(picked).includes('secret'), false)
  assert.equal(CRED.test(JSON.stringify(picked)), false)
  assert.equal(pickVoiceCheckFields(null), null)
  assert.equal(pickVoiceCheckFields('nope'), null)
  assert.equal(pickVoiceCheckFields([1, 2]), null)
})

test('LEGACY_VOICE_WARNING 含三点（静默遮蔽 / 云计费 / 勿装回）', () => {
  assert.ok(LEGACY_VOICE_WARNING.includes('静默遮蔽'), '需含「静默遮蔽」')
  assert.ok(LEGACY_VOICE_WARNING.includes('静默计费'), '需含「静默计费」')
  assert.ok(LEGACY_VOICE_WARNING.includes('勿装回'), '需含「勿装回」')
  assert.ok(LEGACY_VOICE_WARNING.includes('/api/voice/asr'))
  assert.ok(LEGACY_VOICE_WARNING.includes('exact 优先于 /api 前缀'))
})

/* ── catalog / patch 路径解析与静默降级 ───────────────────────────────────── */

test('catalogCandidates: env → 宿主可执行文件相邻 → 硬编码兜底，且去重', () => {
  const list = catalogCandidates({ DSH_HOST_BUNDLED_PLUGINS_ROOT: '/opt/bundled' }, '/Applications/Slark.app/Contents/Resources/dsh-runtime/app/bin/node')
  assert.equal(list[0], '/opt/bundled/catalog.v1.json')
  assert.equal(list[1], '/Applications/Slark.app/Contents/Resources/dsh-runtime/app/dsh-default-plugins/catalog.v1.json')
  assert.ok(list.includes('/Applications/Slark.app/Contents/Resources/dsh-default-plugins/catalog.v1.json'))
  assert.equal(new Set(list).size, list.length)
  const noEnv = catalogCandidates({}, '')
  assert.equal(noEnv.length, 1)
  assert.equal(noEnv[0], '/Applications/Slark.app/Contents/Resources/dsh-default-plugins/catalog.v1.json')
})

test('patchCandidates: DSH_PROFILE_DIR 优先，回退 $DSH_HOME/profiles/<profile>', () => {
  const list = patchCandidates({ DSH_PROFILE_DIR: '/p/web' }, '/p', 'web')
  assert.equal(list[0], '/p/web/cordis.patch.yml')
  assert.equal(list[1], '/p/profiles/web/cordis.patch.yml')
  assert.equal(patchCandidates({}, '/p', 'web').length, 1)
})

test('firstReadable: 目录/文件不存在 → null（catalogChecked:false 的静默降级）', () => {
  const boom = () => { throw new Error('ENOENT') }
  assert.equal(firstReadable(['/a', '/b'], boom), null)
  assert.equal(firstReadable(['/a', '/b'], (p) => { if (p === '/a') throw new Error('ENOENT'); return 'ok:' + p }), 'ok:/b')
  assert.equal(textMentionsLegacy(firstReadable(['/x'], () => 'has dsh-client-ui-voice here')), true)
  assert.equal(textMentionsLegacy(firstReadable(['/x'], boom)), false)
})

/* ── F5 开关 / F1 埋点归一 ────────────────────────────────────────────────── */

test('parseVoiceConfig: 合法布尔原样；坏 JSON / 非对象 / 非布尔 → 默认 true + invalid 短枚举（CR-23118 ③）', () => {
  assert.deepEqual(parseVoiceConfig(undefined), { voiceAsrEnabled: true })
  assert.deepEqual(parseVoiceConfig(null), { voiceAsrEnabled: true })
  assert.deepEqual(parseVoiceConfig('{"voiceAsrEnabled":true}'), { voiceAsrEnabled: true })
  assert.deepEqual(parseVoiceConfig('{"voiceAsrEnabled":false}'), { voiceAsrEnabled: false })
  // 非法：值用默认 true，且必须带 invalid + 短枚举（不静默）
  assert.deepEqual(parseVoiceConfig('not json'), { voiceAsrEnabled: true, invalid: true, error: 'bad-json' })
  assert.deepEqual(parseVoiceConfig('{not json'), { voiceAsrEnabled: true, invalid: true, error: 'bad-json' })
  assert.deepEqual(parseVoiceConfig('{"voiceAsrEnabled":"false"}'), { voiceAsrEnabled: true, invalid: true, error: 'not-boolean' })
  assert.deepEqual(parseVoiceConfig('{"voiceAsrEnabled":"no"}'), { voiceAsrEnabled: true, invalid: true, error: 'not-boolean' })
  assert.deepEqual(parseVoiceConfig('{"voiceAsrEnabled":0}'), { voiceAsrEnabled: true, invalid: true, error: 'not-boolean' })
  assert.deepEqual(parseVoiceConfig('{"other":1}'), { voiceAsrEnabled: true, invalid: true, error: 'not-boolean' })
  assert.deepEqual(parseVoiceConfig('[1,2]'), { voiceAsrEnabled: true, invalid: true, error: 'not-object' })
  // 非法时只回短枚举，不回原文
  assert.equal(JSON.stringify(parseVoiceConfig('{"voiceAsrEnabled":"SECRET-TEXT"}')).includes('SECRET-TEXT'), false)
  assert.equal(VOICE_CONFIG_ERRORS.includes('bad-json') && VOICE_CONFIG_ERRORS.includes('not-boolean'), true)
  // 宿主告警文案：含短枚举，不含文件内容/绝对路径
  const warn = voiceConfigInvalidWarning('bad-json')
  assert.ok(warn.includes('bad-json') && warn.includes('配置无效'), warn)
  assert.ok(warn.includes('$DSH_HOME/worktable-voice.json'), '用固定文件名指路')
  assert.equal(/\/Users\/|\/private\/|\/tmp\//.test(warn), false, '告警不得含绝对路径：' + warn)
})

test('normalizeDraftTake: 非数字/负值 → 0，单次上限 1000', () => {
  assert.equal(normalizeDraftTake(1), 1)
  assert.equal(normalizeDraftTake('2'), 2)
  assert.equal(normalizeDraftTake(0.9), 0)
  assert.equal(normalizeDraftTake(-5), 0)
  assert.equal(normalizeDraftTake('abc'), 0)
  assert.equal(normalizeDraftTake(undefined), 0)
  assert.equal(normalizeDraftTake(null), 0)
  assert.equal(normalizeDraftTake(1e9), 1000)
})

/* ── 构建产物契约 ─────────────────────────────────────────────────────────── */

test('构建产物 lib/index.js 含三条新路由与 draftTake 落点', () => {
  const lib = fileURLToPath(new URL('../01_content/lib/index.js', import.meta.url))
  assert.ok(existsSync(lib), '先跑 npm run build（lib/index.js 不存在）')
  const text = readFileSync(lib, 'utf8')
  assert.ok(text.includes('/api/worktable/legacy-voice-check'))
  assert.ok(text.includes('/api/worktable/voice-config'))
  assert.ok(text.includes('stats.draftTakes'))
  assert.ok(text.includes('dsh-worktable-check.json'))
})

/* ── apply() 冒烟：路由注册 / 自检产物 / 告警 / draftTake round-trip ────────── */

const LEGACY_ENTRY = { options: { id: 'ui-voice', name: '@deepseek-ai/dsh-client-ui-voice' } }
const OFFICIAL_ENTRY = { options: { id: 'ui-voice-input', name: '@deepseek-ai/dsh-experimental-client-ui-voice-input' } }

function makeCtx(routes, warns, entries) {
  const ctx = {
    logger: { info() {}, debug() {}, warn: (m) => warns.push(String(m)) },
    get: (n) => (n === 'loader' ? { entries: () => (entries || [])[Symbol.iterator]() }
      : n === 'connection' ? { requestRejection: () => undefined } : null),
    on() {}, effect() {},
  }
  ctx.webServer = { register: (r) => routes.set(r.path, r) }
  return ctx
}

/** 调一次已注册路由（guarded 会先走 connection 鉴权；fake connection 放行） */
function callRoute(routes, path, { method = 'GET', url = path, body = null } = {}) {
  return new Promise((resolve) => {
    const res = {
      status: 0, headers: null, text: '',
      writeHead(s, h) { this.status = s; this.headers = h },
      end(b) { this.text = b == null ? '' : String(b); resolve(this) },
    }
    const req = {
      method, url,
      async *[Symbol.asyncIterator]() { if (body !== null) yield Buffer.from(JSON.stringify(body)) },
    }
    routes.get(path).handler(req, res)
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('apply()：注册新路由、写自检产物（字段白名单）、告警与命中信号一致', async () => {
  const routes = new Map(); const warns = []
  mod.apply(makeCtx(routes, warns, [OFFICIAL_ENTRY]))
  for (const p of ['/api/worktable/health', '/api/worktable/legacy-voice-check', '/api/worktable/voice-config', '/api/worktable/user-memory']) {
    assert.ok(routes.has(p), '缺少路由 ' + p)
  }
  await sleep(150)
  const file = join(TMP_HOME, 'logs', 'dsh-worktable-check.json')
  assert.ok(existsSync(file), '自检产物必须写到 $DSH_HOME/logs/dsh-worktable-check.json')
  const raw = readFileSync(file, 'utf8')
  const payload = JSON.parse(raw)
  assert.deepEqual(Object.keys(payload).sort(), [...VOICE_CHECK_FIELDS].sort(), '产物字段白名单必须恰好 6 个')
  for (const k of ['patchHasLegacy', 'catalogHasLegacy', 'legacyLoaded', 'catalogChecked']) assert.equal(typeof payload[k], 'boolean', k)
  assert.equal(typeof payload.time, 'string')
  assert.ok(VOICE_CHECK_CONCLUSIONS.includes(payload.conclusion))
  assert.equal(payload.legacyLoaded, false, '官方 id `ui-voice-input` 不得被判为旧插件')
  assert.equal(payload.catalogChecked, true, '本机应有 Slark bundled catalog')
  assert.equal(payload.catalogHasLegacy, true, '本机 catalog 含 @deepseek-ai/dsh-client-ui-voice（可一键装回）')
  assert.equal(payload.conclusion, 'legacy-present')
  assert.equal(CRED.test(raw), false, '产物不得含凭据关键字')
  // 告警与命中信号严格一致（patchHasLegacy / catalogHasLegacy / legacyLoaded 任一为真 → 必须告警）
  assert.equal(warns.length > 0, payload.patchHasLegacy || payload.catalogHasLegacy || payload.legacyLoaded,
    '告警必须与命中信号一致；warns=' + JSON.stringify(warns))
  assert.ok(warns.join('\n').includes('静默遮蔽') && warns.join('\n').includes('静默计费') && warns.join('\n').includes('勿装回'))
  const res = await callRoute(routes, '/api/worktable/legacy-voice-check')
  assert.equal(res.status, 200)
  const body = JSON.parse(res.text)
  assert.equal(body.exists, true)
  assert.deepEqual(Object.keys(body).sort(), ['catalogChecked', 'catalogHasLegacy', 'conclusion', 'exists', 'legacyLoaded', 'patchHasLegacy', 'time'])
})

test('apply()：旧插件已加载 → 告警含三点（静默遮蔽/静默计费/勿装回）', async () => {
  const routes = new Map(); const warns = []
  mod.apply(makeCtx(routes, warns, [OFFICIAL_ENTRY, LEGACY_ENTRY]))
  await sleep(150)
  const payload = JSON.parse(readFileSync(join(TMP_HOME, 'logs', 'dsh-worktable-check.json'), 'utf8'))
  assert.equal(payload.legacyLoaded, true)
  assert.equal(payload.conclusion, 'legacy-loaded')
  assert.ok(warns.length >= 1, '命中必须告警')
  const w = warns.join('\n')
  assert.ok(w.includes('静默遮蔽') && w.includes('静默计费') && w.includes('勿装回'), '告警三点必须齐全：' + w)
})

test('apply()：voice-config 四态 —— 缺文件 / 坏 JSON / 非布尔 / 合法 false（CR-23118 ③）', async () => {
  const CFG = join(TMP_HOME, 'worktable-voice.json')
  const boot = async () => {
    const routes = new Map(); const warns = []
    mod.apply(makeCtx(routes, warns, [OFFICIAL_ENTRY]))
    const body = JSON.parse((await callRoute(routes, '/api/worktable/voice-config')).text)
    return { body, warns }
  }

  // ① 缺文件 → exists:false + source:default，**不出现** invalid/error，也不告警
  rmSync(CFG, { force: true })
  let r = await boot()
  assert.deepEqual(r.body, { voiceAsrEnabled: true, exists: false, source: 'default' })
  assert.equal('invalid' in r.body, false)
  assert.equal('error' in r.body, false)
  assert.equal(r.warns.some((w) => w.includes('配置无效')), false)

  // ② 坏 JSON → invalid:true + 默认 true + error:'bad-json' + 宿主告警（不含文件内容）
  writeFileSync(CFG, '{not json at all')
  r = await boot()
  assert.deepEqual(r.body, { voiceAsrEnabled: true, exists: true, source: 'default', invalid: true, error: 'bad-json' })
  assert.ok(r.warns.some((w) => w.includes('配置无效') && w.includes('bad-json')), '坏 JSON 必须写宿主告警：' + JSON.stringify(r.warns))
  assert.equal(r.warns.join('\n').includes('not json at all'), false, '告警不得含文件内容')

  // ③ 字符串 "false"（非布尔）→ invalid:true + 值仍是默认 true（**不得**显示成已停用/已启用）
  writeFileSync(CFG, JSON.stringify({ voiceAsrEnabled: 'false' }))
  r = await boot()
  assert.deepEqual(r.body, { voiceAsrEnabled: true, exists: true, source: 'default', invalid: true, error: 'not-boolean' })
  assert.ok(r.warns.some((w) => w.includes('配置无效')), '非布尔必须写宿主告警')

  // ④ 合法布尔 false → 不出现 invalid，值如实为 false，无告警
  writeFileSync(CFG, JSON.stringify({ voiceAsrEnabled: false }))
  r = await boot()
  assert.deepEqual(r.body, { voiceAsrEnabled: false, exists: true, source: 'file' })
  assert.equal('invalid' in r.body, false)
  assert.equal(r.warns.some((w) => w.includes('配置无效')), false)

  // ⑤ 合法布尔 true → source:file
  writeFileSync(CFG, JSON.stringify({ voiceAsrEnabled: true }))
  r = await boot()
  assert.deepEqual(r.body, { voiceAsrEnabled: true, exists: true, source: 'file' })
  rmSync(CFG, { force: true })
})

test('draftTake 埋点：POST 累加 stats.draftTakes，GET 读回；与 corrected/learn 并列', async () => {
  const routes = new Map()
  mod.apply(makeCtx(routes, [], [OFFICIAL_ENTRY]))
  const UM = '/api/worktable/user-memory'
  const get = () => callRoute(routes, UM, { url: UM + '?name=speech.json' }).then((r) => JSON.parse(r.text))
  const post = (b) => callRoute(routes, UM, { method: 'POST', url: UM + '?name=speech.json', body: b }).then((r) => JSON.parse(r.text))

  const before = await get()
  const n0 = Number(before.content.stats.draftTakes) || 0
  assert.equal(n0, 0, '初始为 0（缺失按 0）')

  const r1 = await post({ draftTake: 1 })
  assert.equal(r1.ok, true)
  assert.equal(r1.draftTakes, 1)
  assert.equal((await get()).content.stats.draftTakes, 1, 'GET 必须读回 content.stats.draftTakes')

  // 与 corrected 同时出现（三者并列）
  await post({ draftTake: 1, corrected: { 艳梅: 2 } })
  const after = await get()
  assert.equal(after.content.stats.draftTakes, 2)
  assert.equal(after.content.stats.corrected['艳梅'], 2)

  // 与 learn 同时出现
  await post({ draftTake: 1, learn: { wrong: '燕梅', right: '彦梅' } })
  const last = await get()
  assert.equal(last.content.stats.draftTakes, 3)
  assert.ok(last.content.homophones.some((h) => h.wrong === '燕梅' && h.right === '彦梅'))

  // 非法值不累加（归一为 0 → 400，因为没有任何有效操作）
  const bad = await callRoute(routes, UM, { method: 'POST', url: UM + '?name=speech.json', body: { draftTake: 'abc' } })
  assert.equal(bad.status, 400)
  assert.equal((await get()).content.stats.draftTakes, 3, '非法埋点不得改动计数')
})

/* ── CR-23118 ②：并发不丢更新（串行化 + 原子替换）───────────────────────────── */

test('withFileLock: 同一路径串行（读改写不丢更新），单次失败不阻塞后续', async () => {
  const key = 'lock-' + Date.now()
  let n = 0
  await Promise.all(Array.from({ length: 10 }, () => withFileLock(key, async () => {
    const cur = n
    await sleep(1)
    n = cur + 1
  })))
  assert.equal(n, 10, '同一路径必须串行：并发 10 次读改写不得丢更新')
  await assert.rejects(withFileLock(key, async () => { throw new Error('boom') }), /boom/)
  assert.equal(await withFileLock(key, async () => 'ok'), 'ok', '前一个任务失败后队列仍可用')
})

test('writeFileAtomic: 临时文件 + rename 替换（0600），不残留 .tmp', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wt-atomic-'))
  const target = join(dir, 'x.json')
  writeFileSync(target, 'old')
  await writeFileAtomic(target, 'new', 0o600)
  assert.equal(readFileSync(target, 'utf8'), 'new')
  assert.deepEqual(readdirSync(dir), ['x.json'], '不得残留临时文件（rename 后目录里只有目标文件）')
  if (process.platform !== 'win32') assert.equal(statSync(target).mode & 0o777, 0o600, '保留 0600 语义')
  rmSync(dir, { recursive: true, force: true })
})

test('draftTake 并发：10 个并发 POST → stats.draftTakes 恰好 += 10（无丢失更新）', async () => {
  const routes = new Map()
  mod.apply(makeCtx(routes, [], [OFFICIAL_ENTRY]))
  const UM = '/api/worktable/user-memory'
  const get = () => callRoute(routes, UM, { url: UM + '?name=speech.json' }).then((r) => JSON.parse(r.text))
  const post = () => callRoute(routes, UM, { method: 'POST', url: UM + '?name=speech.json', body: { draftTake: 1 } })

  const before = Number((await get()).content.stats.draftTakes) || 0
  const res = await Promise.all(Array.from({ length: 10 }, post))
  for (const r of res) assert.equal(r.status, 200, '并发 POST 全部应 200：' + r.text)
  const after = await get()
  assert.equal(Number(after.content.stats.draftTakes) - before, 10,
    '并发 10 次必须恰好 +10（少记 = 串行化失效的丢失更新）；before=' + before + ' after=' + after.content.stats.draftTakes)
})

test('corrected/learn/draftTake 并发不互相覆盖（同一串行队列）', async () => {
  const routes = new Map()
  mod.apply(makeCtx(routes, [], [OFFICIAL_ENTRY]))
  const UM = '/api/worktable/user-memory'
  const post = (b) => callRoute(routes, UM, { method: 'POST', url: UM + '?name=speech.json', body: b })
  const get = () => callRoute(routes, UM, { url: UM + '?name=speech.json' }).then((r) => JSON.parse(r.text))

  const base = await get()
  const n0 = Number(base.content.stats.draftTakes) || 0
  const c0 = Number(base.content.stats.corrected['彦梅']) || 0
  await Promise.all([
    ...Array.from({ length: 5 }, () => post({ draftTake: 1 })),
    ...Array.from({ length: 5 }, () => post({ corrected: { 彦梅: 1 } })),
    post({ learn: { wrong: '彦梅梅', right: '彦梅' } }),
  ])
  const after = await get()
  assert.equal(Number(after.content.stats.draftTakes) - n0, 5, 'draftTake 5 次全部记上')
  assert.equal(Number(after.content.stats.corrected['彦梅']) - c0, 5, 'corrected 5 次全部记上（未被 draftTake 覆盖）')
  assert.ok(after.content.terms.includes('彦梅'), 'learn 与并发计数并存')
})

// 自检的「第二趟」（apply 里 1.5s 后补跑）会在这之后写盘，故先等它跑完再清临时 DSH_HOME
after(async () => {
  await sleep(1800)
  rmSync(TMP_HOME, { recursive: true, force: true })
})

