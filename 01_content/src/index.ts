import { Context } from '@deepseek-ai/cordis'
import { execFile } from 'node:child_process'
import { existsSync, readdirSync, realpathSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve as pathResolve, sep } from 'node:path'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * 基础数据目录解析：不加载任何官方包（loadPkg 的兜底只能用它，禁止反向调用包加载函数——否则成环）。
 * 规则与官方 @deepseek-ai/dsh-home-paths 的 resolveDshHome 一致：
 *   DSH_HOME 环境变量优先（空/纯空白视为未设置），否则 ~/.dsh；
 *   支持 ~、~/、~\ 前缀展开；相对路径按进程 cwd 解析；结果归一为绝对路径。
 * 禁止任何业务代码直接拼 homedir()/.dsh —— 自定义 DSH_HOME（Desktop/隔离测试）会读错数据。
 */
function baseDshHome(): string {
  const env = process.env.DSH_HOME
  // 与官方一致：trim 只用于判断是否全空白，实际路径保留原字符串（两端空格有含义）
  const value = env !== undefined && env.trim().length > 0 ? env : pathResolve(homedir(), '.dsh')
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return pathResolve(homedir(), value.slice(2))
  return pathResolve(value)
}

/** 解析 DSH 数据根目录：优先官方 @deepseek-ai/dsh-home-paths（显式配置/DSH_HOME/默认），
 *  不可用或返回非法值时回退 baseDshHome()（同官方规则）。带缓存。 */
let cachedDshHome: string | null = null
/** 本次解析实际走了哪条路径（供测试断言官方包是否真的被使用） */
let dshHomeSource: 'official' | 'fallback' = 'fallback'
function resolveDshHomeSafe(): string {
  if (cachedDshHome) return cachedDshHome
  try {
    const pkg = loadPkg('@deepseek-ai/dsh-home-paths') as any
    if (pkg && typeof pkg.resolveDshHome === 'function') {
      const home = pkg.resolveDshHome(undefined, process.env)
      if (typeof home === 'string' && home.trim() !== '') {
        dshHomeSource = 'official'
        cachedDshHome = home
        return cachedDshHome
      }
    }
  } catch {}
  dshHomeSource = 'fallback'
  cachedDshHome = baseDshHome()
  return cachedDshHome
}

/**
 * dsh-worktable 服务端：健康路由 + 工作区内容窗的数据路由。
 * 参考 dsh-better-sidebar 的架构——内容窗能力由本插件自己的服务端路由提供：
 *   - POST /api/worktable/fs     目录列表（资源管理器窗）
 *   - POST /api/worktable/git    git 状态（源代码管理窗）
 *   - WS   /api/worktable/term   node-pty 终端流（终端窗；依赖宿主 node_modules 中的
 *                                node-pty 与 ws，缺失时该路由不注册、终端窗降级提示）
 */

declare const __WT_VERSION__: string
const PLUGIN_VERSION = typeof __WT_VERSION__ === 'undefined' ? 'dev' : __WT_VERSION__

export const name = 'dsh-worktable'
export const inject = ['webServer', 'sessions']

export const HEALTH_PATH = '/api/worktable/health'

const MAX_ENTRIES = 500

/** 本地文件/站点静态资源的 MIME 映射（file 与 site 两条路由共用） */
const FILE_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8', map: 'application/json; charset=utf-8',
  md: 'text/markdown; charset=utf-8', markdown: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8', log: 'text/plain; charset=utf-8',
  pdf: 'application/pdf', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  wasm: 'application/wasm', mp3: 'audio/mpeg', mp4: 'video/mp4', webm: 'video/webm',
}

const SITE_PREFIX = '/api/worktable/site'

// 原生皮肤模板（esbuild text loader 嵌入；/api/worktable/template 路由直接下发）
// @ts-ignore
import dshellCss from '../template/dshell.css'
// @ts-ignore
import dshellHtml from '../template/dshell.html'
const TEMPLATE_PREFIX = '/api/worktable/template'

/**
 * 从本插件模块位置向祖先方向查找并加载 node_modules 包（如 ws / node-pty）。
 * 本包经 junction 链接进 profile，普通 import 可能解析不到 profile 级依赖；
 * 同时尝试 junction 路径与 realpath 两条祖先链。
 */
/** 依赖探测尝试计数（供测试断言「有界探测、无循环重入」） */
let loadProbeAttempts = 0
function loadPkg(pkg: string): any | null {
  const starts = new Set<string>()
  try { starts.add(dirname(fileURLToPath(import.meta.url))) } catch {}
  try { starts.add(realpathSync(dirname(fileURLToPath(import.meta.url)))) } catch {}
  for (const start of starts) {
    let dir: string | null = start
    while (dir && dir !== pathResolve(dir, '..')) {
      loadProbeAttempts++
      try {
        const req = createRequire(pathToFileURL(pathResolve(dir, '__wt_probe__.js')).href)
        return req(pkg)
      } catch {}
      dir = pathResolve(dir, '..')
    }
  }
  // 兜底：DSH profiles/*/node_modules（按 baseDshHome 解析根目录——不能用 resolveDshHomeSafe，否则与本函数成环）
  try {
    const profilesDir = pathResolve(baseDshHome(), 'profiles')
    for (const profile of readdirSync(profilesDir, { withFileTypes: true })) {
      if (!profile.isDirectory() && !profile.isSymbolicLink()) continue
      const nm = pathResolve(profilesDir, profile.name, 'node_modules')
      loadProbeAttempts++
      try {
        const req = createRequire(pathToFileURL(pathResolve(nm, '__wt_probe__.js')).href)
        return req(pkg)
      } catch {}
    }
  } catch {}
  return null
}

/** 测试钩子：依赖探测尝试次数 + 数据目录解析路径（循环回归与官方路径断言用） */
export function __wtLoadProbeStats(): { attempts: number; homeSource: 'official' | 'fallback' } {
  return { attempts: loadProbeAttempts, homeSource: dshHomeSource }
}

/** 解析会话工作目录：服务端 header.cwd 优先，其次客户端传入 cwd，最后进程 cwd */
function serverCwd(ctx: any, sessionId?: string, clientCwd?: string): string {
  if (sessionId) {
    try {
      const headerCwd = ctx.sessions?.get?.(sessionId)?.header?.cwd
      if (typeof headerCwd === 'string' && headerCwd) return headerCwd
    } catch {}
  }
  if (typeof clientCwd === 'string' && clientCwd) return clientCwd
  return process.cwd()
}

