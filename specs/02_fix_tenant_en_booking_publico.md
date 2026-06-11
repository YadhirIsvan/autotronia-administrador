# Spec 02 — Fix: Tenant en Booking Público y Notificaciones WebSocket

**Fecha:** 2026-03-13
**Severidad global:** CRITICA — Las notificaciones de nuevas citas nunca llegan al staff en local dev
**Dependencia:** Pasos 1-5 del spec 01 ya completados (base WebSocket funcional)

---

## Resumen ejecutivo

La cita se crea con `tenant = None` porque la cadena de resolución de tenant falla en todos
sus puntos para el flujo de booking público en local dev. Sin `tenant_id` en la cita, el
signal `post_save` no puede identificar a qué usuarios notificar y termina con
`user_ids = []`.

Hay cuatro bugs independientes encadenados, más un bug adicional en el consumer
WebSocket que nunca une al admin al grupo `tenant_X` (lo que hubiera permitido una
alternativa de broadcast).

---

## Bugs identificados

### BUG-01 — CRITICO: `getAuthHeaders()` nunca envía `X-Tenant-ID` cuando el tenant es `'default'`

**Archivo:** `front-end-taller-pro/src/lib/api.ts` ~línea 43
**Código actual:**
```typescript
if (tenant && tenant !== 'default') {
  headers['X-Tenant-ID'] = tenant;
}
```
**Problema:** En local dev sin `VITE_TENANT_SLUG`, `getCurrentTenant()` devuelve `'default'`
(ya sea de localStorage o del fallback). La condición nunca se cumple. El header
`X-Tenant-ID` nunca sale del frontend hacia el backend.

---

### BUG-02 — CRITICO: `createAppointment()` tampoco envía `tenant_slug` cuando el tenant es `'default'`

**Archivo:** `front-end-taller-pro/src/lib/api.ts` ~línea 769
**Código actual:**
```typescript
const currentTenant = getCurrentTenant();
if (currentTenant && currentTenant !== 'default') {
  payload.tenant_slug = currentTenant;
}
```
**Problema:** Misma condición defensiva que BUG-01. Si el tenant es `'default'`, el payload
llega al backend sin `tenant_slug`. El fallback en `perform_create` no tiene nada que
resolver.

**Causa raíz de BUG-01 y BUG-02:** `initTenant()` en `tenant.ts` llama a
`fetchTenantConfig('default')` y el backend devuelve 404 (no existe un tenant con slug
`'default'`). El tenant real del sistema nunca se guarda en `localStorage` durante el
flujo de booking público.

---

### BUG-03 — CRITICO: `TenantFromUserMiddleware` no ayuda a clientes públicos

**Archivo:** `backend-taller-pro/apps/core/middleware.py` línea 227
**Código actual:**
```python
TenantUser.objects.select_related('tenant').filter(
    user=request.user,
    is_current=True,
    ...
).first()
```
**Problema:** Los clientes públicos creados desde el booking NO tienen registro en
`TenantUser` (esa tabla es solo para staff con `TenantRegistrationView` o
`TenantUserViewSet`). El middleware queda con `request.tenant = None`.

---

### BUG-04 — ALTA: `consumers.py:get_user_tenant_id()` siempre devuelve `None` para usuarios staff

**Archivo:** `backend-taller-pro/apps/notifications/consumers.py` línea 172
**Código actual:**
```python
@database_sync_to_async
def get_user_tenant_id(self):
    if hasattr(self.user, 'tenant_id'):
        return self.user.tenant_id
    return None
```
**Problema:** El modelo `User` de Django **no tiene** campo `tenant_id`. `hasattr` devuelve
`False` siempre. El consumer nunca une al usuario al grupo `tenant_{id}`, lo que hace que
`NotificationService.send_to_tenant()` no llegue a ningún consumer conectado.

**Impacto:** No afecta el flujo principal de notificaciones por `user_{id}` (que sí
funciona cuando `user_ids` no está vacío), pero elimina la posibilidad de broadcast al
tenant como alternativa de fallback.

