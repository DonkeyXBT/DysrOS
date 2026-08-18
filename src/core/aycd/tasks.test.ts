import { describe, it, expect } from 'vitest'
import { AYCD_LIMITS, validateTask } from './client.js'
import {
  AYCD_TASK_BUILDERS, builderById, bolOrderConfirmationTask, bolShipmentTask,
  bolCancellationTask, mediamarktOrderTask, mediamarktShipmentTask,
  pocketgamesOrderTask, proshopOrderTask,
} from './tasks.js'

const REQUEST = { email: 'orders@example.com', receivedAt: 1_787_000_000 }
const OCCURRED = '2026-07-01T10:00:00.000Z'

describe('every task definition', () => {
  it.each(AYCD_TASK_BUILDERS.map((builder) => [builder.id, builder] as const))(
    '%s builds a task Inbox will accept',
    (_id, builder) => {
      expect(validateTask(builder.build(REQUEST))).toEqual([])
    },
  )

  it.each(AYCD_TASK_BUILDERS.map((builder) => [builder.id, builder] as const))(
    '%s gives every body element a selector, which Inbox requires',
    (_id, builder) => {
      const body = builder.build(REQUEST).mailElements.filter((e) => e.target === 'body')
      expect(body.every((element) => Boolean(element.selector))).toBe(true)
    },
  )

  it.each(AYCD_TASK_BUILDERS.map((builder) => [builder.id, builder] as const))(
    '%s stays inside the documented ceilings',
    (_id, builder) => {
      const task = builder.build(REQUEST)
      expect(task.mailFilters.length).toBeLessThanOrEqual(AYCD_LIMITS.maxFilters)
      expect(task.mailElements.length).toBeLessThanOrEqual(AYCD_LIMITS.maxElements)
      expect(task.mailElements.length).toBeGreaterThan(0)
      for (const filter of task.mailFilters) {
        expect(filter.value.length).toBeLessThanOrEqual(AYCD_LIMITS.maxFieldLength)
        expect(filter.orValues?.length ?? 0).toBeLessThanOrEqual(AYCD_LIMITS.maxOrValues)
      }
    },
  )

  it.each(AYCD_TASK_BUILDERS.map((builder) => [builder.id, builder] as const))(
    '%s uses element regexes that are valid patterns',
    (_id, builder) => {
      for (const element of builder.build(REQUEST).mailElements) {
        expect(() => new RegExp(element.regex ?? '')).not.toThrow()
      }
    },
  )

  it('names every element uniquely, since results come back keyed by name', () => {
    for (const builder of AYCD_TASK_BUILDERS) {
      const names = builder.build(REQUEST).mailElements.map((element) => element.name)
      expect(new Set(names).size, builder.id).toBe(names.length)
    }
  })

  it('passes the requested address, start moment and timeout through', () => {
    const task = bolOrderConfirmationTask.build({ ...REQUEST, timeout: 300 })
    expect(task.email).toBe('orders@example.com')
    expect(task.receivedAt).toBe(1_787_000_000)
    expect(task.timeout).toBe(300)
  })

  it('omits the timeout when none was asked for, leaving the client default', () => {
    expect(bolOrderConfirmationTask.build(REQUEST).timeout).toBeUndefined()
  })

  it('is addressable by id, which is how a completed task is converted', () => {
    expect(builderById('aycd-bol-shipment-confirmation')).toBe(bolShipmentTask)
    expect(builderById('nonexistent')).toBeNull()
  })
})