function json(res: any, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/* ── 路由鉴权 ─────────────────────────────────────────────────────────────
 * 插件用 webServer.register 注册的是「裸」HTTP 路由，不经过 DSH 的 Typert 网关，
 * 因此默认没有任何鉴权：本机任何进程、或浏览器里任意页面，都能以本机用户权限
 * 调 /api/worktable/file|write|mkdir|fs（任意绝对路径，无白名单）——等于把
 * 「任意文件读写」挂在无鉴权端点上。
 *
 * 修法：复用宿主 connection 服务**同一套**判定（持久 cookie + Host/Origin 围栏），
 * 也就是 DSH 自己 /api/* 走的那一条。服务不可用时 fail-closed。
 * ─────────────────────────────────────────────────────────────────────── */
function authRejectCode(ctx: any, req: any): number | undefined {
  let conn: any = null
  try { conn = ctx.get?.('connection') ?? null } catch { conn = null }
  if (!conn || typeof conn.requestRejection !== 'function') {
    ctx.logger?.warn?.('[dsh-worktable] connection 服务不可用 → fail-closed（拒绝该请求）')
    return 403
  }
  try { return conn.requestRejection(req) } catch { return 403 }
}

function denyRequest(res: any, code: number) {
  res.writeHead(code, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' })
  res.end(code === 401
    ? 'dsh web authentication required; reopen the URL printed by dsh web.\n'
    : 'dsh-worktable: forbidden\n')
}

/** 包装一个路由 handler：先鉴权，再进业务。所有 HTTP 路由都必须经此注册。 */
function guarded(ctx: any, handler: (req: any, res: any) => any) {
  return (req: any, res: any) => {
    const code = authRejectCode(ctx, req)
    if (code !== undefined) { denyRequest(res, code); return }
    return handler(req, res)
  }
}

/* ── 旧语音插件的回流检测（REQ-20261008-0010 · F3，P0）────────────────────
 * 旧插件 `@deepseek-ai/dsh-client-ui-voice` 有两条回流通道：
 *   ① 盘上 `node_modules/@deepseek-ai/dsh-client-ui-voice.before-REQ-20260918-00{12,13}`；
 *   ② Slark 自带 `dsh-default-plugins/catalog.v1.json`（`entryIds:["ui-voice"]`）→ 可一键装回。
 * 它走 `ctx.connection.fetch.register`（另一张表），不与本地桥的 webServer exact 冲突 →
 * 后果**不是**"启动故障"，而是「与本地桥静默遮蔽（exact 优先于 /api 前缀）+ 静默云计费」。
 *
 * 本段只做「检测 + 提示」：不改 Slark 应用包、不读/不写任何凭据，
 * 产物字段白名单恰好 6 个（只布尔/字符串枚举），异常一律不外抛原文。
 * ─────────────────────────────────────────────────────────────────────── */

/** 匹配规则：只看 `entry.options.name` 是否包含该包名。
 *  ⚠️ 禁止用 id 前缀匹配：官方 bundle 的 entry id 是 `ui-voice-input`（`ui-voice` 前缀会误报），
 *  而它的 entry name 是 `@deepseek-ai/dsh-experimental-client-ui-voice-input`（不含本子串 → 不误报）。 */
export function parseLegacyMatch(name: unknown): boolean {
  return typeof name === 'string' && name.includes('dsh-client-ui-voice')
}

/** 文本里是否出现该包名（只回布尔，**绝不把文本带出去**） */
export function textMentionsLegacy(text: unknown): boolean {
  return typeof text === 'string' && text.includes('dsh-client-ui-voice')
}

/** 按 YAML 行内注释规则截断一行：从「行首或前置空白之后的第一个 `#`」起丢弃该行剩余部分。
 *  - `#` 前必须有空白（或位于行首）才算注释，故 `foo#bar` 不被截断（YAML plain scalar）；
 *  - `'…'` / `"…"` 引号字符串内的 `#` **不算**注释（YAML quoted scalar）；按 YAML 处理
 *    `''`（单引号内转义单引号）与 `\"`（双引号内转义双引号）。
 *  只回文本、不做任何 IO；这是纯文本近似，非完整 YAML 解析。 */
export function stripYamlLineComment(line: string): string {
  let quote = ''
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (quote === '"' && c === '\\') { i++; continue }
      if (c === quote) {
        if (quote === "'" && line[i + 1] === "'") { i++; continue }   // YAML: '' 表示一个单引号
        quote = ''
      }
      continue
    }
    if (c === "'" || c === '"') { quote = c; continue }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i)
  }
  return line
}

/** F3① 判定：文本里是否有该插件的**非注释条目**（只回布尔，**绝不把文本带出去**）。
 *  PRD §3.2 F3① 的语义是「profile patch 是否含该插件**条目**」——注释里的提及不算命中
 *  （例：`# 2026-10-04 已摘除 @deepseek-ai/dsh-client-ui-voice` 是摘除记录，不是回流信号）。
 *  实现按 YAML 行内注释规则**逐行截断**后匹配（行首注释与行内尾随注释都丢弃），
 *  **不引入 YAML 解析**（避免新风险）；引号字符串内的提及仍算命中（与 PRD「条目」口径的
 *  已知偏差：把 `note: "@deepseek-ai/dsh-client-ui-voice"` 这类任意字符串值当条目，
 *  要区分它需要完整 YAML 解析，本 REQ 不做）。 */
export function textMentionsLegacyEntry(text: unknown): boolean {
  if (typeof text !== 'string') return false
  const entryText = text.split('\n').map(stripYamlLineComment).join('\n')
  return textMentionsLegacy(entryText)
}

/** 枚举 loader entries（取 `entry.options.name`）判断旧插件是否已加载；枚举异常一律视为未命中 */
export function detectLegacyLoaded(entries: Iterable<any>): boolean {
  try {
    for (const entry of entries) if (parseLegacyMatch(entry?.options?.name)) return true
  } catch { /* 枚举失败 → 未命中（不外抛） */ }
  return false
}

/** 自检产物（字段白名单恰好这 6 个；只允许布尔/字符串枚举） */
export type VoiceCheckPayload = {
  time: string
  patchHasLegacy: boolean
  catalogHasLegacy: boolean
  legacyLoaded: boolean
  catalogChecked: boolean
  conclusion: string
}

/** 产物字段名白名单（测试与复核用；顺序即产物字段顺序） */
export const VOICE_CHECK_FIELDS = ['time', 'patchHasLegacy', 'catalogHasLegacy', 'legacyLoaded', 'catalogChecked', 'conclusion'] as const

/** conclusion 枚举（异常只体现为 catalogChecked:false，不把错误原文写进产物） */
export const VOICE_CHECK_CONCLUSIONS = ['legacy-loaded', 'legacy-present', 'clean', 'catalog-unchecked'] as const

/** 只按入参构造产物：不读文件、不带原文；缺省/非布尔一律按 false（异常不外抛） */
export function buildCheckPayload(input: {
  time?: unknown
  patchHasLegacy?: unknown
  catalogHasLegacy?: unknown
  legacyLoaded?: unknown
  catalogChecked?: unknown
}): VoiceCheckPayload {
  const patchHasLegacy = input.patchHasLegacy === true
  const catalogHasLegacy = input.catalogHasLegacy === true
  const legacyLoaded = input.legacyLoaded === true
  const catalogChecked = input.catalogChecked === true
  const conclusion = legacyLoaded ? 'legacy-loaded'
    : (patchHasLegacy || catalogHasLegacy) ? 'legacy-present'
      : catalogChecked ? 'clean' : 'catalog-unchecked'
  return {
    time: typeof input.time === 'string' && input.time ? input.time : new Date().toISOString(),
    patchHasLegacy,
    catalogHasLegacy,
    legacyLoaded,
    catalogChecked,
    conclusion,
  }
}

/** 只透出白名单字段（防产物被外部篡改后把任意内容回显给页面） */
export function pickVoiceCheckFields(doc: any): VoiceCheckPayload | null {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null
  return buildCheckPayload({
    time: typeof doc.time === 'string' ? doc.time : '',
    patchHasLegacy: doc.patchHasLegacy,
    catalogHasLegacy: doc.catalogHasLegacy,
    legacyLoaded: doc.legacyLoaded,
    catalogChecked: doc.catalogChecked,
  })
}

/** 命中（已加载 / 可一键装回 / profile 配置里出现）时的告警：三点必须齐全 */
export const LEGACY_VOICE_WARNING =
  '[dsh-worktable] ⚠️ 检测到旧语音插件 @deepseek-ai/dsh-client-ui-voice 的回流信号：' +
  '① 装回会与本地桥 /api/voice/asr 静默遮蔽（exact 优先于 /api 前缀，用户无感知）；' +
  '② 它的 ASR/TTS 走云（豆包 ASR volc.bigasr.auc_turbo + 豆包 TTS + ark）→ 静默计费；' +
  '③ 主路径（输入框麦克风 + 工作台）已覆盖需求，勿装回。'