---

### BUG-05 — MEDIA: `AppointmentViewSet` tiene `permission_classes = [IsAuthenticated]` pero el booking público es llamado sin autenticación

**Archivo:** `backend-taller-pro/apps/appointments/views.py` línea 54
**Problema:** La página `Booking.tsx` llama `api.createAppointment()` sin token (el cliente
público no está logueado). `apiFetch` no agrega `Authorization` si no hay token en
`localStorage`, pero la vista requiere autenticación. Esto debería producir un **401**, no
un **201**.

**Hipótesis de por qué da 201:** O el cliente de booking SÍ está logueado con una cuenta
de prueba, o hay algún permiso permisivo más amplio. Requiere verificación en el siguiente
end-to-end test. Si el booking público crea citas sin autenticación, la vista necesita
`AllowAny` con una lógica de seguridad diferente.

---

## Plan de implementación

### ✅ Paso 1 — Backend: Endpoint público para descubrir el tenant único activo _(COMPLETADO)_

**Objetivo:** Dar al frontend un mecanismo determinístico para obtener el slug real del
tenant cuando no hay subdominio ni env var configurada.

**Archivo:** `apps/tenants/views.py`

Agregar una nueva acción al `TenantViewSet`:

```python
@action(
    detail=False,
    methods=['get'],
    url_path='active-single',
    permission_classes=[AllowAny]
)
def active_single(self, request):
    """
    GET /api/tenants/active-single/

    Devuelve el slug del tenant activo si solo hay uno en el sistema.
    Usado por el booking publico en local dev y deployments single-tenant.

    Responde 404 si hay 0 o más de 1 tenant activos (entorno multi-tenant
    real, no se puede asumir cual es el correcto).
    """
    active_tenants = Tenant.objects.filter(
        is_active=True, is_deleted=False
    ).values('slug', 'name', 'id')

    count = active_tenants.count()

    if count == 1:
        tenant = active_tenants.first()
        return Response({
            'slug': tenant['slug'],
            'name': tenant['name'],
            'id': tenant['id'],
        })

    return Response(
        {'error': 'No se puede determinar el tenant automaticamente'},
        status=status.HTTP_404_NOT_FOUND
    )
```

**Consideracion de seguridad:** Este endpoint devuelve el slug (dato publico, ya expuesto
en `public-config`). No devuelve emails, IDs internos sensibles ni conteos de datos de
negocio. En produccion con multiples tenants, devuelve 404, lo que es el comportamiento
correcto: el booking publico siempre debe tener un slug explicito.

**Validacion:** `curl http://localhost:8000/api/tenants/active-single/` debe devolver el
slug del taller de prueba.

---

### ✅ Paso 2 — Frontend: `initTenant()` con auto-discovery como fallback _(COMPLETADO)_

**Objetivo:** Cuando `getTenantFromURL()` devuelve `'default'` (ningun mecanismo de
deteccion funcion), intentar auto-discovery contra el backend antes de rendirse.

**Archivo:** `front-end-taller-pro/src/lib/tenant.ts`

Agregar funcion de auto-discovery:

```typescript
/**
 * Intenta descubrir el tenant automaticamente si el sistema tiene solo uno activo.
 * Solo aplica cuando no hay otro mecanismo de deteccion disponible.
 * Devuelve el slug o null si no es posible determinarlo.
 */
async function discoverSingleTenant(): Promise<string | null> {
  try {
    const response = await fetch(`${API_URL}/tenants/active-single/`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.slug || null;
  } catch {
    return null;
  }
}
```

Modificar `initTenant()`:

