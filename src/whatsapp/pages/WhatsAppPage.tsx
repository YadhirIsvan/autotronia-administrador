import { useState } from 'react'
import { Loader2, Wifi, WifiOff, QrCode, Phone, LogOut, Send, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { useWhatsAppStatus, useWhatsAppQR, useWhatsAppMutations } from '../hooks'
import { useAuth } from '@/auth/context'

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; className: string }> = {
    WORKING:      { label: 'Conectado',    className: 'bg-green-100 text-green-700' },
    SCAN_QR_CODE: { label: 'Esperando QR', className: 'bg-yellow-100 text-yellow-700' },
    STARTING:     { label: 'Iniciando…',   className: 'bg-blue-100 text-blue-700' },
    STOPPED:      { label: 'Detenido',     className: 'bg-gray-100 text-gray-600' },
    FAILED:       { label: 'Error',        className: 'bg-red-100 text-red-700' },
    UNKNOWN:      { label: 'Desconocido',  className: 'bg-gray-100 text-gray-600' },
  }
  const { label, className } = map[status] ?? map['UNKNOWN']
  return (
    <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-medium ${className}`}>
      {status === 'WORKING' ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
      {label}
    </span>
  )
}

function QRSection({ qrBase64 }: { qrBase64: string }) {
  return (
    <div className="flex flex-col items-center gap-3 p-4 bg-gray-50 rounded-xl">
      <div className="flex items-center gap-2 text-sm text-gray-600">
        <QrCode className="h-4 w-4" />
        Escanea con WhatsApp del número de Autotronia
      </div>
      <img
        src={`data:image/png;base64,${qrBase64}`}
        alt="QR WhatsApp"
        className="w-64 h-64 rounded-lg border border-gray-200"
      />
      <p className="text-xs text-gray-400 text-center">
        WhatsApp → Dispositivos vinculados → Vincular dispositivo
      </p>
    </div>
  )
}

function TestMessageForm({ onSend, isPending }: { onSend: (phone: string, msg: string) => void; isPending: boolean }) {
  const [phone, setPhone] = useState('')
  const [message, setMessage] = useState('Mensaje de prueba desde Autotronia ✅')

  const handleSend = () => {
    if (!phone.trim()) { toast.error('Ingresa un número de teléfono'); return }
    onSend(phone.trim(), message.trim() || 'Mensaje de prueba')
  }

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
        <Send className="h-4 w-4" /> Enviar mensaje de prueba
      </h3>
      <input
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        placeholder="5215512345678 (con código país)"
        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
      />
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        rows={2}
        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900 resize-none"
      />
      <button
        onClick={handleSend}
        disabled={isPending}
        className="flex items-center gap-2 bg-gray-900 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-700 disabled:opacity-50"
      >
        {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        Enviar
      </button>
    </div>
  )
}

export default function WhatsAppPage() {
  const { logout } = useAuth()
  const { data: status, isLoading, refetch } = useWhatsAppStatus()
  const { data: qrData } = useWhatsAppQR()
  const { start, logout: logoutWA, testMsg } = useWhatsAppMutations()

  const sessionStatus = status?.session_status ?? 'UNKNOWN'
  const isWorking = sessionStatus === 'WORKING'
  const needsQR = sessionStatus === 'SCAN_QR_CODE'
  const isStarting = sessionStatus === 'STARTING'
  const isOff = ['STOPPED', 'FAILED', 'UNKNOWN'].includes(sessionStatus)

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-gray-900">Autotronia Admin</h1>
          <p className="text-xs text-gray-400">Panel de administración</p>
        </div>
        <button
          onClick={logout}
          className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-900"
        >
          <LogOut className="h-4 w-4" /> Salir
        </button>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-8 space-y-6">
        {/* Estado de la sesión */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 space-y-5">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-gray-900">WhatsApp — Sesión global</h2>
            <button onClick={() => refetch()} className="text-gray-400 hover:text-gray-700">
              <RefreshCw className="h-4 w-4" />
            </button>
          </div>

          {isLoading ? (
            <div className="flex items-center gap-2 text-gray-400 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" /> Cargando…
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <StatusBadge status={sessionStatus} />
                {isWorking && status?.connected_phone && (
                  <span className="text-sm text-gray-500 flex items-center gap-1">
                    <Phone className="h-3.5 w-3.5" /> +{status.connected_phone}
                  </span>
                )}
              </div>

              {/* QR */}
              {needsQR && qrData?.qr && <QRSection qrBase64={qrData.qr} />}
              {needsQR && !qrData?.qr && (
                <div className="flex items-center gap-2 text-sm text-yellow-600">
                  <Loader2 className="h-4 w-4 animate-spin" /> Generando QR…
                </div>
              )}
              {isStarting && (
                <div className="flex items-center gap-2 text-sm text-blue-600">
                  <Loader2 className="h-4 w-4 animate-spin" /> Iniciando sesión de WhatsApp…
                </div>
              )}

              {/* Acciones */}
              <div className="flex gap-3 flex-wrap">
                {isOff && (
                  <button
                    onClick={() => start.mutate()}
                    disabled={start.isPending}
                    className="flex items-center gap-2 bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50"
                  >
                    {start.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <QrCode className="h-4 w-4" />}
                    Vincular número
                  </button>
                )}
                {(isWorking || needsQR) && (
                  <button
                    onClick={() => logoutWA.mutate()}
                    disabled={logoutWA.isPending}
                    className="flex items-center gap-2 border border-red-300 text-red-600 px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-50 disabled:opacity-50"
                  >
                    {logoutWA.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <WifiOff className="h-4 w-4" />}
                    Desvincular
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Mensaje de prueba */}
        {isWorking && (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
            <TestMessageForm
              onSend={(phone, message) => testMsg.mutate({ phone, message })}
              isPending={testMsg.isPending}
            />
          </div>
        )}

        {/* Guía de reconexión */}
        <div className="bg-blue-50 rounded-2xl p-5 text-sm text-blue-700 space-y-2">
          <p className="font-semibold">¿Se desconectó? Reconexión rápida desde el VPS:</p>
          <pre className="bg-blue-100 rounded-lg p-3 text-xs overflow-x-auto whitespace-pre-wrap">
{`# 1. Cerrar sesión actual
curl -s -X POST -H "X-Api-Key: taller123" \\
  http://localhost:3000/api/sessions/default/logout

# 2. Esperar ~15 segundos y usar el botón "Vincular" aquí`}
          </pre>
        </div>
      </main>
    </div>
  )
}
