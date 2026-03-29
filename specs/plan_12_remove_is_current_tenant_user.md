# plan_12 — Eliminar `is_current` de TenantUser: sesiones multi-tenant simultáneas

**Estado:** Pendiente
**Spec de referencia:** `spec_12_remove_is_current_tenant_user.md`
**Fecha:** 2026-03-21
**Prioridad:** Media — mejora de arquitectura multi-tenant
**Rama sugerida:** `feature/remove-is-current-tenant-user`

---

## Resumen ejecutivo

Eliminar el campo `is_current` del modelo `TenantUser` y reemplazar todas sus referencias por:
- **HTTP**: `request.tenant` resuelto por `X-Tenant-ID` header (ya funciona, prioridad 1 en `TenantMiddleware`).
- **WebSocket**: Claim `tenant_id` incrustado en el JWT access token al momento del login.

**Sin cambios en el frontend.** La eliminación es transparente para el cliente.

---

## Archivos afectados

| # | Archivo | Tipo de cambio |
|---|---------|---------------|
| 1 | `apps/tenants/models.py` | Eliminar campo + método `save()` |
| 2 | `apps/core/views.py` | Incrustar claim JWT + eliminar filtros `is_current` (3 lugares) |
| 3 | `apps/core/middleware.py` | Cambiar fallback en `TenantFromUserMiddleware` |
| 4 | `apps/tenants/views.py` | Actualizar `current()`, `switch()`, `get_queryset()`, `TenantRegistrationView` |
| 5 | `shared/permissions.py` | Reemplazar 7 filtros `is_current=True` por `tenant=request.tenant` |
| 6 | `apps/notifications/consumers.py` | Leer `tenant_id` desde claim JWT |
| 7 | `apps/notifications/services.py` | Aceptar `tenant_id` como parámetro explícito |
| 8 | `apps/notifications/whatsapp_views.py` | Cambiar fallback a `order_by('created_at').first()` |
| 9 | `conftest.py` | Eliminar `is_current=True` de `TenantUserFactory` |
| 10 | `apps/tenants/migrations/` | Nueva migración `0002_remove_is_current_from_tenant_user` |
| 11 | 13 archivos de tests | Limpiar `is_current=True/False` del setup |

---

## Plan de implementación

### Paso 1 — Incrustar `tenant_id` como claim en el JWT ⬜

**Archivo:** `apps/core/views.py` — `CustomJWTLoginView` y `GoogleAuthView`

En ambas vistas, después de resolver `resolved_tenant`, añadir el claim al access token:

```python
# ANTES
refresh = RefreshToken.for_user(user)
access = refresh.access_token

# DESPUÉS
refresh = RefreshToken.for_user(user)
access = refresh.access_token
if resolved_tenant:
    access['tenant_id'] = resolved_tenant.id
```

> **Debe ir primero** — así los tokens nuevos ya traen el claim antes de que el consumer lo requiera.

---

### Paso 2 — Actualizar `NotificationConsumer.get_user_tenant_id()` ⬜

**Archivo:** `apps/notifications/consumers.py`

```python
# En connect(), después de validar el token:
try:
    validated = AccessToken(token_key)
    self._jwt_tenant_id = validated.get('tenant_id')
except Exception:
    self._jwt_tenant_id = None

# Nuevo get_user_tenant_id():
@database_sync_to_async
def get_user_tenant_id(self):
    try:
        tenant_id = getattr(self, '_jwt_tenant_id', None)
        if tenant_id:
            return tenant_id
        # Fallback para tokens emitidos antes del cambio
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

---

### Paso 3 — Actualizar `NotificationService.send_to_user()` ⬜

**Archivo:** `apps/notifications/services.py`

```python
# ANTES
current_tenant = user.tenant_memberships.filter(is_current=True).first()
tenant_id = current_tenant.tenant_id if current_tenant else None

# DESPUÉS — aceptar tenant_id como parámetro con fallback
@classmethod
def send_to_user(cls, user_id, title, message, notification_type='system',
                 data=None, save=True, tenant_id=None):
    ...
    if save and tenant_id is None:
        current_tenant = user.tenant_memberships.filter(
            tenant__is_active=True,
            tenant__is_deleted=False,
        ).order_by('created_at').first()
        tenant_id = current_tenant.tenant_id if current_tenant else None
