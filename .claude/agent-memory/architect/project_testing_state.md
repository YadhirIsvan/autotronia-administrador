---
name: project_testing_state
description: Estado actual de la infraestructura de testing en Taller Pro (backend y frontend)
type: project
---

Estado a 2026-03-13:

**Backend (pytest):**
- pytest 8.0.0 + pytest-django 4.8.0 + pytest-cov 4.1.0 + factory-boy 3.3.0
- coverage mínimo: 65% (pytest.ini --cov-fail-under=65)
- FALTA: pytest-asyncio (sin él no hay tests async para WebSocket consumers)
- CHANNEL_LAYERS en testing.py NO tiene InMemoryChannelLayer configurado — base.py usa Redis. Necesita override en testing.py para tests de consumer.
- Archivos de test existentes: appointments/tests/{test_api,test_models,test_services}.py, tenants/tests/{test_api,test_models}.py
- NO existe: apps/notifications/tests/, apps/appointments/tests/test_signals.py

**Frontend (React/TS):**
- CERO infraestructura de testing: no hay vitest, jest, ni archivos .test.ts/.test.tsx
- TypeScript en modo permisivo (noImplicitAny: false, strictNullChecks: false)

**Why:** El plan de spec/02 y spec/03 requiere tests para: endpoint active_single, perform_create con 3 fallbacks, get_user_tenant_id en consumer, _send_appointment_notification con admins/owners/advisors, e initTenant/discoverSingleTenant en frontend.

**How to apply:** Al proponer tests, incluir siempre: instalación de pytest-asyncio, configuración de InMemoryChannelLayer en testing.py, y setup completo de vitest para frontend.
