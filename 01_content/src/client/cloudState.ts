/**
 * 云状态文件的合并与历史（纯函数，便于单测）。
 *
 * 背景（2026-10-08 事故 + 2026-10-09 加固）：
 *  - 工作台状态在浏览器里按 origin 隔离，重启换端口即"另一台机器"；云端状态文件是唯一兜底。
 *  - 但原来的推送是**整份覆盖**（后写覆盖先写）：多端口/多机并发写会互相覆盖，
 *    而恢复只在"本地为空"时触发 → 本地有一点内容就跳过恢复，等于丢云端。
 *
 * 本模块给出三个保证：
 *  1) **不丢**：项目状态按 id 做并集合并（layouts/shortcuts/hidden/removed/各 id 映射表/order），
 *     任何一侧出现过的 id 在结果里都存在；同 id 冲突时才按"谁更新"决定。
 *  2) **可回滚**：每次写入把上一份快照压进 history，保留最近 N 份。
 *  3) **绑定也同步**：窗口自动挂载绑定（widgetBindings）按 project/pane 层级并集合并。
 */

/** 云端保留的历史快照份数上限。 */
export const CLOUD_HISTORY_LIMIT = 10

export type CloudSnapshot = {
  updatedAt: string
  projects?: any
  bindings?: Record<string, any> | null
}

export type CloudPayload = {
  view?: any
  projects?: any
  bindings?: Record<string, any> | null
  updatedAt?: string
  history?: CloudSnapshot[]
}

export type LocalCloudState = { view?: any; projects?: any; bindings?: Record<string, any> | null }

const ID_LIST_FIELDS = ['layouts', 'shortcuts'] as const
const ID_MAP_FIELDS = ['lastUsed', 'nameOverrides', 'iconOverrides', 'views', 'bindings', 'folders'] as const
const ID_SET_FIELDS = ['hidden', 'removed'] as const

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)

/** 数组按元素 id 并集：preferred 的顺序在前，另一侧独有的追加在后；同 id 冲突取 preferred 那份。 */
function unionById(list: any[], key: string, other: any[], preferOther: boolean): any[] {
  const out: any[] = []
  const seen = new Set<string>()
  const push = (arr: any[], isPreferred: boolean) => {
    for (const item of arr) {
      const id = item && typeof item === 'object' ? String(item.id ?? '') : ''
      if (!id) continue
      if (seen.has(id)) {
        // 同 id 冲突：非首选侧不覆盖已写入的那份
        if (!isPreferred) continue
        const i = out.findIndex((x) => String(x?.id ?? '') === id)
        if (i >= 0) out[i] = item
        continue
      }
      seen.add(id)
      out.push(item)
    }
  }
  push(preferOther ? other : list, true)
  push(preferOther ? list : other, false)
  return out
}

/** 字符串数组并集（hidden / removed）：保留 preferred 顺序，另一侧独有项追加。 */
function unionStrings(list: unknown, other: unknown, preferOther: boolean): string[] {
  const a = Array.isArray(list) ? list.filter((x) => typeof x === 'string') : []
  const b = Array.isArray(other) ? other.filter((x) => typeof x === 'string') : []
  const first = preferOther ? b : a
  const second = preferOther ? a : b
  const out: string[] = []
  for (const x of [...first, ...second]) if (!out.includes(x)) out.push(x)
  return out
}

/** 记录表并集（含 order 的 id 序列按同样规则处理）：同 key 冲突时按 preferOther 取一侧。 */
function unionMap<T extends Record<string, any>>(local: unknown, remote: unknown, preferOther: boolean): T {
  const a = isObj(local) ? local : {}
  const b = isObj(remote) ? remote : {}
  const out: Record<string, any> = {}
  const keys = [...Object.keys(a), ...Object.keys(b)]
  for (const k of keys) {
    const hasA = Object.prototype.hasOwnProperty.call(a, k)
    const hasB = Object.prototype.hasOwnProperty.call(b, k)
    if (hasA && hasB) out[k] = preferOther ? b[k] : a[k]
    else if (hasA) out[k] = a[k]
    else out[k] = b[k]
  }
  return out as T
}

/**
 * 项目状态并集合并。`preferRemote = true` 表示云端更新（同 id 冲突以云端为准）。
 * 不变量：local 或 remote 中任一存在的 id，结果里都存在（不丢任何一侧的项目/布局/文件夹）。
 */
export function mergeProjects(local: any, remote: any, preferRemote: boolean): any {
  if (!isObj(local) && !isObj(remote)) return remote ?? local ?? {}
  const a = isObj(local) ? local : {}
  const b = isObj(remote) ? remote : {}
  const out: Record<string, any> = {}
  for (const f of ID_LIST_FIELDS) out[f] = unionById(Array.isArray(a[f]) ? a[f] : [], f, Array.isArray(b[f]) ? b[f] : [], preferRemote)
  for (const f of ID_MAP_FIELDS) out[f] = unionMap(a[f], b[f], preferRemote)
  for (const f of ID_SET_FIELDS) out[f] = unionStrings(a[f], b[f], preferRemote)
  // order 是 id 序列：与记录表同规则（优先一侧在前，另一侧独有追加）
  const orderA = Array.isArray(a.order) ? a.order.filter((x: unknown): x is string => typeof x === 'string') : []
  const orderB = Array.isArray(b.order) ? b.order.filter((x: unknown): x is string => typeof x === 'string') : []
  const first = preferRemote ? orderB : orderA
  const second = preferRemote ? orderA : orderB
  const order: string[] = []
  for (const x of [...first, ...second]) if (!order.includes(x)) order.push(x)
  out.order = order
  return out
}

