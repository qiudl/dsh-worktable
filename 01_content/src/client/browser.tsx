import { useEffect, useLayoutEffect, useRef, useState } from 'react'

type BrowserTabState = {
  tabId: string
  url: string
  title: string
  faviconUrl: string | null
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  crashed: boolean
  audible: boolean
  muted: boolean
  mediaActive: boolean
}

type BrowserSurfaceState = {
  surfaceId: string
  paneId: string
  sequence: number
  tabs: BrowserTabState[]
  activeTabId: string | null
  visible: boolean
  appliedRevision: number
}

type BrokerResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

type BrowserBridge = {
  hello(): Promise<BrokerResult<{ protocol: 1 }>>
  createSurface(input: unknown): Promise<BrokerResult<{ surfaceId: string; activeTabId: string; state: BrowserSurfaceState }>>
  setGeometry(input: unknown): Promise<BrokerResult<{ appliedRevision: number; visible: boolean }>>
  openTab(input: unknown): Promise<BrokerResult<{ tabId: string; state: BrowserTabState }>>
  navigate(input: unknown): Promise<BrokerResult<{ accepted: true; navigationId: string }>>
  tabAction(input: unknown): Promise<BrokerResult<{ accepted: true }>>
  mediaAction(input: unknown): Promise<BrokerResult<{ accepted: true; effect: string; mediaState: BrowserTabState }>>
  closeSurface(input: unknown): Promise<BrokerResult<{ closed: true }>>
  onState(listener: (state: BrowserSurfaceState) => void): () => void
}

declare global {
  interface Window { __SLARK_DSH_BROWSER__?: BrowserBridge }
}

type MediaSource = {
  bridge: BrowserBridge
  surfaceId: string
  tab: BrowserTabState
  rememberedMedia: boolean
}

const mediaSources = new Map<string, MediaSource>()
const mediaListeners = new Set<() => void>()

function publishMediaSource(bridge: BrowserBridge, state: BrowserSurfaceState) {
  const liveIds = new Set(state.tabs.map((tab) => tab.tabId))
  for (const [key, source] of mediaSources) {
    if (source.surfaceId === state.surfaceId && !liveIds.has(source.tab.tabId)) mediaSources.delete(key)
  }
  for (const tab of state.tabs) {
    const key = `${state.surfaceId}:${tab.tabId}`
    const previous = mediaSources.get(key)
    if (tab.mediaActive || previous?.rememberedMedia) {
      mediaSources.set(key, {
        bridge,
        surfaceId: state.surfaceId,
        tab,
        rememberedMedia: tab.mediaActive || previous?.rememberedMedia === true,
      })
    }
  }
  for (const listener of mediaListeners) listener()
}

function forgetSurface(surfaceId: string) {
  for (const [key, source] of mediaSources) if (source.surfaceId === surfaceId) mediaSources.delete(key)
  for (const listener of mediaListeners) listener()
}

function forgetMediaSource(surfaceId: string, tabId: string) {
  mediaSources.delete(`${surfaceId}:${tabId}`)
  for (const listener of mediaListeners) listener()
}

function requestId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`
}

function normalizeUrl(value: string): string | null {
  const input = value.trim()
  if (!input) return null
  try {
    const parsed = new URL(/^https?:\/\//iu.test(input) ? input : `https://${input}`)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null
  } catch { return null }
}

function labelFor(tab: BrowserTabState) {
  if (tab.title.trim()) return tab.title.trim()
  try { return new URL(tab.url).hostname || tab.url } catch { return tab.url || '新标签页' }
}

