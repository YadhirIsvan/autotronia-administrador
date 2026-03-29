# spec_12 — Eliminar `is_current` de TenantUser: sesiones multi-tenant simultáneas

**Estado:** Pendiente
**Fecha:** 2026-03-20
**Prioridad:** Media — mejora de arquitectura multi-tenant

---

## 1. Problema y motivación

### El problema

`TenantUser.is_current` modela el concepto "un usuario tiene UN tenant activo a la vez". Esto se implementa con:

1. Un `BooleanField(default=True)` en el modelo.
2. Un `save()` que, cuando `is_current=True`, hace `UPDATE ... SET is_current=False` en TODOS los otros `TenantUser` del mismo usuario.
3. Un endpoint `POST /api/tenants/{id}/switch/` que orquesta ese cambio.
4. `TenantFromUserMiddleware` que lee `is_current=True` cuando no hay header `X-Tenant-ID`.
5. Cuatro clases de permiso en `shared/permissions.py` que buscan `is_current=True` para obtener el rol del usuario.
6. `NotificationConsumer.get_user_tenant_id()` y `NotificationService.send_to_user()` que leen `is_current=True` para determinar a qué grupo de canal unirse.

### Por qué es un problema de arquitectura

- **Rompe sesiones simultáneas**: Si Pepe es cliente en Taller A y Taller B, abre Taller A en laptop y Taller B en celular. En el momento que la app del celular hace login, el backend pone `is_current=False` en Taller A. La sesión de laptop queda en un estado inconsistente: el header `X-Tenant-ID` que manda es ignorado por algunos middlewares y todas las queries a `is_current=True` devuelven el tenant incorrecto.
- **El header ya existe y ya funciona**: El frontend ya envía `X-Tenant-ID` en **todos** los requests HTTP (via `getAuthHeaders()` en `src/lib/api.ts` y en los 5 clientes Axios). El `TenantMiddleware` ya lo resuelve con prioridad 1. El campo `is_current` es redundante para el flujo HTTP normal.
- **WebSockets**: Los consumers no reciben headers HTTP por el protocolo WS. Este es el único lugar donde se necesita una alternativa real a `is_current`.

### Solución deseada

Eliminar `is_current` del modelo `TenantUser`. El tenant siempre se resuelve por:
- **HTTP**: Header `X-Tenant-ID` (ya funciona, prioridad 1 en `TenantMiddleware`).
- **WebSocket**: El token JWT incluye el `tenant_id` del tenant que el usuario estaba usando cuando generó el token. Esto se incrusta en el JWT al hacer login y el consumer lo lee desde el scope.

---

## 2. Inventario exhaustivo de referencias a `is_current`

| # | Archivo | Línea aprox. | Tipo | Descripción | Acción requerida |
|---|---------|-------------|------|-------------|-----------------|
| 1 | `apps/tenants/models.py` | 316 | Definición | `is_current = BooleanField(default=True)` | Eliminar el campo |
| 2 | `apps/tenants/models.py` | 341–348 | Escritura | `save()` que hace `UPDATE ... is_current=False` en otros TenantUser del usuario | Eliminar el método `save()` completo |
| 3 | `apps/core/middleware.py` | 253–263 | Lectura | `TenantFromUserMiddleware`: `TenantUser.objects.filter(is_current=True).first()` cuando no hay header `X-Tenant-ID` | Eliminar este middleware o cambiar su lógica — ver sección 3 |
| 4 | `apps/core/views.py` | 167–173 | Lectura | `CustomJWTLoginView`: fallback `filter(is_current=True)` cuando no viene `tenant_slug` en el login | Cambiar fallback: usar `first()` sin filtro `is_current` |
| 5 | `apps/core/views.py` | 434–439 | Lectura | `GoogleAuthView`: `filter(is_current=True)` para obtener tenant del usuario tras Google login | Cambiar: usar `tenant` ya conocido del contexto (se pasó `tenant_slug`) |
| 6 | `apps/core/views.py` | 395–402 | Escritura | `GoogleAuthView`: `TenantUser.objects.get_or_create(defaults={'is_current': True, ...})` | Eliminar `is_current` del `defaults` dict |
| 7 | `apps/tenants/views.py` | 141–142 | Escritura | `TenantRegistrationView`: `TenantUser.objects.create(..., is_current=True)` | Eliminar `is_current=True` del `create()` |
| 8 | `apps/tenants/views.py` | 303–313 | Lectura | `TenantViewSet.current()`: `TenantUser.objects.get(is_current=True)` | Cambiar a resolver desde `request.tenant` (ya disponible por middleware) |
| 9 | `apps/tenants/views.py` | 401–408 | Lectura | `TenantUserViewSet.get_queryset()`: `TenantUser.objects.get(is_current=True).tenant` | Cambiar a usar `request.tenant` |
| 10 | `apps/tenants/views.py` | 363–365 | Escritura | `TenantViewSet.switch()`: `TenantUser.objects.filter(user=user).update(is_current=False)` + `tenant_user.is_current = True` | Eliminar endpoint o convertirlo en no-op / deprecarlo |
| 11 | `shared/permissions.py` | 93–96 | Lectura | `IsAdmin`: `TenantUser.objects.filter(is_current=True).first()` | Cambiar a `filter(tenant=request.tenant)` |
| 12 | `shared/permissions.py` | 146–149 | Lectura | `IsAdminOrSuperAdmin`: igual patrón | Cambiar a `filter(tenant=request.tenant)` |
| 13 | `shared/permissions.py` | 180–183 | Lectura | `IsStaffMember`: igual patrón | Cambiar a `filter(tenant=request.tenant)` |
| 14 | `shared/permissions.py` | 211–214 | Lectura | `IsOwnerOrAdmin.has_object_permission()`: igual patrón | Cambiar a `filter(tenant=request.tenant)` |
| 15 | `shared/permissions.py` | 265–268 | Lectura | `CanManageCustomers`: igual patrón | Cambiar a `filter(tenant=request.tenant)` |
| 16 | `shared/permissions.py` | 304–307 | Lectura | `CanManageVehicles.has_permission()`: igual patrón | Cambiar a `filter(tenant=request.tenant)` |
| 17 | `shared/permissions.py` | 333–336 | Lectura | `CanManageVehicles.has_object_permission()`: igual patrón | Cambiar a `filter(tenant=request.tenant)` |
| 18 | `apps/notifications/consumers.py` | 181–191 | Lectura | `get_user_tenant_id()`: `filter(is_current=True)` para unirse a grupo `tenant_{id}` en WebSocket | Cambiar a leer `tenant_id` desde el JWT claim — ver sección 3 |
| 19 | `apps/notifications/services.py` | 48–50 | Lectura | `send_to_user()`: `tenant_memberships.filter(is_current=True).first()` para determinar tenant de la notificación en BD | Cambiar a recibir `tenant_id` explícito como parámetro |
| 20 | `apps/notifications/whatsapp_views.py` | 14–19 | Lectura | `get_user_tenant()`: `tenant_memberships.filter(is_current=True).first()` | Cambiar a recibir el tenant por contexto del request |
| 21 | `conftest.py` | 80 | Escritura | `TenantUserFactory`: `is_current = True` como atributo por defecto | Eliminar el campo de la factory |
| 22 | `apps/tenants/migrations/0001_initial.py` | 80 | Definición | Columna `is_current` en la migración inicial | Crear migración 0002 para eliminarla |

