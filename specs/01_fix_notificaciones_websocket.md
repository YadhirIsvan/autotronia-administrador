# Análisis Técnico: Fix Notificaciones WebSocket en Tiempo Real

## Problema

Los administradores y asesores no reciben notificaciones en tiempo real cuando un cliente agenda una cita desde el panel de booking público. Las notificaciones se guardan en la base de datos pero nunca se entregan vía WebSocket al frontend.

## Impacto Arquitectural

### Backend
- **Modelos afectados**: `Appointment` — el campo `tenant` llega `NULL` en citas creadas desde booking público
- **Signals**: `apps/appointments/signals.py` — el bloque de notificación se omite cuando `appointment.tenant_id` es `None`
- **ViewSet**: `apps/appointments/views.py` — `perform_create` no asigna tenant si `request.tenant` es `None`
- **Queryset del signal**: El JOIN con `tenant_memberships` puede excluir admins sin membership explícita

### Frontend
- **WebSocket URL**: `src/lib/websocket.ts` — hardcodea puerto `8001` que no está accesible desde el host (Daphne está detrás de Nginx)
- **Tenant header**: `src/lib/api.ts` — no envía `X-Tenant-ID` cuando el tenant es `'default'`, causando que el backend no resuelva el tenant en requests del booking público

### Infraestructura
- **Nginx** (`docker/nginx/nginx.conf` y `nginx.dev.conf`): `proxy_read_timeout 60s` en el bloque `/ws/` mata conexiones WebSocket inactivas cada minuto. Tras 10 reconexiones fallidas, el frontend abandona permanentemente.

### Base de Datos
- Citas históricas existentes con `tenant_id = NULL` no triggerean notificaciones
- No se requieren migraciones de schema — solo reparación de datos

---

## Bugs Identificados

### Bug #1 — CRÍTICO | Frontend | `websocket.ts:211`
WebSocket hardcodea `ws://localhost:8001` pero Daphne tiene `expose` (interno Docker), no `ports`. El navegador no puede alcanzar ese puerto. Debe conectar vía Nginx en puerto 80.

### Bug #2 — CRÍTICO | Nginx | `nginx.dev.conf:80` y `nginx.conf:152`
`proxy_read_timeout 60s` cierra conexiones WebSocket inactivas. El frontend reconecta con backoff exponencial hasta 10 intentos y luego abandona permanentemente hasta reload de página.

### Bug #3 — CRÍTICO | Backend + Frontend | `views.py:114` + `api.ts:757`
Cadena de fallo:
1. `getCurrentTenant()` retorna `'default'` en booking público sin slug configurado
2. `apiFetch` omite el header `X-Tenant-ID` cuando tenant es `'default'`
3. `TenantMiddleware` no resuelve tenant → `request.tenant = None`
4. `perform_create` no asigna `appointment.tenant`
5. Signal: `if appointment.tenant_id:` → `False` → bloque de notificación omitido → `user_ids = []` → nadie notificado

### Bug #4 — MODERADO | Backend | `signals.py:116`
El queryset usa JOIN con `tenant_memberships`, excluyendo admins que existen en el sistema pero no tienen un registro `TenantMembership` para ese tenant específico.

---

## Plan de Implementación

### ✅ Paso 1 — Nginx: Aumentar timeout de WebSocket _(COMPLETADO)_
**Archivos:** `docker/nginx/nginx.dev.conf` y `docker/nginx/nginx.conf`
**Prioridad:** CRÍTICO | **Esfuerzo:** 5 min | **Riesgo:** Bajo

En el bloque `location /ws/` de **ambos** archivos, cambiar:
```nginx
# ANTES
proxy_connect_timeout 60s;
proxy_send_timeout 60s;
proxy_read_timeout 60s;

# DESPUÉS
proxy_connect_timeout 60s;
proxy_send_timeout 3600s;
proxy_read_timeout 3600s;
```

**Restart requerido:**
```bash
# Local
docker compose -f docker-compose.local.yml exec nginx nginx -s reload

# Producción
docker compose exec nginx nginx -s reload
```
> `nginx -s reload` es graceful — no interrumpe conexiones activas.

---

### ✅ Paso 2 — Frontend: Corregir URL del WebSocket _(COMPLETADO)_
**Archivo:** `front-end-taller-pro/src/lib/websocket.ts`
**Prioridad:** CRÍTICO | **Esfuerzo:** 5 min | **Riesgo:** Bajo

