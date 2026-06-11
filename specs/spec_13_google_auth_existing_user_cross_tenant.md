# spec_13 — Bug: Google Login falla para usuarios existentes en otro tenant

**Estado:** Pendiente
**Fecha:** 2026-03-21
**Prioridad:** Alta — bloquea login de admin con Google
**Cuenta afectada:** pallaresvanessita@gmail.com (admin en `real-madrid`)

---

## 1. Síntoma

El usuario intenta hacer login con Google en el tenant `real-betis` con la cuenta
`pallaresvanessita@gmail.com`, que ya tiene cuenta registrada en `real-madrid` con rol `admin`.
El login falla con error (probablemente **500 Internal Server Error** — IntegrityError en BD).

Cuentas de `customer` que aún no tienen DjangoUser sí funcionan porque no hay conflicto de email.

---

## 2. Causa Raíz — Análisis exacto del flujo

### Flujo de `GoogleAuthView.post()` para el caso problemático

```
POST /api/auth/google/
{
  "id_token": "<Google JWT de pallaresvanessita@gmail.com>",
  "tenant_slug": "real-betis"
}
```

**Paso 1 — Busca Customer por `google_sub` en `real-betis`**
```python
# apps/core/views.py ~335-346
existing_customer = Customer.objects.filter(
    google_sub=google_sub,
    tenant=tenant  # real-betis
).first()
# → None (no tiene Customer en real-betis)
```

**Paso 2A — Busca Customer por email en `real-betis`**
```python
# apps/core/views.py ~351-362
existing_customer = Customer.objects.get(
    email=email,             # pallaresvanessita@gmail.com
    tenant=tenant            # real-betis
)
# → Customer.DoesNotExist (no tiene Customer en real-betis)
```

**Paso 2B — Busca DjangoUser por email (AQUÍ ESTÁ EL BUG)**
```python
# apps/core/views.py ~363-371
try:
    existing_django_user = DjangoUser.objects.get(email=email)
    # → ENCUENTRA el usuario (existe de real-madrid)

    if TenantUser.objects.filter(user=existing_django_user, tenant=tenant).exists():
        user = existing_django_user
    # → TenantUser en real-betis NO existe → user SIGUE siendo None
except DjangoUser.DoesNotExist:
    pass
```

**Paso 3 — Intenta CREAR un nuevo DjangoUser — FALLA**
```python
# apps/core/views.py ~373-405
if user is None:
    user = DjangoUser.objects.create(
        email=email,   # pallaresvanessita@gmail.com — YA EXISTE en BD
        ...
    )
    # → IntegrityError: UNIQUE constraint on accounts_user.email
    # → Django lanza 500 Internal Server Error
```

### Diagrama del bug

```
pallaresvanessita@gmail.com
    │
    ├── DjangoUser: SÍ existe (de real-madrid)
    ├── Customer en real-madrid: SÍ
    ├── TenantUser real-madrid: SÍ (role='admin')
    │
    └── Login con Google en real-betis:
        ├── Customer en real-betis: NO
        ├── TenantUser en real-betis: NO
        │
        └── 2B: Encuentra DjangoUser SÍ,
            pero TenantUser en real-betis NO
            → user = None
            → intenta DjangoUser.objects.create(email=...)
            → ❌ IntegrityError (email ya existe)
            → 500 Internal Server Error
```

### Por qué las cuentas de customer SÍ funcionan

Una cuenta de customer que funciona es uno de estos casos:

| Caso | Razón |
|------|-------|
| Usuario **nuevo** (no existe en ningún tenant) | No hay DjangoUser previo → create() no falla |
| Usuario que ya tiene **Customer en `real-betis`** | Lo encuentra en el Paso 1 o 2A → usa ese user |
| Usuario con **TenantUser en `real-betis`** | El check en 2B devuelve True → user se asigna |

---

## 3. Inventario completo de archivos afectados

| Archivo | Líneas | Problema | Acción |
|---------|--------|----------|--------|
| `apps/core/views.py` | ~363–405 | La condición en 2B ignora el DjangoUser existente si no tiene TenantUser en este tenant. Cuando `user is None`, intenta crear un DjangoUser con email duplicado → **IntegrityError** | Fix principal |
| `apps/core/views.py` | ~395–405 | `TenantUser.get_or_create(defaults={'role': 'member'})` — siempre crea con rol `member`. No preserva ni consulta el rol del usuario en otros tenants | Secundario |
| `apps/core/views.py` | ~373–405 | `Customer.objects.create(...)` — crea perfil customer automáticamente para cualquier usuario nuevo en el tenant, incluyendo admins | Secundario |

---

## 4. Fix principal

El bloque 2B debe usar el DjangoUser existente **aunque no tenga TenantUser en este tenant**.
La solución es cambiar la condición para asignar el usuario siempre que exista, y luego crear
el TenantUser y Customer para el nuevo tenant si no existen.

### Código actual (buggy)