describe('bol.com order confirmation', () => {
  const labelled = {
    orderRef: 'C0008N401L',
    title: 'Bestelnummer: C0008N401L LEGO Star Wars 75192',
    seller: 'Verkoper: bol.com',
    quantity: '3 x €',
    unitPrice: '3 x €53,99',
    shipping: 'Verzendkosten: €0,00',
    total: 'Totaal: €161,97',
    deliveryDate: 'Bezorgdatum: woensdag 3 juli',
  }

  const captured = {
    orderRef: 'C0008N401L',
    title: 'LEGO Star Wars 75192',
    seller: 'bol.com',
    quantity: '3 x €',
    unitPrice: '53,99',
    shipping: '0,00',
    total: '161,97',
    deliveryDate: '3 juli',
  }

  it('extracts the order into the same shape the .eml parser produces', () => {
    const event = bolOrderConfirmationTask.toEvent(labelled, OCCURRED)

    expect(event.type).toBe('order_placed')
    expect(event.retailer).toBe('bol')
    expect(event.externalOrderId).toBe('C0008N401L')
    expect(event.occurredAt).toBe(OCCURRED)
    expect(event.payload).toMatchObject({
      title: 'LEGO Star Wars 75192',
      seller: 'bol.com',
      quantity: 3,
      currency: 'EUR',
      unitMinor: 5399,
      shippingMinor: 0,
      totalMinor: 16197,
      deliveryDate: '2026-07-03',
    })
  })

  it('reads a whole-match result and a capture-group result identically', () => {
    // Which of the two Inbox returns is not documented, so both must work.
    expect(bolOrderConfirmationTask.toEvent(captured, OCCURRED))
      .toEqual(bolOrderConfirmationTask.toEvent(labelled, OCCURRED))
  })

  it('marks the totals as consistent when the parts add up', () => {
    expect(bolOrderConfirmationTask.toEvent(labelled, OCCURRED).payload.totalsConsistent).toBe(true)
  })

  it('flags totals that do not add up rather than trusting them', () => {
    const event = bolOrderConfirmationTask.toEvent({ ...labelled, total: 'Totaal: €99,00' }, OCCURRED)
    expect(event.payload.totalsConsistent).toBe(false)
    expect(event.payload.totalMinor).toBe(9900)
  })

  it('reads free shipping as zero, not as a missing value', () => {
    const event = bolOrderConfirmationTask.toEvent({ ...labelled, shipping: 'Verzendkosten: Gratis' }, OCCURRED)
    expect(event.payload.shippingMinor).toBe(0)
  })

  it('records a missing amount as unknown rather than as zero', () => {
    const { total: _total, ...withoutTotal } = labelled
    const event = bolOrderConfirmationTask.toEvent(withoutTotal, OCCURRED)
    expect(event.payload.totalMinor).toBeNull()
    expect(event.payload.totalsConsistent).toBe(false)
  })

  it('takes the first value when a pattern matched more than once', () => {
    const event = bolOrderConfirmationTask.toEvent(
      { ...labelled, orderRef: 'C0008N401L\nC000CXJLHK' },
      OCCURRED,
    )
    expect(event.externalOrderId).toBe('C0008N401L')
  })

  it('rolls a delivery day into next year when it would otherwise be past', () => {
    // Ordered 28 December, delivering 2 January: the year of the mail is wrong.
    const event = bolOrderConfirmationTask.toEvent(
      { ...labelled, deliveryDate: 'Bezorgdatum: 2 januari' },
      '2026-12-28T09:00:00.000Z',
    )
    expect(event.payload.deliveryDate).toBe('2027-01-02')
  })

  it('marks a truncated title so review can tell it is incomplete', () => {
    const event = bolOrderConfirmationTask.toEvent({ ...labelled, title: 'LEGO Star Wars Ultimate...' }, OCCURRED)
    expect(event.payload.titleTruncated).toBe(true)
  })

  it('filters on the sender and the subject, and asks for the fields that matter', () => {
    const task = bolOrderConfirmationTask.build(REQUEST)
    expect(task.mailFilters).toContainEqual({
      target: 'from', comparator: 'includes', value: 'automail@bol.com',
    })
    expect(task.mailElements.map((element) => element.name)).toEqual([
      'orderRef', 'title', 'seller', 'quantity', 'unitPrice', 'shipping', 'total', 'deliveryDate',
    ])
  })
})

describe('bol.com shipment confirmation', () => {
  const results = {
    carrier: 'Je pakket is nu bij DHL',
    orderRef: 'C000CXJLHK',
    title: 'Dit is onderweg 1 artikel Nintendo Switch 2',
    quantity: '2 stuks',
    expectedDelivery: 'Bezorgd op maandag 3 juli',
    postalCode: '1012 AB',
  }

  it('produces a shipped event carrying carrier, contents and postcode', () => {
    const event = bolShipmentTask.toEvent(results, OCCURRED)

    expect(event.type).toBe('shipped')
    expect(event.externalOrderId).toBe('C000CXJLHK')
    expect(event.payload).toMatchObject({
      carrier: 'dhl',
      direction: 'inbound',
      title: 'Nintendo Switch 2',
      quantity: 2,
      expectedDeliveryAt: '2026-07-03',
      deliveryPostalCode: '1012AB',
      deliveryPostalCodeFormatted: '1012 AB',
      dhlRedirectable: true,
    })
  })

  it('passes an unrecognised carrier through lowercased rather than dropping it', () => {
    const event = bolShipmentTask.toEvent({ ...results, carrier: 'Je pakket is nu bij Homerr!' }, OCCURRED)
    expect(event.payload.carrier).toBe('homerr')
    expect(event.payload.dhlRedirectable).toBe(false)
  })

  it('reports no tracking code, because bol.com does not put one in this mail', () => {
    const event = bolShipmentTask.toEvent(results, OCCURRED)
    expect(event.payload.trackingNumber).toBeNull()
    expect(event.payload.trackingResolvable).toBe(false)
  })

  it('defaults quantity to one unit when the mail states none', () => {
    const { quantity: _quantity, ...withoutQuantity } = results
    expect(bolShipmentTask.toEvent(withoutQuantity, OCCURRED).payload.quantity).toBe(1)
  })

  it('is not redirectable without a postcode, even for DHL', () => {
    const { postalCode: _postalCode, ...withoutPostcode } = results
    const event = bolShipmentTask.toEvent(withoutPostcode, OCCURRED)
    expect(event.payload.dhlRedirectable).toBe(false)
    expect(event.payload.deliveryPostalCode).toBeNull()
  })
})