**Líneas 209–214 — cambio:**
```typescript
// ANTES
if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
    const wsPort = '8001'; // Puerto de Daphne en desarrollo
    console.log('[WebSocket] Modo desarrollo - usando puerto:', wsPort);
    return `${wsProtocol}//${url.hostname}:${wsPort}/ws/notifications/`;
}

// DESPUÉS — conectar siempre vía Nginx (que rutea internamente a Daphne)
if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
    console.log('[WebSocket] Modo desarrollo - usando Nginx en puerto 80');
    return `${wsProtocol}//${url.hostname}/ws/notifications/`;
}
```

**Líneas 222–224 — cambio en el fallback:**
```typescript
// ANTES
const host = window.location.hostname === 'localhost'
    ? 'localhost:8001'
    : 'api.autotronia.com';

// DESPUÉS
const host = window.location.hostname === 'localhost'
    ? 'localhost'
    : 'api.autotronia.com';
```

**Validación:** Abrir DevTools → Network → WS. Debe aparecer una conexión a `ws://localhost/ws/notifications/` con status 101 Switching Protocols.

---

### ✅ Paso 3-A — Backend: Fallback de tenant en `perform_create` _(COMPLETADO)_
**Archivo:** `backend-taller-pro/apps/appointments/views.py`
**Prioridad:** CRÍTICO | **Esfuerzo:** 15 min | **Riesgo:** Medio

**Cambio en `perform_create` (líneas 108–124):**
```python
# ANTES
def perform_create(self, serializer):
    user = self.request.user
    extra_fields = {'created_by': user}

    tenant = getattr(self.request, 'tenant', None)
    if tenant:
        extra_fields['tenant'] = tenant
    # ...
    serializer.save(**extra_fields)

# DESPUÉS — agregar fallback por tenant_slug en el body del request
def perform_create(self, serializer):
    user = self.request.user
    extra_fields = {'created_by': user}

    # Resolver tenant: primero del middleware, luego del body (booking público)
    tenant = getattr(self.request, 'tenant', None)
    if not tenant:
        tenant_slug = self.request.data.get('tenant_slug')
        if tenant_slug:
            from apps.tenants.models import Tenant
            tenant = Tenant.objects.filter(slug=tenant_slug, is_active=True).first()

    if tenant:
        extra_fields['tenant'] = tenant

    # ...resto sin cambios
    serializer.save(**extra_fields)
```

**Restart requerido:**
```bash
docker compose -f docker-compose.local.yml restart web daphne
```

**Validación:**
```python
# Django shell
from apps.appointments.models import Appointment
Appointment.objects.order_by('-created_at').first().tenant
# Debe retornar el objeto Tenant, no None
```

---

### ✅ Paso 3-B — Frontend: Incluir `tenant_slug` en payload de booking _(COMPLETADO)_
**Archivo:** `front-end-taller-pro/src/lib/api.ts`
**Prioridad:** CRÍTICO | **Esfuerzo:** 10 min | **Riesgo:** Bajo

**En la función `createAppointment` (~línea 749), agregar `tenant_slug` al payload:**
```typescript
// Agregar después de construir el payload base:
const currentTenant = getCurrentTenant();
const payload: Record<string, any> = {
    customer: data.customer || data.customerId,
    vehicle: data.vehicle || data.vehicleId,
    appointment_type: data.appointment_type || data.serviceType,
    scheduled_date: formattedDate,
    scheduled_time: data.scheduled_time || data.time,
    reason: data.reason || 'Cita Web',
    symptoms: data.symptoms || data.notes || '',
};

// Incluir tenant_slug para que el backend resuelva el tenant
// cuando X-Tenant-ID no llega (booking público sin slug en header)
if (currentTenant && currentTenant !== 'default') {
    payload.tenant_slug = currentTenant;
}
```

> `getCurrentTenant()` ya está importado en `api.ts` (línea 6 vía `tenant.ts`). No requiere import adicional.

**Validación:** En Network tab del navegador, verificar que el POST a `/api/appointments/` incluya `tenant_slug` en el body cuando `VITE_TENANT_SLUG` está configurado.

---

### ✅ Paso 4 — Backend: Query más robusta en el signal _(COMPLETADO)_
**Archivo:** `backend-taller-pro/apps/appointments/signals.py`
**Prioridad:** MODERADO | **Esfuerzo:** 15 min | **Riesgo:** Bajo

