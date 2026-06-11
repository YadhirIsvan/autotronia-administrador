# Spec 08 — Auth, Registro y UI: Análisis de Impacto (8 Requerimientos)

**Fecha:** 2026-03-17
**Tipo:** Análisis técnico de impacto (spec)
**Estado:** Pendiente de implementación
**Alcance:** Login, registro, roles, Google OAuth, UI mobile-first

---

## Índice

- [REQ-1: Registro con email — unicidad por tenant](#req-1-registro-con-email--unicidad-por-tenant)
- [REQ-2: Login con email — resolución por tenant](#req-2-login-con-email--resolución-por-tenant)
- [REQ-3: Exclusividad de roles](#req-3-exclusividad-de-roles)
- [REQ-4: Google signup automático — verificación post plan_07](#req-4-google-signup-automático--verificación-post-plan_07)
- [REQ-5: Eliminar botón Apple](#req-5-eliminar-botón-apple)
- [REQ-6: Móvil first — agregar botón login en vista de registro](#req-6-móvil-first--agregar-botón-login-en-vista-de-registro)
- [REQ-7: Formulario de registro con botón Google](#req-7-formulario-de-registro-con-botón-google)
- [REQ-8: Mejorar estilos — mobile-first, profesional](#req-8-mejorar-estilos--mobile-first-profesional)
- [Tabla resumen](#tabla-resumen)
- [Orden de implementación recomendado](#orden-de-implementación-recomendado)
- [Archivos a crear/modificar](#archivos-a-crearmodificar)

---

## REQ-1: Registro con email — unicidad por tenant

### Descripción

Cuando un usuario se registra con email+contraseña, el sistema debe verificar que no exista otro
Customer con el mismo email **en ese tenant específico**. El mismo email en un tenant diferente
debe ser considerado una cuenta distinta y permitirse el registro.

### Estado actual

**Flujo de registro existente:**

El registro usa dos endpoints en `apps/password_reset/views.py`:

1. `POST /api/auth/send-registration-code/` (líneas 210-316)
2. `POST /api/auth/verify-and-register/` (líneas 319-479)

**Análisis de la verificación en `send_registration_code` (línea 234):**

```python
# ← PROBLEMA CRÍTICO: busca User Django global, sin contexto de tenant
if User.objects.filter(email=email).exists():
    return Response(
        {'error': 'Este email ya está registrado. Intenta iniciar sesión.'},
        status=status.HTTP_400_BAD_REQUEST
    )
```

Esta verificación es global sobre `auth_user`. Si Juan registró su email en Taller Rojo,
no puede registrarse en Taller Azul, aunque sean tenants completamente independientes.

**Verificación tenant-scoped que SÍ existe (líneas 241-252):**

```python
tenant_slug = request.headers.get('X-Tenant-ID')
if tenant_slug:
    try:
        tenant = Tenant.objects.get(...)
        if Customer.objects.filter(email=email, tenant=tenant).exists():
            return Response({'error': 'Ya existe una cuenta...'}...)
    except Tenant.DoesNotExist:
        pass
```

Esta parte es correcta: verifica unicidad en el Customer por tenant. Pero la verificación
anterior la hace irrelevante porque bloquea antes por el `auth_user` global.

**El mismo problema existe en `verify_and_register` (línea 378):**

```python
# Otro bloqueo global
if User.objects.filter(email=email).exists():
    ...
```

**En el modelo `Customer` (línea 135):**

```python
unique_together = ['tenant', 'email']   # ← correcto: unicidad por tenant
```

El constraint de BD es correcto. El problema está únicamente en la lógica de las vistas.

**Implicación arquitectural:**

El diseño multi-tenant de Taller Pro asume que `auth_user` es compartido entre tenants — el mismo
`User` de Django puede pertenecer a múltiples tenants vía `TenantUser`. Sin embargo, para
`customers`, el flujo de registro crea un nuevo `User` Django por cada registro, sin verificar
si ese `User` ya existe en otro tenant. Esto significa que:

- Si el mismo email ya tiene un `auth_user`, el registro falla globalmente.
- Si no tiene `auth_user`, se crea uno nuevo, ignorando que podría haber uno existente en otro tenant.

La solución correcta tiene dos sub-casos:

**Sub-caso A: Email existe en `auth_user` (usuario ya registrado en otro tenant)**

No crear un nuevo `User` Django. Reusar el existente, crear solo un nuevo `Customer` vinculado
al tenant actual, y crear el `TenantUser` correspondiente. Verificar que no exista ya un
`Customer` con ese email en ese tenant (el `unique_together` del modelo lo garantiza en BD).

**Sub-caso B: Email existe como Customer en el mismo tenant**

Rechazar el registro con el mensaje apropiado. Esto ya funciona correctamente.

**Sub-caso C: Email es completamente nuevo**

Crear `User` + `Customer` + `TenantUser`. Flujo actual funcionando correctamente.

### Impacto backend

**Archivo:** `apps/password_reset/views.py`

- `send_registration_code`: eliminar la verificación global `User.objects.filter(email=email).exists()`.
  Reemplazar con verificación tenant-scoped en `Customer`. Si no hay tenant en el header, continuar
  sin esa validación (el endpoint puede recibir el código igual; la validación real es en
  `verify_and_register`).
- `verify_and_register`: eliminar la verificación global `User.objects.filter(email=email).exists()`.
  Implementar lógica de tres sub-casos. Si el `User` Django ya existe: crear solo el `Customer`
  y `TenantUser` sin crear un nuevo `User`. Usar `transaction.atomic()` (ya existe).

**Serializers:** ninguno afectado.

**Modelos:** ninguno afectado (el `unique_together = ['tenant', 'email']` en `Customer` es correcto).

**Migración:** no requiere migración.

### Impacto frontend

No hay impacto en `Register.tsx`. El formulario ya envía el header `X-Tenant-ID`.
Los mensajes de error ya se muestran correctamente con `toast.error`.

### Impacto en tests

**Tests existentes que se rompen:** ninguno conocido directamente, pero hay que verificar tests
en `apps/customers/tests/` o `apps/password_reset/tests/` que prueben el flujo de registro.

**Tests nuevos necesarios:**

```python
# test_registration_tenant_isolation.py (nuevo archivo)

@pytest.mark.django_db
class TestRegistrationTenantIsolation:
    def test_same_email_different_tenant_allowed(self, tenant_a, tenant_b):
        # Registrar en tenant_a → OK
        # Registrar el mismo email en tenant_b → debe ser OK (antes fallaba)
        pass

    def test_same_email_same_tenant_rejected(self, tenant):
        # Registrar dos veces en el mismo tenant → debe fallar con mensaje apropiado
        pass

    def test_existing_auth_user_reused_on_new_tenant(self, tenant_a, tenant_b):
        # Si el User Django ya existe (registro previo en tenant_a)
        # El registro en tenant_b debe: reusar el User, crear Customer en tenant_b
        pass

    def test_send_code_no_longer_blocks_on_global_user(self, tenant):
        # send-registration-code no debe rechazar emails de otros tenants
        pass
```

### Riesgos

- **Riesgo de colisión de username:** Django requiere `username` único global. En `verify_and_register`
  línea 413, el username se establece como el email. Si el `User` ya existe (Sub-caso A), no hay
  que crear un nuevo usuario, pero hay que manejar el caso en que el `user.email` sea el mismo.

- **Riesgo de contraseña en Sub-caso A:** Si el usuario ya existe con contraseña en tenant_a y se
  registra en tenant_b con una contraseña diferente, ¿se actualiza la contraseña global? Decisión
  de negocio: NO actualizar la contraseña existente. El usuario ya tiene credenciales en tenant_a
  y esas credenciales funcionarán en tenant_b (misma cuenta `auth_user`). Documentar esto
  claramente en el UX.

- **Riesgo de race condition:** si dos registros simultáneos del mismo email en el mismo tenant
  pasan la validación al mismo tiempo, el `unique_together` de BD lanzará `IntegrityError`.
  La `transaction.atomic()` ya existe, pero hay que capturar `IntegrityError` y devolver un
  mensaje amigable.

### Complejidad estimada

**Media.** La lógica de tres sub-casos requiere cuidado, especialmente el Sub-caso A (reuso de
`auth_user`). El riesgo de contraseña merece una decisión explícita de producto.

### Dependencias

Ninguna. Este REQ es independiente.

---

## REQ-2: Login con email — resolución por tenant

### Descripción

Un usuario con el mismo email registrado en múltiples tenants debe autenticarse en el tenant
correcto (el que indica el `VITE_TENANT_SLUG` / `tenant_slug` del request o el `X-Tenant-ID`
del header). No se deben mezclar datos de tenants distintos.

### Estado actual

**Archivo:** `apps/core/views.py`, `CustomJWTLoginView.post` (líneas 94-189)

El flujo actual de login:

```python
# Línea 105 — autenticación global
user = authenticate(request, username=username, password=password)

# Líneas 141-168 — resolución de tenant
tenant_user = TenantUser.objects.select_related('tenant').filter(
    user=user,
    is_current=True,          # ← toma el tenant "activo" del usuario
    tenant__is_active=True,
    tenant__is_deleted=False,
).first()
```

El problema: si Juan tiene `TenantUser` en dos tenants (tenant_a y tenant_b), el login
siempre devuelve el tenant donde `is_current=True`, independientemente de desde qué frontend
está haciendo login. El campo `is_current` se actualiza al último tenant donde se hizo login
(ver `TenantUser.save()` en `models.py` líneas 341-348).

**Escenario de fallo:**

1. Juan se registra en Taller Rojo → `TenantUser(is_current=True, tenant=rojo)`
2. Juan se registra en Taller Azul → `TenantUser(is_current=True, tenant=azul)`,
   el de Taller Rojo queda `is_current=False`
3. Juan hace login desde el frontend de Taller Rojo → el backend devuelve datos de Taller Azul.

**Auth backend (`apps/core/auth_backend.py` presumiblemente):** el `EmailBackend` autentica
por email sin contexto de tenant, lo cual es correcto (la autenticación es global en Django,
el tenant se resuelve después).

**¿Cómo el frontend envía el contexto de tenant?**

En `Register.tsx` línea 67: `headers['X-Tenant-ID'] = tenant` para los endpoints de registro.
En `Login.tsx`, el `handleSubmit` usa `auth-context.tsx → login()`, que llama a
`/api/auth/login/` sin header `X-Tenant-ID`. El `CustomJWTLoginView` no lee ese header.

### Impacto backend

**Archivo:** `apps/core/views.py` — `CustomJWTLoginView.post`

Modificar la resolución de `TenantUser`. En lugar de filtrar por `is_current=True`,
filtrar por tenant si hay un `tenant_slug` en el request (body o header):

```python
# Pseudo-código de la solución
tenant_slug = request.data.get('tenant_slug') or request.headers.get('X-Tenant-ID')

if tenant_slug:
    tenant_user = TenantUser.objects.select_related('tenant').filter(
        user=user,
        tenant__slug=tenant_slug,
        tenant__is_active=True,
        tenant__is_deleted=False,
    ).first()
else:
    # Fallback: comportamiento actual (is_current)
    tenant_user = TenantUser.objects.select_related('tenant').filter(
        user=user,
        is_current=True,
        tenant__is_active=True,
        tenant__is_deleted=False,
    ).first()
```

**Migración:** no requiere.

**Auth backend:** no se modifica.

### Impacto frontend

**Archivo:** `src/lib/auth-context.tsx` — función `login()` (líneas 98-142)

Agregar el `tenant_slug` al body del POST, o enviarlo como header `X-Tenant-ID`.
El `tenant_slug` se obtiene igual que en `handleGoogleSuccess` de `Login.tsx`:

```typescript
const tenantConfigRaw = localStorage.getItem(STORAGE_KEYS.TENANT_CONFIG);
const tenantSlug = (tenantConfigRaw ? JSON.parse(tenantConfigRaw)?.slug : null)
  || getCurrentTenant();

// Agregar al body:
body: JSON.stringify({ username: email, password, tenant_slug: tenantSlug })
```

**Archivo:** `src/pages/Login.tsx` — no requiere cambios si el fix está en `auth-context.tsx`.

### Impacto en tests

**Tests existentes:** verificar tests de `CustomJWTLoginView` en `apps/core/tests/`.

**Tests nuevos necesarios:**

```python
class TestLoginTenantResolution:
    def test_login_resolves_correct_tenant_by_slug(self):
        # Usuario en dos tenants — login con tenant_slug=rojo → tokens de rojo
        pass

    def test_login_fallback_to_is_current_without_slug(self):
        # Sin tenant_slug → comportamiento actual (is_current)
        pass

    def test_login_unknown_tenant_slug_returns_error(self):
        # tenant_slug que no existe → 401 o 400 con mensaje claro
        pass
```

### Riesgos

- **Staff con múltiples roles:** un `admin` que también tiene un `customer_profile` en otro tenant
  podría recibir el tenant equivocado si envía el slug incorrecto. Este es un edge case muy
  específico, cubierto por el REQ-3 (exclusividad de roles) que lo hace imposible.

- **Backwards compatibility:** el frontend de producción actual no envía `tenant_slug` en el
  login. El fallback a `is_current` mantiene el comportamiento existente sin regresiones.

- **Seguridad:** el `tenant_slug` es público (está en la URL/config del taller), no es un
  secreto. No representa una vulnerabilidad permitir filtrarlo en el login.

### Complejidad estimada

**Baja.** El cambio es pequeño: una condicional en `CustomJWTLoginView` y una línea extra en
el body del fetch del frontend. El riesgo de regresión es mínimo gracias al fallback.

### Dependencias

Ninguna. Aunque REQ-1 resuelve el problema de "mismo email en múltiples tenants", REQ-2 puede
(y debe) implementarse independientemente para cualquier usuario multi-tenant existente.

---

## REQ-3: Exclusividad de roles

### Descripción

Un `User` no puede tener roles cruzados: si tiene `customer_profile`, no puede tener
`TenantUser.role` en `['owner', 'admin', 'member']` con perfil de mecánico/asesor, y viceversa.
La tabla de verdad de roles debe estar clara y la validación debe ocurrir en el lugar correcto.

### Estado actual

**Tabla de roles actual (inferida del código):**

| Rol efectivo | Cómo se determina (en `CustomJWTLoginView`) |
|---|---|
| `owner` | `TenantUser.role == 'owner'` |
| `admin` | `TenantUser.role == 'admin'` |
| `advisor` | `TenantUser.role == 'member'` + `mechanic_profile.role == 'advisor'` |
| `mechanic` | `TenantUser.role == 'member'` + `mechanic_profile.role == 'mechanic'` |
| `customer` | `customer_profile` existe, o fallback default |

**Problema: no hay validación de exclusividad en ningún lado.**

Si un admin crea un `customer_profile` manualmente (ej: desde Django Admin), el usuario tendría
ambos perfiles. El login lo resolvería como `owner`/`admin` (porque `TenantUser.role` tiene
prioridad), pero el `customer_profile` quedaría "flotando" sin uso y podría causar bugs
en vistas de cliente.

El flujo inverso es más peligroso: si un `customer` registrado con el flujo de registro
(que crea `TenantUser(role='member')`) tiene su `TenantUser.role` cambiado a `admin` por
algún bug, de repente tiene acceso de administrador.

**Análisis de `verify_and_register` (línea 424):**

```python
customer_group, _ = Group.objects.get_or_create(name='Customers')
user.groups.add(customer_group)
```

Los grupos de Django se usan, pero no son el mecanismo de autorización principal. El rol
efectivo lo determina `CustomJWTLoginView` en runtime, no los grupos.

**¿Dónde se debe validar?**

- **Al crear un customer** (registro público): verificar que el `User` no tenga un
  `TenantUser` con `role in ['owner', 'admin']` en este tenant.
- **Al crear staff** (admin crea mecánico/asesor): verificar que el `User` no tenga
  `customer_profile` en este tenant.
- **Al promover un usuario** (cambio de rol en `TenantUser`): verificar exclusividad.

**Tabla de verdad propuesta:**

```
customer_profile EXISTS → puede tener TenantUser(role='member') solo si NO tiene mechanic_profile
mechanic_profile EXISTS → TenantUser(role='member'), NO puede tener customer_profile en mismo tenant
TenantUser(role='owner'|'admin') → NO puede tener customer_profile en ese tenant
```

Un mismo `User` puede ser `customer` en Taller Rojo y `admin` en Taller Azul — esto es válido.
La exclusividad es **por tenant**, no global.

### Impacto backend

**Archivo:** `apps/password_reset/views.py` — `verify_and_register`

Agregar validación antes de crear el `Customer`:

```python
# Si el User Django ya existe (Sub-caso A del REQ-1):
# verificar que no tenga TenantUser(role in ['owner','admin']) en este tenant
if tenant:
    conflicting_tenantuser = TenantUser.objects.filter(
        user=existing_user,
        tenant=tenant,
        role__in=['owner', 'admin']
    ).exists()
    if conflicting_tenantuser:
        return Response({'error': 'Este usuario ya tiene un rol de staff en este taller.'}, ...)
```

**Archivo:** `apps/customers/services/customer_service.py` (o donde esté `create_customer_with_user`)

Agregar validación equivalente en el servicio de creación de customers.

**Archivo:** `apps/mechanics/views.py` o donde se creen `MechanicProfile`

Agregar validación de que el `User` no tenga `customer_profile` en el mismo tenant.

**Nuevo validador reutilizable en `apps/core/validators.py` o `apps/tenants/validators.py`:**

```python
def validate_role_exclusivity(user, tenant, new_role):
    """
    Lanza ValidationError si el usuario ya tiene un rol incompatible
    con new_role en este tenant.
    """
    ...
```

**Migración:** no requiere.

### Impacto frontend

Ningún cambio requerido. Los errores de validación se devuelven como `400 Bad Request` y
ya se muestran con `toast.error` en los formularios existentes.

### Impacto en tests

**Tests nuevos necesarios:**

```python
class TestRoleExclusivity:
    def test_customer_cannot_register_if_already_admin(self):
        # User con TenantUser(role='admin') en tenant_a
        # Intentar crear customer_profile en tenant_a → debe fallar
        pass

    def test_customer_in_tenant_a_can_be_admin_in_tenant_b(self):
        # Customer en tenant_a puede ser admin en tenant_b → permitido
        pass

    def test_mechanic_profile_creation_blocked_if_customer_profile_exists(self):
        pass
```

### Riesgos

- **Datos existentes inconsistentes:** puede haber usuarios en producción con roles cruzados
  creados antes de esta validación. La implementación NO debe hacer una migración de datos
  forzada; solo prevenir nuevas inconsistencias. Para limpiar datos existentes, se necesita
  un management command separado con revisión manual.

- **Django Admin bypass:** la validación en vistas no protege contra crear roles cruzados
  directamente desde Django Admin. Considerar agregar la validación en `Customer.save()` o
  en un `pre_save` signal para cobertura total. Esto tiene más impacto pero más protección.

### Complejidad estimada

**Media.** La validación en sí es simple, pero implica tocar varios puntos de creación de
perfiles (registro de customer, creación de mecánico/asesor desde panel admin). El riesgo de
datos existentes merece atención.

### Dependencias

REQ-1 (el Sub-caso A de reuso de `auth_user` es cuando más importa esta validación de roles).

---

## REQ-4: Google signup automático — verificación post plan_07

### Descripción

Verificar que el flow de "Login con Google para usuario nuevo → creación automática de cuenta"
funciona correctamente con el aislamiento de tenant implementado en el plan_07. Documentar si
hay algo pendiente.

### Estado actual

**Archivo:** `apps/core/views.py` — `GoogleAuthView` (líneas 223-447)

**Estado del plan_07:** `Implementado ✅ — Tests pasando` (según `plan_07_google_oauth_tenant_isolation.md`)

**Verificación de la implementación actual en el código:**

El código actual en `views.py` ya refleja el fix del plan_07:

- **Línea 299:** `Customer.objects.get(google_sub=google_sub, tenant=tenant)` ← filtrado por tenant
- **Línea 311:** `Customer.objects.get(email=email, tenant=tenant)` ← filtrado por tenant
- **Línea 324-329:** Solo acepta un `DjangoUser` existente si tiene `TenantUser` en este tenant
- **Líneas 332-368:** Creación de nuevo usuario con `tenant` pasado explícitamente
- **Modelo `Customer`:** `UniqueConstraint(fields=['tenant', 'google_sub'], condition=...)` ← correcto

**La lógica de auto-creación funciona así:**

```
Google ID token válido
    ↓
Buscar Customer por google_sub en ESTE tenant → si existe: autenticar
    ↓ (no encontrado)
Buscar Customer por email en ESTE tenant → si existe: vincular google_sub + autenticar
    ↓ (no encontrado)
¿Existe DjangoUser con este email con TenantUser en este tenant? → si sí: autenticar como staff
    ↓ (no encontrado)
Crear nuevo DjangoUser + Customer(tenant=tenant) + TenantUser(tenant=tenant, role='member')
```

**Aspectos pendientes identificados:**

1. **Phone vacío en auto-creación (línea 356):** `phone=''` — el Customer creado vía Google
   no tiene teléfono. El modelo `Customer` tiene `phone = CharField(validators=[validate_phone_number])`.
   Si el validador se aplica en `full_clean()`, un string vacío podría fallar dependiendo de
   la implementación de `validate_phone_number`. Verificar que `blank=True` está en el campo.
   Actualmente en el modelo `phone` NO tiene `blank=True` (línea 79-82 de `customers/models.py`).

2. **`last_name = 'Sin apellido'` (línea 355):** si Google no provee apellido, se guarda el
   literal "Sin apellido". Esto es un dato de mala calidad en producción. Considerar `''` o `null`.

3. **Tenant_data vs tenant_user.tenant (líneas 406-427):** el bloque de resolución de rol
   post-creación busca `TenantUser` con `is_current=True`. Para usuarios recién creados, el
   `TenantUser` se crea con `is_current=True` en `get_or_create` (línea 365), pero si el
   usuario YA tiene otro `TenantUser` con `is_current=True` en otro tenant, el `save()` de
   `TenantUser` lo desactivará (líneas 341-348 de `tenants/models.py`). Esto es correcto:
   el login de Google en tenant_azul debe devolver datos de tenant_azul. Sin embargo, el
   bloque de respuesta usa `tenant_user = TenantUser.objects.filter(is_current=True).first()`
   en lugar de filtrar por el tenant específico que se usó en este request. Esto es una
   inconsistencia menor: si hay latencia entre la creación y el query, podría devolver el
   tenant equivocado en casos de race condition.

### Impacto backend

**Archivo:** `apps/core/views.py` — `GoogleAuthView`

Cambios necesarios (menores):

1. **Línea 356:** cambiar `phone=''` a verificar si el campo tiene `blank=True`. Si no, o bien
   agregar `blank=True` al modelo `Customer.phone`, o bien omitir el campo en la creación
   (ya que es `blank=True` en el modelo actualmente — verificar con `\d customers_customer`
   en psql o re-leyendo el modelo). **Nota:** en `customers/models.py` línea 79, `phone` no
   tiene `blank=True`. Esto es un bug latente que puede explotar cuando la validación de modelo
   se active.

2. **Líneas 406-427 (resolución de rol):** cambiar el filtro de `is_current=True` por
   `tenant=tenant` para garantizar consistencia:
   ```python
   tenant_user = TenantUser.objects.select_related('tenant').filter(
       user=user,
       tenant=tenant,   # ← usar el tenant resuelto al inicio del request
   ).first()
   ```

3. **`last_name='Sin apellido'`:** cambiar a `last_name=last_name or ''`.

**Migración:** posible migración para agregar `blank=True` a `Customer.phone`.

### Impacto frontend

Ninguno. El frontend ya funciona con el flow de Google en `Login.tsx` (líneas 30-101).

### Impacto en tests

Los tests del plan_07 ya cubren el caso principal. Tests adicionales para los tres puntos
pendientes:

```python
class TestGoogleAuthPendingFixes:
    def test_customer_created_with_empty_phone_via_google(self, tenant):
        # Verificar que la creación no falla con phone=''
        pass

    def test_role_resolution_uses_request_tenant_not_is_current(self, tenant_a, tenant_b):
        # Usuario autenticado en tenant_b → response.tenant debe ser tenant_b
        # aunque is_current apunte a tenant_a
        pass
```

### Riesgos

- **`phone` vacío en Customer:** si hay una migración pendiente o la validación del modelo
  se activa en algún path (ej: admin de Django), `Customer(phone='')` lanzará `ValidationError`.
  Prioridad alta para revisar antes de desplegar.

- **Race condition en resolución de rol:** menor. Solo afecaería si dos requests simultáneos
  del mismo usuario en tenants distintos ocurrieran en el mismo milisegundo.

### Complejidad estimada

**Baja.** Los tres puntos son correcciones de 1-3 líneas cada uno. La revisión de `phone`
puede requerir una migración.

### Dependencias

Depende del plan_07 (ya implementado). Sin dependencia de otros REQs de este spec.

---

## REQ-5: Eliminar botón Apple

### Descripción

En `Login.tsx` hay un botón "Continuar con Apple" decorativo (sin funcionalidad). Debe eliminarse.

### Estado actual

**Archivo:** `src/pages/Login.tsx` — líneas 221-227

```tsx
<Button variant="outline" className="w-full gap-2" type="button">
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
    <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05..." />
  </svg>
  Continuar con Apple
</Button>
```

Este botón:
- No tiene `onClick` handler
- No llama ningún API
- No tiene ninguna lógica de autenticación
- Está dentro del bloque `{!isStaffMode && (...)}` (línea 207)

### Impacto backend

Ninguno.

### Impacto frontend

**Archivo:** `src/pages/Login.tsx`

Eliminar las líneas 221-227 (el `<Button>` completo con el SVG del logo de Apple).

El `<div className="space-y-2 mb-4">` que contiene tanto el botón de Google como el de Apple
(línea 209) quedaría solo con el componente `GoogleLogin`. Posiblemente simplificar el wrapper
div eliminando el `space-y-2` si solo queda un elemento.

### Impacto en tests

Ninguno. No hay tests de UI configurados en el frontend.

### Riesgos

Ninguno. El botón es puramente decorativo.

### Complejidad estimada

**Baja.** Eliminación de 7 líneas.

### Dependencias

Ninguna. Puede implementarse de forma totalmente independiente.

---

## REQ-6: Móvil first — agregar botón login donde solo aparece "registrarse"

### Descripción

En la vista móvil del formulario de registro, hay contextos donde solo aparece el formulario
de registro pero no hay un enlace/botón visible para ir al login. Debe corregirse.

### Estado actual

**Archivo:** `src/pages/Register.tsx`

Analizando el código actual:

- En el paso `form` (líneas 192-311), hay un enlace de login al **final** del formulario
  (líneas 304-309):
  ```tsx
  <div className="text-center text-sm mt-4">
    <span className="text-muted-foreground">¿Ya tienes cuenta? </span>
    <Link to="/login" className="text-primary hover:underline font-medium">
      Inicia Sesión
    </Link>
  </div>
  ```
  Este enlace existe pero está al final del formulario, debajo de todos los campos y el botón
  submit. En móvil, para llegar a él el usuario debe hacer scroll hacia abajo.

- En el paso `code` (líneas 316-377) y `success` (líneas 382-409): no hay enlace al login.

**El problema específico en móvil:**

En pantallas pequeñas (< 640px), el formulario tiene 6 campos + botón submit + enlace.
La altura total del formulario supera la pantalla visible, y el enlace "Inicia Sesión"
queda debajo del fold. Un usuario que llega por error a /register y quiere ir a /login
no ve la opción sin hacer scroll.

**Adicionalmente:** no hay un botón/enlace de retorno al login en la **parte superior** de la
página (antes del formulario o en el header). El logo "TallerPro" no es clickeable.

### Impacto backend

Ninguno.

### Impacto frontend

**Archivo:** `src/pages/Register.tsx`

Dos cambios:

1. **Agregar enlace al login en la parte superior del Card**, en el `CardHeader`, visible antes
   de hacer scroll. Solo en el paso `form`:
   ```tsx
   <div className="text-right mb-1">
     <Link to="/login" className="text-sm text-primary hover:underline">
       ¿Ya tienes cuenta? Inicia Sesión
     </Link>
   </div>
   ```

2. El enlace existente al final del formulario (líneas 304-309) puede mantenerse o eliminarse
   para evitar duplicidad. Recomendación: mantenerlo pero solo en mobile (`sm:hidden` el de
   arriba, o hacerlos siempre visibles).

**Restricción del REQ-8:** este cambio toca layout/posicionamiento, lo cual puede combinarse
con la tarea de mejoras de estilos de REQ-8 para evitar dos pasadas sobre el mismo archivo.

### Impacto en tests

Ninguno.

### Riesgos

Ninguno. Cambio puramente aditivo de navegación.

### Complejidad estimada

**Baja.** Agregar 3-5 líneas en el componente.

### Dependencias

Puede implementarse junto con REQ-8 para eficiencia (mismo archivo, misma pasada de cambios).

---

## REQ-7: Formulario de registro con botón Google

### Descripción

El formulario de registro en `/register` debe tener un botón "Registrarse con Google" que use
el mismo flow de `GoogleAuthView`. El backend ya soporta la creación automática de cuenta
cuando el usuario no existe.

### Estado actual

**Archivo:** `src/pages/Register.tsx`

El formulario de registro actual (`step === 'form'`) no tiene ningún botón de Google. Solo
tiene el flujo de email+código+contraseña.

**Archivo:** `src/pages/Login.tsx` — líneas 30-101, 210-220

El handler `handleGoogleSuccess` en `Login.tsx` ya implementa el flow completo de Google:
- Obtiene `tenant_slug` desde localStorage
- Llama a `POST /api/auth/google/` con `id_token` y `tenant_slug`
- Guarda tokens y tenant config en localStorage
- Redirige según el rol

**Lo que se necesita en Register.tsx:**

Importar `GoogleLogin` de `@react-oauth/google` y replicar el handler `handleGoogleSuccess`
de `Login.tsx`. El comportamiento es idéntico: si el usuario no existe, el backend lo crea
automáticamente. Si ya existe, simplemente autentica.

**Consideración importante:** el botón de Google en Register debe comportarse igual que en
Login (mismo endpoint, misma lógica de redirección). La única diferencia semántica es el
texto del botón (`signup_with` vs `continue_with` en el prop `text` de `GoogleLogin`).

### Impacto backend

Ninguno. `POST /api/auth/google/` ya maneja el caso de usuario nuevo (auto-crea).
Este REQ sí depende de que REQ-4 esté resuelto (el phone vacío en Customer).

### Impacto frontend

**Archivo:** `src/pages/Register.tsx`

Cambios necesarios:

1. Importar `GoogleLogin` de `@react-oauth/google` y los helpers de tenant/auth:
   ```tsx
   import { GoogleLogin } from '@react-oauth/google';
   import { STORAGE_KEYS } from '@/lib/auth-context';
   import { setCurrentTenant, applyTenantTheme, getCurrentTenant } from '@/lib/tenant';
   import { API_URL } from '@/config';
   ```

2. Agregar estado `isGoogleLoading` y copiar `handleGoogleSuccess` de `Login.tsx`.
   La función puede extraerse a un hook compartido (ver sección de refactor).

3. Agregar el componente `GoogleLogin` en el paso `form`, antes del formulario de email:
   ```tsx
   {step === 'form' && (
     <>
       <div className="mb-4">
         <GoogleLogin
           onSuccess={handleGoogleSuccess}
           onError={() => toast.error('Error al registrarse con Google')}
           text="signup_with"
           width="368"
           shape="rectangular"
         />
       </div>
       <div className="relative mb-4">
         {/* separador "o con email" */}
       </div>
       {/* formulario existente */}
     </>
   )}
   ```

**Oportunidad de refactor (recomendada):**

Extraer `handleGoogleSuccess` a un hook reutilizable:
`src/hooks/useGoogleAuth.ts`

```typescript
export function useGoogleAuth() {
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);

  const handleGoogleSuccess = async (credentialResponse: { credential?: string }) => {
    // ... lógica actual de Login.tsx líneas 30-101
  };

  return { handleGoogleSuccess, isGoogleLoading };
}
```

Esto evita duplicar ~70 líneas de lógica y centraliza el comportamiento.

**Archivos afectados:**
- `src/pages/Register.tsx` — consumidor del hook
- `src/pages/Login.tsx` — refactorizar para usar el mismo hook (opcional pero recomendado)
- `src/hooks/useGoogleAuth.ts` — nuevo archivo

### Impacto en tests

Ninguno (no hay framework de tests en frontend).

### Riesgos

- **Duplicación de código:** si NO se extrae el hook y se copia el handler, cualquier cambio
  futuro en el flow de Google debe hacerse en dos lugares.
- **`phone` vacío en Customer creado vía Google:** el REQ-4 identifica que `Customer.phone`
  no tiene `blank=True`. Si se implementa REQ-7 sin resolver REQ-4, los usuarios que se
  registren vía Google en Register podrían encontrar errores en flujos posteriores que
  requieran teléfono.

### Complejidad estimada

**Baja-Media.** Si se incluye el refactor del hook: Media. Si se copia el handler: Baja pero
con deuda técnica.

### Dependencias

- REQ-4 (fix de `Customer.phone` blank + resolución de rol en GoogleAuthView): implementar antes
  para evitar bugs en producción.
- REQ-5 (eliminar Apple): implementar junto o antes, ya que ambos modifican secciones de
  social login.

---

## REQ-8: Mejorar estilos — mobile-first, profesional, adictivo

### Descripción

Mejoras de UI/UX en las pantallas de login y registro. Prioridad absoluta: mobile-first.
Restricción estricta: NO modificar handlers, hooks, llamadas API, ni lógica de storage.
Solo estilos: colores, spacing, tipografía, animaciones, layout.

### Estado actual

**Archivos:**
- `src/pages/Login.tsx` (417 líneas)
- `src/pages/Register.tsx` (419 líneas)

**Login.tsx — análisis de estado visual:**

El login tiene dos modos: cliente (default) y staff (`isStaffMode`). El modo cliente muestra
Google + email/password. El modo staff usa tema oscuro (`bg-slate-900`).

Aspectos mejorables:

1. **Contenedor:** `max-w-md` con `p-4`. En móvil (< 640px) el card ocupa casi todo el ancho.
   En pantallas de 375px, el padding interno del Card puede ser insuficiente.

2. **Botón Google (`GoogleLogin`):** el componente de `@react-oauth/google` genera un iframe
   de ancho fijo (`width="368"`). En pantallas < 375px este ancho desborda. Considerar
   `width="320"` o usar el wrapper con `overflow-hidden`.

3. **Separador "o con email":** funcional pero básico. El `bg-card` del span puede no ser
   correcto en dark mode.

4. **Espaciado:** los `space-y-4` son funcionales pero en móvil el formulario puede sentirse
   comprimido. Considerar `space-y-3` en móvil y `space-y-4` en desktop.

5. **Botón de toggle staff/customer (líneas 391-406):** link de texto al fondo de la página.
   En móvil puede ser difícil de encontrar. Considerar moverlo más cerca del formulario.

6. **Animación `animate-slide-up`:** ya existe pero revisar que esté definida en `index.css`.

**Register.tsx — análisis de estado visual:**

1. **Logo repetido:** tanto Login como Register tienen el mismo bloque de logo (líneas 149-157
   en Register, 174-189 en Login). Ligeras diferencias de estilo entre ambos.

2. **Grid de nombre/apellido (línea 201):** `grid-cols-2 gap-4`. En móvil < 375px los campos
   son muy estrechos. Considerar `sm:grid-cols-2 grid-cols-1` para stacking en móvil pequeño.

3. **Indicadores de paso:** no hay ningún indicador visual de en qué paso del flujo está el
   usuario (form / code / success). Un stepper visual mejoraría la UX.

4. **Transiciones entre pasos:** no hay animación al cambiar entre `step === 'form'` y
   `step === 'code'`. Un fade o slide suave mejoraría la percepción.

5. **Estado de éxito (líneas 382-409):** usa colores hardcodeados de Tailwind (`bg-green-100`,
   `text-green-600`, `text-gray-900`) que no respetan el tema del tenant ni el dark/light mode.

**Restricción importante (del enunciado):**

No modificar:
- `handleSendCode`, `handleVerifyAndRegister` en Register.tsx
- `handleSubmit`, `handleGoogleSuccess` en Login.tsx
- Cualquier llamada a `login()`, `register()`, `getCurrentTenant()`
- Lógica de localStorage

Solo se pueden modificar: clases Tailwind, estructura HTML de presentación, imports de iconos,
textos de labels/placeholders.

### Impacto backend

Ninguno.

### Impacto frontend

**Archivo:** `src/pages/Login.tsx`

Cambios de estilo permitidos:
- Ajustar `width` del `GoogleLogin` para responsive
- Corregir `bg-card` del separador a `bg-background` para consistencia en dark mode
- Mejorar espaciado mobile con clases responsive
- Opcional: agregar `transition-all` al Card para el toggle staff/customer
- Mover o hacer más visible el toggle staff/customer en móvil

**Archivo:** `src/pages/Register.tsx`

Cambios de estilo permitidos:
- Cambiar `grid-cols-2` a `grid-cols-1 sm:grid-cols-2` para nombre/apellido en móvil
- Agregar un indicador de paso (stepper) puramente visual con clases Tailwind
- Agregar `transition-opacity` o `animate-fade-in` a los contenedores de cada paso
- Reemplazar colores hardcodeados en el estado de éxito por variables CSS del tema
- Mejorar el `PhoneInput` para que sea consistente con el resto de inputs

**Nota sobre ROI:** REQ-8 tiene el menor impacto funcional pero el mayor impacto perceptivo
para los usuarios finales. Se recomienda implementarlo como la última tarea, consolidando
también los cambios de REQ-5, REQ-6 y REQ-7 en una misma pasada de estilo.

### Impacto en tests

Ninguno.

### Riesgos

- **Clases Tailwind no purgeadas:** si se agregan clases nuevas que no existen en ningún
  otro archivo, Tailwind las incluirá solo si están en el whitelist de `safelist` o son
  detectadas por el content scanner. Usar solo clases estándar de Tailwind.

- **`@react-oauth/google` renderiza un iframe:** el botón de Google no puede ser estilado
  con Tailwind directamente. El wrapper div controla el tamaño externo, pero el botón
  interno es controlado por Google. Considerar este límite al planear el layout.

- **Dark mode y clases hardcodeadas:** `bg-green-100`/`text-green-600` en el estado de
  éxito no tienen variante dark. Si el sistema tiene dark mode, estos colores se verán
  incorrectos en modo oscuro.

### Complejidad estimada

**Baja-Media.** Muchos cambios pequeños de CSS, pero requieren revisión en múltiples puntos
del componente. El riesgo principal es romper el layout en algún viewport específico.

### Dependencias

- REQ-5: implementar primero (elimina el botón Apple, simplifica el bloque de social login)
- REQ-6: puede hacerse junto (misma pasada en Register.tsx)
- REQ-7: puede hacerse junto (agrega el bloque de Google en Register.tsx)

Recomendación: implementar REQ-5, REQ-6, REQ-7 primero, luego REQ-8 como pasada final de
estilo sobre los archivos ya modificados.

---

## Tabla resumen

| REQ | Título | Complejidad | Backend | Frontend | Tests nuevos | Dependencias |
|-----|--------|-------------|---------|----------|--------------|--------------|
| REQ-1 | Registro: unicidad por tenant | Media | `password_reset/views.py` | Ninguno | Sí (4 tests) | Ninguna |
| REQ-2 | Login: resolución por tenant | Baja | `core/views.py` | `lib/auth-context.tsx` | Sí (3 tests) | Ninguna |
| REQ-3 | Exclusividad de roles | Media | `password_reset/views.py`, `core/validators.py` | Ninguno | Sí (3 tests) | REQ-1 |
| REQ-4 | Google signup: verificación plan_07 | Baja | `core/views.py`, `customers/models.py` | Ninguno | Sí (2 tests) | — |
| REQ-5 | Eliminar botón Apple | Baja | Ninguno | `pages/Login.tsx` | No | Ninguna |
| REQ-6 | Móvil: botón login en registro | Baja | Ninguno | `pages/Register.tsx` | No | REQ-8 (opcional, para eficiencia) |
| REQ-7 | Google en formulario de registro | Baja-Media | Ninguno | `pages/Register.tsx`, `hooks/useGoogleAuth.ts` | No | REQ-4, REQ-5 |
| REQ-8 | Estilos mobile-first | Baja-Media | Ninguno | `pages/Login.tsx`, `pages/Register.tsx` | No | REQ-5, REQ-6, REQ-7 |

---

## Orden de implementación recomendado

### Fase 1 — Backend: correcciones críticas (sin dependencias entre ellas)

**Paso 1.1 — REQ-4: Fixes menores en GoogleAuthView**

Archivos: `apps/core/views.py`, `apps/customers/models.py`

Cambios:
- `Customer.phone`: agregar `blank=True` al campo en el modelo → migración
- `GoogleAuthView`: cambiar `last_name=last_name or ''`
- `GoogleAuthView`: cambiar resolución de rol de `is_current=True` a `tenant=tenant`
- Tests: 2 tests nuevos

Checkpoint: `pytest apps/core/tests/ -v` + `pytest apps/customers/tests/ -v` deben pasar.

**Paso 1.2 — REQ-1: Registro con unicidad por tenant**

Archivos: `apps/password_reset/views.py`

Cambios:
- Eliminar verificación global `User.objects.filter(email=email).exists()`
- Implementar lógica de tres sub-casos en `verify_and_register`
- Tests: 4 tests nuevos

Checkpoint: `pytest apps/password_reset/tests/ -v` debe pasar.

**Paso 1.3 — REQ-2: Login con resolución por tenant**

Archivos: `apps/core/views.py` (`CustomJWTLoginView`)

Cambios:
- Leer `tenant_slug` del body o del header
- Filtrar `TenantUser` por `tenant__slug=tenant_slug` cuando está disponible
- Mantener fallback a `is_current=True`
- Tests: 3 tests nuevos

Checkpoint: `pytest apps/core/tests/ -v` debe pasar.

**Paso 1.4 — REQ-3: Exclusividad de roles**

Archivos: `apps/password_reset/views.py`, nuevo `apps/core/role_validators.py` o similar

Cambios:
- Validador reutilizable `validate_role_exclusivity(user, tenant, new_role)`
- Llamar al validador en `verify_and_register` (Sub-caso A del REQ-1)
- Tests: 3 tests nuevos

Checkpoint: `pytest -m "unit or api" -v` debe pasar.

### Fase 2 — Frontend: UI sin tocar lógica

**Paso 2.1 — REQ-5: Eliminar botón Apple**

Archivo: `src/pages/Login.tsx`
Cambio: eliminar 7 líneas.
Checkpoint: visual en navegador — botón Apple no debe aparecer.

**Paso 2.2 — REQ-6: Botón login en vista de registro**

Archivo: `src/pages/Register.tsx`
Cambio: agregar enlace en la parte superior del Card.
Checkpoint: en móvil (DevTools 375px), el enlace "Iniciar Sesión" debe ser visible sin scroll.

**Paso 2.3 — REQ-7: Google en registro**

Archivos: `src/hooks/useGoogleAuth.ts` (nuevo), `src/pages/Register.tsx`, `src/pages/Login.tsx`

Cambios:
- Extraer `handleGoogleSuccess` a `useGoogleAuth.ts`
- Actualizar `Login.tsx` para usar el hook
- Agregar `GoogleLogin` en `Register.tsx` (paso `form`)

Checkpoint: en `/register`, el botón de Google debe aparecer. Flujo de "registrarse con Google"
debe crear la cuenta y redirigir a `/customer`.

**Paso 2.4 — REQ-2 frontend: tenant_slug en login**

Archivo: `src/lib/auth-context.tsx`
Cambio: agregar `tenant_slug` al body del fetch de login.
Checkpoint: en un taller con tenant_slug configurado, el login debe devolver el tenant correcto.

### Fase 3 — Polish de UI

**Paso 3.1 — REQ-8: Estilos mobile-first**

Archivos: `src/pages/Login.tsx`, `src/pages/Register.tsx`

Cambios de estilo consolidados sobre los archivos ya modificados en Fase 2.
Checkpoint: revisión visual en viewport 375px, 430px, 768px, 1280px.

---

## Archivos a crear/modificar

### Backend

| Archivo | Acción | REQs |
|---------|--------|------|
| `apps/customers/models.py` | Modificar: `Customer.phone` agregar `blank=True` | REQ-4 |
| `apps/customers/migrations/XXXX_phone_blank.py` | Crear: migración para phone blank | REQ-4 |
| `apps/core/views.py` | Modificar: `GoogleAuthView` (3 fixes) + `CustomJWTLoginView` (tenant_slug) | REQ-2, REQ-4 |
| `apps/password_reset/views.py` | Modificar: `send_registration_code` + `verify_and_register` | REQ-1, REQ-3 |
| `apps/core/role_validators.py` | Crear: función `validate_role_exclusivity` | REQ-3 |
| `apps/core/tests/test_login_tenant.py` | Crear: tests de login por tenant | REQ-2 |
| `apps/core/tests/test_google_auth.py` | Crear: tests complementarios Google | REQ-4 |
| `apps/password_reset/tests/test_registration.py` | Crear: tests de registro multi-tenant | REQ-1, REQ-3 |

### Frontend

| Archivo | Acción | REQs |
|---------|--------|------|
| `src/pages/Login.tsx` | Modificar: eliminar Apple, refactorizar a useGoogleAuth, estilos | REQ-5, REQ-7, REQ-8 |
| `src/pages/Register.tsx` | Modificar: agregar botón login, agregar Google, estilos | REQ-6, REQ-7, REQ-8 |
| `src/lib/auth-context.tsx` | Modificar: agregar `tenant_slug` en `login()` | REQ-2 |
| `src/hooks/useGoogleAuth.ts` | Crear: hook reutilizable para Google OAuth | REQ-7 |

---

## Notas de implementación transversales

### Sobre la arquitectura de `auth_user` compartido (REQ-1 y REQ-3)

El sistema Django usa `auth_user` como tabla global. En multi-tenant puro, lo correcto es que
un mismo `auth_user` pueda tener perfiles en múltiples tenants. El REQ-1 formaliza este
comportamiento para el flujo de registro. Cualquier cambio debe respetar que:

- `User.email` es único en `auth_user` (restricción de Django).
- `Customer.email` + `Customer.tenant` es único (ya configurado con `unique_together`).
- El mismo `User` puede tener múltiples `Customer` en múltiples tenants.
- El mismo `User` NO puede tener un `Customer` y un `TenantUser(role='admin')` en el MISMO tenant.

### Sobre el `api.register()` en `auth-context.tsx`

La función `register` en `auth-context.tsx` (líneas 186-201) llama a `api.register()` de
`src/lib/api.ts`. Este endpoint sería `POST /api/auth/register/` (el `CustomerRegistrationView`
en `apps/customers/urls.py`). Sin embargo, `Register.tsx` NO usa `useAuth().register()` — llama
directamente a los endpoints de `send-registration-code` y `verify-and-register`. El `api.register()`
en `api.ts` parece ser el endpoint antiguo (pre-verificación por email) y puede estar obsoleto.

No es necesario modificarlo para este spec, pero se recomienda documentarlo o eliminarlo en
un cleanup posterior para evitar confusión.

### Sobre los grupos de Django (`Customers`, `Admins`, etc.)

Los grupos existen pero el mecanismo de autorización principal es la combinación
`TenantUser.role` + `mechanic_profile`/`customer_profile`. Los grupos se usan en `verify_and_register`
(líneas 424-426) pero no son consultados en `CustomJWTLoginView` ni en `TenantModelMixin`.
Este desacoplamiento es una deuda técnica existente que no se aborda en este spec.
