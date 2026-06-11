import { createBrowserRouter, Navigate } from 'react-router-dom'
import { lazy, Suspense } from 'react'
import { SuperadminRoute } from '@/auth/guards'

const Login = lazy(() => import('@/auth/pages/Login'))
const WhatsAppPage = lazy(() => import('@/whatsapp/pages/WhatsAppPage'))

const Spinner = () => (
  <div className="flex items-center justify-center min-h-screen">
    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900" />
  </div>
)

export const router = createBrowserRouter([
  { path: '/login', element: <Suspense fallback={<Spinner />}><Login /></Suspense> },
  {
    element: <SuperadminRoute />,
    children: [
      { path: '/whatsapp', element: <Suspense fallback={<Spinner />}><WhatsAppPage /></Suspense> },
    ],
  },
  { path: '/', element: <Navigate to="/whatsapp" replace /> },
  { path: '*', element: <Navigate to="/whatsapp" replace /> },
])