```typescript
export async function initTenant(): Promise<TenantConfig | null> {
  applyThemeFromCache();

  let slug = getTenantFromURL();

  // Si no detectamos un tenant real, intentar auto-discovery (single-tenant)
  if (slug === DEFAULT_TENANT) {
    const discovered = await discoverSingleTenant();
    if (discovered) {
      slug = discovered;
      console.log('Tenant descubierto automaticamente:', slug);
    }
  }

  setCurrentTenant(slug);

  const targetSlug = slug !== DEFAULT_TENANT ? slug : DEFAULT_TENANT;
  const config = await fetchTenantConfig(targetSlug);

  if (config) {
    applyTenantTheme(config);
    return config;
  }

  return getCachedTenantConfig();
}
```

**Resultado:** Despues de `initTenant()`, `getCurrentTenant()` devuelve el slug real (ej:
`'taller-de-messi'`) en lugar de `'default'`. Los BUG-01 y BUG-02 se resuelven
automaticamente porque la condicion `!== 'default'` ahora se cumple.

**Validacion:** En la consola del browser, al cargar `/booking`, debe aparecer:
`Tenant descubierto automaticamente: <slug-real>`. El header `X-Tenant-ID` debe ser
visible en el POST a `/api/appointments/` en DevTools > Network.

---

### ✅ Paso 3 — Backend: Fix en `perform_create` para fallback agresivo (single-tenant) _(COMPLETADO)_

**Objetivo:** Ultimo recurso en el backend. Si despues de todo `request.tenant` sigue
siendo `None` y no viene `tenant_slug` en el payload, asignar el unico tenant activo si
existe exactamente uno.

**Archivo:** `apps/appointments/views.py` — metodo `perform_create`

```python
def perform_create(self, serializer):
    """Asigna tenant + created_by + advisor al crear cita"""
    user = self.request.user
    extra_fields = {'created_by': user}

    # 1. Tenant desde el middleware (header X-Tenant-ID o subdominio)
    tenant = getattr(self.request, 'tenant', None)

    # 2. Tenant desde el body (booking publico con tenant_slug)
    if not tenant:
        tenant_slug = self.request.data.get('tenant_slug')
        if tenant_slug:
            from apps.tenants.models import Tenant
            tenant = Tenant.objects.filter(
                slug=tenant_slug, is_active=True, is_deleted=False
            ).first()

    # 3. Fallback: si hay exactamente un tenant activo, asignarlo
    # SOLO seguro en sistemas single-tenant (un taller)
    if not tenant:
        from apps.tenants.models import Tenant
        active_tenants = Tenant.objects.filter(is_active=True, is_deleted=False)
        if active_tenants.count() == 1:
            tenant = active_tenants.first()
            import logging
            logging.getLogger(__name__).warning(
                f"[Appointments] perform_create: tenant asignado por fallback "
                f"single-tenant: {tenant.slug}"
            )

    if tenant:
        extra_fields['tenant'] = tenant

    # Si no se especifico advisor y el usuario es asesor, asignarse el mismo
    if not serializer.validated_data.get('advisor'):
        if hasattr(user, 'mechanic_profile'):
            if user.mechanic_profile.role in ['advisor', 'admin', 'superadmin']:
                extra_fields['advisor'] = user

    serializer.save(**extra_fields)
```

**Consideracion de seguridad:** El fallback del paso 3 es deliberadamente conservador:
solo actua cuando `count() == 1`. En produccion con multiples tenants activos, retorna sin
asignar tenant (la cita quedaria con `tenant=None`, lo que es el comportamiento previo y
genera un warning en logs). No hay riesgo de cruzar datos entre tenants.

**Validacion:** En logs del backend debe aparecer el warning solo en local dev. En
produccion con el tenant correcto resuelto por el Paso 2, el warning nunca debe aparecer.

---

### ✅ Paso 4 — Backend: Fix en `consumers.py:get_user_tenant_id()` _(COMPLETADO)_

**Objetivo:** Corregir BUG-04. El consumer debe unirse al grupo `tenant_{id}` para que el
broadcast por tenant funcione como alternativa.

**Archivo:** `apps/notifications/consumers.py` — metodo `get_user_tenant_id`

