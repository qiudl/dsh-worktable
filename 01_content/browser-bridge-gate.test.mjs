import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

const source = [
  readFileSync(new URL('./src/client/split.tsx', import.meta.url), 'utf8'),
  readFileSync(new URL('./src/client/browser.tsx', import.meta.url), 'utf8'),
].join('\n')

describe('native Desktop browser bridge', () => {
  it('uses the Slark broker for browser panes while retaining a web fallback', () => {
    assert.match(source, /__SLARK_DSH_BROWSER__/u)
    assert.match(source, /createSurface\(/u)
    assert.match(source, /setGeometry\(/u)
    assert.match(source, /closeSurface\(/u)
    assert.match(source, /NativeBrowserPane/u)
    assert.match(source, /IframeBrowserPane/u)
  })

  it('exposes native tab and background-media controls', () => {
    assert.match(source, /openTab\(/u)
    assert.match(source, /tabAction\(/u)
    assert.match(source, /mediaAction\(/u)
    assert.match(source, /BrowserMediaDock/u)
    assert.match(source, /mediaActive/u)
    assert.match(source, /forgetMediaSource/u)
  })
})