### Archivos de tests con `is_current` (solo escritura en setup — no lógica de negocio)

| Archivo | Ocurrencias | Acción |
|---------|------------|--------|
| `apps/tenants/tests/test_models.py` | 6 (incluyendo tests de comportamiento de `is_current`) | Eliminar o reemplazar los tests `test_tenant_user_is_current_default` y `test_tenant_user_only_one_current`; limpiar `is_current=True/False` del resto |
| `apps/tenants/tests/test_api.py` | 2 | Limpiar `is_current=False/True` en setup del test de `switch` |
| `apps/core/tests/test_spec08_auth_registro.py` | 8 (incluyendo `test_login_fallback_is_current_cuando_no_hay_tenant_slug`) | Actualizar el test de fallback al nuevo comportamiento |
| `apps/core/tests/test_auth_roles.py` | 8 | Limpiar `is_current=True` del setup de fixtures |
| `apps/core/tests/test_jwt_login.py` | 1 | Limpiar |
| `apps/core/tests/test_jwt_refresh.py` | 1 | Limpiar |
| `apps/core/tests/test_google_auth.py` | 4 (incluyendo assert `tenant_user.is_current is True`) | Cambiar assert por verificar membresía al tenant correcto |
| `apps/core/tests/test_auth_optimizations.py` | 2 | Limpiar |
| `apps/accounts/tests/test_custom_user.py` | 1 | Limpiar |
| `apps/notifications/tests/test_consumer.py` | 4 (tests directos de `get_user_tenant_id()` con `is_current`) | Reescribir para el nuevo mecanismo JWT |
| `apps/notifications/tests/test_services.py` | 3 (incluyendo `test_sets_tenant_from_is_current_membership`) | Reescribir con nuevo parámetro `tenant_id` |
| `apps/notifications/tests/test_ws_jwt_auth.py` | 1 | Limpiar |
| `apps/customers/tests/test_customer_permissions.py` | 3 | Limpiar |

---

## 3. Análisis del TenantMiddleware

### Cadena de resolución actual

```
Request HTTP
    ↓
TenantMiddleware (apps/core/middleware.py)
    1. Header X-Tenant-ID → busca en BD (con cache Redis 5 min)
    2. Subdominio (si no es www/app/api/admin/localhost)
    → si encontrado: request.tenant = Tenant, request.tenant_id = id
    → si no: request.tenant = None
    ↓
TenantFromUserMiddleware (apps/core/middleware.py)
    [Solo si request.tenant es None]
    3. usuario autenticado → TenantUser.filter(is_current=True, tenant__is_active=True).first()
    → si encontrado: request.tenant = tenant_user.tenant
    → si no: request.tenant sigue None
    ↓
ViewSets / Permisos — operan sobre request.tenant
```

**Conclusión clave:** En el flujo HTTP normal, `TenantFromUserMiddleware` solo entra en juego cuando no hay header `X-Tenant-ID` y no hay subdominio. Esto ocurre en:
- Llamadas internas del sistema (tasks de Celery, management commands).
- Requests desde el Django Admin (sin header).
- Requests en tests mal configurados.
- Clientes API externos que no envíen el header.

En todos los flujos de la SPA, el header siempre está presente y el middleware 3 nunca se ejecuta.

### Cambios requeridos en TenantMiddleware

**`TenantFromUserMiddleware`** debe modificarse para no depender de `is_current`:

```python
# ANTES
tenant_user = TenantUser.objects.filter(
    user=request.user,
    is_current=True,
    tenant__is_active=True,
    tenant__is_deleted=False
).first()

# DESPUÉS (fallback: primer tenant activo del usuario)
tenant_user = TenantUser.objects.select_related('tenant').filter(
    user=request.user,
    tenant__is_active=True,
    tenant__is_deleted=False
).order_by('created_at').first()
```

Este fallback es aceptable porque solo actúa cuando no hay header `X-Tenant-ID`. Si hay ambigüedad (usuario en múltiples tenants sin header), se toma el más antiguo. Para el flujo de la SPA esto nunca ocurre.

### WebSocket — el único lugar con problema real

El `NotificationConsumer` no recibe headers HTTP (el protocolo WebSocket solo envía headers en el handshake inicial, pero Django Channels no los expone de forma confiable). Hoy usa `is_current=True` para determinar a qué grupo `tenant_{id}` unirse.

**Solución**: Incrustar `tenant_id` como claim en el JWT access token al momento del login, y leerlo en el consumer desde el `scope` del token.

```python
# En CustomJWTLoginView (apps/core/views.py), al generar el token:
refresh = RefreshToken.for_user(user)
access = refresh.access_token
if resolved_tenant:
    access['tenant_id'] = resolved_tenant.id   # Claim custom

# En NotificationConsumer.get_user_tenant_id():
# ANTES
tenant_user = TenantUser.objects.filter(user=self.user, is_current=True, ...).first()
return tenant_user.tenant_id if tenant_user else None

# DESPUÉS
validated = AccessToken(token_key)  # ya se validó antes
return validated.get('tenant_id')   # puede ser None si token viejo
```

Si el claim no está en el token (tokens emitidos antes del cambio), el consumer puede hacer fallback a la primera membresía activa del usuario. Esta transición es segura.

---

## 4. Análisis de permisos (`shared/permissions.py`)

Hay 7 lugares en `shared/permissions.py` donde se lee `is_current`. Todos siguen el mismo patrón: quieren saber el `role` (owner/admin) del usuario en el tenant actual. El tenant actual ya está disponible en `request.tenant`.

### Código actual (patrón repetido 7 veces)

```python
try:
    from apps.tenants.models import TenantUser
    tenant_user = TenantUser.objects.filter(
        user=request.user,
        is_current=True
    ).first()
    if tenant_user and tenant_user.role in ['owner', 'admin']:
        return True
except Exception:
    pass
```

### Código propuesto (igual en los 7 lugares)

```python
try:
    tenant = getattr(request, 'tenant', None)
    if tenant:
        from apps.tenants.models import TenantUser
        tenant_user = TenantUser.objects.filter(
            user=request.user,
            tenant=tenant
        ).first()
        if tenant_user and tenant_user.role in ['owner', 'admin']:
            return True
except Exception:
    pass
```

**Observación importante**: Este cambio es más correcto que el código actual. El código actual buscaba `is_current=True` ignorando el `request.tenant` que ya estaba resuelto, lo que podía causar un bug silencioso donde la verificación de rol correspondía a un tenant distinto al que se estaba accediendo.

### Tabla por clase de permiso

| Clase | Método | Cambio |
|-------|--------|--------|
| `IsAdmin` | `has_permission` | Reemplazar filtro `is_current=True` por `tenant=request.tenant` |
| `IsAdminOrSuperAdmin` | `has_permission` | Igual |
| `IsStaffMember` | `has_permission` | Igual; cambiar roles buscados a incluir `'staff'` |
| `IsOwnerOrAdmin` | `has_object_permission` | Igual |
| `CanManageCustomers` | `has_permission` | Igual |
| `CanManageVehicles` | `has_permission` | Igual |
| `CanManageVehicles` | `has_object_permission` | Igual |

---

## 5. Análisis del frontend

### Cómo funciona `X-Tenant-ID` hoy

El frontend tiene múltiples instancias Axios, cada una con un interceptor `request` que:

1. Lee el tenant de `getCurrentTenant()` desde `src/lib/tenant.ts`.
2. `getCurrentTenant()` resuelve en este orden:
   - `VITE_TENANT_SLUG` (env var, fija por deployment)
   - Query param `?tenant=slug`
   - Subdominio del hostname
   - `localStorage.getItem('taller_tenant_slug')`
   - Fallback: `'default'`
3. Si el tenant no es `'default'`, agrega `headers['X-Tenant-ID'] = tenant`.

Las instancias que ya hacen esto:
- `src/lib/api.ts` — `getAuthHeaders()` (fetch nativo)
- `src/auth/api/auth.api.ts` — interceptor Axios
- `src/advisor/api/advisor.api.ts` — interceptor Axios
- `src/admin/api/admin.api.ts` — interceptor Axios
- `src/customer/api/customer.api.ts` — interceptor Axios
- `src/mechanic/api/mechanic.api.ts` — interceptor Axios
- `src/admin/components/ServiceCatalog.tsx` — headers manuales

El tenant se persiste en `localStorage` clave `taller_tenant_slug` al hacer login en `src/lib/auth-context.tsx`:
```typescript
if (data.tenant && data.tenant.slug) {
    setCurrentTenant(data.tenant.slug);  // → localStorage
    localStorage.setItem('taller_tenant_config', JSON.stringify(data.tenant));
}
```

### Casos donde el frontend NO envía `X-Tenant-ID`

