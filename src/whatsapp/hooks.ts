import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { getStatus, getQR, startSession, logoutSession, sendTestMessage } from './actions'
import type { TestMessagePayload } from './types'

const STATUS_KEY = ['whatsapp', 'status']
const QR_KEY = ['whatsapp', 'qr']

export function useWhatsAppStatus() {
  return useQuery({
    queryKey: STATUS_KEY,
    queryFn: getStatus,
    refetchInterval: (query) => {
      const status = query.state.data?.session_status
      // Polling rápido solo cuando está esperando QR o arrancando
      if (status === 'SCAN_QR_CODE' || status === 'STARTING') return 5_000
      return 30_000
    },
  })
}

export function useWhatsAppQR() {
  const { data: status } = useWhatsAppStatus()
  return useQuery({
    queryKey: QR_KEY,
    queryFn: getQR,
    enabled: status?.session_status === 'SCAN_QR_CODE',
    refetchInterval: 5_000,
  })
}

export function useWhatsAppMutations() {
  const qc = useQueryClient()
  const invalidate = () => qc.invalidateQueries({ queryKey: STATUS_KEY })

  const start = useMutation({
    mutationFn: startSession,
    onSuccess: () => { toast.success('Sesión iniciada — escanea el QR'); void invalidate() },
    onError: () => toast.error('Error al iniciar sesión'),
  })

  const logout = useMutation({
    mutationFn: logoutSession,
    onSuccess: () => { toast.success('Sesión cerrada'); void invalidate() },
    onError: () => toast.error('Error al cerrar sesión'),
  })

  const testMsg = useMutation({
    mutationFn: (payload: TestMessagePayload) => sendTestMessage(payload),
    onSuccess: () => toast.success('Mensaje enviado correctamente'),
    onError: () => toast.error('Error al enviar mensaje'),
  })

  return { start, logout, testMsg }
}