**Cambio en `_send_appointment_notification` (líneas 110–126):**
```python
# ANTES
if appointment.tenant_id:
    from django.db.models import Q
    users = User.objects.filter(
        is_active=True,
        tenant_memberships__tenant_id=appointment.tenant_id
    ).filter(
        Q(groups__name__in=['advisors', 'admins', 'Advisors', 'Admins']) |
        Q(is_staff=True)
    ).distinct()
    for uid in users.values_list('id', flat=True):
        if uid not in user_ids:
            user_ids.append(uid)

# DESPUÉS — separar queries para mayor claridad y robustez
if appointment.tenant_id:
    from django.db.models import Q

    # Usuarios con membership en el tenant Y rol advisor/admin
    users_with_role = User.objects.filter(
        is_active=True,
        tenant_memberships__tenant_id=appointment.tenant_id,
        groups__name__in=['advisors', 'admins', 'Advisors', 'Admins'],
    ).distinct()

    # Staff con membership en el tenant (superadmins)
    staff_users = User.objects.filter(
        is_active=True,
        is_staff=True,
        tenant_memberships__tenant_id=appointment.tenant_id,
    ).distinct()

    # Unir sin duplicados usando sets de Python (evita UNION SQL)
    notifiable_ids = (
        set(users_with_role.values_list('id', flat=True)) |
        set(staff_users.values_list('id', flat=True))
    )

    for uid in notifiable_ids:
        if uid not in user_ids:
            user_ids.append(uid)
```

**Validación:**
```python
# Django shell
from apps.appointments.signals import _send_appointment_notification
from apps.appointments.models import Appointment
appt = Appointment.objects.filter(tenant__isnull=False).first()
_send_appointment_notification(appt, 'appointment', 'Test notif', 'Mensaje de prueba')
# Logs deben mostrar: [Notificaciones] Enviando a N usuarios: [1, 2, ...]
```

---

### ✅ Paso 5 — Datos: Reparar citas históricas sin tenant _(NO REQUERIDO — 0 citas huérfanas)_
**Tipo:** Script de mantenimiento en Django shell
**Prioridad:** MODERADO | **Esfuerzo:** 10 min | **Riesgo:** Alto (verificar antes de ejecutar)

```python
# 1. Diagnóstico — ejecutar primero, NO modificar nada
from apps.appointments.models import Appointment
from apps.tenants.models import Tenant

orphaned = Appointment.objects.filter(tenant__isnull=True)
print(f"Citas sin tenant: {orphaned.count()}")

tenants = Tenant.objects.filter(is_active=True)
print(f"Tenants activos: {list(tenants.values('id', 'slug', 'name'))}")

# 2. Ver de quién son las citas huérfanas
for appt in orphaned[:10]:
    print(f"  ID={appt.id} | {appt.customer} | creada={appt.created_at} | por={appt.created_by}")

# 3. SOLO ejecutar si hay un único tenant y las citas claramente le pertenecen
# main_tenant = Tenant.objects.get(slug='mi-taller-slug')
# orphaned.update(tenant=main_tenant)
# print(f"Actualizadas: {orphaned.count()} citas")
```

**Riesgo:** Si hay múltiples tenants, asignar todas al mismo tenant es incorrecto. Hacer el update manualmente por grupos basándose en el `created_by` y su tenant membership.

---

## Consideraciones de Seguridad

- **`tenant_slug` en body**: Se valida con `Tenant.objects.filter(slug=..., is_active=True)` — un slug inválido simplemente no resuelve tenant. No hay riesgo de inyección.
- **Aislamiento multi-tenant**: El signal sigue filtrando por `tenant_memberships__tenant_id` — usuarios de otros tenants no reciben notificaciones cruzadas.
- **Nginx timeout 3600s**: Con alta concurrencia puede agotar file descriptors de Daphne. Mitigación futura: implementar ping/pong en el consumer para detectar conexiones muertas.

## Validación End-to-End

Después de aplicar todos los pasos, validar el flujo completo:

1. Admin logueado en `http://localhost:8081/dashboard`
2. Verificar en DevTools → Network → WS: conexión activa a `ws://localhost/ws/notifications/`
3. Desde otra pestaña, abrir `http://localhost:8081/booking` como cliente
4. Agendar una cita
5. En la pestaña del admin: debe aparecer toast de notificación y badge con número en la campana
6. En logs del backend: `[Notificaciones] Enviando a N usuarios: [...]`

## Deuda Técnica Identificada (fuera del scope de este fix)

- Implementar ping/pong en `NotificationConsumer` para detectar conexiones muertas sin depender del timeout de Nginx
- Reemplazar `print()` con `logger.error()`/`logger.info()` en `signals.py` y `services.py`
- Agregar retry logic en `NotificationService` para fallos del channel layer
- Validar que todos los admins/asesores tengan `TenantMembership` correcta via `assign_tenant` management command