1. **Primer acceso sin login**: El localStorage no tiene tenant. `getCurrentTenant()` devuelve `'default'`, el interceptor no agrega el header. Esto afecta al endpoint de login — pero el login ya acepta `tenant_slug` en el body.
2. **Endpoints públicos** (booking, `public-config`, `active-single`): No necesitan `X-Tenant-ID` porque o son anónimos o reciben el slug en la URL/body.
3. **Tenant = `'default'`**: Ningún interceptor envía el header si el valor es `'default'`. Esto es intencional — el backend no tiene tenant `'default'`.

### Cambios requeridos en el frontend

**Ninguno**. El frontend ya funciona correctamente. La eliminación de `is_current` es 100% transparente para el cliente porque:
- El header `X-Tenant-ID` ya se envía en todos los requests autenticados.
- El campo `is_current` nunca se lee ni se muestra en la UI.
- El endpoint `switch` es el único que modifica `is_current`, pero el frontend puede seguir llamándolo (si existe) o simplemente cambiar `localStorage` y recargar — la sesión no depende del estado de BD.

El único ajuste recomendado (no obligatorio) es deprecar o eliminar la llamada al endpoint `POST /api/tenants/{id}/switch/` en el frontend, que ya no tiene utilidad una vez que el backend no mantiene estado de tenant activo.

---

## 6. Casos edge a resolver

### ¿Qué pasa si el request no trae `X-Tenant-ID`?

- `TenantMiddleware` pone `request.tenant = None`.
- `TenantFromUserMiddleware` (con el cambio propuesto) intenta recuperar el primer tenant activo del usuario.
- Si el usuario solo tiene un tenant, funciona correctamente.
- Si el usuario tiene múltiples tenants y no viene el header, se toma el más antiguo (por `created_at`). Esto es una degradación aceptable — el cliente debería siempre enviar el header.
- Los ViewSets con `TenantModelMixin` filtran por `request.tenant`; si es `None`, devolverán queryset vacío (comportamiento actual).

**Acción**: No requiere cambio adicional — el comportamiento ya existe hoy cuando no hay subdominio ni header.

### ¿Qué pasa en el primer login de un usuario nuevo?

El frontend envía `tenant_slug` en el body del POST al login. `CustomJWTLoginView` busca el `TenantUser` por `tenant_slug` primero, y solo si no lo encuentra hace fallback (que tras el cambio será `first()` en lugar de `is_current=True`). Para un usuario nuevo que acaba de ser creado (con un único `TenantUser`), ambos comportamientos son equivalentes.

### ¿Qué devuelve el login para que el frontend sepa qué tenants tiene el usuario?

El endpoint `/api/auth/login/` ya devuelve:
```json
{
  "access": "...",
  "tenant": {
    "id": 1,
    "name": "Taller de Pepe",
    "slug": "taller-pepe",
    "logo": null,
    "primary_color": "#10B981",
    ...
  }
}
```

Esto no cambia. El frontend guarda el `slug` en localStorage y lo usa como `X-Tenant-ID` en todos los requests subsiguientes. Si el usuario quiere acceder a otro tenant, debe abrir la URL de ese tenant (que tiene otro slug en subdominio o query param), lo que sobreescribe el valor de `getCurrentTenant()`.

### ¿El endpoint `switch` se elimina?

El endpoint `POST /api/tenants/{id}/switch/` puede **mantenerse como no-op útil**: devuelve un nuevo JWT con `tenant_id` como claim, sin modificar `is_current`. El frontend puede llamarlo para obtener un token "contextualizado" para el nuevo tenant. Esto es opcional — el JWT genérico también funciona porque el consumer cae al fallback.

Alternativa más simple: deprecar el endpoint y eliminar su cuerpo, dejando solo el return del nuevo JWT sin tocar BD.

### WebSocket — usuario con múltiples tenants

Tras el cambio, el consumer lee `tenant_id` del JWT claim. Si el usuario tiene sesiones en dos tenants distintos con dos tokens distintos, cada conexión WebSocket estará en el grupo correcto (`tenant_1` o `tenant_2`). **Esto resuelve el problema de sesiones simultáneas** — es exactamente el caso de uso que motivó este spec.

---

## 7. Plan de implementación (pasos ordenados)

### Paso 1 — Incrustar `tenant_id` en el JWT access token ✅ DONE

**Archivo:** `apps/core/views.py` — `CustomJWTLoginView` y `GoogleAuthView`

En ambas vistas, después de resolver `resolved_tenant`:

```python
# Código actual
refresh = RefreshToken.for_user(user)
access = refresh.access_token

# Código nuevo — agregar claim
refresh = RefreshToken.for_user(user)
access = refresh.access_token
if resolved_tenant:
    access['tenant_id'] = resolved_tenant.id
```

Este es el **primer paso** porque permite que los nuevos tokens ya traigan el claim antes de que el consumer lo use.

### Paso 2 — Actualizar `NotificationConsumer.get_user_tenant_id()` ✅ DONE

**Archivo:** `apps/notifications/consumers.py`

