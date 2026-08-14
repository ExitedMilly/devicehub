/**
 * Holds manager requests until the device booking has settled.
 *
 * Opening a device runs two independent things at once: the stores mount and immediately ask the
 * manager for their state, and `DeviceLifecycleService.prepareDevice` books the device over
 * socket.io. Nothing ordered them, so the mount-time reads regularly won the race by a few hundred
 * milliseconds and hit the manager before an owner existed — the manager answered 403, and the user
 * saw empty Scenarios and Schedule until they reloaded the page.
 *
 * The gate is a barrier, not a retry. It delays a request until the booking outcome is known and
 * then lets it go exactly once, whatever that outcome was: a user who really does not own the
 * device still gets the manager's honest 403, immediately after the booking attempt fails, with no
 * repeated attempts to paper over it.
 *
 * It lives at the single place every manager call passes through (`managerApiFetch`) rather than in
 * the stores, so a store added later is covered without knowing this file exists.
 */

/** Backstop: if booking never settles, stop blocking and let requests take their chances. */
const BOOKING_SETTLE_TIMEOUT_MS = 15_000

type GateEntry = {
  promise: Promise<void>
  settle: () => void
  timer: ReturnType<typeof setTimeout>
}

class DeviceBookingGate {
  private entries = new Map<string, GateEntry>()

  /**
   * Arm the gate for a serial. Called when the device's DI container is created — that happens
   * during the control page's render, before any device store can be resolved, which is what makes
   * the barrier cover even a store that fetches straight from its constructor.
   */
  arm(serial: string): void {
    if (!serial || this.entries.has(serial)) return

    let settle!: () => void
    const promise = new Promise<void>((resolve) => {
      settle = resolve
    })

    const timer = setTimeout(() => {
      settle()
    }, BOOKING_SETTLE_TIMEOUT_MS)

    this.entries.set(serial, { promise, settle, timer })
  }

  /** Hand the gate the booking promise. Settles the barrier on both success and failure. */
  track(serial: string, booking: Promise<unknown>): void {
    const entry = this.entries.get(serial)
    if (!entry) return

    booking
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(entry.timer)
        entry.settle()
      })
  }

  /** Drop the barrier for a serial, so re-opening the device arms a fresh one. */
  release(serial: string): void {
    const entry = this.entries.get(serial)
    if (!entry) return

    clearTimeout(entry.timer)
    entry.settle()
    this.entries.delete(serial)
  }

  /**
   * Resolves once this serial's booking has settled. Resolves immediately when the gate was never
   * armed for it, so a manager call made outside a control page behaves exactly as before.
   */
  whenSettled(serial: string): Promise<void> {
    return this.entries.get(serial)?.promise ?? Promise.resolve()
  }
}

export const deviceBookingGate = new DeviceBookingGate()
