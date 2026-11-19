/**
 * 宿主侧状态镜像（本地补丁）。
 *
 * 背景：桌面端宿主每次启动都带 `--port 0`（随机端口），页面来源随之变化
 * （如 127.0.0.1:2080 → 127.0.0.1:8494）。浏览器按来源隔离 localStorage /
 * IndexedDB，换端口就等于换一个空库，项目/布局/外观重启后全丢。
 *
 * 做法：把「项目 + 视图」这份 JSON 镜像到宿主侧文件（/api/worktable/state），
 * 启动时若宿主侧比本地新，就用宿主侧恢复。localStorage 仍是第一落点（同步、快），
 * 宿主文件是跨重启的兜底。
 *
 * 两条安全约束（都来自一次真实事故：空状态把宿主文件冲掉）：
 *   1. 读不到宿主状态就**不写**——宁可这次会话只在本地，也不拿空值覆盖镜像。
 *   2. POST 始终带上完整的 parts（projects 与 view 都在内存里各留一份），
 *      服务端再做一次按 key 合并，半截写入不会丢另一半。
 */

const ENDPOINT = '/api/worktable/state'

export type HostStateParts = { projects?: unknown; view?: unknown }

/** 宿主镜像里可能带的写入时间戳（毫秒） */
export type HostState = HostStateParts & { updatedAt?: number }

/** reachable=false 表示宿主这次根本没读到（连接没就绪/路由不可用），不能据此覆盖镜像 */
export type HostReadResult =
  | { reachable: true; state: HostState | null }
  | { reachable: false }

const RETRY_DELAYS = [0, 300, 700, 1200, 2000, 3000]

/**
 * 拉取宿主侧镜像；不抛错，不影响工作台本身。
 * 页面刚挂载时宿主连接可能还没就绪，所以这里带退避重试。
 * - reachable: true, state: null → 宿主可达但还没有镜像（首次使用），可以写
 * - reachable: false → 读不到，本次会话禁止写
 */
export async function loadHostState(localAt = 0): Promise<HostReadResult> {
  for (const delay of RETRY_DELAYS) {
    if (delay) await new Promise((r) => setTimeout(r, delay))
    try {
      const r = await fetch(ENDPOINT + '?localAt=' + encodeURIComponent(String(localAt)), {
        cache: 'no-store',
        headers: { accept: 'application/json' },
      })
      if (!r.ok) continue
      const j: any = await r.json()
      if (j && typeof j === 'object' && j.state && typeof j.state === 'object') {
        return { reachable: true, state: j.state as HostState }
      }
      return { reachable: true, state: null }
    } catch {
      // 继续重试
    }
  }
  return { reachable: false }
}

/** 累积中的镜像内容：POST 只带最新值，避免每次编辑都发整包 */
let parts: HostStateParts = {}
let timer: any = null
let inflight = false
let dirty = false
/** 读完宿主之前不写宿主：首屏默认值不能覆盖镜像，读失败就整场不写 */
let hydrated = false

function schedule() {
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    void flush()
  }, 400)
}

async function flush(): Promise<void> {
  if (!hydrated || inflight) {
    if (inflight) dirty = true
    return
  }
  if (!parts.projects && !parts.view) return
  inflight = true
  try {
    await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: { ...parts, updatedAt: Date.now() } }),
      keepalive: true,
    })
  } catch {
    // 宿主不可用时静默：localStorage 仍是本次会话的真值
  } finally {
    inflight = false
    if (dirty) {
      dirty = false
      schedule()
    }
  }
}

/** 记下要镜像的部分；400ms 内多次调用合并成一次 POST */
export function queueHostSave(patch: HostStateParts): void {
  parts = { ...parts, ...patch }
  if (!hydrated) return
  schedule()
}

/**
 * 宿主镜像已成功读到，放行写入。
 * 传入权威内容时**整体替换**待写队列 —— 首屏自愈等早于恢复发生的写入必须作废，
 * 否则那半截空值会把刚恢复好的项目盖掉（真实事故）。
 */
export function markHydrated(authoritative?: HostStateParts | null): void {
  parts = authoritative ? { projects: authoritative.projects, view: authoritative.view } : {}
  hydrated = true
}

/** 本次会话没有读到宿主：禁止写入，避免空状态覆盖镜像 */
export function staysReadOnly(): void {
  hydrated = false
}

/** 立即冲刷（页面隐藏/关闭前调用，避免丢掉最后一个 400ms 内的改动） */
export function flushHostSave(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  void flush()
}