```python
@database_sync_to_async
def get_user_tenant_id(self):
    """
    Obtiene el tenant_id del usuario.
    Prioridad: claim 'tenant_id' del JWT > primera membresía activa.
    """
    try:
        # 1. Leer desde el claim del token (si está disponible)
        tenant_id = getattr(self, '_jwt_tenant_id', None)
        if tenant_id:
            return tenant_id

        # 2. Fallback: primera membresía activa (tokens anteriores al cambio)
        from apps.tenants.models import TenantUser
        tenant_user = TenantUser.objects.filter(
            user=self.user,
            tenant__is_active=True,
            tenant__is_deleted=False,
        ).select_related('tenant').order_by('created_at').first()
        return tenant_user.tenant_id if tenant_user else None
    except Exception:
        return None
```

Y en `connect()`, antes de llamar `get_user_tenant_id()`, extraer el claim del token validado:

```python
# Después de self.user = await self.get_user_from_token(token_key)
# Extraer tenant_id del JWT
try:
    validated = AccessToken(token_key)
    self._jwt_tenant_id = validated.get('tenant_id')
except Exception:
    self._jwt_tenant_id = None
```

### Paso 3 — Actualizar `NotificationService.send_to_user()` ✅ DONE

**Archivo:** `apps/notifications/services.py`

```python
# ANTES
current_tenant = user.tenant_memberships.filter(is_current=True).first()
tenant_id = current_tenant.tenant_id if current_tenant else None

# DESPUÉS — aceptar tenant_id como parámetro opcional
@classmethod
def send_to_user(cls, user_id, title, message, notification_type='system',
                 data=None, save=True, tenant_id=None):
    ...
    if save:
        if tenant_id is None:
            # Fallback: primera membresía activa
            current_tenant = user.tenant_memberships.filter(
                tenant__is_active=True,
                tenant__is_deleted=False,
            ).order_by('created_at').first()
            tenant_id = current_tenant.tenant_id if current_tenant else None
```

Todas las llamadas a `send_to_user` que tienen contexto de tenant (en signals de appointments y workshop) deben pasar `tenant_id` explícitamente. Esto ya es posible porque los signals tienen acceso al objeto con su FK `tenant`.

### Paso 4 — Actualizar `notifications/whatsapp_views.py` ✅ DONE

**Archivo:** `apps/notifications/whatsapp_views.py`

```python
def get_user_tenant(user):
    """Obtiene el tenant del usuario. Fallback: primera membresía activa."""
    if hasattr(user, 'tenant_memberships'):
        membership = user.tenant_memberships.filter(
            tenant__is_active=True,
            tenant__is_deleted=False,
        ).order_by('created_at').first()
        if membership:
            return membership.tenant
    return None
```

### Paso 5 — Actualizar `shared/permissions.py` ✅ DONE

**Archivo:** `shared/permissions.py`

Reemplazar el patrón `filter(is_current=True)` por `filter(tenant=request.tenant)` en las 7 clases afectadas (ver sección 4 para código exacto). El patrón es idéntico en todos los casos.

### Paso 6 — Actualizar `TenantFromUserMiddleware` ✅ DONE

**Archivo:** `apps/core/middleware.py`

```python
# ANTES
tenant_user = TenantUser.objects.select_related('tenant').filter(
    user=request.user,
    is_current=True,
    tenant__is_active=True,
    tenant__is_deleted=False
).first()

# DESPUÉS
tenant_user = TenantUser.objects.select_related('tenant').filter(
    user=request.user,
    tenant__is_active=True,
    tenant__is_deleted=False
).order_by('created_at').first()
```

### Paso 7 — Actualizar `CustomJWTLoginView` fallback y `TenantViewSet` ✅ DONE

**Archivo:** `apps/core/views.py` — `CustomJWTLoginView`

```python
# ANTES — fallback cuando no hay tenant_slug en el login
tenant_user = TenantUser.objects.select_related('tenant').filter(
    user=user,
    is_current=True,
    tenant__is_active=True,
    tenant__is_deleted=False,
).first()

# DESPUÉS
tenant_user = TenantUser.objects.select_related('tenant').filter(
    user=user,
    tenant__is_active=True,
    tenant__is_deleted=False,
).order_by('created_at').first()
```

**Archivo:** `apps/tenants/views.py` — `TenantViewSet.current()`

```python
# ANTES
tenant_user = TenantUser.objects.select_related('tenant').get(
    user=user,
    is_current=True
)

# DESPUÉS — usar request.tenant si está disponible
@action(detail=False, methods=['get'])
def current(self, request):
    tenant = getattr(request, 'tenant', None)
    if not tenant:
        return Response(
            {'error': 'No hay tenant en el contexto del request. Envía X-Tenant-ID.'},
            status=status.HTTP_400_BAD_REQUEST
        )
    serializer = TenantDetailSerializer(tenant, context={'request': request})
    return Response(serializer.data)
```

**Archivo:** `apps/tenants/views.py` — `TenantUserViewSet.get_queryset()`

```python
# ANTES
current_tenant = TenantUser.objects.get(user=user, is_current=True).tenant

# DESPUÉS
current_tenant = getattr(self.request, 'tenant', None)
if not current_tenant:
    return TenantUser.objects.none()
return TenantUser.objects.filter(tenant=current_tenant)
```

**Archivo:** `apps/tenants/views.py` — `TenantViewSet.switch()`