/** catalog 候选路径：env `DSH_HOST_BUNDLED_PLUGINS_ROOT` → 宿主可执行文件相邻 → Slark 硬编码兜底 */
export function catalogCandidates(env: Record<string, string | undefined>, execPath: string): string[] {
  const out: string[] = []
  const root = typeof env?.DSH_HOST_BUNDLED_PLUGINS_ROOT === 'string' ? env.DSH_HOST_BUNDLED_PLUGINS_ROOT.trim() : ''
  if (root) out.push(pathResolve(root, 'catalog.v1.json'))
  if (typeof execPath === 'string' && execPath) out.push(pathResolve(dirname(execPath), '..', 'dsh-default-plugins', 'catalog.v1.json'))
  out.push('/Applications/Slark.app/Contents/Resources/dsh-default-plugins/catalog.v1.json')
  return Array.from(new Set(out))
}

/** 依次尝试候选文件，返回第一个可读内容；全都读不到 → null（静默降级，不抛错） */
export function firstReadable(candidates: string[], read: (p: string) => string): string | null {
  for (const file of candidates) {
    try { return read(file) } catch { /* 试下一个 */ }
  }
  return null
}

/** F5 开关的 error 短枚举（**不含路径/内容**：日志与页面只回这个枚举） */
export const VOICE_CONFIG_ERRORS = ['bad-json', 'not-object', 'not-boolean', 'read-failed'] as const
export type VoiceConfigError = typeof VOICE_CONFIG_ERRORS[number]

/** F5 开关状态（CR-23118 ③：非法值不再静默）。
 *  - 缺文件 → `{voiceAsrEnabled:true, exists:false, source:'default'}`（默认行为保留，**不标 invalid**）；
 *  - 文件存在但坏 JSON / 非对象 / 值非布尔 → `invalid:true` + `voiceAsrEnabled` 用默认 `true` + `error` 短枚举；
 *  - 值合法布尔 → 原值，**不出现 invalid**（`false` 也如实回 `false`）。
 *  `source` 表示**生效值**的来源：读到合法布尔为 `'file'`，其余（缺文件/非法回落）为 `'default'`。 */
export type VoiceConfigStatus = {
  voiceAsrEnabled: boolean
  exists: boolean
  source: 'file' | 'default'
  invalid?: true
  error?: VoiceConfigError
}

/** F5 开关解析：`{"voiceAsrEnabled": bool}` → 原值；坏 JSON / 非对象 / 非布尔 → 默认 true + invalid 标记。
 *  入参非字符串（未读到内容）视为「没有配置」→ 默认 true，**不标 invalid**（与缺文件同口径）。 */
export function parseVoiceConfig(raw: unknown): { voiceAsrEnabled: boolean; invalid?: true; error?: VoiceConfigError } {
  if (typeof raw !== 'string') return { voiceAsrEnabled: true }
  let doc: any
  try { doc = JSON.parse(raw) } catch { return { voiceAsrEnabled: true, invalid: true, error: 'bad-json' } }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { voiceAsrEnabled: true, invalid: true, error: 'not-object' }
  if (typeof doc.voiceAsrEnabled !== 'boolean') return { voiceAsrEnabled: true, invalid: true, error: 'not-boolean' }
  return { voiceAsrEnabled: doc.voiceAsrEnabled }
}

/** 读 F5 开关文件：`$DSH_HOME/worktable-voice.json`。
 *  缺文件/读失败 → 默认 true + `exists:false`（读失败另外标 `invalid:true` + `error:'read-failed'`）；
 *  读到了就交给 `parseVoiceConfig` 区分「合法 / 非法」——非法时标 invalid，值仍用默认 true。 */
function loadVoiceConfig(): VoiceConfigStatus {
  const file = pathResolve(resolveDshHomeSafe(), 'worktable-voice.json')
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    if (existsSync(file)) {
      return { voiceAsrEnabled: true, exists: true, source: 'default', invalid: true, error: 'read-failed' }
    }
    return { voiceAsrEnabled: true, exists: false, source: 'default' }
  }
  const parsed = parseVoiceConfig(raw)
  if (parsed.invalid) return { voiceAsrEnabled: parsed.voiceAsrEnabled, exists: true, source: 'default', invalid: true, error: parsed.error }
  return { voiceAsrEnabled: parsed.voiceAsrEnabled, exists: true, source: 'file' }
}

/** 配置非法时的宿主告警（CR-23118 ③）：只含**短枚举**与固定文件名，
 *  **不含文件内容、不含绝对路径**（不得把配置原文带进日志）。 */
export function voiceConfigInvalidWarning(error: string): string {
  return '[dsh-worktable] ⚠️ 语音开关配置无效（$DSH_HOME/worktable-voice.json：' + error +
    '）→ voiceAsrEnabled 已按默认 true 生效；请修正该文件（或删掉它走默认）'
}

/* ── F2 本地转写桥（REQ-20261008-0010）─────────────────────────────────────
 * duet 桌面云桥不可用时回落到 `POST /api/voice/asr`（M0 实测：20s 内 5+ 次命中，
 * `audio/wav` + `x-voice-mode: duet`）→ 本桥把该 WAV 直接交给宿主本地 `speechToText`
 * （`resolve` → `transcribe`），**只转发不落盘**：不写文件、不记正文、不上云。
 * 失败/超时/停用一律回 `200 {"text":""}`，让 duet 侧保持 `unavailable`（显式失败、
 * 不编造）——**绝不**回 5xx 让 duet 抛异常（PRD §3.2 F2）。
 * ─────────────────────────────────────────────────────────────────────── */

/** 桥内单段上限：与官方 `api-speech-to-text` 的 `maxAudioBytes` 默认值一致（4MiB）。 */
export const VOICE_ASR_MAX_BYTES = 4 * 1024 * 1024
/** 桥内转写超时：duet fetch 上限 20s，桥内取 ≤15s（PRD §3.2 F2 / §5.1）。 */
export const VOICE_ASR_TIMEOUT_MS = 15000
/** 桥回空文本的原因短枚举（日志只回这个，**不含音频内容 / 不含路径**）。 */
export const VOICE_ASR_REASONS = ['disabled', 'rejected', 'unavailable', 'failed'] as const
export type VoiceAsrReason = typeof VOICE_ASR_REASONS[number]

/** 桥的上限判定（沿用官方 `validateWave` 的**大小**语义）：
 *  - 必须 `byteLength > 44`（WAV 头 44B；与 duet 渲染侧 `parseDshVoiceRequest` 同口径）；
 *  - 必须 `byteLength ≤ maxBytes`（默认 4MiB，同官方 `maxAudioBytes`）。
 *  头部规范性与 120s 时长由 provider 的 `validateWave` 负责——那类非法音频会在
 *  `transcribe` 里抛错、同样落到「识别为空」，故这里**不**重复校验头，
 *  以免把 duet 的合法音频误判成空文本（那会让桥变死代码）。 */
export function checkVoiceWaveBounds(bytes: unknown, maxBytes: number = VOICE_ASR_MAX_BYTES): boolean {
  const n = (bytes as { byteLength?: unknown } | null | undefined)?.byteLength
  return typeof n === 'number' && Number.isFinite(n) && n > 44 && n <= maxBytes
}

/** 桥的宿主日志行（一行、固定文案 + 短枚举；**不含音频内容/字节数/路径**）。 */
export function voiceAsrLogLine(reason: VoiceAsrReason | string): string {
  return '[dsh-worktable] /api/voice/asr 本地转写桥：' + reason + '（返回空文本；音频不落盘）'
}

