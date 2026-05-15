import { authStore } from '@/store/auth-store'

export function managerApiHeaders(extra?: Record<string, string>): HeadersInit {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extra }
  if (authStore.jwt) headers['Authorization'] = `Bearer ${authStore.jwt}`
  return headers
}

export function managerApiFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, headers: managerApiHeaders(init?.headers as Record<string, string>) })
}

export function managerApiWebSocket(url: string): WebSocket {
  if (authStore.jwt) return new WebSocket(url, `access_token.${authStore.jwt}`)
  return new WebSocket(url)
}