```python
# ANTES — modifica is_current en BD
TenantUser.objects.filter(user=user).update(is_current=False)
tenant_user.is_current = True
tenant_user.save()

# DESPUÉS — solo emite nuevo JWT con claim tenant_id, sin tocar BD
# (el switch real ocurre en el frontend cambiando localStorage)
from rest_framework_simplejwt.tokens import RefreshToken
refresh = RefreshToken.for_user(user)
access = refresh.access_token
access['tenant_id'] = tenant.id
refresh['tenant_id'] = tenant.id
refresh['tenant_slug'] = tenant.slug

return Response({
    'message': f'Cambiado a {tenant.name}',
    'tenant': TenantDetailSerializer(tenant, context={'request': request}).data,
    'access': str(access),
    'refresh': str(refresh),
})
```

### Paso 8 — Actualizar `GoogleAuthView` ✅ DONE

**Archivo:** `apps/core/views.py` — `GoogleAuthView`

Dos cambios:

```python
# ANTES — al crear TenantUser nuevo
TenantUser.objects.get_or_create(
    user=user,
    tenant=tenant,
    defaults={'is_current': True, 'role': 'member'},
)

# DESPUÉS
TenantUser.objects.get_or_create(
    user=user,
    tenant=tenant,
    defaults={'role': 'member'},
)
```

```python
# ANTES — para obtener datos del tenant en la respuesta
tenant_user = TenantUser.objects.select_related('tenant').filter(
    user=user,
    is_current=True,
    ...
).first()

# DESPUÉS — el tenant ya está resuelto del contexto
# GoogleAuthView ya tiene `tenant` del paso de validación del tenant_slug.
# Usar directamente ese objeto.
resolved_tenant = tenant  # ya está disponible del bloque anterior
tenant_data = {
    'id': resolved_tenant.id,
    'name': resolved_tenant.name,
    ...
}
```

### Paso 9 — Actualizar `TenantRegistrationView` ✅ DONE

**Archivo:** `apps/tenants/views.py`

```python
# ANTES
TenantUser.objects.create(user=user, tenant=tenant, role='owner', is_current=True)

# DESPUÉS
TenantUser.objects.create(user=user, tenant=tenant, role='owner')
```

### Paso 10 — Eliminar campo del modelo y crear migración ✅ DONE

**Archivo:** `apps/tenants/models.py`

Eliminar:
- El campo `is_current = models.BooleanField(...)` (líneas 316–319).
- El método `save()` completo (líneas 341–348).

```python
class TenantUser(TimeStampedModel):
    user = models.ForeignKey(...)
    tenant = models.ForeignKey(...)
    role = models.CharField(...)

    class Meta:
        verbose_name = "Usuario de Tenant"
        verbose_name_plural = "Usuarios de Tenant"
        unique_together = ['user', 'tenant']

    def __str__(self):
        return f"{self.user.email} → {self.tenant.name}"
    # save() eliminado — ya no hay lógica de is_current
```

Crear migración:

```bash
python manage.py makemigrations tenants --name="remove_is_current_from_tenant_user"
```

La migración generada será:
```python
operations = [
    migrations.RemoveField(
        model_name='tenantuser',
        name='is_current',
    ),
]
```

### Paso 11 — Actualizar `conftest.py` y todos los tests ✅ DONE

**Archivo:** `conftest.py`

```python
# ANTES
class TenantUserFactory(DjangoModelFactory):
    ...
    is_current = True

# DESPUÉS
class TenantUserFactory(DjangoModelFactory):
    ...
    # is_current eliminado
```

Ver sección 9 para los tests específicos a actualizar.

---

## 8. Plan de migración de BD

### Estado actual de la columna

La columna `is_current` existe desde `0001_initial.py` (la única migración de `apps/tenants/`).

No hay `unique_together` ni índice sobre `is_current`. El único constraint lógico era enforced por el método `save()` del modelo, no por la BD.

### Script de limpieza previo (opcional pero recomendado)

Antes de aplicar la migración, ejecutar en Django shell para verificar que no hay lógica de negocio dependiendo del valor:

```python
from apps.tenants.models import TenantUser

# Cuántos usuarios tienen más de un is_current=True (debería ser 0 por el save() actual)
from django.db.models import Count
usuarios_con_multiple_current = (
    TenantUser.objects
    .filter(is_current=True)
    .values('user')
    .annotate(n=Count('id'))
    .filter(n__gt=1)
)
print(f"Usuarios con múltiples is_current=True: {usuarios_con_multiple_current.count()}")

# Total de TenantUser
print(f"Total TenantUser: {TenantUser.objects.count()}")
print(f"Con is_current=True: {TenantUser.objects.filter(is_current=True).count()}")
print(f"Con is_current=False: {TenantUser.objects.filter(is_current=False).count()}")
```

Si hay usuarios con `is_current=False` y son los únicos `TenantUser` del usuario, esos usuarios no podrán ser resueltos por `TenantFromUserMiddleware` hoy mismo. La migración mejora esa situación.

### Migración a crear

```python
# apps/tenants/migrations/0002_remove_is_current_from_tenant_user.py
from django.db import migrations

class Migration(migrations.Migration):

    dependencies = [
        ('tenants', '0001_initial'),
    ]

    operations = [
        migrations.RemoveField(
            model_name='tenantuser',
            name='is_current',
        ),
    ]
```

### Consideraciones

- La columna `is_current` es un `BooleanField` sin índice. Su eliminación es inmediata y no requiere `CONCURRENTLY` ni precauciones especiales de bloqueo en PostgreSQL.
- No hay datos que migrar — simplemente se elimina la columna.
- Si la BD está en producción y tiene datos, la migración se puede aplicar con zero downtime ya que `RemoveField` en PostgreSQL es una operación DDL rápida.

---