export function IframeBrowserPane(props: { initialUrl: string; onNavigate(url: string): void; reloadKey: number }) {
  const [url, setUrl] = useState(props.initialUrl)
  const [src, setSrc] = useState(props.initialUrl)
  const go = () => {
    const next = normalizeUrl(url) ?? 'about:blank'
    setSrc(next)
    if (next !== 'about:blank') props.onNavigate(next)
  }
  return <>
    <div className="dsh-wt_browserBar">
      <input className="dsh-wt_browserInput" value={url} placeholder="https://" onChange={(event) => setUrl(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') go() }} />
      <button type="button" className="dsh-wt_browserGo" onClick={go}>↗</button>
    </div>
    <iframe key={props.reloadKey} className="dsh-wt_paneFrame" src={src} title="browser" />
  </>
}

function NativeBrowserPane(props: {
  bridge: BrowserBridge
  paneId: string
  initialUrl: string
  onNavigate(url: string): void
  reloadKey: number
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const surfaceIdRef = useRef<string | null>(null)
  const revisionRef = useRef(0)
  const [state, setState] = useState<BrowserSurfaceState | null>(null)
  const [url, setUrl] = useState(props.initialUrl)
  const [error, setError] = useState('')

  const syncGeometry = () => {
    const host = hostRef.current
    const surfaceId = surfaceIdRef.current
    if (!host || !surfaceId) return
    const rect = host.getBoundingClientRect()
    const style = getComputedStyle(host)
    const visible = document.visibilityState === 'visible' && style.visibility !== 'hidden'
      && style.display !== 'none' && rect.width >= 1 && rect.height >= 1
    revisionRef.current += 1
    void props.bridge.setGeometry({
      surfaceId,
      bounds: {
        x: Math.round(rect.x), y: Math.round(rect.y),
        width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)),
      },
      visible,
      revision: revisionRef.current,
    })
  }

  useEffect(() => {
    let disposed = false
    const unsubscribe = props.bridge.onState((next) => {
      if (next.surfaceId !== surfaceIdRef.current) return
      setState(next)
      publishMediaSource(props.bridge, next)
      const active = next.tabs.find((tab) => tab.tabId === next.activeTabId)
      if (active?.url && active.url !== 'about:blank') {
        setUrl(active.url)
        props.onNavigate(active.url)
      }
    })
    const host = hostRef.current
    const rect = host?.getBoundingClientRect()
    void props.bridge.createSurface({
      paneId: props.paneId,
      initialUrl: normalizeUrl(props.initialUrl) ?? 'about:blank',
      bounds: {
        x: Math.round(rect?.x ?? 0), y: Math.round(rect?.y ?? 0),
        width: Math.max(1, Math.round(rect?.width ?? 1)), height: Math.max(1, Math.round(rect?.height ?? 1)),
      },
      visible: !!rect && rect.width >= 1 && rect.height >= 1 && document.visibilityState === 'visible',
    }).then((result) => {
      if (disposed) {
        if (result.ok) void props.bridge.closeSurface({ surfaceId: result.value.surfaceId, reason: 'pane_closed' })
        return
      }
      if (!result.ok) { setError(result.error.code); return }
      surfaceIdRef.current = result.value.surfaceId
      setState(result.value.state)
      publishMediaSource(props.bridge, result.value.state)
      syncGeometry()
    })
    return () => {
      disposed = true
      unsubscribe()
      const surfaceId = surfaceIdRef.current
      surfaceIdRef.current = null
      if (surfaceId) {
        forgetSurface(surfaceId)
        void props.bridge.closeSurface({ surfaceId, reason: 'pane_closed' })
      }
    }
  }, [props.bridge, props.paneId])

  useLayoutEffect(syncGeometry)
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const observer = new ResizeObserver(syncGeometry)
    observer.observe(host)
    window.addEventListener('resize', syncGeometry)
    window.addEventListener('scroll', syncGeometry, true)
    document.addEventListener('visibilitychange', syncGeometry)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', syncGeometry)
      window.removeEventListener('scroll', syncGeometry, true)
      document.removeEventListener('visibilitychange', syncGeometry)
    }
  }, [props.bridge, props.paneId])

  const active = state?.tabs.find((tab) => tab.tabId === state.activeTabId) ?? null
  const tabAction = (action: 'back' | 'forward' | 'reload' | 'stop' | 'activate' | 'close' | 'focus', tabId = active?.tabId) => {
    const surfaceId = surfaceIdRef.current
    if (!surfaceId || !tabId) return
    void props.bridge.tabAction({ surfaceId, tabId, action, requestId: requestId(action) })
  }
  const mediaAction = (action: 'mute' | 'unmute' | 'pause' | 'resume' | 'stop') => {
    const surfaceId = surfaceIdRef.current
    if (!surfaceId || !active) return
    void props.bridge.mediaAction({ surfaceId, tabId: active.tabId, action, requestId: requestId(action) })
    if (action === 'stop') forgetMediaSource(surfaceId, active.tabId)
  }
  const go = () => {
    const surfaceId = surfaceIdRef.current
    const next = normalizeUrl(url)
    if (!surfaceId || !active || !next) return
    props.onNavigate(next)
    void props.bridge.navigate({ surfaceId, tabId: active.tabId, url: next })
  }

  useEffect(() => {
    if (props.reloadKey > 0) tabAction('reload')
  }, [props.reloadKey])

  return <>
    {state && state.tabs.length > 1 && <div className="dsh-wt_nativeTabs">
      {state.tabs.map((tab) => <button key={tab.tabId} type="button" className={'dsh-wt_nativeTab' + (tab.tabId === state.activeTabId ? ' dsh-wt_nativeTabOn' : '')} onClick={() => tabAction('activate', tab.tabId)}>
        <span className="dsh-wt_nativeTabTitle">{labelFor(tab)}</span>{tab.mediaActive && <span title="正在播放">♪</span>}
        <span className="dsh-wt_nativeTabClose" onClick={(event) => { event.stopPropagation(); tabAction('close', tab.tabId) }}>×</span>
      </button>)}
    </div>}
    <div className="dsh-wt_browserBar">
      <button type="button" className="dsh-wt_browserGo" disabled={!active?.canGoBack} onClick={() => tabAction('back')}>‹</button>
      <button type="button" className="dsh-wt_browserGo" disabled={!active?.canGoForward} onClick={() => tabAction('forward')}>›</button>
      <button type="button" className="dsh-wt_browserGo" onClick={() => tabAction(active?.loading ? 'stop' : 'reload')}>{active?.loading ? '×' : '↻'}</button>
      <input className="dsh-wt_browserInput" value={url} placeholder="https://" onChange={(event) => setUrl(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') go() }} />
      <button type="button" className="dsh-wt_browserGo" onClick={go}>↗</button>
      <button type="button" className="dsh-wt_browserGo" title="新标签页" onClick={() => {
        const surfaceId = surfaceIdRef.current
        if (surfaceId) void props.bridge.openTab({ surfaceId, activate: true })
      }}>＋</button>
      {active?.mediaActive && <button type="button" className="dsh-wt_browserGo" title={active.muted ? '取消静音' : '静音'} onClick={() => mediaAction(active.muted ? 'unmute' : 'mute')}>{active.muted ? '🔇' : '🔊'}</button>}
      {active?.mediaActive && <button type="button" className="dsh-wt_browserGo" title="暂停" onClick={() => mediaAction('pause')}>Ⅱ</button>}
    </div>
    {error && <div className="dsh-wt_nativeBrowserError">浏览器不可用：{error}</div>}
    <div ref={hostRef} className="dsh-wt_nativeBrowserViewport" />
  </>
}

export function BrowserPane(props: { paneId: string; initialUrl: string; onNavigate(url: string): void; reloadKey: number }) {
  const bridge = window.__SLARK_DSH_BROWSER__
  if (!bridge) return <IframeBrowserPane initialUrl={props.initialUrl} onNavigate={props.onNavigate} reloadKey={props.reloadKey} />
  return <NativeBrowserPane bridge={bridge} {...props} />
}

export function BrowserMediaDock() {
  const [, render] = useState(0)
  useEffect(() => {
    const listener = () => render((value) => value + 1)
    mediaListeners.add(listener)
    return () => { mediaListeners.delete(listener) }
  }, [])
  const sources = Array.from(mediaSources.values()).filter((source) => source.rememberedMedia)
  if (sources.length === 0) return null
  return <div className="dsh-wt_mediaDock" aria-label="后台媒体">
    {sources.map((source) => <div className="dsh-wt_mediaSource" key={`${source.surfaceId}:${source.tab.tabId}`}>
      <span className="dsh-wt_mediaTitle" title={source.tab.url}>{labelFor(source.tab)}</span>
      <button type="button" title={source.tab.mediaActive ? '暂停' : '恢复'} onClick={() => void source.bridge.mediaAction({
        surfaceId: source.surfaceId, tabId: source.tab.tabId,
        action: source.tab.mediaActive ? 'pause' : 'resume', requestId: requestId('dock-play'),
      })}>{source.tab.mediaActive ? 'Ⅱ' : '▶'}</button>
      <button type="button" title={source.tab.muted ? '取消静音' : '静音'} onClick={() => void source.bridge.mediaAction({
        surfaceId: source.surfaceId, tabId: source.tab.tabId,
        action: source.tab.muted ? 'unmute' : 'mute', requestId: requestId('dock-mute'),
      })}>{source.tab.muted ? '🔇' : '🔊'}</button>
      <button type="button" title="停止" onClick={() => {
        forgetMediaSource(source.surfaceId, source.tab.tabId)
        void source.bridge.mediaAction({ surfaceId: source.surfaceId, tabId: source.tab.tabId, action: 'stop', requestId: requestId('dock-stop') })
      }}>■</button>
    </div>)}
  </div>
}