```

Auditar todas las llamadas a `send_to_user()` en signals de `appointments/` y `workshop/` para pasar `tenant_id=instance.tenant_id` explícitamente.

---

### Paso 4 — Actualizar `notifications/whatsapp_views.py` ⬜

**Archivo:** `apps/notifications/whatsapp_views.py`

```python
def get_user_tenant(user):
    if hasattr(user, 'tenant_memberships'):
        membership = user.tenant_memberships.filter(
            tenant__is_active=True,
            tenant__is_deleted=False,
        ).order_by('created_at').first()
        if membership:
            return membership.tenant
    return None
```

---

### Paso 5 — Actualizar `shared/permissions.py` (7 ocurrencias) ⬜

**Archivo:** `shared/permissions.py`

Reemplazar el patrón en las 7 clases. Cambio idéntico en todas:

```python
# ANTES (patrón repetido 7 veces)
tenant_user = TenantUser.objects.filter(
    user=request.user,
    is_current=True
).first()
if tenant_user and tenant_user.role in ['owner', 'admin']:
    return True

# DESPUÉS
tenant = getattr(request, 'tenant', None)
if tenant:
    tenant_user = TenantUser.objects.filter(
        user=request.user,
        tenant=tenant
    ).first()
    if tenant_user and tenant_user.role in ['owner', 'admin']:
        return True
```

| Clase | Método |
|-------|--------|
| `IsAdmin` | `has_permission` |
| `IsAdminOrSuperAdmin` | `has_permission` |
| `IsStaffMember` | `has_permission` |
| `IsOwnerOrAdmin` | `has_object_permission` |
| `CanManageCustomers` | `has_permission` |
| `CanManageVehicles` | `has_permission` |
| `CanManageVehicles` | `has_object_permission` |

---

### Paso 6 — Actualizar `TenantFromUserMiddleware` ⬜

**Archivo:** `apps/core/middleware.py`

```python
# ANTES
tenant_user = TenantUser.objects.select_related('tenant').filter(
    user=request.user,
    is_current=True,
    tenant__is_active=True,
    tenant__is_deleted=False
).first()

# DESPUÉS — primer tenant activo por fecha de alta
tenant_user = TenantUser.objects.select_related('tenant').filter(
    user=request.user,
    tenant__is_active=True,
    tenant__is_deleted=False
).order_by('created_at').first()
```

---

### Paso 7 — Actualizar auth views: login fallback y `TenantViewSet` ⬜

**`CustomJWTLoginView` fallback** (`apps/core/views.py`):

```python
# ANTES
tenant_user = TenantUser.objects.select_related('tenant').filter(
    user=user, is_current=True, tenant__is_active=True, ...
).first()

# DESPUÉS
tenant_user = TenantUser.objects.select_related('tenant').filter(
    user=user, tenant__is_active=True, tenant__is_deleted=False,
).order_by('created_at').first()
```

**`TenantViewSet.current()`** (`apps/tenants/views.py`):

```python
# ANTES
tenant_user = TenantUser.objects.select_related('tenant').get(
    user=user, is_current=True
)

# DESPUÉS
tenant = getattr(request, 'tenant', None)
if not tenant:
    return Response(
        {'error': 'No hay tenant en el contexto. Envía X-Tenant-ID.'},
        status=status.HTTP_400_BAD_REQUEST
    )
serializer = TenantDetailSerializer(tenant, context={'request': request})
return Response(serializer.data)
```

**`TenantUserViewSet.get_queryset()`** (`apps/tenants/views.py`):

```python
# ANTES
current_tenant = TenantUser.objects.get(user=user, is_current=True).tenant

# DESPUÉS
current_tenant = getattr(self.request, 'tenant', None)
if not current_tenant:
    return TenantUser.objects.none()
return TenantUser.objects.filter(tenant=current_tenant)
```

**`TenantViewSet.switch()`** (`apps/tenants/views.py`):

```python
# ANTES — modifica is_current en BD
TenantUser.objects.filter(user=user).update(is_current=False)
tenant_user.is_current = True
tenant_user.save()

# DESPUÉS — solo emite nuevo JWT con claim, sin tocar BD
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

---

### Paso 8 — Actualizar `GoogleAuthView` ⬜

**Archivo:** `apps/core/views.py` — `GoogleAuthView`

```python
# ANTES — al crear TenantUser
TenantUser.objects.get_or_create(
    user=user, tenant=tenant,
    defaults={'is_current': True, 'role': 'member'},
)

# DESPUÉS
TenantUser.objects.get_or_create(
    user=user, tenant=tenant,
    defaults={'role': 'member'},
)

# ANTES — para datos del tenant en respuesta
tenant_user = TenantUser.objects.select_related('tenant').filter(
    user=user, is_current=True, ...
).first()

# DESPUÉS — usar el tenant ya resuelto del contexto
resolved_tenant = tenant  # ya disponible del bloque de validación anterior
```