## 9. Plan de pruebas

### Tests a eliminar (ya no aplican)

```
apps/tenants/tests/test_models.py::TestTenantUserModel::test_tenant_user_is_current_default
apps/tenants/tests/test_models.py::TestTenantUserModel::test_tenant_user_only_one_current
apps/notifications/tests/test_consumer.py::TestGetUserTenantId::test_get_user_tenant_id_ignores_non_current
apps/core/tests/test_spec08_auth_registro.py::TestLogin::test_login_fallback_is_current_cuando_no_hay_tenant_slug
```

### Tests a actualizar (cambiar setup, no lógica)

Eliminar `is_current=True` de todas las llamadas a `TenantUserFactory(...)` o `TenantUser.objects.create(...)` en los 13 archivos de test listados en la sección 2. La lógica del test no cambia — solo el parámetro de creación.

```python
# ANTES
TenantUserFactory(user=user, tenant=tenant, role='admin', is_current=True)

# DESPUÉS
TenantUserFactory(user=user, tenant=tenant, role='admin')
```

Para `apps/core/tests/test_google_auth.py`, el assert:
```python
# ANTES
assert tenant_user.is_current is True

# DESPUÉS
assert TenantUser.objects.filter(user=user, tenant=self.tenant).exists()
```

Para `apps/tenants/tests/test_models.py::test_tenant_user_multiple_tenants`:
```python
# ANTES
TenantUser.objects.create(user=user, tenant=tenant1, is_current=False)
TenantUser.objects.create(user=user, tenant=tenant2, is_current=True)

# DESPUÉS
TenantUser.objects.create(user=user, tenant=tenant1)
TenantUser.objects.create(user=user, tenant=tenant2)
```

### Tests nuevos a crear

#### Test 1 — JWT incluye claim `tenant_id`

```python
# apps/core/tests/test_jwt_login.py

@pytest.mark.django_db
def test_login_jwt_includes_tenant_id_claim(client, tenant):
    """El access token emitido en el login incluye el claim tenant_id."""
    from conftest import UserFactory, TenantUserFactory
    from rest_framework_simplejwt.tokens import AccessToken

    user = UserFactory(password='testpass123')
    TenantUserFactory(user=user, tenant=tenant, role='admin')

    response = client.post(
        '/api/auth/login/',
        {'email': user.email, 'password': 'testpass123', 'tenant_slug': tenant.slug},
        content_type='application/json',
    )

    assert response.status_code == 200
    access_token_str = response.data['access']
    token = AccessToken(access_token_str)
    assert token.get('tenant_id') == tenant.id
```

#### Test 2 — `TenantFromUserMiddleware` sin `is_current` usa `order_by('created_at')`

```python
# apps/core/tests/test_middleware.py (nuevo archivo)

@pytest.mark.django_db
def test_tenant_from_user_middleware_fallback_first_membership():
    """Sin header X-Tenant-ID, el middleware elige el primer tenant por created_at."""
    from django.test import RequestFactory
    from apps.core.middleware import TenantFromUserMiddleware
    from conftest import UserFactory, TenantUserFactory, TenantFactory

    user = UserFactory()
    tenant_old = TenantFactory()
    tenant_new = TenantFactory()

    # Crear en orden — el más antiguo es tenant_old
    TenantUserFactory(user=user, tenant=tenant_old, role='member')
    TenantUserFactory(user=user, tenant=tenant_new, role='member')

    rf = RequestFactory()
    request = rf.get('/')
    request.user = user
    request.tenant = None

    middleware = TenantFromUserMiddleware(get_response=lambda r: r)
    middleware(request)

    assert request.tenant is not None
    assert request.tenant.id == tenant_old.id
```

#### Test 3 — Permisos usan `request.tenant` para TenantUser.role

```python
# apps/core/tests/test_permissions.py (nuevo test en archivo existente o nuevo)

@pytest.mark.django_db
def test_is_admin_uses_request_tenant_not_is_current():
    """
    IsAdmin verifica el rol del usuario en request.tenant,
    no en un tenant is_current que podría ser distinto.
    """
    from django.test import RequestFactory
    from shared.permissions import IsAdmin
    from conftest import UserFactory, TenantUserFactory, TenantFactory
    from unittest.mock import Mock

    user = UserFactory()
    tenant_a = TenantFactory()
    tenant_b = TenantFactory()

    # Usuario es admin en tenant_a, member en tenant_b
    TenantUserFactory(user=user, tenant=tenant_a, role='admin')
    TenantUserFactory(user=user, tenant=tenant_b, role='member')

    rf = RequestFactory()
    request = rf.get('/')
    request.user = user

    # Con request.tenant = tenant_a → debe ser admin
    request.tenant = tenant_a
    perm = IsAdmin()
    assert perm.has_permission(request, Mock()) is True

    # Con request.tenant = tenant_b → NO debe ser admin
    request.tenant = tenant_b
    assert perm.has_permission(request, Mock()) is False
```

#### Test 4 — `NotificationConsumer` usa claim JWT para `tenant_group`

