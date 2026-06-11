import client from '@/api/client'
import type { LoginPayload, LoginResponse } from './types'

export const authApi = {
  login: (payload: LoginPayload) =>
    client.post<LoginResponse>('/api/auth/login/', payload),
  logout: (refresh: string) =>
    client.post('/api/auth/logout/', { refresh }),
}
