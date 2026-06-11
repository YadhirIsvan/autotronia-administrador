import { authApi } from './api'
import type { LoginPayload, User } from './types'

export async function loginAction(payload: LoginPayload): Promise<User> {
  const { data } = await authApi.login(payload)

  if (data.role !== 'superadmin') {
    throw new Error('Acceso denegado: se requiere cuenta de administrador Autotronia.')
  }

  localStorage.setItem('admin_token', data.access)
  localStorage.setItem('admin_refresh_token', data.refresh)
  const user: User = { id: data.user_id, email: data.email, name: data.name, role: data.role }
  localStorage.setItem('admin_user', JSON.stringify(user))
  return user
}

export function logoutAction(): void {
  const refresh = localStorage.getItem('admin_refresh_token') ?? ''
  void authApi.logout(refresh).catch(() => null)
  localStorage.removeItem('admin_token')
  localStorage.removeItem('admin_refresh_token')
  localStorage.removeItem('admin_user')
}
