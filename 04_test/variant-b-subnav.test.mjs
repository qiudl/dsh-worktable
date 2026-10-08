// 方案 B（展开态行内二级菜单）结构回归：
// 1) 卡片标注选择器必须排除插件自渲染的按钮（否则菜单项会被当成项目卡片 → data-wt-id 错位）
// 2) 行内菜单的关键接线必须在源码里（hasNav / subOpen / 切页 / 配置 / 打开布局）
// 3) 构建产物里必须有对应类名
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const indexSrc = read('../01_content/src/client/index.tsx')
const stylesSrc = read('../01_content/src/client/styles.ts')
const localesSrc = read('../01_content/src/client/locales.ts')
const bundle = read('../01_content/lib/client.js')

test('卡片标注选择器排除插件自渲染按钮（布局卡 + 二级菜单项）', () => {
  const m = /export const PROJECT_CARD_SELECTOR = '([^']+)'/.exec(indexSrc)
  assert.ok(m, 'PROJECT_CARD_SELECTOR 应已导出')
  const sel = m[1]
  assert.ok(sel.includes(':not(.dsh-wt_layout)'), '必须排除布局卡：' + sel)
  assert.ok(sel.includes(':not(.dsh-wt_subNavItem)'), '必须排除行内二级菜单项：' + sel)
  assert.ok(indexSrc.includes('querySelectorAll<HTMLElement>(PROJECT_CARD_SELECTOR)'), 'DOM 桥必须使用该常量')
  assert.ok(!indexSrc.includes("querySelectorAll<HTMLElement>('button:not(.dsh-wt_layout)')"), '不应残留旧选择器')
})

test('行内二级菜单接线齐全', () => {
  for (const needle of ['dsh-wt_layoutWrap', 'dsh-wt_subChevron', 'dsh-wt_subNavItem',
                        'const subOpen = hasNav && openSubId === l.id', 'openRailProjectTab(l.id, it.id)',
                        'openRailConfig(l.id)', 'aria-expanded={hasNav ? String(subOpen) : undefined}']) {
    assert.ok(indexSrc.includes(needle), '源码缺少：' + needle)
  }
  // 有二级菜单的项目：单击展开、双击打开（语义与原型一致）
  assert.ok(/if \(hasNav\) \{ setOpenSubId\(subOpen \? null : l\.id\); return \}/.test(indexSrc), '单击应为展开/收起')
  assert.ok(/onDoubleClick=\{\(\) => \{ if \(hasNav\) \{ setOpenSubId\(null\); openRailProject\(l\.id\) \} \}\}/.test(indexSrc), '双击应为打开布局')
})

test('样式与文案就位，且构建产物包含新类名', () => {
  for (const cls of ['.dsh-wt_layoutWrap{', '.dsh-wt_subNav{', '.dsh-wt_subNavItem{', '.dsh-wt_subChevron{']) {
    assert.ok(stylesSrc.includes(cls), '样式缺少：' + cls)
  }
  assert.ok(localesSrc.includes("'rail.subHint'"), '缺少 rail.subHint 文案（zh/en 各一份）')
  assert.equal((localesSrc.match(/'rail\.subHint'/g) || []).length, 2, 'zh/en 都要有 rail.subHint')
  for (const cls of ['dsh-wt_layoutWrap', 'dsh-wt_subNavItem', 'dsh-wt_subChevron']) {
    assert.ok(bundle.includes(cls), '构建产物缺少类名：' + cls)
  }
})
test('按你的选择：收起态不再有弹出菜单（只保留展开态行内菜单）', () => {
  const banned = ['dsh-wt_railMenu', 'dsh-wt_railBtnHasSub', 'dsh-wt_railBtnDot', 'rail.submenuHint', 'openRailSub', 'railMenu']
  for (const b of banned) {
    assert.ok(!indexSrc.includes(b), 'client 源码不应残留方案 A 的：' + b)
    assert.ok(!stylesSrc.includes(b), '样式不应残留方案 A 的：' + b)
    assert.ok(!localesSrc.includes(b), '文案不应残留方案 A 的：' + b)
  }
  assert.ok(!bundle.includes('dsh-wt_railMenu'), '构建产物不应再含方案 A 的类名')
  // 收起态图标恢复为「直接打开项目」
  assert.ok(/onClick: \(\) => openRailProject\(id\)/.test(indexSrc), '收起态图标应恢复为 openRailProject')
  // 但行内菜单依赖的接线必须保留（否则 B 也一起没了）
  for (const keep of ['openRailProjectTab', 'openRailConfig', 'dsh-wt_subNavItem']) {
    assert.ok(indexSrc.includes(keep), '行内菜单接线被误删：' + keep)
  }
})
