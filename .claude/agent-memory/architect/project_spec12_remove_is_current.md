---
name: spec_12_remove_is_current
description: spec_12 — Eliminar is_current de TenantUser para habilitar sesiones multi-tenant simultáneas
type: project
---

spec_12 propone eliminar `TenantUser.is_current` y hacer que el tenant siempre se resuelva desde `X-Tenant-ID` header.

**Why:** `is_current` asume sesión single-tenant: al hacer login en tenant B se pone `is_current=False` en tenant A, rompiendo la sesión paralela. El header ya se envía en todos los requests de la SPA.

**How to apply:** Cuando se trabaje en tenants o middlewares, recordar que `is_current` está pendiente de eliminación. No agregar nuevas referencias a `is_current`. El spec describe 22 archivos afectados y 11 pasos de implementación ordenados.

Puntos clave del plan:
- Paso 1: incrustar `tenant_id` como claim en el JWT access token (login + google auth).
- Paso 2: `NotificationConsumer` lee claim JWT en lugar de `filter(is_current=True)`.
- Pasos 3–9: actualizar services, permisos, middleware, views sin tocar BD.
- Paso 10: eliminar campo del modelo + migración `0002_remove_is_current_from_tenant_user`.
- Paso 11: limpiar conftest y 13 archivos de tests.

WebSocket es el único caso que NO puede usar el header HTTP — se resuelve con el claim JWT.
