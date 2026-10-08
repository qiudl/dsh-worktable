import { Context } from '@deepseek-ai/cordis'
import { execFile } from 'node:child_process'
import { readdirSync, realpathSync, readFileSync, writeFileSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, resolve as pathResolve, sep } from 'node:path'
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
          if (!delta) { json(res, 400, { error: 'expect {corrected:{"<wrong>":<n>}}' }); return }
          let doc: any = null
          try { doc = JSON.parse(await readFile(file, 'utf8')) } catch { /* 见下 */ }
          if (!doc || typeof doc !== 'object') { json(res, 404, { error: 'user memory file missing or unreadable' }); return }
          doc.stats = doc.stats && typeof doc.stats === 'object' ? doc.stats : {}
          doc.stats.corrected = doc.stats.corrected && typeof doc.stats.corrected === 'object' ? doc.stats.corrected : {}
          let added = 0
          for (const [k, v] of Object.entries(delta as Record<string, unknown>)) {
            const n = Math.max(0, Math.min(1000, Math.floor(Number(v) || 0)))
            if (!n) continue
            doc.stats.corrected[k] = Math.floor(Number(doc.stats.corrected[k]) || 0) + n
            added += n
          }
          doc.savedAt = Date.now()
          const fsx = await import('node:fs/promises')
          await fsx.writeFile(file, JSON.stringify(doc, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
          json(res, 200, { ok: true, added, corrected: doc.stats.corrected })
          return
        }

        res.writeHead(405); res.end()
      } catch (err) { json(res, 500, { error: String(err) }) }
    },
  })

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
