/**
 * 工作台主题桥（theme bridge）。
 *
 * 问题：产物页是**独立的 document**，DSH 宿主写在 `body` / `body[data-ds-dark-theme]` 上的
 * `--dsw-*` token 不会跨文档继承；`dshell.css` 只能靠 `var(--x, 兜底)` 兜底，
 * 于是所有工作台页在浅色主题下依旧渲染成深色（2026-10-15 用户报"页面缺少主题跟随"）。
 *
 * 方案（同源 iframe 直接读宿主文档的 computed style，实测可枚举自定义属性）：
 *   1) **站点路由自动注入**（`injectThemeBridge`）：`/api/worktable/site/**` 下所有 `.html`
 *      响应都会带上一段内联桥，页面作者零改动，嵌套 iframe 也各拿一份；
 *   2) **显式引入**：`/api/worktable/template/theme.js`（同一份脚本），供独立打开、
 *      或经 file/其它托管方式打开的页面使用；
 *   3) 纯函数 `shouldMirrorVar` / `pickThemeVars` 同时给测试与浏览器脚本用，避免判定漂移。
 *
 * 桥的行为：把宿主 body 上 `--dsw-* / --dsh-* / --ds-*` 的自定义属性镜像到自己的
 * `html`/`body` 内联样式（内联优先级高于 dshell.css 的 `:root` 兜底），并同步
 * `color-scheme` 与 `data-ds-dark-theme` 标记；跟随宿主属性变化（MutationObserver）、
 * 系统深浅色变化（matchMedia）与低频轮询兜底。拿不到宿主（独立打开）时退回系统偏好。
 *
 * **页面优先**：页面自带主题开关时不抢——`window.__wtThemeBridgeManual = true`、
 * `<html data-wt-theme-mode="manual">`，或老工作台页的 `<html data-wb-theme>` /
 * `localStorage['dwb.theme']`（日记工作台、ai递归学习用这套）。判定为手动时会**清掉**
 * 桥写过的内联 token，让页面自己的样式表值生效；页面切回跟随（清掉标记）后调
 * `window.__wtThemeBridgeApply()` 即可恢复镜像。
 */

/** 需要镜像的自定义属性前缀：颜色/材质 token（--dsw-）、字体与字号 token（--dsh-）、代码字体（--ds-）。 */
export const THEME_VAR_PREFIXES = ['--dsw-', '--dsh-', '--ds-'] as const

/** 桥脚本的 DOM 标记（幂等注入与测试断言共用）。 */
export const THEME_BRIDGE_ID = 'wt-theme-bridge'

/** 主题脚本路由（显式引入用）。 */
export const THEME_JS_PATH = '/api/worktable/template/theme.js'

export type ThemeVar = [name: string, value: string]

/** 该自定义属性是否属于需要镜像的主题 token。 */
export function shouldMirrorVar(name: string): boolean {
  const n = String(name ?? '').trim()
  if (!n.startsWith('--')) return false
  return THEME_VAR_PREFIXES.some((p) => n.startsWith(p))
}

/** 从 [名, 值] 列表里挑出要镜像的 token（去空值、去非法名）。 */
export function pickThemeVars(pairs: ReadonlyArray<ThemeVar> | null | undefined): ThemeVar[] {
  const out: ThemeVar[] = []
  for (const pair of pairs ?? []) {
    if (!Array.isArray(pair) || pair.length < 2) continue
    const name = String(pair[0] ?? '').trim()
    const value = String(pair[1] ?? '').trim()
    if (!shouldMirrorVar(name) || !value) continue
    out.push([name, value])
  }
  return out
}

