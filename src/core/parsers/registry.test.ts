import { describe, it, expect } from 'vitest'
import { loadEml, type ParsedMessage } from '../mail/parsed-message.js'
import { ParserRegistry, type Parser } from './registry.js'

async function message(overrides: { from?: string; subject?: string } = {}): Promise<ParsedMessage> {
  return loadEml(
    [
      `From: Sender <${overrides.from ?? 'noreply@bol.com'}>`,
      `Subject: ${overrides.subject ?? 'Bedankt voor je bestelling'}`,
      'Date: Tue, 18 Aug 2026 09:55:00 +0200',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Bestelnummer 1234567890',
      '',
    ].join('\r\n'),
  )
}

const orderParser: Parser = {
  id: 'test-order',
  retailer: 'test',
  matches: (m) => m.fromAddress.endsWith('@bol.com') && /bestelling/i.test(m.subject),
  parse: (m) => [
    {
      type: 'order_placed',
      retailer: 'test',
      externalOrderId: /Bestelnummer (\d+)/.exec(m.text)?.[1] ?? null,
      occurredAt: m.receivedAt,
      payload: {},
    },
  ],
}

const greedyParser: Parser = {
  id: 'greedy',
  retailer: 'test',
  matches: () => true,
  parse: () => [],
}

describe('ParserRegistry.parse', () => {
  it('returns the events from the parser that claims the message', async () => {
    const registry = new ParserRegistry([orderParser])
    const result = registry.parse(await message())

    expect(result).not.toBeNull()
    expect(result!.parserId).toBe('test-order')
    expect(result!.events).toHaveLength(1)
    expect(result!.events[0]!.externalOrderId).toBe('1234567890')
  })

  it('returns null when no parser claims the message', async () => {
    const registry = new ParserRegistry([orderParser])
    expect(registry.parse(await message({ from: 'noreply@unknown-shop.com' }))).toBeNull()
  })

  it('gives the first registered parser priority', async () => {
    const registry = new ParserRegistry([orderParser, greedyParser])
    expect(registry.parse(await message())!.parserId).toBe('test-order')
  })

  it('falls through to a later parser when the first does not match', async () => {
    const registry = new ParserRegistry([orderParser, greedyParser])
    const result = registry.parse(await message({ subject: 'Something else entirely' }))
    expect(result!.parserId).toBe('greedy')
  })

  it('treats a parser that claims a message but extracts nothing as a match', async () => {
    const registry = new ParserRegistry([greedyParser])
    const result = registry.parse(await message())
    expect(result).not.toBeNull()
    expect(result!.events).toEqual([])
  })
})

describe('ParserRegistry error containment', () => {
  it('does not let a throwing parser take down the pipeline', async () => {
    const broken: Parser = {
      id: 'broken',
      retailer: 'test',
      matches: () => true,
      parse: () => {
        throw new Error('bad regex on unexpected layout')
      },
    }
    const registry = new ParserRegistry([broken, orderParser])
    const result = registry.parse(await message())

    expect(result!.parserId).toBe('test-order')
    expect(registry.failures).toHaveLength(1)
    expect(registry.failures[0]!.parserId).toBe('broken')
  })

  it('reports no match when the only parser throws', async () => {
    const broken: Parser = {
      id: 'broken',
      retailer: 'test',
      matches: () => true,
      parse: () => {
        throw new Error('nope')
      },
    }
    const registry = new ParserRegistry([broken])
    expect(registry.parse(await message())).toBeNull()
  })
})

describe('ParserRegistry.describe', () => {
  it('lists registered parsers for the diagnostics screen', () => {
    const registry = new ParserRegistry([orderParser, greedyParser])
    expect(registry.describe()).toEqual([
      { id: 'test-order', retailer: 'test' },
      { id: 'greedy', retailer: 'test' },
    ])
  })
})