```python
@database_sync_to_async
def get_user_tenant_id(self):
    """Obtiene el tenant_id del usuario via TenantUser (is_current=True)."""
    try:
        from apps.tenants.models import TenantUser
        tenant_user = TenantUser.objects.filter(
            user=self.user,
            is_current=True,
            tenant__is_active=True,
            tenant__is_deleted=False,
        ).select_related('tenant').first()
        return tenant_user.tenant_id if tenant_user else None
    except Exception:
        return None
```

**Impacto:** A partir de esta correccion, cuando un admin conecta su WebSocket, se une
a `tenant_{id}`. `NotificationService.send_to_tenant()` ahora funciona como canal de
broadcast alternativo. Esto no reemplaza el flujo por `user_{id}` pero es una capa
adicional de resiliencia.

**Validacion:** En los logs del consumer al conectar debe aparecer el tenant_group
resuelto. Verificar con `docker compose logs -f daphne`.

---

### Paso 5 — Backend: Verificar y corregir `permission_classes` del booking publico (BUG-05)

**Objetivo:** Determinar si el booking publico requiere autenticacion o no, y aplicar el
permiso correcto.

**Investigacion requerida:** Confirmar si `Booking.tsx` usa una cuenta de cliente logueada
o crea citas anonimamente.

**Escenario A — El booking es anonimo (sin token):**
El `AppointmentViewSet` necesita permitir creacion sin autenticacion solo para la accion
`create`. Usar permiso diferenciado por accion:

```python
# apps/appointments/views.py
from rest_framework.permissions import IsAuthenticatedOrReadOnly

class AppointmentViewSet(TenantModelMixin, viewsets.ModelViewSet):
    # ...

    def get_permissions(self):
        if self.action == 'create':
            # Booking publico: no requiere autenticacion
            return [AllowAny()]
        return [IsAuthenticated()]
```

Y en `perform_create`, el `created_by` debe ser opcional:

```python
user = self.request.user
extra_fields = {}
if user.is_authenticated:
    extra_fields['created_by'] = user
```

**Escenario B — El booking requiere que el cliente este logueado:**
No hay cambio en `permission_classes`. El cliente debe tener un token valido. En este
caso verificar que el flujo de login del cliente guarda el tenant correcto en localStorage
(que tambien es afectado por BUG-01/02).

**Validacion:** Intentar el POST a `/api/appointments/` sin header `Authorization` y
observar si da 401 o 201. Si da 401, estamos en Escenario B.

---

### Paso 6 — Tests

**Archivo nuevo:** `apps/appointments/tests/test_booking_tenant.py`