---

### Paso 9 — Actualizar `TenantRegistrationView` ⬜

**Archivo:** `apps/tenants/views.py`

```python
# ANTES
TenantUser.objects.create(user=user, tenant=tenant, role='owner', is_current=True)

# DESPUÉS
TenantUser.objects.create(user=user, tenant=tenant, role='owner')
```

---

### Paso 10 — Eliminar campo del modelo y crear migración ⬜

**Archivo:** `apps/tenants/models.py`

Eliminar:
- El campo `is_current = models.BooleanField(...)` (líneas ~316–319)
- El método `save()` completo (líneas ~341–348)

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

**Generar migración:**

```bash
docker compose exec web python manage.py makemigrations tenants \
    --name="remove_is_current_from_tenant_user"
docker compose exec web python manage.py migrate
```

La migración resultante:

```python
# apps/tenants/migrations/0002_remove_is_current_from_tenant_user.py
operations = [
    migrations.RemoveField(
        model_name='tenantuser',
        name='is_current',
    ),
]
```

---

### Paso 11 — Actualizar `conftest.py` y tests ⬜

**`conftest.py`:**

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

**13 archivos de tests** — eliminar `is_current=True/False` del setup:

```python
# ANTES (patrón en todos)
TenantUserFactory(user=user, tenant=tenant, role='admin', is_current=True)

# DESPUÉS
TenantUserFactory(user=user, tenant=tenant, role='admin')
```

**Tests a eliminar** (ya no aplican):

```
apps/tenants/tests/test_models.py::TestTenantUserModel::test_tenant_user_is_current_default
apps/tenants/tests/test_models.py::TestTenantUserModel::test_tenant_user_only_one_current
apps/notifications/tests/test_consumer.py::TestGetUserTenantId::test_get_user_tenant_id_ignores_non_current
apps/core/tests/test_spec08_auth_registro.py::TestLogin::test_login_fallback_is_current_cuando_no_hay_tenant_slug
```

**Assert a reemplazar** en `apps/core/tests/test_google_auth.py`:

```python
# ANTES
assert tenant_user.is_current is True

# DESPUÉS
assert TenantUser.objects.filter(user=user, tenant=self.tenant).exists()
```

---

## Plan de pruebas — Tests nuevos

### Test 1 — JWT incluye claim `tenant_id` tras login

```python
# apps/core/tests/test_jwt_login.py

@pytest.mark.django_db
def test_login_jwt_includes_tenant_id_claim(client, tenant):
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
    token = AccessToken(response.data['access'])
    assert token.get('tenant_id') == tenant.id
```

### Test 2 — `TenantFromUserMiddleware` usa `order_by('created_at')`

```python
# apps/core/tests/test_middleware.py (nuevo archivo)

@pytest.mark.django_db
def test_tenant_from_user_middleware_fallback_first_membership():
    from django.test import RequestFactory
    from apps.core.middleware import TenantFromUserMiddleware
    from conftest import UserFactory, TenantUserFactory, TenantFactory

    user = UserFactory()
    tenant_old = TenantFactory()
    tenant_new = TenantFactory()
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

### Test 3 — `IsAdmin` usa `request.tenant`, no `is_current`

```python
# apps/core/tests/test_permissions.py

@pytest.mark.django_db
def test_is_admin_uses_request_tenant_not_is_current():
    from shared.permissions import IsAdmin
    from conftest import UserFactory, TenantUserFactory, TenantFactory
    from unittest.mock import Mock
    from django.test import RequestFactory

    user = UserFactory()
    tenant_a = TenantFactory()
    tenant_b = TenantFactory()
    TenantUserFactory(user=user, tenant=tenant_a, role='admin')
    TenantUserFactory(user=user, tenant=tenant_b, role='member')

    rf = RequestFactory()
    request = rf.get('/')
    request.user = user

    perm = IsAdmin()

    request.tenant = tenant_a
    assert perm.has_permission(request, Mock()) is True

    request.tenant = tenant_b
    assert perm.has_permission(request, Mock()) is False
```

### Test 4 — `NotificationConsumer` usa claim JWT

```python
# apps/notifications/tests/test_consumer.py