/** 读原始请求体：桥的载荷是 WAV 字节（**不是** JSON，不能用 readJsonBody）。 */
async function readRawBody(req: any): Promise<Uint8Array> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  return new Uint8Array(Buffer.concat(chunks))
}

/** 进程内按文件路径串行化：同一路径的「读—改—写」排队执行（CR-23118 ②：防并发丢更新）。
 *  - 前一个任务失败也继续跑下一个（队列不因单次失败卡死）；
 *  - 调用方拿到自己那次任务的真实结果/异常；队列尾只存吞掉异常的空链，避免 unhandled rejection。 */
const fileQueues = new Map<string, Promise<unknown>>()
export function withFileLock<T>(file: string, task: () => Promise<T>): Promise<T> {
  const prev = fileQueues.get(file) ?? Promise.resolve()
  const run = prev.then(task, task)
  fileQueues.set(file, run.then(() => undefined, () => undefined))
  return run
}

/** 原子落盘：同目录临时文件 + `rename` 替换（POSIX rename 原子，读者见到的是完整新旧版本之一）。
 *  临时文件是新建的 → `mode`（0600）生效，rename 后目标文件即该权限（保留既有语义）；
 *  rename 失败先清理临时文件再重抛（错误交给调用方既有的 catch）。 */
export async function writeFileAtomic(file: string, data: string, mode: number): Promise<void> {
  const fsx = await import('node:fs/promises')
  const tmp = pathResolve(dirname(file), '.' + basename(file) + '.' + process.pid + '.' + Date.now().toString(36) + '.' + Math.random().toString(36).slice(2, 8) + '.tmp')
  await fsx.writeFile(tmp, data, { encoding: 'utf8', mode })
  try {
    await fsx.rename(tmp, file)
  } catch (err) {
    try { await fsx.unlink(tmp) } catch { /* 清理失败忽略 */ }
    throw err
  }
}

/** F1 埋点增量归一：非数字/负值 → 0；单次上限 1000（防一次请求把计数写爆） */
export function normalizeDraftTake(value: unknown): number {
  return Math.max(0, Math.min(1000, Math.floor(Number(value) || 0)))
}

function voiceCheckLogPath(): string { return pathResolve(resolveDshHomeSafe(), 'logs', 'dsh-worktable-check.json') }

/** 当前 profile 名：宿主注入 DSH_PROFILE；缺省 'web'（本 REQ 的目标 profile） */
function currentProfileName(): string {
  const p = process.env.DSH_PROFILE
  return typeof p === 'string' && p.trim() ? p.trim() : 'web'
}

/** profile 的 cordis.patch.yml 候选路径（**只用于判存在性，内容绝不外带**） */
export function patchCandidates(env: Record<string, string | undefined>, home: string, profile: string): string[] {
  const explicit = typeof env?.DSH_PROFILE_DIR === 'string' ? env.DSH_PROFILE_DIR.trim() : ''
  const out: string[] = []
  if (explicit) out.push(pathResolve(explicit, 'cordis.patch.yml'))
  out.push(pathResolve(home, 'profiles', profile, 'cordis.patch.yml'))
  return Array.from(new Set(out))
}

/** 本轮自检结果（供只读路由在产物缺失时兜底；仅白名单字段） */
let lastVoiceCheckPayload: VoiceCheckPayload | null = null

/** 采集一次自检结果（同步；任何异常都被吞成 false / null，不外抛原文） */
function collectVoiceCheck(ctx: any, time: string): VoiceCheckPayload {
  const read = (p: string) => readFileSync(p, 'utf8')
  let catalogText: string | null = null
  let patchText: string | null = null
  try { catalogText = firstReadable(catalogCandidates(process.env, process.execPath), read) } catch { catalogText = null }
  try { patchText = firstReadable(patchCandidates(process.env, resolveDshHomeSafe(), currentProfileName()), read) } catch { patchText = null }
  let loaded = false
  try {
    const loader: any = (ctx as any)?.get?.('loader') ?? null
    if (loader && typeof loader.entries === 'function') loaded = detectLegacyLoaded(loader.entries())
  } catch { loaded = false }
  return buildCheckPayload({
    time,
    patchHasLegacy: textMentionsLegacyEntry(patchText),   // 只认非注释条目（注释提及不算命中）
    catalogHasLegacy: textMentionsLegacy(catalogText),
    catalogChecked: typeof catalogText === 'string',   // 目录/文件不存在 → false（静默降级）
    legacyLoaded: loaded,
  })
}

/** 启动自检：写产物 + 命中告警。
 *  - 用 `setTimeout(…, 0)` 推迟到当前 tick 之后 → 异步、不阻塞、失败不影响插件加载；
 *  - 1.5s 后再补一次：loader 的 entry 是加载过程中逐个建的，首轮枚举可能还没建全（防漏报）；
 *  - 产物含且仅含白名单 6 字段，异常只体现为 catalogChecked:false / 产物缺失。 */
function scheduleVoiceCheck(ctx: any): void {
  const time = new Date().toISOString()
  let warned = false   // 每轮启动最多告警一次（两趟自检不重复刷日志）
  const run = () => {
    void (async () => {
      try {
        const payload = collectVoiceCheck(ctx, time)
        lastVoiceCheckPayload = payload
        try {
          const file = voiceCheckLogPath()
          await mkdir(dirname(file), { recursive: true })
          await writeFile(file, JSON.stringify(payload, null, 2) + '\n', 'utf8')
        } catch { /* 落盘失败不影响插件加载 */ }
        if (!warned && (payload.legacyLoaded || payload.catalogHasLegacy || payload.patchHasLegacy)) {
          warned = true
          try { ctx.logger?.warn?.(LEGACY_VOICE_WARNING) } catch { /* 日志失败忽略 */ }
        }
      } catch { /* 自检整体失败：不影响插件加载 */ }
    })()
  }
  try {
    setTimeout(run, 0)
    setTimeout(run, 1500)
  } catch { /* 定时器不可用：放弃自检，不影响插件加载 */ }
}

/* ── 路径策略 ─────────────────────────────────────────────────────────────
 * 1) 敏感路径黑名单：读写都拒（凭据 / 私钥 / 钥匙串）。
 * 2) 可写根白名单：客户端上报的项目文件夹（POST /api/worktable/roots），
 *    持久化在 DSH_HOME；write / mkdir 必须落在某个根之内。
 *    白名单为空（首次运行、客户端还没上报）时只查黑名单，避免把功能打死。
 * ─────────────────────────────────────────────────────────────────────── */
const SENSITIVE_SEGMENTS = ['.ssh', '.aws', '.gnupg', '.netrc', '.git-credentials', 'keychains', '.config/gh']
let writableRoots: string[] = []

function rootsFilePath(): string { return pathResolve(resolveDshHomeSafe(), 'worktable-roots.json') }

function loadWritableRoots(): void {
  try {
    const d = JSON.parse(readFileSync(rootsFilePath(), 'utf8'))
    if (Array.isArray(d?.folders)) {
      writableRoots = d.folders.filter((x: unknown): x is string => typeof x === 'string' && x.length > 0)
    }
  } catch { /* 没有 / 坏了都当空 */ }
}

function saveWritableRoots(): void {
  try { writeFileSync(rootsFilePath(), JSON.stringify({ folders: writableRoots }, null, 1)) } catch { /* 落盘失败不影响本次放行 */ }
}

/** 归一化后按路径段匹配敏感目录，避免 .. 与分隔符花样绕过 */
function isSensitivePath(abs: string): boolean {
  const p = abs.replace(/\\/g, '/')
  return SENSITIVE_SEGMENTS.some((seg) => p.includes('/' + seg + '/') || p.endsWith('/' + seg))
}

