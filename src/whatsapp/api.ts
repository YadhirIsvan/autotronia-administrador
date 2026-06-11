import client from '@/api/client'
import type { WhatsAppStatus, QRResponse, TestMessagePayload } from './types'

export const whatsappApi = {
  status: () => client.get<WhatsAppStatus>('/api/whatsapp/status/'),
  qr: () => client.get<QRResponse>('/api/whatsapp/qr/'),
  start: () => client.post<{ message: string }>('/api/whatsapp/start/'),
  logout: () => client.post<{ message: string }>('/api/whatsapp/logout/'),
  test: (payload: TestMessagePayload) =>
    client.post<{ message: string }>('/api/whatsapp/test/', payload),
}