```python
import pytest
from apps.tenants.models import Tenant, TenantUser
from apps.appointments.models import Appointment
from django.contrib.auth.models import User


@pytest.mark.django_db
class TestBookingTenantResolution:
    """Verifica que el tenant se asigna correctamente al crear citas publicas."""

    def test_booking_con_x_tenant_id_header(self, client, tenant, appointment_type):
        """El header X-Tenant-ID resuelve el tenant correctamente."""
        data = {
            'appointment_type': appointment_type.id,
            'scheduled_date': '2026-04-01',
            'scheduled_time': '10:00',
            'customer_name': 'Test Cliente',
            'customer_email': 'cliente@test.com',
            'customer_phone': '555-0000',
        }
        response = client.post(
            '/api/appointments/',
            data,
            content_type='application/json',
            HTTP_X_TENANT_ID=tenant.slug,
        )
        assert response.status_code == 201
        appointment = Appointment.objects.get(id=response.data['id'])
        assert appointment.tenant_id == tenant.id

    def test_booking_con_tenant_slug_en_body(self, client, tenant, appointment_type):
        """El campo tenant_slug en el body resuelve el tenant."""
        data = {
            'appointment_type': appointment_type.id,
            'scheduled_date': '2026-04-01',
            'scheduled_time': '11:00',
            'customer_name': 'Test Cliente 2',
            'customer_email': 'cliente2@test.com',
            'customer_phone': '555-0001',
            'tenant_slug': tenant.slug,
        }
        response = client.post(
            '/api/appointments/',
            data,
            content_type='application/json',
        )
        assert response.status_code == 201
        appointment = Appointment.objects.get(id=response.data['id'])
        assert appointment.tenant_id == tenant.id

    def test_booking_sin_tenant_fallback_single(self, client, appointment_type):
        """Sin tenant en header ni body, usa fallback single-tenant."""
        # Asegurarse de que hay exactamente un tenant activo
        Tenant.objects.filter(is_active=True).update(is_active=False)
        tenant = Tenant.objects.create(
            name='Unico Taller',
            slug='unico-taller',
            owner_name='Test',
            owner_email='owner@test.com',
            is_active=True,
        )
        data = {
            'appointment_type': appointment_type.id,
            'scheduled_date': '2026-04-01',
            'scheduled_time': '12:00',
            'customer_name': 'Test Cliente 3',
            'customer_email': 'cliente3@test.com',
            'customer_phone': '555-0002',
        }
        response = client.post(
            '/api/appointments/',
            data,
            content_type='application/json',
        )
        # Puede ser 201 o 403 dependiendo del Paso 5
        if response.status_code == 201:
            appointment = Appointment.objects.get(id=response.data['id'])
            assert appointment.tenant_id == tenant.id

    def test_active_single_endpoint_con_un_tenant(self, client, tenant):
        """El endpoint active-single devuelve el slug cuando hay un tenant."""
        Tenant.objects.filter(is_active=True).exclude(id=tenant.id).update(is_active=False)
        response = client.get('/api/tenants/active-single/')
        assert response.status_code == 200
        assert response.data['slug'] == tenant.slug

    def test_active_single_endpoint_con_multiples_tenants(self, client):
        """El endpoint active-single devuelve 404 cuando hay multiples tenants."""
        Tenant.objects.create(
            name='Taller Extra', slug='taller-extra', owner_name='X',
            owner_email='x@x.com', is_active=True,
        )
        assert Tenant.objects.filter(is_active=True, is_deleted=False).count() >= 2
        response = client.get('/api/tenants/active-single/')
        assert response.status_code == 404
```

---

### Paso 7 — Verificacion end-to-end

Secuencia de verificacion despues de implementar los pasos 1-6:

1. Levantar el stack: `docker compose -f docker-compose.dev.yml up`
2. Abrir `/booking` en el browser
3. En consola del browser verificar: `Tenant descubierto automaticamente: <slug>`
4. En DevTools > Network, el POST a `/api/appointments/` debe tener:
   - Header `X-Tenant-ID: <slug>` O
   - Body con `tenant_slug: <slug>`
5. En logs del backend (`docker compose logs -f web`):
   - `[Notificaciones] Enviando a N usuarios: [1, 2, ...]` con N > 0
   - NO debe aparecer el fallback warning del Paso 3 si el frontend funciona correctamente
6. En la sesion del admin (browser separado), la notificacion debe aparecer como toast

---

## Consideraciones de seguridad

### Endpoint `active-single` (Paso 1)

- Devuelve: `slug` (ya publico via `public-config`), `name` (dato publico), `id` (entero)
- NO devuelve: emails, conteos, configuracion interna, datos de clientes
- En multi-tenant real: devuelve 404. Un atacante no puede usar este endpoint para enumerar tenants.
- Recomendacion: agregar rate limiting si se usa en produccion con alta concurrencia.

### Fallback single-tenant en `perform_create` (Paso 3)

- Solo asigna tenant cuando `count() == 1`. Imposible cruzar datos entre tenants.
- Emite un warning en logs para facilitar la deteccion de configuraciones incorrectas.
- En produccion con multiples tenants: el fallback no actua, la cita queda con `tenant=None`
  (igual que antes). No es un regression en produccion.

### `AllowAny` en la accion `create` (Paso 5, Escenario A)

