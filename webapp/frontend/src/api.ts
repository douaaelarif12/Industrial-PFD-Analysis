// In local Vite development, `/api` is proxied to FastAPI.  Keeping requests
// same-origin avoids browser CORS/localhost resolution issues.  A deployment
// can still supply VITE_API_URL explicitly.
export const API_URL = import.meta.env.VITE_API_URL || ''

// Artifact files are served by FastAPI (not by Vite). During local development
// the UI runs on :5173, so relative /analysis-files links must target :8000.
export function assetUrl(path: string): string {
  if (/^(https?:|data:|blob:)/i.test(path)) return path
  if (API_URL) return `${API_URL.replace(/\/$/, '')}${path}`
  if (typeof window !== 'undefined' && window.location.port === '5173') return `http://127.0.0.1:8000${path}`
  return path
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  const token = localStorage.getItem('pfd-access-token')
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const response = await fetch(`${API_URL}${path}`, { ...init, headers })
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`)
  return response.json() as Promise<T>
}
