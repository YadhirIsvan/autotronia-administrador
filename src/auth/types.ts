export interface LoginPayload {
  username: string
  password: string
}

export interface User {
  id: number
  email: string
  name: string
  role: string
}

export interface LoginResponse {
  access: string
  refresh: string
  user_id: number
  email: string
  name: string
  role: string
}
