import React, { createContext, useContext, useState, useCallback, useEffect } from 'react'
import type { User } from './types'
import { logoutAction } from './actions'

interface AuthContextType {
  user: User | null
  isAuthenticated: boolean
  isLoading: boolean
  setUser: (user: User | null) => void
  logout: () => void
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    const stored = localStorage.getItem('admin_user')
    const token = localStorage.getItem('admin_token')
    if (stored && token) {
      try { setUser(JSON.parse(stored) as User) } catch { /* ignore */ }
    }
    setIsLoading(false)
  }, [])

  const logout = useCallback(() => {
    logoutAction()
    setUser(null)
  }, [])

  return (
    <AuthContext.Provider value={{ user, isAuthenticated: !!user, isLoading, setUser, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