/**
 * 窗口自动挂载绑定并集：{ [projectId]: { [paneId]: WidgetBinding } }。
 * 本地优先（本机当前状态更"真"；例如本地已 revoke 的窗口不应被云端旧记录复活）。
 */
export function mergeBindings(local: unknown, remote: unknown): Record<string, Record<string, any>> {
  const out: Record<string, Record<string, any>> = {}
  for (const src of [isObj(local) ? local : {}, isObj(remote) ? remote : {}]) {
    for (const [projectId, panes] of Object.entries(src)) {
      if (!isObj(panes)) continue
      const bucket = out[projectId] ?? (out[projectId] = {})
      for (const [paneId, b] of Object.entries(panes)) {
        if (!isObj(b)) continue
        if (bucket[paneId] === undefined) bucket[paneId] = b       // 本地先写；云端只补空缺
      }
    }
  }
  return out
}

/** 历史裁剪：新的在前，同 updatedAt 去重，最多保留 limit 份。 */
export function pruneHistory(list: unknown, limit: number = CLOUD_HISTORY_LIMIT): CloudSnapshot[] {
  const arr = Array.isArray(list) ? list : []
  const out: CloudSnapshot[] = []
  const seen = new Set<string>()
  for (const raw of arr) {
    if (!isObj(raw)) continue
    const at = typeof raw.updatedAt === 'string' ? raw.updatedAt : ''
    if (!at || seen.has(at)) continue
    seen.add(at)
    out.push({ updatedAt: at, projects: raw.projects ?? null, bindings: raw.bindings ?? null })
    if (out.length >= Math.max(1, limit)) break
  }
  return out
}

/** 把一份云端 payload 压成历史快照（无内容则 null）。 */
export function snapshotOf(p: CloudPayload | null | undefined): CloudSnapshot | null {
  if (!isObj(p)) return null
  const at = typeof p.updatedAt === 'string' ? p.updatedAt : ''
  if (!at) return null
  if (p.projects == null && p.bindings == null) return null
  return { updatedAt: at, projects: p.projects ?? null, bindings: p.bindings ?? null }
}

/**
 * 生成"推送用的云端 payload"：读到的云端 payload + 本机当前状态 → 合并结果。
 *  - 项目/绑定：并集（不丢）
 *  - view（UI 偏好）：按 updatedAt 较新的一方
 *  - history：把上一份云端快照压入（内容未变则不重复压）
 */
export function mergeCloudState(
  remote: CloudPayload | null | undefined,
  incoming: LocalCloudState,
  now: string,
  limit: number = CLOUD_HISTORY_LIMIT,
): CloudPayload {
  const fresh: CloudPayload = {
    view: incoming.view,
    projects: incoming.projects ?? null,
    bindings: incoming.bindings ?? null,
    updatedAt: now,
    history: [],
  }
  if (!isObj(remote)) return fresh
  const remoteAt = typeof remote.updatedAt === 'string' ? remote.updatedAt : ''
  const preferRemote = !!remoteAt && remoteAt > now
  const prev = snapshotOf(remote)
  const unchanged = !!prev
    && JSON.stringify(prev.projects ?? null) === JSON.stringify(incoming.projects ?? null)
    && JSON.stringify(prev.bindings ?? null) === JSON.stringify(incoming.bindings ?? null)
  return {
    view: preferRemote ? (remote.view ?? incoming.view) : incoming.view,
    projects: mergeProjects(incoming.projects, remote.projects, preferRemote),
    bindings: mergeBindings(incoming.bindings, remote.bindings),
    updatedAt: now,
    history: pruneHistory(unchanged ? (remote.history ?? []) : [prev, ...(remote.history ?? [])], limit),
  }
}

/**
 * 生成"适合写回本地"的状态（启动时的恢复路径）：
 * 与推送同规则合并，但 view 以本地为准（本地没有才用云端），避免把本机 UI 偏好顶掉。
 */
export function mergeIntoLocal(
  remote: CloudPayload | null | undefined,
  local: LocalCloudState,
): { view: any; projects: any; bindings: Record<string, Record<string, any>> } {
  if (!isObj(remote)) return { view: local.view, projects: local.projects, bindings: mergeBindings(local.bindings, null) }
  return {
    view: local.view ?? remote.view,
    projects: mergeProjects(local.projects, remote.projects, false),
    bindings: mergeBindings(local.bindings, remote.bindings),
  }
}