/** 取「最近的存在祖先」做 realpath，消除符号链接造成的越界 */
function realAncestor(abs: string): string {
  let cur = abs
  for (let i = 0; i < 64; i++) {
    try { return realpathSync(cur) } catch { /* 不存在就往上一层 */ }
    const up = pathResolve(cur, '..')
    if (up === cur) return cur
    cur = up
  }
  return abs
}

/** write / mkdir 的放行判定；返回字符串表示拒绝原因 */
function writePathReject(abs: string): string | undefined {
  if (isSensitivePath(abs)) return 'sensitive path'
  if (writableRoots.length === 0) return undefined
  const real = realAncestor(abs)
  const inside = writableRoots.some((r) => {
    const rr = realAncestor(pathResolve(r))
    return real === rr || real.startsWith(rr.endsWith('/') ? rr : rr + '/')
  })
  return inside ? undefined : 'outside project folders'
}

async function readJsonBody(req: any): Promise<any> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  try { return JSON.parse(text) } catch { return {} }
}

/** 列出一个目录层级（目录在前、大小写不敏感排序、上限 500、隐藏项标注） */
async function listDirectory(path: string) {
  const abs = pathResolve(path)
  const dirents = await readdir(abs, { withFileTypes: true })
  const entries = dirents
    .map((d) => ({ name: d.name, path: abs + sep + d.name, isDir: d.isDirectory(), hidden: d.name.startsWith('.') }))
    .sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })
  const truncated = entries.length > MAX_ENTRIES
  return { path: abs, entries: truncated ? entries.slice(0, MAX_ENTRIES) : entries, truncated }
}

function gitExec(args: string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', args, { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err)
      else resolvePromise(stdout)
    })
  })
}

/** git 状态快照（porcelain v1 -z；非仓库返回 isRepo:false） */
async function gitStatus(cwd: string) {
  try {
    const branchRaw = await gitExec(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
    const porcelain = await gitExec(['status', '--porcelain=v1', '-z'], cwd)
    const entries = porcelain
      .split('\0')
      .filter((s) => s.length > 2)
      .map((s) => ({ xy: s.slice(0, 2), path: s.slice(3) }))
    return { isRepo: true, branch: branchRaw.trim() || 'HEAD', entries }
  } catch {
    return { isRepo: false, branch: undefined, entries: [] }
  }
}

/** 终端 WebSocket 升级路由（同步注册 + ctx.effect，同 better-sidebar；node-pty 缺失时不注册） */
function setupTerminal(webServer: any, ctx: any) {
  if (typeof webServer.registerUpgrade !== 'function') return
  const wsMod = loadPkg('ws')
  const ptyMod = loadPkg('node-pty')
  ctx.logger?.info?.('[dsh-worktable] term deps: ws=' + (wsMod ? 'ok' : 'MISSING') + ' node-pty=' + (ptyMod ? 'ok' : 'MISSING'))
  if (!wsMod || !ptyMod) {
    ctx.logger?.warn('[dsh-worktable] 终端路由未注册：ws/node-pty 不可用')
    return
  }
  const WebSocketServer = wsMod.WebSocketServer ?? wsMod.default?.WebSocketServer
  if (!WebSocketServer) return
  const pty = ptyMod.default ?? ptyMod
  const wss = new WebSocketServer({ noServer: true })
  const spawnShell = (): { cmd: string; args: string[] } =>
    process.platform === 'win32'
      ? { cmd: 'powershell.exe', args: ['-NoLogo', '-NoProfile'] } // -NoProfile：跳过用户配置（oh-my-posh 花哨提示符在 xterm 里是乱码，PSReadLine 长输入行不换行被截断）
      : { cmd: process.env.SHELL || '/bin/bash', args: [] }
  const clampDim = (v: number, fallback: number) => Math.min(1024, Math.max(2, Number.isFinite(v) ? v : fallback))

  ctx.effect(() => webServer.registerUpgrade({
    path: '/api/worktable/term',
    handler: (req: any, socket: any, head: any) => {
      // WebSocket 升级同样必须先过鉴权（裸 upgrade 路由不受 Typert 网关保护）
      const reject = authRejectCode(ctx, req)
      if (reject !== undefined) {
        try {
          socket.write('HTTP/1.1 ' + reject + (reject === 401 ? ' Unauthorized' : ' Forbidden') +
            '\r\ncontent-length: 0\r\nconnection: close\r\n\r\n')
        } catch { /* socket 可能已断 */ }
        try { socket.destroy() } catch { /* 同上 */ }
        return
      }
      wss.handleUpgrade(req, socket, head, (ws: any) => {
        const u = new URL(req.url ?? '/', 'http://dsh.internal')
        const cwd = serverCwd(ctx, u.searchParams.get('sessionId') || undefined, u.searchParams.get('cwd') || undefined)
        const cols = clampDim(Number(u.searchParams.get('cols')), 80)
        const rows = clampDim(Number(u.searchParams.get('rows')), 24)
        let term: any = null
        try {
          const shell = spawnShell()
          term = pty.spawn(shell.cmd, shell.args, { name: 'xterm-256color', cols, rows, cwd, env: process.env })
        } catch (err) {
          try { ws.send('\r\n[worktable] 终端启动失败：' + String(err)) } catch {}
          try { ws.close() } catch {}
          return
        }
        term.onData((d: string) => { try { ws.send(d) } catch {} })
        term.onExit(() => { try { ws.close() } catch {} })
        ws.on('message', (raw: any) => {
          const text = String(raw)
          try {
            const msg = JSON.parse(text)
            if (msg && msg.type === 'resize' && Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
              term.resize(clampDim(msg.cols, cols), clampDim(msg.rows, rows))
              return
            }
          } catch {}
          try { term.write(text) } catch {}
        })
        ws.on('close', () => { try { term.kill() } catch {} })
      })
    },
  }), 'dsh-worktable: terminal upgrade')
}

/** 本机配置候选路径（03_local/*.json：.gitignore 的本机目录，不入库）。
 *  查找顺序：环境变量 DSH_WORKTABLE_LOCAL_DIR（指向配置目录）→ <插件根>/03_local →
 *  仓库根/03_local → 仓库上一层/03_local（相对深度都试，避免放错一层）。
 *  个人绝对路径只存在于这些配置文件里，src/、README、package.json 与打包产物中零出现。 */
function localConfigPaths(fileName: string): string[] {
  const libDir = dirname(fileURLToPath(import.meta.url))
  const out: string[] = []
  const envDir = process.env.DSH_WORKTABLE_LOCAL_DIR
  if (typeof envDir === 'string' && envDir.trim()) out.push(pathResolve(envDir.trim(), fileName))
  out.push(pathResolve(libDir, '..', '03_local', fileName))
  out.push(pathResolve(libDir, '..', '..', '03_local', fileName))
  out.push(pathResolve(libDir, '..', '..', '..', '03_local', fileName))
  return out
}

/** 按候选路径读本机配置里的一个字符串字段（只读、绝不抛错）：
 *  文件缺失 / 坏 JSON / 字段缺失或空串 → 继续试下一个候选；全都没命中 → null。 */
async function readLocalConfigField(fileName: string, field: string): Promise<string | null> {
  for (const file of localConfigPaths(fileName)) {
    try {
      const raw = await readFile(file, 'utf8')
      // 容忍 BOM（外部工具改写可能带 EF BB BF，JSON.parse 会抛错）
      const parsed = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw)
      const value = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>)[field] : undefined
      const text = typeof value === 'string' ? value.trim() : ''
      if (text) return text
    } catch {}
  }
  return null
}