- Si el booking es publico, `created_by` no puede ser obligatorio.
- El tenant debe estar correctamente resuelto para que la cita quede aislada.
- Riesgo: spam de citas desde bots. Mitigacion recomendada: agregar throttle por IP.
  ```python
  from rest_framework.throttling import AnonRateThrottle
  # En settings: 'DEFAULT_THROTTLE_RATES': {'anon': '10/hour'}
  ```

---

## Deuda tecnica identificada

### DT-01 — El modelo `User` no tiene campo `tenant_id`

El frontend tiene `User.tenant_id` en los tipos (`src/lib/types.ts`), pero el modelo de
Django no lo tiene. El `auth-context.tsx` probablemente asigna el `tenant_id` manualmente
al objeto de usuario en memoria tras el login. Esto es fragil: si se pierde la sesion o se
serializa el objeto, `tenant_id` puede quedar `undefined`.

**Solucion a futuro:** Al login, el backend debe devolver el `tenant_id` del
`TenantUser.is_current=True` en el response de autenticacion, y el frontend debe guardarlo
en `localStorage` junto con `taller_user`.

### DT-02 — `getTenantFromURL()` tiene logica inconsistente con el backend

El backend `TenantMiddleware` excluye subdominios `['www', 'app', 'api', 'admin',
'localhost', '127']`. El frontend excluye `['www', 'app', 'localhost', '127', '192', '10']`.
Faltan `'api'` y `'admin'` en el frontend; sobran `'192'` y `'10'` en el frontend que no
existen en el backend. Las listas deben sincronizarse.

### DT-03 — `initTenant()` llama a `fetchTenantConfig('default')` innecesariamente

Si el slug sigue siendo `'default'` despues del auto-discovery, el fetch a
`/api/tenants/by-slug/default/public-config/` produce un 404 en logs del backend para
cada carga de la pagina. Agregar un guard antes del fetch:

```typescript
if (targetSlug === DEFAULT_TENANT) {
  return getCachedTenantConfig();
}
```

### DT-04 — Clientes publicos no tienen `TenantUser`

El flujo de booking puede crear objetos `Customer` sin tenant asociado si el
`perform_create` no resuelve el tenant. El modelo `Customer` tambien tiene `tenant = FK`.
Verificar que el serializer `AppointmentCreateSerializer` crea o vincula al `Customer`
con el tenant correcto cuando llega desde el booking publico.

### DT-05 — No hay mecanismo de ping/pong en el consumer WebSocket

El `CLAUDE.md` del backend menciona que el `proxy_read_timeout` de Nginx para `/ws/` es
60 segundos (aunque en el spec 01 se menciono que se subio a 3600s). Sin ping/pong, las
conexiones inactivas se cierran. El `useNotifications` hook tiene logica de reconexion
pero no de keepalive. Agregar heartbeat en el consumer:

```python
# En NotificationConsumer.connect():
self.keep_alive_task = asyncio.ensure_future(self.send_heartbeat())

async def send_heartbeat(self):
    while True:
        await asyncio.sleep(30)
        try:
            await self.send(text_data='{"type":"ping"}')
        except Exception:
            break
```

---

## Orden de implementacion recomendado

| Paso | Impacto | Riesgo | Tiempo estimado |
|------|---------|--------|-----------------|
| Paso 4 (consumers.py) | Alto | Bajo | 10 min |
| Paso 1 (endpoint active-single) | Alto | Bajo | 15 min |
| Paso 2 (initTenant auto-discovery) | Alto | Bajo | 20 min |
| Paso 3 (fallback en perform_create) | Medio | Bajo | 10 min |
| Paso 5 (permissions booking) | Alto | Medio | 20 min |
| Paso 6 (tests) | — | — | 45 min |

Total estimado: ~2 horas.

Prioridad de implementacion: Pasos 4, 1 y 2 primero. Son independientes entre si y
resuelven el bug principal. El Paso 3 es el seguro de red. El Paso 5 requiere
investigacion adicional antes de tocar permisos.
