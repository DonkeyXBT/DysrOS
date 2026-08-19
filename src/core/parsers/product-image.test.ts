import { describe, expect, it } from 'vitest'
import { collectProductImages, findProductImage } from './product-image.js'

const IMAGE = 'https://media.s-bol.com/mo3GjW1ZZyxA/YvAEmy2/250x200.jpg'

describe('collectProductImages', () => {
  it('takes the article photograph', () => {
    const html = `<img src="${IMAGE}" class="bol-order-list-item-image">`
    expect(collectProductImages(html).map((image) => image.url)).toEqual([IMAGE])
  })

  it('leaves logos, spacers and the tracking pixel alone', () => {
    const html = `
      <img src="https://emailassets.bol.com/assets/v2/logo-bol-white.gif">
      <img src="https://link.bol.com/imgs/019f221e.gif" width="1" height="1">
      <img src="${IMAGE}" class="bol-order-list-item-image">`
    expect(collectProductImages(html).map((image) => image.url)).toEqual([IMAGE])
  })

  it('refuses anything that is not fetched over https', () => {
    expect(collectProductImages('<img src="cid:part1" class="order-list-item-image">')).toEqual([])
  })

  it('does not repeat one picture used twice in a mail', () => {
    const html = `<img src="${IMAGE}" class="order-list-item-image">
                  <img src="${IMAGE}" class="order-list-item-image">`
    expect(collectProductImages(html)).toHaveLength(1)
  })
})

describe('findProductImage', () => {
  const second = 'https://media.s-bol.com/qNVmknlw9RZD/gZYw393/250x200.jpg'
  const multi = `
    <td><img src="${IMAGE}" class="bol-order-list-item-image"></td>
    <td class="bol-order-list-item-article">LEGO Botanicals Bospaddenstoelen - 11505</td>
    <td><img src="${second}" class="bol-order-list-item-image"></td>
    <td class="bol-order-list-item-article">Pokemon TCG - Ascended Heroes Booster Bundle</td>`

  it('pairs each article with the picture beside it', () => {
    expect(findProductImage(multi, 'Pokemon TCG - Ascended Heroes Booster Bundle')).toBe(second)
    expect(findProductImage(multi, 'LEGO Botanicals Bospaddenstoelen - 11505')).toBe(IMAGE)
  })

  it('pairs on a title the mail truncated', () => {
    expect(findProductImage(multi, 'Pokemon TCG - Ascended Heroes...')).toBe(second)
  })

  it('needs no title when the mail holds one article', () => {
    expect(findProductImage(`<img src="${IMAGE}" class="order-list-item-image">`, null)).toBe(IMAGE)
  })

  it('falls back to the first rather than guessing when no block matches', () => {
    expect(findProductImage(multi, 'Something else entirely')).toBe(IMAGE)
  })

  it('is null when the mail carries no article photograph', () => {
    expect(findProductImage('<p>no pictures here</p>', 'anything')).toBeNull()
  })
})
