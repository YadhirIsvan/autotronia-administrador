export interface WhatsAppStatus {
  enabled: boolean
  is_superadmin: boolean
  session_status: 'WORKING' | 'SCAN_QR_CODE' | 'STARTING' | 'STOPPED' | 'FAILED' | 'UNKNOWN'
  connected_phone: string
  business_phone: string
  admin_phones: string[]
  notifications: Record<string, unknown>
}

export interface QRResponse {
  qr: string // base64 PNG
}

export interface TestMessagePayload {
  phone: string
  message: string
}