export function apply(ctx: Context) {
  const webServer = (ctx as any).webServer
  if (!webServer) {
    ctx.logger?.warn('[dsh-worktable] ctx.webServer 不可用（headless profile？），跳过服务端路由')
    return
  }

  // 所有 HTTP 路由统一经 guarded() 鉴权后再注册（见文件顶部的 authRejectCode 注释）。
  // 用 bind 保留原函数引用，避免下方 replace 后的 register 递归调用自己。
  const registerRoute = webServer.register.bind(webServer)
  const register = (route: any) => registerRoute({ ...route, handler: guarded(ctx, route.handler) })
  loadWritableRoots()

  register({
    kind: 'exact',
    path: HEALTH_PATH,
    handler: (_req: any, res: any) => {
      json(res, 200, { plugin: 'dsh-worktable', version: PLUGIN_VERSION, ok: true })
    },
  })

  // 客户端上报「当前项目的文件夹」→ 作为 write / mkdir 的可写根白名单。
  // 本路由同样受鉴权保护：只有已登录的页面能设置，别的用户/页面改不了。
  register({
    kind: 'exact',
    path: '/api/worktable/roots',
    handler: async (req: any, res: any) => {
      try {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        const body = await readJsonBody(req)
        const folders = Array.isArray(body?.folders)
          ? body.folders.filter((x: unknown): x is string => typeof x === 'string' && x.length > 0)
          : []
        // 空列表不清空已有白名单（避免一次误报把保护关掉）
        if (folders.length > 0) {
          writableRoots = Array.from(new Set([...folders.map((f: string) => pathResolve(f)), ...writableRoots]))
          saveWritableRoots()
        }
        json(res, 200, { ok: true, roots: writableRoots.length })
      } catch (err) { json(res, 500, { error: String(err) }) }
    },
  })

  // 本地文件读取（资源管理器点击 .html 后浏览器标签内打开）
  register({
    kind: 'exact',
    path: '/api/worktable/file',
    handler: async (req: any, res: any) => {
      try {
        const u = new URL(req.url ?? '/', 'http://dsh.internal')
        const p = u.searchParams.get('path') || ''
        if (!p) { json(res, 400, { error: 'missing path' }); return }
        const abs = pathResolve(p)
        if (isSensitivePath(abs)) { json(res, 403, { error: 'sensitive path' }); return }
        const stat = await import('node:fs/promises').then((m) => m.stat(abs))
        if (stat.size > 20 * 1024 * 1024) { json(res, 413, { error: 'file too large' }); return }
        const data = await readFile(abs)
        const ext = (abs.split('.').pop() || '').toLowerCase()
        const types: Record<string, string> = {
          html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
          css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
          json: 'application/json; charset=utf-8', md: 'text/markdown; charset=utf-8', markdown: 'text/markdown; charset=utf-8', txt: 'text/plain; charset=utf-8', log: 'text/plain; charset=utf-8',
          pdf: 'application/pdf', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon',
        }
        res.writeHead(200, { 'content-type': FILE_TYPES[ext] ?? 'application/octet-stream', 'cache-control': 'no-store' })
        res.end(data)
      } catch (err) {
        json(res, 404, { error: String(err) })
      }
    },
  })

  // 本地站点（目录级静态托管）：点开 index.html 时挂载整个所在目录，
  // 让 ./assets/... 等相对引用正常解析（前缀路由，余下路径 = <rootToken>/<相对路径>）。
  // 原生皮肤模板：HTML 骨架 + 设计系统样式表（随插件分发，主题自动适配）
  register({
    kind: 'prefix',
    path: TEMPLATE_PREFIX,
    handler: (req: any, res: any) => {
      try {
        if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
        const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
        const rel = pathname.slice(TEMPLATE_PREFIX.length)
        if (rel === '/dshell.css') {
          res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' })
          res.end(dshellCss)
        } else {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          res.end(dshellHtml)
        }
      } catch (err) {
        res.writeHead(404); res.end(String(err))
      }
    },
  })

  register({
    kind: 'prefix',
    path: SITE_PREFIX,
    handler: async (req: any, res: any) => {
      try {
        if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
        const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
        const segs = pathname.slice(SITE_PREFIX.length).split('/').filter(Boolean)
        const rootToken = decodeURIComponent(segs.shift() ?? '')
        const rel = segs.map((s) => { try { return decodeURIComponent(s) } catch { return s } }).join('/')
        if (!rootToken) { json(res, 400, { error: 'missing root' }); return }
        const root = pathResolve(rootToken)
        let abs = pathResolve(root, rel)
        if (abs !== root && !abs.startsWith(root + sep)) { json(res, 403, { error: 'outside root' }); return }
        if (isSensitivePath(abs)) { json(res, 403, { error: 'sensitive path' }); return }
        const statMod = await import('node:fs/promises')
        let info = await statMod.stat(abs).catch(() => null)
        if (info && info.isDirectory()) {
          abs = pathResolve(abs, 'index.html')
          info = await statMod.stat(abs).catch(() => null)
        }
        if (!info || !info.isFile()) { json(res, 404, { error: 'not found' }); return }
        if (info.size > 40 * 1024 * 1024) { json(res, 413, { error: 'file too large' }); return }
        const data = await readFile(abs)
        const ext = (abs.split('.').pop() || '').toLowerCase()
        res.writeHead(200, { 'content-type': FILE_TYPES[ext] ?? 'application/octet-stream', 'cache-control': 'no-store' })
        res.end(data)
      } catch (err) {
        json(res, 404, { error: String(err) })
      }
    },
  })

  register({
    kind: 'exact',
    path: '/api/worktable/fs',
    handler: async (req: any, res: any) => {
      try {
        const body = await readJsonBody(req)
        const path = typeof body.path === 'string' && body.path
          ? body.path
          : serverCwd(ctx, body.sessionId, body.cwd)
        const absFs = pathResolve(path)
        if (isSensitivePath(absFs)) { json(res, 403, { path: '', entries: [], truncated: false, error: 'sensitive path' }); return }
        json(res, 200, await listDirectory(absFs))
      } catch (err) {
        json(res, 500, { path: '', entries: [], truncated: false, error: String(err) })
      }
    },
  })

  // 本机路径配置（03_local/local.json）：只读下发云状态文件路径；
  // 未配置/读不到 → 200 { cloudState: null }，客户端据此整体停用云同步（本地状态不受影响）。
  register({
    kind: 'exact',
    path: '/api/worktable/local-paths',
    handler: async (_req: any, res: any) => {
      json(res, 200, { cloudState: await readLocalConfigField('local.json', 'cloudStatePath') })
    },
  })

  // 用户级记忆（语音术语表等）：给工作台页面用 —— 页面读不到 DSH_HOME（不能把 profile 路径写死在页面里，
  // 见 REQ-20261008-0006 缺陷 #9），故由插件按 DSH_HOME 解析后提供。
  // 只允许白名单文件名；GET 读；POST 只接受一种写入：记一次纠错 {"corrected":{"<错误写法>":<n>}}。
  // 本路由与其它路由一样经 guarded() 鉴权（cookie + Host/Origin 围栏）。
  const USER_MEMORY_FILES = ['speech.json', 'facts.json', 'procedures.json']
  register({
    kind: 'exact',
    path: '/api/worktable/user-memory',
    handler: async (req: any, res: any) => {
      try {
        const u = new URL(req.url ?? '/', 'http://dsh.internal')
        const name = u.searchParams.get('name') || 'speech.json'
        if (!USER_MEMORY_FILES.includes(name)) { json(res, 403, { error: 'name not allowed' }); return }
        const file = pathResolve(resolveDshHomeSafe(), 'memory', 'user', name)

        if (req.method === 'GET') {
          try {
            const raw = await readFile(file, 'utf8')
            json(res, 200, { name, path: file, exists: true, content: JSON.parse(raw) })
          } catch (err) {
            // 文件不存在不算错误：页面据此提示"术语表还没建"
            json(res, 200, { name, path: file, exists: false, error: String(err) })
          }
          return
        }

        if (req.method === 'POST') {
          const body = await readJsonBody(req)
          const delta = body && typeof body.corrected === 'object' && body.corrected ? body.corrected : null
          const learn = body && body.learn && typeof body.learn === 'object' ? body.learn : null
          // REQ-20261008-0010 F1 埋点：点「📥 取输入框草稿」→ {"draftTake":1}。
          // 与 corrected / learn 并列，三者可同时出现；读取仍走本路由的 GET（content.stats.draftTakes）。
          const draftTake = normalizeDraftTake(body && body.draftTake)
          if (!delta && !learn && !draftTake) { json(res, 400, { error: 'expect {corrected:{"<wrong>":<n>}} 、 {learn:{wrong,right}} 或 {draftTake:1}' }); return }
          // CR-23118 ②：同一文件的「读—改—写」串行化（进程内按路径排队）+ 临时文件 rename 原子替换。
          // corrected / learn / draftTake 共用这一条队列，跨请求不再互相覆盖（响应结构与字段名不变）。
          const out = await withFileLock(file, async (): Promise<{ status: number; body: any }> => {
            let doc: any = null
            try { doc = JSON.parse(await readFile(file, 'utf8')) } catch { /* 见下 */ }
            if (!doc || typeof doc !== 'object') return { status: 404, body: { error: 'user memory file missing or unreadable' } }
            doc.stats = doc.stats && typeof doc.stats === 'object' ? doc.stats : {}

            // ⓪ 主路径采用度计数（F1 · 缺陷 #52：字段名定死 stats.draftTakes）
            if (draftTake) {
              doc.stats.draftTakes = Math.floor(Number(doc.stats.draftTakes) || 0) + draftTake
            }

            // ① 记一次纠错（审计）
            let added = 0
            if (delta) {
              doc.stats.corrected = doc.stats.corrected && typeof doc.stats.corrected === 'object' ? doc.stats.corrected : {}
              for (const [k, v] of Object.entries(delta as Record<string, unknown>)) {
                const n = Math.max(0, Math.min(1000, Math.floor(Number(v) || 0)))
                if (!n) continue
                doc.stats.corrected[k] = Math.floor(Number(doc.stats.corrected[k]) || 0) + n
                added += n
              }
            }

            // ② 学一条纠正（F1 自动学习；缺陷 #20 的根治入口 —— 不依赖 duet 转交，页面/草稿也能学）
            //    规则（Q003）：用户明确纠正才写；条目带 source；幂等（不重复添加）；只写用户级（AC5）
            let learned: any = null
            if (learn) {
              const wrong = typeof learn.wrong === 'string' ? learn.wrong.trim() : ''
              const right = typeof learn.right === 'string' ? learn.right.trim() : ''
              if (!wrong || !right || wrong === right || wrong.length > 40 || right.length > 40) {
                return { status: 400, body: { error: 'learn 需要 {wrong,right}：非空、不相等、各 ≤40 字' } }
              }
              const nowIso = new Date().toISOString()
              const src = { by: 'user', how: String(learn.how || '页面「记下纠正」'), at: nowIso }
              doc.homophones = Array.isArray(doc.homophones) ? doc.homophones : []
              doc.people = Array.isArray(doc.people) ? doc.people : []
              const existed = doc.homophones.some((h: any) => h && h.wrong === wrong && h.right === right)
              if (!existed) doc.homophones.push({ wrong, right, ambiguous: false, source: src })
              let aliasAdded = false
              const person = doc.people.find((p: any) => p && p.canonical === right)
              if (person) {
                person.aliases = Array.isArray(person.aliases) ? person.aliases : []
                if (!person.aliases.includes(wrong)) { person.aliases.push(wrong); aliasAdded = true }
                person.lastUsedAt = nowIso
              } else {
                doc.people.push({ canonical: right, aliases: [wrong], note: '', source: src, lastUsedAt: nowIso })
                aliasAdded = true
              }
              if (!Array.isArray(doc.terms)) doc.terms = []
              if (!doc.terms.includes(right)) doc.terms.push(right)
              learned = { wrong, right, homophoneAdded: !existed, aliasAdded }
            }

            doc.savedAt = Date.now()
            await writeFileAtomic(file, JSON.stringify(doc, null, 2) + '\n', 0o600)
            return {
              status: 200,
              body: {
                ok: true,
                added,
                corrected: (doc.stats && doc.stats.corrected) || {},
                draftTakes: Math.floor(Number(doc.stats && doc.stats.draftTakes) || 0),
                learned,
              },
            }
          })
          json(res, out.status, out.body)
          return
        }

        res.writeHead(405); res.end()
      } catch (err) { json(res, 500, { error: String(err) }) }
    },
  })

  // 旧语音插件自检产物（REQ-20261008-0010 F3）：页面显示一行状态。
  // 产物 = $DSH_HOME/logs/dsh-worktable-check.json；不存在 → 200 {exists:false}（页面友好，不必处理 404）。
  // 回显前一律经 pickVoiceCheckFields() 过白名单，避免产物被篡改后把任意内容带进页面。
  register({
    kind: 'exact',
    path: '/api/worktable/legacy-voice-check',
    handler: async (_req: any, res: any) => {
      try {
        const raw = await readFile(voiceCheckLogPath(), 'utf8')
        const picked = pickVoiceCheckFields(JSON.parse(raw))
        json(res, 200, picked ? { exists: true, ...picked } : { exists: false })
      } catch {
        json(res, 200, lastVoiceCheckPayload ? { exists: true, ...lastVoiceCheckPayload } : { exists: false })
      }
    },
  })

  // F5 开关（REQ-20261008-0010）：只读暴露 $DSH_HOME/worktable-voice.json 的 voiceAsrEnabled。
  // CR-23118 ③：坏 JSON / 非布尔 / 读失败不再静默 —— 回显 invalid:true + error 短枚举（值仍按默认 true），
  // 并写一行宿主告警（日志只含枚举与固定文件名，不含文件内容/绝对路径）。
  const voiceConfig = loadVoiceConfig()
  if (voiceConfig.invalid) {
    try { ctx.logger?.warn?.(voiceConfigInvalidWarning(String(voiceConfig.error || 'invalid'))) } catch { /* 日志失败忽略 */ }
  }
  register({
    kind: 'exact',
    path: '/api/worktable/voice-config',
    handler: (_req: any, res: any) => {
      json(res, 200, voiceConfig)
    },
  })

  // F3 启动自检：异步写产物 + 命中告警（失败不影响插件加载）
  scheduleVoiceCheck(ctx)

  // 公共级时间事实（REQ-20261008-0006 的 F3）：日期/星期/时区由**宿主**给出，不靠模型猜。
  // 与 duet 的 clockLine 同源思路；本路由让页面/agent 都取同一份权威时间。
  // 与其它路由一致，经 guarded() 鉴权。
  register({
    kind: 'exact',
    path: '/api/worktable/now',
    handler: (_req: any, res: any) => {
      const n = new Date()
      const pad2 = (v: number) => String(v).padStart(2, '0')
      const wd = ['日', '一', '二', '三', '四', '五', '六'][n.getDay()]
      const off = -n.getTimezoneOffset()
      const tz = `UTC${off >= 0 ? '+' : '-'}${pad2(Math.floor(Math.abs(off) / 60))}:${pad2(Math.abs(off) % 60)}`
      let tzName = ''
      try { tzName = Intl.DateTimeFormat().resolvedOptions().timeZone } catch { tzName = '' }
      json(res, 200, {
        epoch: n.getTime(),
        iso: n.toISOString(),
        date: `${n.getFullYear()}-${pad2(n.getMonth() + 1)}-${pad2(n.getDate())}`,
        time: `${pad2(n.getHours())}:${pad2(n.getMinutes())}`,
        weekday: '星期' + wd,
        tz,
        tzName,
      })
    },
  })

  // === F2 本地转写桥（REQ-20261008-0010；替换 M0 探针桩，路径不变）===
  // duet 桌面云桥回落时打 POST /api/voice/asr（M0 实测命中）→ 交给宿主本地 speechToText。
  // 只转发不落盘：不写文件、不记正文、不上云；失败/超时/停用一律 200 {"text":""}。
  // 注册包 try/catch：duplicate exact route 等情况**不得让插件 fiber 加载失败**（F5 fail-soft），
  // 失败只记一行日志。
  const voiceAsrLog = (reason: VoiceAsrReason) => {
    try {
      // 停用是**预期的配置态** → info（不是告警）；拒绝/不可用/失败 → warn。
      const line = voiceAsrLogLine(reason)
      if (reason === 'disabled') ctx.logger?.info?.(line)
      else ctx.logger?.warn?.(line)
    } catch { /* 日志失败忽略 */ }
  }
  try {
    register({
      kind: 'exact',
      path: '/api/voice/asr',
      handler: async (req: any, res: any) => {
        // F5 开关（启动时快照）：停用 → 不调用识别，直接空文本 + 一行日志。
        if (!voiceConfig.voiceAsrEnabled) { voiceAsrLog('disabled'); json(res, 200, { text: '' }); return }
        try {
          const bytes = await readRawBody(req)
          // 上限/非法 → 按「识别为空」处理（**不抛给 duet 变成 500**），只留一行日志。
          if (!checkVoiceWaveBounds(bytes)) { voiceAsrLog('rejected'); json(res, 200, { text: '' }); return }
          let svc: any = null
          try { svc = ctx.get?.('speechToText') ?? null } catch { svc = null }
          if (!svc || typeof svc.resolve !== 'function' || typeof svc.transcribe !== 'function') {
            voiceAsrLog('unavailable'); json(res, 200, { text: '' }); return
          }
          const spec = svc.resolve({ audio: bytes, language: 'zh' })            // 同步，返回 {provider,audio,language}
          const { text } = await svc.transcribe(spec, AbortSignal.timeout(VOICE_ASR_TIMEOUT_MS))  // signal 必传
          json(res, 200, { text: typeof text === 'string' ? text : '' })        // 空识别 → ""（不编造）
        } catch {
          // 失败 / 超时 / 服务不可用 → 空文本（duet 侧保持 unavailable：显式失败、不编造）。
          voiceAsrLog('failed')
          json(res, 200, { text: '' })
        }
      },
    })
  } catch (err) {
    // 注册失败（如 duplicate exact route）只记一行：不影响插件 fiber 加载。
    try {
      ctx.logger?.warn?.('[dsh-worktable] /api/voice/asr 注册失败（已跳过；不影响插件加载）：' +
        String((err as any)?.message || err))
    } catch { /* 日志失败忽略 */ }
  }

  // 工作区列表（自定义窗口会话分组用）：
  // 优先走宿主正式服务 ctx.workspaceRegistry（0.1.1/0.1.2 均有，正确感知 DSH_HOME 与存储后端）；
  // 不可用时回退按 resolveDshHomeSafe() 读 storages/workspace.json（只读）。
  // 返回结构是客户端契约，两种来源都映射成同一 shape。
  register({
    kind: 'exact',
    path: '/api/worktable/workspaces',
    handler: async (_req: any, res: any) => {
      try {
        // cordis 对未 inject 服务的属性访问会直接 throw（不返回 undefined），必须 try-catch 探测
        let registry: any = null
        try { registry = (ctx as any).workspaceRegistry ?? null } catch {}
        if (!registry) {
          try { registry = ctx.get?.('workspaceRegistry') ?? null } catch {}
        }
        if (registry && typeof registry.list === 'function') {
          const list = registry.list() ?? []
          const workspaceIds: string[] = []
          const tables: Record<string, { title?: string; sessionIds?: string[] }> = {}
          for (const ws of list) {
            const id = String(ws?.id ?? '')
            if (!id) continue
            workspaceIds.push(id)
            tables[id] = {
              title: typeof ws?.title === 'string' ? ws.title : undefined,
              sessionIds: Array.isArray(ws?.sessionIds) ? ws.sessionIds.map(String) : [],
            }
          }
          let archived: string[] = []
          try { archived = (registry.archivedSessionIds ?? []).map(String) } catch {}
          json(res, 200, {
            unit: { name: 'workspace', version: 2 },
            global: { initialized: true, workspaceIds, archivedSessionIds: archived },
            tables: { workspaces: tables },
          })
          return
        }
        const file = pathResolve(resolveDshHomeSafe(), 'storages', 'workspace.json')
        const raw = await readFile(file, 'utf8')
        // 容忍 BOM（外部工具改写可能带 EF BB BF，JSON.parse 会抛错）
        json(res, 200, JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw))
      } catch (err) {
        json(res, 404, { error: String(err) })
      }
    },
  })

  // 本地文件写入（MD 编辑模式保存回磁盘）
  register({
    kind: 'exact',
    path: '/api/worktable/write',
    handler: async (req: any, res: any) => {
      try {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        const body = await readJsonBody(req)
        const p = typeof body.path === 'string' ? body.path : ''
        const content = typeof body.content === 'string' ? body.content : ''
        if (!p) { json(res, 400, { error: 'missing path' }); return }
        if (content.length > 20 * 1024 * 1024) { json(res, 413, { error: 'content too large' }); return }
        const abs = pathResolve(p)
        const badWrite = writePathReject(abs)
        if (badWrite) { json(res, 403, { error: badWrite }); return }
        await import('node:fs/promises').then((m) => m.writeFile(abs, content, 'utf8'))
        json(res, 200, { ok: true })
      } catch (err) {
        json(res, 500, { error: String(err) })
      }
    },
  })

  // 新建分组：创建目录（仅当父目录已存在，避免递归误建深层垃圾目录）
  register({
    kind: 'exact',
    path: '/api/worktable/mkdir',
    handler: async (req: any, res: any) => {
      try {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        const body = await readJsonBody(req)
        const p = typeof body.path === 'string' ? body.path.trim() : ''
        if (!p) { json(res, 400, { error: 'missing path' }); return }
        const abs = pathResolve(p)
        const badMkdir = writePathReject(abs)
        if (badMkdir) { json(res, 403, { error: badMkdir }); return }
        const fsx = await import('node:fs/promises')
        const parent = dirname(abs)
        try { await fsx.access(parent) } catch { json(res, 400, { error: 'parent not found' }); return }
        await fsx.mkdir(abs)
        json(res, 200, { ok: true, path: abs })
      } catch (err: any) {
        json(res, err?.code === 'EEXIST' ? 200 : 500, err?.code === 'EEXIST' ? { ok: true, exists: true } : { error: String(err) })
      }
    },
  })

  register({
    kind: 'exact',
    path: '/api/worktable/git',
    handler: async (req: any, res: any) => {
      const body = await readJsonBody(req)
      const cwd = serverCwd(ctx, body.sessionId, body.cwd)
      json(res, 200, await gitStatus(cwd))
    },
  })

  setupTerminal(webServer, ctx)
}
