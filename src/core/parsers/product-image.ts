/**
 * Product photographs carried in retailer mail.
 *
 * bol.com puts a thumbnail of every ordered article in its order, shipping and
 * cancellation mail, in the same block as the article's name. That is the only
 * picture of the goods the tool ever gets without asking bol.com for it, so it
 * is worth taking: an inventory of grey placeholders is much harder to scan
 * than one you recognise at a glance.
 *
 * Only images that are demonstrably article photographs are accepted. A mail
 * is also full of logos, spacers and a tracking pixel, and showing one of those
 * as the product would be worse than showing nothing.
 */

/** Hosts that serve article photographs, as opposed to mail furniture. */
const PRODUCT_HOSTS = [/^https:\/\/media\.s-bol\.com\//i]

/** Classes retailers put on the article thumbnail itself. */
const PRODUCT_CLASS = /order-list-item-image/i

export interface ProductImage {
  url: string
  /** Where the tag sat, used to pair a picture with the article beside it. */
  at: number
}

/** Every article photograph in the mail, in the order they appear. */
export function collectProductImages(html: string): ProductImage[] {
  if (!html) return []
  const found: ProductImage[] = []
  const tags = /<img\b[^>]*>/gi
  let tag: RegExpExecArray | null
  while ((tag = tags.exec(html)) !== null) {
    const source = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag[0])?.[1]
    if (!source) continue
    const url = decodeEntities(source.trim())
    const known = PRODUCT_HOSTS.some((host) => host.test(url))
    if (!known && !PRODUCT_CLASS.test(tag[0])) continue
    if (!/^https:\/\//i.test(url)) continue
    if (found.some((image) => image.url === url)) continue
    found.push({ url, at: tag.index })
  }
  return found
}

/**
 * The photograph of one named article.
 *
 * A mail with several articles carries several pictures, and the block after
 * each picture names the article it belongs to — so the title decides which
 * one is returned. With a single picture the pairing is unambiguous and the
 * title is not needed, which matters because shipping mail sometimes states a
 * title the tool could only partly recover.
 */
export function findProductImage(html: string, title: string | null): string | null {
  const images = collectProductImages(html)
  if (images.length === 0) return null
  if (images.length === 1) return images[0]!.url

  const wanted = normalise(title ?? '')
  if (wanted.length >= 8) {
    for (let index = 0; index < images.length; index += 1) {
      const start = images[index]!.at
      const end = images[index + 1]?.at ?? html.length
      const block = normalise(stripTags(html.slice(start, end)))
      // A truncated title still identifies the block it came from.
      if (block.includes(wanted) || block.includes(wanted.slice(0, 24))) {
        return images[index]!.url
      }
    }
  }
  return images[0]!.url
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, ' ')
}

function decodeEntities(value: string): string {
  return value.replace(/&amp;/gi, '&')
}

function normalise(value: string): string {
  return decodeEntities(value)
    .replace(/\.\.\.$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}
