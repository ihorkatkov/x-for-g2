/** Bounded, local-only diagnostics. No free text, PCM, vectors, URLs or device IDs. */
export type Metrics = Record<string, number | boolean>
export type EventName = 'session.start' | 'session.end' | 'screen' | 'input' | 'error' | 'render' | 'health'
export type RecordEntry = { at: string; event: EventName; metrics: Metrics }
export class Diagnostics {
  // LAN development pages may lack secure-context randomUUID; this ID is not an auth token.
  readonly session = globalThis.crypto?.randomUUID?.() ?? `session-${Date.now()}-${Math.random().toString(36).slice(2)}`
  private entries: RecordEntry[] = []
  dropped = 0
  readonly app: string
  readonly version: string
  readonly sdk: string
  readonly capacity: number
  constructor(app: string, version: string, sdk: string, capacity = 200) {
    this.app = app; this.version = version; this.sdk = sdk; this.capacity = capacity
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 1000) throw new Error('Invalid diagnostics capacity')
  }
  record(event: EventName, metrics: Metrics = {}) {
    // Copy only finite scalar measurements. Bound key count and size as well as record count.
    const safe: Metrics = {}
    for (const [key, value] of Object.entries(metrics).slice(0, 40)) {
      if (/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(key) && (typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value))) safe[key] = value
    }
    this.entries.push({ at: new Date().toISOString(), event, metrics: safe })
    if (this.entries.length > this.capacity) { this.entries.shift(); this.dropped++ }
  }
  export() { return { schema: 1, app: this.app, version: this.version, sdk: this.sdk, session: this.session, dropped: this.dropped, events: this.entries.map(e => ({ ...e, metrics: { ...e.metrics } })) } }
}
