import { whatsappApi } from './api'
import type { WhatsAppStatus, QRResponse, TestMessagePayload } from './types'

export const getStatus = async (): Promise<WhatsAppStatus> => {
  const { data } = await whatsappApi.status()
  return data
}

export const getQR = async (): Promise<QRResponse> => {
  const { data } = await whatsappApi.qr()
  return data
}

export const startSession = async (): Promise<void> => {
  await whatsappApi.start()
}

export const logoutSession = async (): Promise<void> => {
  await whatsappApi.logout()
}

export const sendTestMessage = async (payload: TestMessagePayload): Promise<void> => {
  await whatsappApi.test(payload)
}