```python
# apps/core/views.py ~363-371
try:
    existing_django_user = DjangoUser.objects.get(email=email)
    if TenantUser.objects.filter(user=existing_django_user, tenant=tenant).exists():
        user = existing_django_user  # ← Solo asigna si YA tiene TenantUser en este tenant
except DjangoUser.DoesNotExist:
    pass
```

### Código propuesto

```python
# apps/core/views.py ~363-371
try:
    existing_django_user = DjangoUser.objects.get(email=email)
    user = existing_django_user  # ← Usar siempre si el email existe globalmente

    # Actualizar google_sub en cualquier Customer que tenga ese email en este tenant
    # (por si tiene Customer sin google_sub vinculado)
    if not google_sub_already_saved:
        Customer.objects.filter(
            email=email,
            tenant=tenant,
            google_sub__isnull=True
        ).update(google_sub=google_sub)

except DjangoUser.DoesNotExist:
    pass
```

Luego, el bloque de `if user is None` queda igual — solo se ejecuta para usuarios
**completamente nuevos** que no existen en ningún tenant.

Para el caso de usuario existente sin TenantUser en este tenant, agregar antes de generar el JWT:

```python
# Asegurarse de que el usuario tiene TenantUser en este tenant
# (puede no tenerlo si se registró en otro tenant y hace login aquí por primera vez)
TenantUser.objects.get_or_create(
    user=user,
    tenant=tenant,
    defaults={'role': 'member'},
)

# Asegurarse de que tiene Customer en este tenant si corresponde
# (solo si no es un usuario de staff/mechanic)
if not Customer.objects.filter(user=user, tenant=tenant).exists():
    # Verificar si el usuario es staff antes de crear Customer
    is_staff_user = TenantUser.objects.filter(
        user=user,
        tenant=tenant,
        role__in=['owner', 'admin', 'advisor', 'mechanic']
    ).exists()

    if not is_staff_user:
        # Es un usuario tipo customer — crear perfil
        full_name = idinfo.get('name', '')
        first_name = idinfo.get('given_name', full_name)
        last_name = idinfo.get('family_name', '')
        Customer.objects.get_or_create(
            user=user,
            tenant=tenant,
            defaults={
                'name': first_name,
                'last_name': last_name,
                'email': email,
                'google_sub': google_sub,
            }
        )
```

---

## 5. Casos edge que el fix debe manejar

| Caso | Comportamiento esperado |
|------|------------------------|
| Admin en `real-madrid` → login Google en `real-betis` por primera vez | Usa DjangoUser existente, crea TenantUser con role='member' en real-betis. Retorna role='customer' (correcto — no es admin en real-betis) |
| Admin en `real-madrid` → login Google en `real-madrid` | Encuentra TenantUser con role='admin' en real-madrid. Retorna role='admin' ✅ |
| Usuario nuevo (nunca registrado) → login Google | Crea DjangoUser + Customer + TenantUser(role='member'). Funciona igual que antes ✅ |
| Usuario con Customer en real-betis + sin google_sub → login Google | Vincula google_sub al Customer existente. Funciona igual que antes ✅ |
| Usuario que ya tiene TenantUser en real-betis con role='admin' → login Google | Encuentra TenantUser correctamente. Retorna role='admin' ✅ |
| Dos usuarios con el mismo email en distintos tenants | No puede ocurrir — DjangoUser.email es único globalmente ✅ |

---

## 6. Plan de implementación

### Paso 1 — Fix en `GoogleAuthView` ⬜

**Archivo:** `apps/core/views.py`

1. Leer el bloque 2B completo (líneas ~363–405)
2. Cambiar la condición del `if` en 2B para asignar `user = existing_django_user` sin condicionar la existencia de TenantUser
3. Mover la creación de TenantUser y Customer a un bloque separado post-resolución de user:
   - Si user fue resuelto (existente) pero NO tiene TenantUser en este tenant → crearlo con role='member'
   - Si user fue resuelto pero NO tiene Customer en este tenant → crearlo SOLO si no es staff

### Paso 2 — Agregar manejo de IntegrityError como safety net ⬜

**Archivo:** `apps/core/views.py`

Envolver el `DjangoUser.objects.create(...)` en un try/except para que si por alguna razón
llega ahí con email duplicado, se recupere gracefully:

```python
try:
    user = DjangoUser.objects.create(email=email, ...)
except IntegrityError:
    # Alguien se registró entre el get y el create (race condition)
    user = DjangoUser.objects.get(email=email)
```

### Paso 3 — Tests ⬜

Crear en `apps/core/tests/test_google_auth.py`:

```python
def test_admin_en_otro_tenant_puede_login_google_en_nuevo_tenant(
    self, mock_verify_token
):
    """
    Un usuario con rol admin en tenant A puede hacer login con Google
    en tenant B sin generar IntegrityError.
    """
    # Setup: usuario existente en real-madrid con role='admin'
    user = UserFactory()
    tenant_a = TenantFactory(slug='real-madrid')
    tenant_b = TenantFactory(slug='real-betis')
    TenantUserFactory(user=user, tenant=tenant_a, role='admin')

    mock_verify_token.return_value = {
        'sub': 'google-sub-123',
        'email': user.email,
        'name': 'Test User',
        'given_name': 'Test',
        'family_name': 'User',
    }

    response = self.client.post(
        '/api/auth/google/',
        {'id_token': 'fake-token', 'tenant_slug': 'real-betis'},
        content_type='application/json',
        HTTP_X_TENANT_ID='real-betis',
    )

    # No debe explotar con 500
    assert response.status_code == 200

    # Usuario debe tener ahora TenantUser en real-betis
    assert TenantUser.objects.filter(user=user, tenant=tenant_b).exists()

    # El rol en real-betis es 'member' (no admin — no se hereda)
    tenant_user_b = TenantUser.objects.get(user=user, tenant=tenant_b)
    assert tenant_user_b.role == 'member'

    # El rol retornado es 'customer' (correcto para este tenant)
    assert response.data['role'] == 'customer'


def test_usuario_nuevo_google_login_crea_todo_correctamente(self, mock_verify_token):
    """
    Flujo normal: usuario nuevo (no existe en ningún tenant) → todo se crea.
    """
    tenant = TenantFactory()
    mock_verify_token.return_value = {
        'sub': 'google-sub-nuevo',
        'email': 'nuevousuario@gmail.com',
        'name': 'Nuevo Usuario',
        'given_name': 'Nuevo',
        'family_name': 'Usuario',
    }

    response = self.client.post(
        '/api/auth/google/',
        {'id_token': 'fake-token', 'tenant_slug': tenant.slug},
        content_type='application/json',
        HTTP_X_TENANT_ID=tenant.slug,
    )

    assert response.status_code == 200
    from django.contrib.auth import get_user_model
    User = get_user_model()
    assert User.objects.filter(email='nuevousuario@gmail.com').exists()


def test_admin_en_mismo_tenant_mantiene_rol_admin(self, mock_verify_token):
    """
    Un usuario con rol admin en el tenant donde hace login debe retornar role='admin'.
    """
    user = UserFactory()
    tenant = TenantFactory()
    TenantUserFactory(user=user, tenant=tenant, role='admin')

    mock_verify_token.return_value = {
        'sub': 'google-sub-admin',
        'email': user.email,
        'name': 'Admin User',
        'given_name': 'Admin',
        'family_name': 'User',
    }

    response = self.client.post(
        '/api/auth/google/',
        {'id_token': 'fake-token', 'tenant_slug': tenant.slug},
        content_type='application/json',
        HTTP_X_TENANT_ID=tenant.slug,
    )

    assert response.status_code == 200
    assert response.data['role'] == 'admin'
```

---

## 7. Criterios de aceptación

- [ ] `pallaresvanessita@gmail.com` puede hacer login con Google en `real-betis` sin error 500
- [ ] El login retorna `role='customer'` (ya que no es admin en `real-betis`)
- [ ] Se crea `TenantUser(user, tenant='real-betis', role='member')` automáticamente
- [ ] El login con Google en `real-madrid` sigue retornando `role='admin'`
- [ ] `test_admin_en_otro_tenant_puede_login_google_en_nuevo_tenant` pasa
- [ ] `test_usuario_nuevo_google_login_crea_todo_correctamente` sigue pasando
- [ ] No hay regresiones en los otros tests de `test_google_auth.py`
- [ ] `pytest apps/core/tests/test_google_auth.py -v` → 100% passed

---

## 8. Riesgos y mitigaciones

| Riesgo | Prob. | Impacto | Mitigación |
|--------|-------|---------|------------|
| Un admin de real-madrid se auto-registra como customer en real-betis sin querer | Media | Bajo | Es el comportamiento correcto — si quiere ser admin en real-betis, el owner debe asignarlo manualmente desde el panel |
| Race condition: dos requests crean DjangoUser simultáneamente | Muy baja | Bajo | El safety net de `try/except IntegrityError` del Paso 2 lo maneja |
| Un usuario con Customer en real-betis Y DjangoUser en real-madrid causa conflicto | Baja | Bajo | El Paso 2A lo encuentra primero (busca por email+tenant) antes de llegar al 2B |

---

## 9. Nota sobre `VITE_TENANT_SLUG`

El `.env` del frontend tiene `VITE_TENANT_SLUG=real-betis` seteado, lo que significa que
`getCurrentTenant()` **siempre** retorna `'real-betis'` en ese entorno de desarrollo,
independientemente de localStorage o subdominios.

En **producción** (`app.autotronia.com`), esta variable debería estar **vacía** o no definida
para que la resolución sea dinámica (por subdominio o query param).

**Esto es correcto para pruebas locales** del tenant real-betis específicamente, pero no permite
probar multi-tenant desde el mismo frontend sin cambiar el `.env`.