```python
# apps/notifications/tests/test_consumer.py (reescribir test existente)

@pytest.mark.asyncio
@pytest.mark.django_db(transaction=True)
async def test_get_user_tenant_id_from_jwt_claim(db):
    """
    get_user_tenant_id() usa el claim tenant_id del JWT cuando está disponible.
    """
    user = await database_sync_to_async(UserFactory)()
    tenant = await database_sync_to_async(TenantFactory)()
    await database_sync_to_async(TenantUserFactory)(user=user, tenant=tenant)

    from rest_framework_simplejwt.tokens import AccessToken
    token = AccessToken.for_user(user)
    token['tenant_id'] = tenant.id

    from apps.notifications.consumers import NotificationConsumer
    consumer = NotificationConsumer()
    consumer.user = user
    consumer._jwt_tenant_id = token.get('tenant_id')

    result = await consumer.get_user_tenant_id()
    assert result == tenant.id
```

#### Test 5 — Sesiones simultáneas en dos tenants

```python
# apps/core/tests/test_multitenant_sessions.py (nuevo archivo)

@pytest.mark.django_db
def test_user_can_access_two_tenants_simultaneously():
    """
    Un usuario en dos tenants puede acceder a ambos en la misma sesión
    enviando distintos X-Tenant-ID headers.
    """
    from rest_framework.test import APIClient
    from rest_framework_simplejwt.tokens import RefreshToken
    from conftest import UserFactory, TenantUserFactory, TenantFactory, CustomerFactory

    user = UserFactory()
    tenant_a = TenantFactory()
    tenant_b = TenantFactory()

    TenantUserFactory(user=user, tenant=tenant_a, role='admin')
    TenantUserFactory(user=user, tenant=tenant_b, role='admin')

    CustomerFactory(tenant=tenant_a)
    CustomerFactory(tenant=tenant_b)

    refresh = RefreshToken.for_user(user)
    token = str(refresh.access_token)

    client_a = APIClient()
    client_a.credentials(
        HTTP_AUTHORIZATION=f'Bearer {token}',
        HTTP_X_TENANT_ID=tenant_a.slug
    )

    client_b = APIClient()
    client_b.credentials(
        HTTP_AUTHORIZATION=f'Bearer {token}',
        HTTP_X_TENANT_ID=tenant_b.slug
    )

    # Ambos pueden listar clientes de su tenant
    response_a = client_a.get('/api/customers/')
    response_b = client_b.get('/api/customers/')

    assert response_a.status_code == 200
    assert response_b.status_code == 200

    # Los resultados son del tenant correcto (no se mezclan)
    ids_a = {c['id'] for c in response_a.data['results']}
    ids_b = {c['id'] for c in response_b.data['results']}
    assert ids_a.isdisjoint(ids_b)
```

---

## 10. Criterios de aceptación

1. La columna `is_current` no existe en la tabla `tenants_tenantuser` en PostgreSQL.
2. El modelo `TenantUser` no tiene el campo `is_current` ni el método `save()` personalizado.
3. `TenantUserFactory` no acepta ni produce `is_current`.
4. El JWT access token emitido por `/api/auth/login/` y `/api/auth/google/` incluye el claim `tenant_id`.
5. El `NotificationConsumer` se une al grupo `tenant_{id}` usando el claim del JWT; si el claim no está, usa la primera membresía activa por `created_at`.
6. Las 7 clases de permiso en `shared/permissions.py` verifican `TenantUser.role` usando `tenant=request.tenant`, no `is_current=True`.
7. `TenantFromUserMiddleware` resuelve el tenant usando `order_by('created_at').first()` sin filtrar por `is_current`.
8. Los endpoints de la API funcionan correctamente cuando un usuario tiene 2 o más tenants activos y envía distintos `X-Tenant-ID` headers en requests paralelos.
9. Todos los tests pasan (`pytest` con cobertura >= 65%).
10. El test `test_user_can_access_two_tenants_simultaneously` pasa.

---

## 11. Riesgos y mitigaciones

| Riesgo | Probabilidad | Impacto | Mitigación |
|--------|-------------|---------|------------|
| Tokens emitidos antes del cambio no tienen claim `tenant_id` | Media | Bajo | El consumer y la lógica de permisos tienen fallback a membresía por `created_at`. Los tokens expiran en 5-60 min (configuración `SIMPLE_JWT`). |
| `TenantFromUserMiddleware` elige el tenant "incorrecto" para usuarios con múltiples tenants | Baja | Bajo | Solo ocurre cuando no hay header `X-Tenant-ID`. La SPA siempre envía el header. Solo afecta requests desde Django Admin o clientes externos mal configurados. |
| `NotificationService.send_to_user()` guarda notificación en tenant incorrecto | Baja | Medio | Todas las llamadas desde signals de appointments/workshop pasan el tenant por contexto del objeto. El fallback a `first()` solo aplica si no se pasa `tenant_id`. Auditar todas las llamadas a `send_to_user` en los signals. |
| Tests de `switch` endpoint fallan si se espera que modifique BD | Baja | Bajo | Actualizar el test `apps/tenants/tests/test_api.py` de switch para esperar solo el nuevo JWT, no cambios en `is_current`. |
| Regresión en `IsAdmin` / `IsAdminOrSuperAdmin` si `request.tenant` es None | Media | Medio | Agregar guardia: si `tenant` es None, el bloque de TenantUser no se ejecuta (ya existe en la propuesta). El usuario puede tener permisos si tiene `mechanic_profile.role == 'admin'` — ese camino no depende de `is_current` y no se toca. |
| Datos inconsistentes en BD (usuarios sin ningún `TenantUser.is_current=True`) | Baja | Bajo | Ya existe como bug hoy. La migración mejora el caso: ahora `filter().first()` devuelve algo en lugar de nada. |
