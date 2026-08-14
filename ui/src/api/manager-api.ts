import { authStore } from '@/store/auth-store'
import { deviceBookingGate } from '@/store/device-booking-gate'

export function managerApiHeaders(extra?: Record<string, string>): HeadersInit {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extra }
  if (authStore.jwt) headers['Authorization'] = `Bearer ${authStore.jwt}`
  return headers
}

/**
 * Every manager URL is `/manager-api/<endpoint>/<serial>` with the serial percent-encoded, and any
 * further segments (`/status`, `/host-address`, a beacon id) come after it. Endpoints without a
 * serial yield nothing and are not gated.
 */
function serialFromManagerUrl(url: string): string {
  const [, prefix, , serial] = url.split('/')
  if (prefix !== 'manager-api' || !serial) return ''

  try {
    return decodeURIComponent(serial)
  } catch {
    return ''
  }
}

export async function managerApiFetch(url: string, init?: RequestInit): Promise<Response> {
  // Wait for the device booking to settle before asking the manager anything about that device.
  // Without this the stores' mount-time reads race the booking and come back 403. See
  // device-booking-gate for why the barrier lives here and not in each store.
  await deviceBookingGate.whenSettled(serialFromManagerUrl(url))

  return fetch(url, { ...init, headers: managerApiHeaders(init?.headers as Record<string, string>) })
}

export function managerApiWebSocket(url: string): WebSocket {
  if (authStore.jwt) return new WebSocket(url, `access_token.${authStore.jwt}`)
  return new WebSocket(url)
}