/** 浏览器端桥脚本（单份真相：内联注入与 /template/theme.js 都用它）。 */
export const THEME_BRIDGE_JS = `(function () {
  var PREFIXES = ${JSON.stringify(THEME_VAR_PREFIXES)};
  if (window.__wtThemeBridgeInstalled) return;
  window.__wtThemeBridgeInstalled = true;
  function ok(name) {
    if (!name || name.slice(0, 2) !== '--') return false;
    for (var i = 0; i < PREFIXES.length; i++) if (name.slice(0, PREFIXES[i].length) === PREFIXES[i]) return true;
    return false;
  }
  /** 向上找到最外层同源祖先窗口；跨域或到顶就停。 */
  function hostWindow() {
    var w = window;
    try {
      for (var i = 0; i < 12; i++) {
        var p = w.parent;
        if (!p || p === w) break;
        if (!p.document || !p.document.documentElement) break;
        w = p;
      }
    } catch (e) { /* 跨域：停在当前层 */ }
    return w === window ? null : w;
  }
  function hostVars(host) {
    var out = [];
    try {
      var el = host.document.body || host.document.documentElement;
      if (!el) return out;
      var cs = host.getComputedStyle(el);
      for (var i = 0; i < cs.length; i++) {
        var n = cs[i];
        if (!ok(n)) continue;
        var v = cs.getPropertyValue(n);
        if (v && v.trim()) out.push([n, v.trim()]);
      }
      out.dark = el.hasAttribute && el.hasAttribute('data-ds-dark-theme');
    } catch (e) { /* 读不到就退回系统偏好 */ }
    return out;
  }
  function systemDark() {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); } catch (e) { return false; }
  }
  /** 页面自带主题开关？（页面优先，桥不抢）
   *  1) 运行时显式：window.__wtThemeBridgeManual = true
   *  2) 标记：<html data-wt-theme-mode="manual">
   *  3) 老工作台页兼容：<html data-wb-theme> 或 localStorage['dwb.theme']（日记工作台 / ai递归学习用这套）
   *  显式跟随：<html data-wt-theme-mode="auto">（或 <html data-wt-theme-key="自己的键">）＝**忽略**上面 3) 的
   *  legacy 判定，强制跟宿主——同源页面共用一个 localStorage 键时，这条是"我只想跟宿主"的唯一办法。 */
  function pageManual() {
    try {
      if (window.__wtThemeBridgeManual) return true;
      var el = document.documentElement;
      if (el) {
        var mode = el.getAttribute && el.getAttribute('data-wt-theme-mode');
        if (mode === 'manual') return true;
        if (mode === 'auto' || mode === 'host') return false;
        if (el.hasAttribute && el.hasAttribute('data-wt-theme-key')) return false;
        if (el.hasAttribute && el.hasAttribute('data-wb-theme')) return true;
      }
      var v = null;
      try { v = localStorage.getItem('dwb.theme'); } catch (e) { v = null; }
      if (v === 'dark' || v === 'light') return true;
    } catch (e) { /* 读不到就按非手动处理 */ }
    return false;
  }
  var applied = [];
  /** 清掉桥写过的内联 token：切到手动主题时必须让位给页面自己的样式表值。 */
  function clearApplied() {
    var root = document.documentElement;
    for (var i = 0; i < applied.length; i++) {
      try { root.style.removeProperty(applied[i]); } catch (e) {}
      try { if (document.body) document.body.style.removeProperty(applied[i]); } catch (e) {}
    }
    applied = [];
  }
  function apply() {
    if (pageManual()) { clearApplied(); return; }
    var host = hostWindow();
    var vars = host ? hostVars(host) : [];
    var dark = host ? !!vars.dark : systemDark();
    var root = document.documentElement;
    for (var i = 0; i < vars.length; i++) root.style.setProperty(vars[i][0], vars[i][1]);
    root.style.colorScheme = dark ? 'dark' : 'light';
    if (document.body) {
      for (var j = 0; j < vars.length; j++) document.body.style.setProperty(vars[j][0], vars[j][1]);
      if (dark) document.body.setAttribute('data-ds-dark-theme', '');
      else document.body.removeAttribute('data-ds-dark-theme');
    }
    applied = vars.map(function (p) { return p[0]; });
  }
  apply();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply, { once: true });
  // 页面自己切主题（data-wb-theme / data-wt-theme-mode）时立刻重新判定，别等轮询
  try {
    var MO0 = window.MutationObserver;
    if (MO0) new MO0(function () { apply(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-wb-theme', 'data-wt-theme-mode'] });
  } catch (e) { /* 忽略 */ }
  var host = hostWindow();
  if (host) {
    try {
      var MO = host.MutationObserver || window.MutationObserver;
      var mo = new MO(function () { apply(); });
      var opts = { attributes: true, attributeFilter: ['style', 'class', 'data-ds-dark-theme'] };
      mo.observe(host.document.documentElement, opts);
      if (host.document.body) mo.observe(host.document.body, opts);
      host.document.addEventListener('DOMContentLoaded', function () { try { mo.observe(host.document.body, opts); } catch (e) {} apply(); });
    } catch (e) { /* 观测失败靠下面的兜底轮询 */ }
  }
  try {
    var mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
    if (mq) { if (mq.addEventListener) mq.addEventListener('change', apply); else if (mq.addListener) mq.addListener(apply); }
  } catch (e) { /* 忽略 */ }
  window.__wtThemeBridgeApply = apply;
  setInterval(apply, 5000);   // 兜底：宿主换主题也可能只换样式表、不动属性
})();`

/**
 * 给产物 HTML 注入主题桥（幂等）。
 * 优先插到 `</head>` 前；没有 head 就插到 `</body>` 前；都没有就前置。
 * @param html 原始 HTML 文本
 * @param external true = 用 `<script src>` 引 /template/theme.js；默认内联（少一次请求，离线可用）
 */
export function injectThemeBridge(html: string, external = false): string {
  const src = String(html ?? '')
  if (!src || src.includes(THEME_BRIDGE_ID)) return src
  const tag = external
    ? `<script id="${THEME_BRIDGE_ID}" data-wt-theme-bridge src="${THEME_JS_PATH}"></script>`
    : `<script id="${THEME_BRIDGE_ID}" data-wt-theme-bridge>${THEME_BRIDGE_JS}</script>`
  const head = /<\/head\s*>/i.exec(src)
  if (head) return src.slice(0, head.index) + tag + src.slice(head.index)
  const body = /<\/body\s*>/i.exec(src)
  if (body) return src.slice(0, body.index) + tag + src.slice(body.index)
  return tag + src
}
