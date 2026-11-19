// 工作台主题桥回归：
// 1) 纯函数（前缀判定 / 取值清洗）行为正确
// 2) 注入幂等、有 head 插 head、无 head 退 body、再退前置；支持 external 模式
// 3) 浏览器脚本含关键接线（宿主镜像、深色标记、变化跟随、兜底轮询）
// 4) 站点路由 / 模板路由 / dshell.css / dshell.html 的接线必须都在（防"改了桥但没接上"）
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const require = createRequire(new URL('../01_content/package.json', import.meta.url))
const { buildSync } = require('esbuild')
const code = buildSync({
  entryPoints: [fileURLToPath(new URL('../01_content/src/theme.ts', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'cjs',
}).outputFiles[0].text
const module = { exports: {} }
runInNewContext(code, { module, exports: module.exports, setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {} })
const { THEME_VAR_PREFIXES, THEME_BRIDGE_ID, THEME_JS_PATH, shouldMirrorVar, pickThemeVars, injectThemeBridge, THEME_BRIDGE_JS } = module.exports

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const indexSrc = read('../01_content/src/index.ts')
const cssSrc = read('../01_content/template/dshell.css')
const htmlSrc = read('../01_content/template/dshell.html')

test('shouldMirrorVar 只认主题 token 前缀', () => {
  assert.deepEqual([...THEME_VAR_PREFIXES], ['--dsw-', '--dsh-', '--ds-'])
  for (const ok of ['--dsw-alias-bg-base', '--dsh-content-font-size', '--ds-font-family-code']) {
    assert.ok(shouldMirrorVar(ok), '应镜像：' + ok)
  }
  for (const no of ['color', '--x', '--dsw', 'dsw-alias-bg-base', '', null, undefined]) {
    assert.ok(!shouldMirrorVar(no), '不应镜像：' + String(no))
  }
})

test('pickThemeVars 去空值、去非法名、保留顺序', () => {
  const got = pickThemeVars([
    ['--dsw-alias-bg-base', ' #fff '],
    ['color', '#000'],
    ['--dsh-content-font-size', ''],
    ['--ds-font-family-code', 'Menlo, monospace'],
    ['--dsw-alias-label-primary', '   '],
  ])
  // 跨 vm 上下文，数组原型不同，逐项按字符串比较
  assert.equal(got.length, 2)
  assert.deepEqual([String(got[0][0]), String(got[0][1])], ['--dsw-alias-bg-base', '#fff'])
  assert.deepEqual([String(got[1][0]), String(got[1][1])], ['--ds-font-family-code', 'Menlo, monospace'])
  assert.equal(pickThemeVars(null).length, 0)
  assert.equal(pickThemeVars([null, [], ['--dsw-a']]).length, 0)
})

test('injectThemeBridge：插 head、幂等、退化到 body/前置、external 模式', () => {
  const page = '<!doctype html><html><head><title>t</title></head><body>hi</body></html>'
  const out = injectThemeBridge(page)
  assert.ok(out.includes(THEME_BRIDGE_ID), '应写入桥标记')
  assert.ok(out.indexOf(THEME_BRIDGE_ID) < out.indexOf('</head>'), '应插在 </head> 之前')
  assert.ok(out.includes('window.__wtThemeBridgeInstalled'), '应内联脚本本体')
  assert.equal(injectThemeBridge(out), out, '二次注入必须原样返回（幂等）')

  const noHead = '<html><body>hi</body></html>'
  const out2 = injectThemeBridge(noHead)
  assert.ok(out2.indexOf(THEME_BRIDGE_ID) < out2.indexOf('</body>'), '无 head 时插在 </body> 前')
  const bare = 'just text'
  assert.ok(injectThemeBridge(bare).startsWith('<script'), '都没有时前置注入')
  assert.equal(injectThemeBridge(''), '')

  const ext = injectThemeBridge(page, true)
  assert.ok(ext.includes('src="' + THEME_JS_PATH + '"'), 'external 模式应引模板路由')
  assert.ok(!ext.includes('__wtThemeBridgeInstalled'), 'external 模式不内联脚本本体')
})

test('浏览器脚本含主题跟随的关键接线', () => {
  for (const needle of [
    'window.__wtThemeBridgeInstalled',
    'w.parent',
    'getComputedStyle',
    'getPropertyValue',
    "setAttribute('data-ds-dark-theme'",
    "style.colorScheme",
    'MutationObserver',
    'matchMedia',
    'prefers-color-scheme: dark',
    'setInterval',
  ]) {
    assert.ok(THEME_BRIDGE_JS.includes(needle), '桥脚本缺少：' + needle)
  }
  assert.ok(THEME_BRIDGE_JS.includes(JSON.stringify(THEME_VAR_PREFIXES)), '桥脚本应内联同一份前缀表')
})

test('页面优先：自带主题开关时桥必须让位（并清掉自己写过的内联 token）', () => {
  for (const needle of [
    'function pageManual()',
    '__wtThemeBridgeManual',
    "getAttribute('data-wt-theme-mode')",
    "mode === 'auto' || mode === 'host'",
    "hasAttribute('data-wt-theme-key')",
    "hasAttribute('data-wb-theme')",
    "localStorage.getItem('dwb.theme')",
    'function clearApplied()',
    'style.removeProperty',
    'if (pageManual()) { clearApplied(); return; }',
    "attributeFilter: ['data-wb-theme', 'data-wt-theme-mode']",
  ]) {
    assert.ok(THEME_BRIDGE_JS.includes(needle), '页面优先逻辑缺少：' + needle)
  }
  // 「显式跟随宿主」必须排在 legacy dwb.theme 判定之前：同源页面共用一个键时，
  // 否则任何一个页面点过 ◐，所有页面都会被判成手动，想跟宿主的页面就被劫持了。
  const autoIdx = THEME_BRIDGE_JS.indexOf("mode === 'auto' || mode === 'host'")
  const legacyIdx = THEME_BRIDGE_JS.indexOf("localStorage.getItem('dwb.theme')")
  assert.ok(autoIdx > -1 && legacyIdx > -1 && autoIdx < legacyIdx, 'auto/host 短路必须早于 legacy 键判定')
  // 兼容老工作台页：apply() 里必须先判定「页面自带主题」，再镜像宿主
  const callManual = THEME_BRIDGE_JS.indexOf('if (pageManual()) { clearApplied(); return; }')
  const callHost = THEME_BRIDGE_JS.indexOf('host ? hostVars(host) : []')
  assert.ok(callManual > -1 && callHost > -1, 'apply() 应同时含两处调用')
  assert.ok(callManual < callHost, '应先判定手动再镜像宿主')
})

test('站点路由与模板路由接线齐全（产物 HTML 自动跟随主题）', () => {
  assert.ok(indexSrc.includes("import { injectThemeBridge, THEME_BRIDGE_JS } from './theme'"), '服务端应导入主题桥')
  assert.ok(/ext === 'html' \|\| ext === 'htm'[\s\S]{0,120}injectThemeBridge\(/.test(indexSrc), '站点路由应对 html 响应注入主题桥')
  assert.ok(/rel === '\/theme\.js'/.test(indexSrc), '模板路由应下发 /theme.js')
  assert.ok(/text\/javascript; charset=utf-8/.test(indexSrc), 'theme.js 的 content-type 应为 JS')
})

test('dshell.css 不再写死深色，深/浅两套兜底与主题桥分工明确', () => {
  const css = cssSrc.replace(/\/\*[\s\S]*?\*\//g, '')   // 去掉注释（注释里会引用旧写法）
  assert.ok(!/:root\s*\{\s*color-scheme:\s*dark\s*;/.test(css), '不应再写死 color-scheme: dark')
  assert.ok(css.includes('color-scheme: light dark'), '应声明 light dark 让独立打开时跟随系统')
  assert.ok(css.includes('@media (prefers-color-scheme: dark)'), '应有系统深色兜底')
  assert.ok(css.includes('--dsw-alias-bg-base: #ffffff'), '应有浅色兜底 token')
  assert.ok(css.includes('--dsw-alias-bg-base: #0b0e14'), '应有深色兜底 token')
  assert.ok(/font-family:\s*var\(--dsw-font-family/.test(css), '正文字体应跟随主题字体 token')
  assert.ok(htmlSrc.includes('theme.js'), '模板应说明显式引入主题桥的方式')
})
