import { describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cacheName, ImageCache, isAllowed, MAX_BYTES } from './images.js'

function cacheDir(): string {
  return mkdtempSync(join(tmpdir(), 'dysros-images-'))
}

describe('isAllowed', () => {
  it('accepts the retailer image host over https', () => {
    expect(isAllowed('https://media.s-bol.com/abc/def/250x200.jpg')).toBe(true)
  })

  it('refuses any other host, however it is dressed up', () => {
    expect(isAllowed('https://media.s-bol.com.evil.test/x.jpg')).toBe(false)
    expect(isAllowed('https://evil.test/x.jpg?media.s-bol.com')).toBe(false)
  })

  it('refuses plain http, local files and nonsense', () => {
    expect(isAllowed('http://media.s-bol.com/x.jpg')).toBe(false)
    expect(isAllowed('file:///C:/Windows/win.ini')).toBe(false)
    expect(isAllowed('not a url')).toBe(false)
  })
})

describe('ImageCache', () => {
  it('never fetches a URL it is not allowed to fetch', async () => {
    const cache = new ImageCache(cacheDir())
    expect(await cache.get('https://evil.test/x.jpg')).toBeNull()
  })

  it('serves a picture already on disk without going to the network', async () => {
    const dir = cacheDir()
    const url = 'https://media.s-bol.com/abc/def/250x200.jpg'
    writeFileSync(join(dir, cacheName(url, 'jpg')), Buffer.from([1, 2, 3]))

    const cache = new ImageCache(dir)
    expect(await cache.get(url)).toBe(`data:image/jpeg;base64,${Buffer.from([1, 2, 3]).toString('base64')}`)
  })

  it('names the cache file after the URL, so two mails share one copy', () => {
    const url = 'https://media.s-bol.com/abc/def/250x200.jpg'
    expect(cacheName(url, 'jpg')).toBe(cacheName(url, 'jpg'))
    expect(cacheName(url, 'jpg')).not.toBe(cacheName(`${url}?x=1`, 'jpg'))
  })

  it('creates its directory rather than failing on first use', () => {
    const dir = join(cacheDir(), 'nested', 'images')
    // eslint-disable-next-line no-new
    new ImageCache(dir)
    expect(readdirSync(dir)).toEqual([])
  })

  it('caps what it will store', () => {
    expect(MAX_BYTES).toBe(2 * 1024 * 1024)
  })
})
