// 写路径权限边界：本机云状态文件放行、其它路径照旧被拒（2026-10-08 云同步静默失败事故的回归测试）
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'

const require = createRequire(new URL('../01_content/package.json', import.meta.url))
const { buildSync } = require('esbuild')

function loadServerModule(dshHome) {
  process.env.DSH_HOME = dshHome
  process.env.DSH_WORKTABLE_LOCAL_DIR = ''
  const code = buildSync({
    entryPoints: [fileURLToPath(new URL('../01_content/src/index.ts', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs', target: ['node22'],
    // 与 01_content/build.mjs 对齐：皮肤模板以文本嵌入
    loader: { '.css': 'text', '.html': 'text' },
    define: { __WT_VERSION__: JSON.stringify('0.0.0-test') },
    external: ['@deepseek-ai/*', 'node:*', 'ws', 'node-pty'],
  }).outputFiles[0].text
  const module = { exports: {} }
  const req = createRequire(new URL('../01_content/package.json', import.meta.url))
  runInNewContext(code, { module, exports: module.exports, require: req, process, console, URL, setTimeout, clearTimeout, Buffer })
  return module.exports
}

test('云状态文件可写、其它路径仍被 roots 白名单拦住', () => {
  const root = mkdtempSync(join(tmpdir(), 'wt-csw-'))
  try {
    const home = join(root, 'dsHome')
    const projectFolder = join(root, 'project')
    const cloud = join(root, 'cloud-state', 'state.json')
    mkdirSync(home, { recursive: true })
    mkdirSync(projectFolder, { recursive: true })
    mkdirSync(join(root, 'cloud-state'), { recursive: true })
    writeFileSync(join(home, 'worktable-roots.json'), JSON.stringify({ folders: [projectFolder] }))  // 仅保持目录结构真实，实际用下面的注入

    const mod = loadServerModule(home)
    assert.equal(typeof mod.writeRejectFor, 'function', 'writeRejectFor 应已导出')
    // roots 白名单在生产里由 apply() 加载；测试直接注入，保证用例与机器配置无关（hermetic）
    mod.__wtSetWritableRootsForTest([projectFolder])

    // 1) 配好了云状态路径 → 它自己可写（这是修复点：以前会被判 outside project folders）
    assert.equal(mod.writeRejectFor(cloud, cloud), undefined, '配置内的云状态文件必须放行')
    // 2) 没配置云状态路径 → 同一路径仍被拒（不能无配置就放行）
    assert.equal(mod.writeRejectFor(cloud, null), 'outside project folders')
    // 3) 项目文件夹内 → 照旧放行
    assert.equal(mod.writeRejectFor(join(projectFolder, 'a.json'), cloud), undefined)
    // 4) 白名单外 → 拒
    assert.equal(mod.writeRejectFor(join(root, 'evil.json'), cloud), 'outside project folders')
    // 5) 敏感路径 → 即使等于配置也拒（不做无脑放行）
    const ssh = join(process.env.HOME || '/tmp', '.ssh', 'id_rsa')
    assert.equal(mod.writeRejectFor(ssh, ssh), 'sensitive path')
    // 6) 只做“完全相等”匹配：配置路径的子路径不放行
    assert.equal(mod.writeRejectFor(join(root, 'cloud-state', 'other.json'), cloud), 'outside project folders')
    // 7) `..` 穿越到配置项同一真实文件 → 归一化后仍等于配置，可写；但白名单外路径不会因此被放行
    assert.equal(mod.writeRejectFor(join(root, 'cloud-state', '..', 'cloud-state', 'state.json'), cloud), undefined)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