describe('bol.com cancellation', () => {
  it('names the cancelled item and leaves the refund amount to the order', () => {
    const event = bolCancellationTask.toEvent({
      orderRef: 'C000CXJH1J',
      title: 'Dit is geannuleerd 1 artikel LEGO Technic 42096',
      quantity: '1 stuks',
      refundPhrase: 'krijg je dat terug',
    }, OCCURRED)

    expect(event.type).toBe('cancelled')
    expect(event.externalOrderId).toBe('C000CXJH1J')
    expect(event.payload).toMatchObject({
      title: 'LEGO Technic 42096',
      totalMinor: null,
      refundExpected: true,
    })
  })

  it('treats an absent refund phrase as unstated rather than as a refusal', () => {
    const event = bolCancellationTask.toEvent({ orderRef: 'C000CXJH1J' }, OCCURRED)
    expect(event.payload.refundExpected).toBe(false)
    expect(event.payload.title).toBeNull()
  })
})

describe('the other retailers', () => {
  it('reads a MediaMarkt order number and total', () => {
    const event = mediamarktOrderTask.toEvent(
      { orderRef: 'bestelnummer is 1234567', total: 'Totaalbedrag: €249,00' },
      OCCURRED,
    )
    expect(event.externalOrderId).toBe('1234567')
    expect(event.payload.totalMinor).toBe(24900)
    // No per-unit breakdown is trusted, so it stays unknown.
    expect(event.payload.quantity).toBeNull()
  })

  it('excludes cancellation and shipping mail from the MediaMarkt order task', () => {
    const excluded = mediamarktOrderTask.build(REQUEST).mailFilters
      .filter((filter) => filter.comparator === 'excludes')
      .map((filter) => filter.value)
    expect(excluded).toEqual(['geannuleerd', 'onderweg'])
  })

  it('reads a MediaMarkt GLS barcode as a tracked shipment', () => {
    const event = mediamarktShipmentTask.toEvent(
      { orderRef: '1234567', tracking: 'JVGL0123456789' },
      OCCURRED,
    )
    expect(event.type).toBe('shipped')
    expect(event.payload.carrier).toBe('gls')
    expect(event.payload.trackingNumber).toBe('JVGL0123456789')
  })

  it('reads a Proshop order number and total', () => {
    const event = proshopOrderTask.toEvent(
      { orderRef: 'Bestelnummer: 9876543', total: 'Totaal €1.234,56' },
      OCCURRED,
    )
    expect(event.externalOrderId).toBe('9876543')
    expect(event.payload.totalMinor).toBe(123456)
  })

  it('takes the PocketGames reference from the subject, where Shopify puts it', () => {
    const task = pocketgamesOrderTask.build(REQUEST)
    expect(task.mailElements.find((element) => element.name === 'orderRef')?.target).toBe('subject')

    const event = pocketgamesOrderTask.toEvent(
      { orderRef: 'Order #1234', total: 'Total: €59,99', shipping: 'Shipping: €4,95' },
      OCCURRED,
    )
    expect(event.externalOrderId).toBe('1234')
    expect(event.payload.totalMinor).toBe(5999)
    expect(event.payload.shippingMinor).toBe(495)
  })

  it('marks every capture as coming from Inbox, which cannot be re-parsed later', () => {
    for (const builder of AYCD_TASK_BUILDERS) {
      expect(builder.toEvent({}, OCCURRED).payload.source, builder.id).toBe('aycd-inbox')
    }
  })

  it('records an unidentifiable capture without an order reference rather than inventing one', () => {
    for (const builder of AYCD_TASK_BUILDERS) {
      expect(builder.toEvent({}, OCCURRED).externalOrderId, builder.id).toBeNull()
    }
  })
})