@pytest.mark.asyncio
@pytest.mark.django_db(transaction=True)
async def test_get_user_tenant_id_from_jwt_claim(db):
    from channels.db import database_sync_to_async
    from conftest import UserFactory, TenantFactory, TenantUserFactory
    from rest_framework_simplejwt.tokens import AccessToken
    from apps.notifications.consumers import NotificationConsumer

    user = await database_sync_to_async(UserFactory)()
    tenant = await database_sync_to_async(TenantFactory)()
    await database_sync_to_async(TenantUserFactory)(user=user, tenant=tenant)

    token = AccessToken.for_user(user)
    token['tenant_id'] = tenant.id

    consumer = NotificationConsumer()
    consumer.user = user
    consumer._jwt_tenant_id = token.get('tenant_id')

    result = await consumer.get_user_tenant_id()
    assert result == tenant.id
```

### Test 5 — Sesiones simultáneas en dos tenants (prueba de integración clave)

```python
# apps/core/tests/test_multitenant_sessions.py (nuevo archivo)

@pytest.mark.django_db
def test_user_can_access_two_tenants_simultaneously():
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

    token = str(RefreshToken.for_user(user).access_token)

    client_a = APIClient()
    client_a.credentials(HTTP_AUTHORIZATION=f'Bearer {token}', HTTP_X_TENANT_ID=tenant_a.slug)

    client_b = APIClient()
    client_b.credentials(HTTP_AUTHORIZATION=f'Bearer {token}', HTTP_X_TENANT_ID=tenant_b.slug)

    response_a = client_a.get('/api/customers/')
    response_b = client_b.get('/api/customers/')

    assert response_a.status_code == 200
    assert response_b.status_code == 200

    ids_a = {c['id'] for c in response_a.data['results']}
    ids_b = {c['id'] for c in response_b.data['results']}
    assert ids_a.isdisjoint(ids_b), "Los clientes de tenants distintos no deben mezclarse"
```

---

## Migración de BD

### Verificación previa (ejecutar antes de migrar)

```python
# docker compose exec web python manage.py shell
from apps.tenants.models import TenantUser
from django.db.models import Count

inconsistentes = (
    TenantUser.objects
    .filter(is_current=True)
    .values('user')
    .annotate(n=Count('id'))
    .filter(n__gt=1)
)
print(f"Usuarios con múltiples is_current=True: {inconsistentes.count()}")
print(f"Total TenantUser: {TenantUser.objects.count()}")
print(f"Con is_current=True: {TenantUser.objects.filter(is_current=True).count()}")
print(f"Con is_current=False: {TenantUser.objects.filter(is_current=False).count()}")
```

### Aplicar

```bash
docker compose exec web python manage.py makemigrations tenants \
    --name="remove_is_current_from_tenant_user"
docker compose exec web python manage.py migrate
```

> `RemoveField` en PostgreSQL es DDL rápido — no requiere downtime.

---

## Criterios de aceptación

- [ ] La columna `is_current` no existe en `tenants_tenantuser` en PostgreSQL
- [ ] El modelo `TenantUser` no tiene `is_current` ni método `save()` personalizado
- [ ] `TenantUserFactory` no acepta ni produce `is_current`
- [ ] El JWT emitido por `/api/auth/login/` incluye claim `tenant_id`
- [ ] El JWT emitido por `/api/auth/google/` incluye claim `tenant_id`
- [ ] `NotificationConsumer` usa el claim JWT para el `tenant_group`; fallback a `order_by('created_at')` si no hay claim
- [ ] Las 7 clases de permiso usan `tenant=request.tenant`, no `is_current=True`
- [ ] `TenantFromUserMiddleware` resuelve tenant con `order_by('created_at').first()`
- [ ] El test `test_user_can_access_two_tenants_simultaneously` pasa
- [ ] `pytest` pasa al 100% con cobertura >= 65%

---

## Riesgos y mitigaciones

| Riesgo | Prob. | Impacto | Mitigación |
|--------|-------|---------|------------|
| Tokens viejos sin claim `tenant_id` | Media | Bajo | Fallback a `order_by('created_at').first()` en consumer y middleware. Tokens expiran en ≤60 min. |
| `TenantFromUserMiddleware` elige tenant incorrecto (múltiples tenants, sin header) | Baja | Bajo | La SPA siempre envía `X-Tenant-ID`. Solo afecta Django Admin o clientes externos mal configurados. |
| `send_to_user()` guarda notificación en tenant incorrecto | Baja | Medio | Auditar todos los callers en signals y pasar `tenant_id=instance.tenant_id` explícitamente. |
| Regresión si `request.tenant` es None en permisos | Media | Medio | El bloque de `TenantUser.role` no se ejecuta si `tenant` es None (guardia ya en el código propuesto). |
