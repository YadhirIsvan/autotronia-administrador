# spec_08 — Auth Multi-tenant + Branding Autotronia + UI Mobile-First

**Estado:** Implementación completa ✅ — 56/56 tests pasan — Pendiente: prueba E2E
**Fecha:** 2026-03-17
**Referencia previa:** `spec_08_auth_register_ui.md` (análisis de impacto), `plan_07_google_oauth_tenant_isolation.md`

---

## 1. Resumen ejecutivo

Este plan implementa 8 requerimientos agrupados en tres fases independientes pero coordinadas:

- **Fase 1 (Backend):** Corregir la lógica de unicidad de email en el flujo de registro para que soporte la decisión de "auth_user compartido" (REQ-1), verificar que el login JWT resuelve el tenant correctamente con un único auth_user (REQ-2), y agregar validación de exclusividad de roles customer vs staff (REQ-3).
- **Fase 2 (Frontend - lógica):** Eliminar el botón Apple (REQ-5), agregar enlace de login en la vista de registro (REQ-6), agregar `GoogleLogin` al formulario de registro (REQ-7). REQ-4 se documenta como validado sin cambios.
- **Fase 3 (Frontend - branding y estilos):** Reemplazar marca "TallerPro" por "Autotronia", usar el logo `public/autotronia-logo.png`, actualizar copyright, y aplicar estilos mobile-first con paleta teal (REQ-8).

Las fases 1 y 2 pueden ejecutarse en paralelo. La fase 3 puede iniciar en cualquier momento.

---

## 2. Decisiones de diseño (ya tomadas)

| Decisión | Descripción |
|----------|-------------|
| `auth_user` compartido (Opción 3) | Un email = un `auth_user` en todo el sistema. Si el email ya existe en otro tenant, se reutiliza sin crear nueva contraseña. El frontend detecta `existing_user: true` y muestra mensaje explicativo. |
| Branding | "TallerPro" → "Autotronia". Logo en `public/autotronia-logo.png`. Paleta teal (#0891b2 → #06b6d4). |
| Google OAuth | Implementado en plan_07. No requiere cambios de backend. |

---

## 3. Análisis de estado actual

### REQ-1: Registro con email — unicidad por tenant

**Estado actual del backend:**

- `send_registration_code` (archivo: `apps/password_reset/views.py`, línea 210):
  - Línea 234: `if User.objects.filter(email=email).exists()` — bloquea el registro si el `auth_user` ya existe en **cualquier** tenant. Esto contradice la decisión "Opción 3".
  - Línea 241-252: verifica `Customer.objects.filter(email=email, tenant=tenant)` — correcto.

- `verify_and_register` (mismo archivo, línea 319):
  - Línea 378: `if User.objects.filter(email=email).exists()` — mismo problema. Bloquea el registro aunque el usuario quiera unirse a un nuevo tenant.
  - Línea 399-408: verifica Customer por tenant — correcto.
  - Línea 415: `User.objects.create_user(...)` — crea un nuevo `auth_user`, lo cual también es incorrecto en Opción 3 si el email ya existe.

**Gap:** Ambas funciones deben cambiarse para distinguir dos casos:
1. El email existe como `Customer` en **este** tenant → error "ya registrado en este taller".
2. El email existe como `auth_user` pero **no** como `Customer` en este tenant → responder `{"existing_user": true}` en `send_registration_code` y vincular al `auth_user` existente en `verify_and_register`.

**Frontend Register.tsx (línea 86):**
- Solo espera `response.ok` o `data.error`. No maneja `existing_user: true` aún.

---

### REQ-2: Login con email — resolución por tenant

**Estado actual:**

`CustomJWTLoginView` (archivo: `apps/core/views.py`, línea 66):
- Línea 105: `authenticate(request, username=username, password=password)` — usa `EmailBackend`, que hace `User.objects.get(email=email)`. Con Opción 3 (un solo `auth_user` por email), esto funciona correctamente.
- Línea 143-148: busca `TenantUser` con `is_current=True`. Si el usuario pertenece a múltiples tenants, devuelve el tenant marcado como activo.

**Gap menor:** Si un usuario tiene `is_current=True` en un tenant distinto al que intenta acceder, el login devuelve datos del tenant incorrecto. Esto ocurre cuando el frontend no envía `X-Tenant-ID` al login. La corrección es preferir el tenant que coincide con `X-Tenant-ID` del request.

**Estado:** Funciona en el caso normal (un usuario = un tenant). Necesita ajuste defensivo para usuarios multi-tenant.

---

### REQ-3: Exclusividad de roles (customer vs staff)

**Estado actual:** No existe ninguna validación.

- `Customer.user` es `OneToOneField` → un `User` no puede tener dos `Customer` profiles.
- `TenantUser.role` puede ser `owner`, `admin`, o `member` (donde `member` puede ser mechanic o advisor según `mechanic_profile`).
- No hay validación que impida crear un `Customer` para un `User` que ya tiene `TenantUser` con rol staff, ni viceversa.

**Archivos relevantes:**
- `apps/customers/models.py` — modelo `Customer`
- `apps/tenants/models.py` — modelo `TenantUser`
- `apps/customers/serializers.py` — `CustomerCreateSerializer`

---

### REQ-4: Google signup automático

**Estado:** Validado. `GoogleAuthView` en `apps/core/views.py` línea 223 ya implementa el flujo completo post plan_07:
- Busca por `google_sub` en el tenant (línea 299).
- Busca por email en el tenant (línea 307-329).
- Si no existe → crea `User` + `Customer` + `TenantUser(role='member')` (líneas 333-368).

**Sin cambios necesarios en backend.**

---

### REQ-5: Eliminar botón Apple

**Archivo:** `front-end-taller-pro/src/pages/Login.tsx`

Líneas 221-227 (bloque completo a eliminar):
```tsx
<Button variant="outline" className="w-full gap-2" type="button">
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
    <path d="M18.71 19.5c-.83..."/>
  </svg>
  Continuar con Apple
</Button>
```

---

### REQ-6: Botón login en vista de registro

**Archivo:** `front-end-taller-pro/src/pages/Register.tsx`

- En `step === 'form'`: ya existe enlace en línea 304-309 (`¿Ya tienes cuenta? Inicia Sesión`). Está correcto pero no es visible en mobile porque está al final del form y requiere scroll.
- **Gap:** En mobile, el enlace necesita estar también en la parte superior de la card (antes del formulario), visible sin scroll.

---

### REQ-7: Botón Google en formulario de registro

**Archivo:** `front-end-taller-pro/src/pages/Register.tsx`

- No existe `GoogleLogin` en Register.tsx.
- El `handleGoogleSuccess` completo existe en `Login.tsx` (líneas 30-101) y debe replicarse en Register.tsx.
- El backend ya soporta el flujo: `GoogleAuthView` crea el Customer si no existe.

---

### REQ-8: Branding + estilos

**Archivos con "TallerPro" / "Taller Pro":**
- `front-end-taller-pro/src/pages/Login.tsx` — línea 187 (`TallerPro`), línea 412 (copyright)
- `front-end-taller-pro/src/pages/Register.tsx` — línea 155 (`TallerPro`), línea 414 (copyright)

**Logo actual:** Ícono `<Wrench>` + texto hardcodeado (`Login.tsx:183`, `Register.tsx:152-156`). Debe reemplazarse con `<img src="/autotronia-logo.png">`.

---

## 4. Plan de implementación

### Fase 1 — Backend (REQ-1, REQ-2, REQ-3)

**Puede ejecutarse en paralelo con Fase 2.**

---

#### PASO 1.1 — Corregir `send_registration_code` para soportar Opción 3

**Archivo:** `apps/password_reset/views.py`

**Objetivo:** En lugar de bloquear cuando el `auth_user` ya existe, distinguir los dos sub-casos.

Reemplazar el bloque de validación actual (líneas 233-252) con la siguiente lógica:

```python
# apps/password_reset/views.py — función send_registration_code

# Obtener tenant del request
tenant_slug = request.headers.get('X-Tenant-ID')
tenant = None
if tenant_slug:
    try:
        from apps.tenants.models import Tenant
        tenant = Tenant.objects.get(slug=tenant_slug, is_active=True, is_deleted=False)
    except Tenant.DoesNotExist:
        pass

# Caso A: El email ya existe como Customer en ESTE tenant → error definitivo
if tenant and Customer.objects.filter(email=email, tenant=tenant).exists():
    return Response(
        {'error': 'Ya existe una cuenta con este email en este taller. Inicia sesión o recupera tu contraseña.'},
        status=status.HTTP_400_BAD_REQUEST
    )

# Caso B: El auth_user existe pero NO como Customer en este tenant (Opción 3)
# → informar al frontend para que redirija al login
existing_user_flag = False
if User.objects.filter(email=email).exists():
    existing_user_flag = True
    # Guardar el flag en cache para que verify_and_register lo use
    from django.core.cache import cache
    cache.set(f'registration_code_{email}', {
        'code': None,  # Sin código: no se necesita crear cuenta nueva
        'existing_user': True,
        'expires_at': (timezone.now() + timedelta(minutes=15)).isoformat(),
        'first_name': first_name,
        'last_name': last_name,
    }, timeout=900)
    return Response(
        {
            'existing_user': True,
            'message': 'Ya tienes cuenta en Autotronia. Inicia sesión con tu contraseña existente para acceder a este taller.'
        },
        status=status.HTTP_200_OK
    )

# Caso C: Email completamente nuevo → flujo normal (código de verificación)
# ... resto del código existente sin cambios ...
```

**Nota importante:** La respuesta usa `HTTP_200_OK` con `existing_user: true` para que el frontend lo detecte sin tratarlo como error HTTP.

---

#### PASO 1.2 — Corregir `verify_and_register` para Opción 3

**Archivo:** `apps/password_reset/views.py`

**Objetivo:** Si el email ya tiene `auth_user`, vincular ese usuario al nuevo tenant en lugar de crear uno nuevo.

Reemplazar el bloque de creación de cuenta (líneas 377-468) con la siguiente lógica:

```python
# apps/password_reset/views.py — función verify_and_register

# Verificar código en cache (mismo que antes)
from django.core.cache import cache
cache_key = f'registration_code_{email}'
cached_data = cache.get(cache_key)

if not cached_data:
    return Response({'error': 'Código expirado. Solicita uno nuevo.'}, status=400)

# Si es usuario existente, el frontend no debería llamar a este endpoint
# (debería redirigir al login). Pero por seguridad, rechazarlo aquí.
if cached_data.get('existing_user'):
    return Response(
        {'error': 'Este email ya tiene cuenta. Por favor inicia sesión.'},
        status=status.HTTP_400_BAD_REQUEST
    )

if cached_data['code'] != code:
    return Response({'error': 'Código inválido'}, status=400)

# Verificar expiración (mismo que antes)
...

# Obtener tenant
tenant = None
tenant_slug = request.headers.get('X-Tenant-ID')
if tenant_slug:
    try:
        from apps.tenants.models import Tenant
        tenant = Tenant.objects.get(slug=tenant_slug, is_active=True, is_deleted=False)
    except Tenant.DoesNotExist:
        pass

# Verificar que no exista Customer en este tenant
if tenant and Customer.objects.filter(email=email, tenant=tenant).exists():
    cache.delete(cache_key)
    return Response(
        {'error': 'Ya existe una cuenta con este email en este taller.'},
        status=status.HTTP_400_BAD_REQUEST
    )

try:
    with transaction.atomic():
        # OPCIÓN 3: Reutilizar auth_user si ya existe
        existing_django_user = User.objects.filter(email=email).first()

        if existing_django_user:
            user = existing_django_user
            # Actualizar nombre si estaba vacío
            if not user.first_name and first_name:
                user.first_name = first_name
                user.last_name = last_name
                user.save(update_fields=['first_name', 'last_name'])
        else:
            user = User.objects.create_user(
                username=email,
                email=email,
                password=password,
                first_name=first_name,
                last_name=last_name,
            )
            from django.contrib.auth.models import Group
            customer_group, _ = Group.objects.get_or_create(name='Customers')
            user.groups.add(customer_group)

        # Crear Customer en este tenant (siempre es nuevo aquí, ya verificamos arriba)
        customer = Customer.objects.create(
            user=user,
            tenant=tenant,
            first_name=first_name,
            last_name=last_name,
            phone=phone or '',
            email=email,
        )

        # Crear TenantUser si existe tenant
        if tenant:
            from apps.tenants.models import TenantUser
            TenantUser.objects.get_or_create(
                user=user,
                tenant=tenant,
                defaults={'is_current': True, 'role': 'member'}
            )

        cache.delete(cache_key)

        response_data = {
            'message': 'Cuenta creada exitosamente',
            'user_id': user.id,
            'customer_id': customer.id,
        }
        if tenant:
            response_data['tenant'] = {'id': tenant.id, 'name': tenant.name, 'slug': tenant.slug}

        return Response(response_data, status=status.HTTP_201_CREATED)

except Exception as e:
    ...
```

---

#### PASO 1.3 — Ajuste defensivo en `CustomJWTLoginView` para multi-tenant

**Archivo:** `apps/core/views.py`

**Objetivo:** Cuando el request incluye `X-Tenant-ID`, preferir el `TenantUser` de ese tenant sobre el marcado como `is_current`.

Modificar la consulta de `TenantUser` (línea 143) para agregar preferencia por tenant del request:

```python
# apps/core/views.py — CustomJWTLoginView.post()

# Reemplazar líneas 141-148:
try:
    from apps.tenants.models import TenantUser

    # Preferir el tenant del request (X-Tenant-ID) si está presente
    request_tenant_slug = request.headers.get('X-Tenant-ID', '').strip()

    tenant_user = None
    if request_tenant_slug:
        tenant_user = TenantUser.objects.select_related('tenant').filter(
            user=user,
            tenant__slug=request_tenant_slug,
            tenant__is_active=True,
            tenant__is_deleted=False,
        ).first()

    # Fallback: usar el marcado como is_current
    if not tenant_user:
        tenant_user = TenantUser.objects.select_related('tenant').filter(
            user=user,
            is_current=True,
            tenant__is_active=True,
            tenant__is_deleted=False,
        ).first()

    if tenant_user:
        tenant = tenant_user.tenant
        # ... resto igual ...
```

---

#### PASO 1.4 — Validación de exclusividad de roles (REQ-3)

**Estrategia:** Validar en dos capas — serializer de Customer y serializer/view de TenantUser.

**Capa 1: Validación al crear Customer**

Archivo: `apps/customers/serializers.py` — clase `CustomerCreateSerializer`, método `validate`:

```python
# apps/customers/serializers.py

def validate(self, data):
    user = data.get('user')
    tenant = data.get('tenant') or self.context.get('tenant')

    if user:
        # Verificar que el user no sea staff en este tenant
        from apps.tenants.models import TenantUser
        staff_roles = ['owner', 'admin']
        is_staff = TenantUser.objects.filter(
            user=user,
            tenant=tenant,
            role__in=staff_roles,
        ).exists()
        if is_staff:
            raise serializers.ValidationError(
                {'user': 'Este usuario es staff de este taller y no puede ser registrado como cliente.'}
            )

        # Verificar que no tenga mechanic_profile en este tenant
        if hasattr(user, 'mechanic_profile') and user.mechanic_profile:
            from apps.tenants.models import TenantUser
            is_mechanic = TenantUser.objects.filter(
                user=user,
                tenant=tenant,
                role='member',
            ).exists()
            if is_mechanic:
                raise serializers.ValidationError(
                    {'user': 'Este usuario tiene perfil de mecánico en este taller.'}
                )

    return data
```

**Capa 2: Validación al crear TenantUser con rol staff**

Archivo: `apps/tenants/serializers.py` (o crear si no existe) — al crear un `TenantUser` con `role` en `['owner', 'admin', 'member']` donde el user ya tiene `customer_profile` en el mismo tenant:

```python
# apps/tenants/serializers.py — TenantUserCreateSerializer

def validate(self, data):
    user = data.get('user')
    tenant = data.get('tenant')
    role = data.get('role', 'member')

    if user and tenant:
        from apps.customers.models import Customer
        has_customer_profile = Customer.objects.filter(
            user=user,
            tenant=tenant,
            is_deleted=False,
        ).exists()
        if has_customer_profile:
            raise serializers.ValidationError(
                {'user': 'Este usuario ya tiene perfil de cliente en este taller. No puede ser también personal.'}
            )

    return data
```

**Capa 3: Validación en `verify_and_register`**

En `apps/password_reset/views.py`, función `verify_and_register`, agregar antes de crear el Customer:

```python
# Verificar exclusividad de roles: el user no debe ser staff en este tenant
if tenant and existing_django_user:
    from apps.tenants.models import TenantUser
    is_staff = TenantUser.objects.filter(
        user=existing_django_user,
        tenant=tenant,
        role__in=['owner', 'admin'],
    ).exists()
    if is_staff:
        cache.delete(cache_key)
        return Response(
            {'error': 'Este email pertenece a un miembro del personal. No puede registrarse como cliente.'},
            status=status.HTTP_400_BAD_REQUEST
        )
```

### Verificación Fase 1

```bash
# Dentro del container backend
docker compose -f docker-compose.dev.yml exec web python manage.py shell -c "
from apps.password_reset.views import send_registration_code, verify_and_register
from django.test import RequestFactory
from unittest.mock import MagicMock

# Test REQ-1: email existente en otro tenant → debe retornar existing_user: true
from django.contrib.auth.models import User
u = User.objects.filter(email='test@example.com').first()
print('User exists:', u is not None)
"

# Test unitario directo
docker compose -f docker-compose.dev.yml exec web pytest apps/password_reset/tests.py -v -k "registration"
```

---

### Fase 2 — Frontend UI lógica (REQ-4 validado, REQ-5, REQ-6, REQ-7)

**Puede ejecutarse en paralelo con Fase 1.**

---

#### PASO 2.1 — Eliminar botón Apple (REQ-5)

**Archivo:** `front-end-taller-pro/src/pages/Login.tsx`

Eliminar completamente las líneas 221-227:

```tsx
// ELIMINAR este bloque entero:
<Button variant="outline" className="w-full gap-2" type="button">
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
    <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>
  </svg>
  Continuar con Apple
</Button>
```

El bloque `<div className="space-y-2 mb-4">` quedará solo con el `GoogleLogin`. Verificar que el `</div>` de cierre no deje estructura rota.

### Verificación PASO 2.1

```bash
# Build sin errores TS
cd front-end-taller-pro && npm run build 2>&1 | grep -E "(error|Error)" | head -20
```

---

#### PASO 2.2 — Manejo de `existing_user: true` en Register.tsx (REQ-1 frontend)

**Archivo:** `front-end-taller-pro/src/pages/Register.tsx`

Agregar estado para manejar la respuesta del backend:

```tsx
// Agregar junto a los otros useState (después de línea 29):
const [existingUserEmail, setExistingUserEmail] = useState('');
```

Modificar `handleSendCode` para detectar `existing_user: true` (dentro del bloque `if (response.ok)`, línea 82):

```tsx
if (response.ok) {
  // NUEVO: Detectar usuario existente en otro tenant
  if (data.existing_user) {
    setExistingUserEmail(formData.email);
    setStep('existing_user' as Step);  // nuevo step
    return;
  }
  toast.success('Código enviado. Revisa tu email.');
  setStep('code');
}
```

Actualizar el tipo de `Step`:

```tsx
// Línea 22 — cambiar:
type Step = 'form' | 'code' | 'success' | 'existing_user';
```

Agregar el renderizado del nuevo step (después del bloque `step === 'success'`, antes del cierre de `<CardContent>`):

```tsx
{step === 'existing_user' && (
  <div className="space-y-6 text-center py-6">
    <div className="flex justify-center">
      <div className="bg-blue-100 p-4 rounded-full">
        <Mail className="h-12 w-12 text-blue-600" />
      </div>
    </div>
    <div>
      <h3 className="text-lg font-semibold mb-2">Ya tienes cuenta en Autotronia</h3>
      <p className="text-muted-foreground text-sm mb-1">
        El email <strong>{existingUserEmail}</strong> ya está registrado.
      </p>
      <p className="text-muted-foreground text-sm">
        Usa tu contraseña existente para acceder a este taller.
      </p>
    </div>
    <div className="space-y-3">
      <Button
        onClick={() => navigate('/login')}
        className="w-full"
      >
        Ir a Iniciar Sesión
      </Button>
      <Button
        variant="ghost"
        onClick={() => { setStep('form'); setExistingUserEmail(''); }}
        className="w-full"
      >
        Usar otro email
      </Button>
    </div>
  </div>
)}
```

---

#### PASO 2.3 — Botón login visible en mobile (REQ-6)

**Archivo:** `front-end-taller-pro/src/pages/Register.tsx`

El enlace actual (líneas 304-309) está al final del form. Para mobile, agregar un segundo enlace visible en la parte superior de la Card, dentro del `<CardHeader>`, después de `<CardDescription>`:

```tsx
// Agregar después de línea 185 (cierre de <CardDescription>) y solo cuando step === 'form':
{step === 'form' && (
  <div className="flex items-center justify-center gap-1 text-sm mt-2">
    <span className="text-muted-foreground">¿Ya tienes cuenta?</span>
    <Link to="/login" className="text-primary hover:underline font-medium">
      Iniciar sesión
    </Link>
  </div>
)}
```

El enlace existente al final del form (líneas 304-309) puede mantenerse o eliminarse para evitar redundancia. Recomendación: mantenerlo para desktop.

---

#### PASO 2.4 — Agregar GoogleLogin al formulario de registro (REQ-7)

**Archivo:** `front-end-taller-pro/src/pages/Register.tsx`

**Paso A — Agregar imports:**

```tsx
// Agregar junto a los imports existentes:
import { GoogleLogin } from '@react-oauth/google';
import { API_URL } from '@/config';
import { STORAGE_KEYS } from '@/lib/auth-context';
import { setCurrentTenant, applyTenantTheme } from '@/lib/tenant';
```

**Paso B — Agregar estado `isGoogleLoading`:**

```tsx
// Agregar junto a los otros useState:
const [isGoogleLoading, setIsGoogleLoading] = useState(false);
```

**Paso C — Copiar `handleGoogleSuccess` de Login.tsx:**

Insertar esta función completa antes del `return` de Register.tsx. Es idéntica a `Login.tsx:30-101` — no modificar ninguna línea de lógica:

```tsx
const handleGoogleSuccess = async (credentialResponse: { credential?: string }) => {
  const credential = credentialResponse.credential;
  if (!credential) {
    toast.error('No se pudo obtener las credenciales de Google');
    return;
  }

  setIsGoogleLoading(true);
  try {
    const tenantConfigRaw = localStorage.getItem(STORAGE_KEYS.TENANT_CONFIG);
    const tenantSlug = (tenantConfigRaw ? JSON.parse(tenantConfigRaw)?.slug : null)
      || getCurrentTenant();

    const response = await fetch(`${API_URL}/auth/google/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id_token: credential, tenant_slug: tenantSlug }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || errorData.error || 'Error al autenticar con Google');
    }

    const data = await response.json();

    localStorage.setItem(STORAGE_KEYS.ACCESS_TOKEN, data.access);
    localStorage.setItem(STORAGE_KEYS.REFRESH_TOKEN, data.refresh);
    localStorage.setItem(
      STORAGE_KEYS.USER,
      JSON.stringify({
        id: data.user_id,
        email: data.email,
        name: data.name,
        role: data.role,
        avatar: undefined,
      })
    );

    if (data.tenant?.slug) {
      setCurrentTenant(data.tenant.slug);
      localStorage.setItem(STORAGE_KEYS.TENANT_CONFIG, JSON.stringify(data.tenant));
      applyTenantTheme(data.tenant);
    }

    toast.success('Sesión iniciada con Google');

    const role = data.role as string;
    let redirectPath = '/customer';
    switch (role) {
      case 'mechanic': redirectPath = '/mechanic'; break;
      case 'advisor': redirectPath = '/advisor'; break;
      case 'admin': case 'owner': redirectPath = '/dashboard'; break;
      default: redirectPath = '/customer';
    }
    window.location.href = redirectPath;
  } catch (err: any) {
    toast.error(err?.message || 'Error al iniciar sesión con Google');
  } finally {
    setIsGoogleLoading(false);
  }
};
```

**Nota:** El redirect por defecto en Register es `/customer` (no `/dashboard`) porque el registro es para clientes.

**Paso D — Agregar el componente `GoogleLogin` en el formulario:**

Insertar antes del `<form onSubmit={handleSendCode}>` (línea 193 del Register.tsx original), dentro del bloque `{step === 'form' && (`:

```tsx
{step === 'form' && (
  <>
    {/* Google Login — separador visual */}
    <div className={cn("w-full flex justify-center mb-4", isGoogleLoading && "opacity-60 pointer-events-none")}>
      <GoogleLogin
        onSuccess={handleGoogleSuccess}
        onError={() => toast.error('Error al iniciar sesión con Google')}
        width="368"
        text="signup_with"
        shape="rectangular"
        logo_alignment="left"
      />
    </div>

    <div className="relative mb-4">
      <div className="absolute inset-0 flex items-center">
        <span className="w-full border-t border-border" />
      </div>
      <div className="relative flex justify-center text-xs uppercase">
        <span className="bg-card px-2 text-muted-foreground">o regístrate con email</span>
      </div>
    </div>

    <form onSubmit={handleSendCode} className="space-y-4">
      {/* ... contenido existente del formulario ... */}
    </form>
  </>
)}
```

**Importante:** Agregar `import { cn } from '@/lib/utils';` si no está ya importado. También agregar `getCurrentTenant` a los imports de `@/lib/tenant`.

### Verificación Fase 2

```bash
cd front-end-taller-pro && npm run build 2>&1 | tail -5
# Esperado: "built in X.XXs" sin errores TS

# Verificar que 'Apple' ya no aparece en Login.tsx
grep -n "Apple" src/pages/Login.tsx
# Esperado: sin resultados

# Verificar que GoogleLogin está en Register.tsx
grep -n "GoogleLogin" src/pages/Register.tsx
# Esperado: al menos 2 líneas (import + uso)
```

---

### Fase 3 — Branding + Estilos (REQ-8)

---

#### PASO 3.1 — Reemplazar marca en Login.tsx

**Archivo:** `front-end-taller-pro/src/pages/Login.tsx`

**Cambio 1 — Eliminar imports de `Wrench` y `Building2` si quedan sin uso:**

```tsx
// Línea 9 — cambiar:
import { Wrench, Eye, EyeOff, Loader2, AlertCircle, Building2 } from 'lucide-react';
// por:
import { Eye, EyeOff, Loader2, AlertCircle } from 'lucide-react';
```

**Cambio 2 — Reemplazar el bloque del logo (líneas 175-189):**

```tsx
// REEMPLAZAR bloque del logo (líneas 175-189):
<div className="flex items-center justify-center mb-8">
  <img
    src="/autotronia-logo.png"
    alt="Autotronia"
    className="h-16 w-auto object-contain"
  />
</div>
```

**Cambio 3 — Actualizar copyright (línea 412):**

```tsx
// Cambiar:
© 2024 TallerPro. Sistema de Gestión Automotriz.
// por:
© 2025 Autotronia. El Motor de tu Negocio.
```

---

#### PASO 3.2 — Reemplazar marca en Register.tsx

**Archivo:** `front-end-taller-pro/src/pages/Register.tsx`

**Cambio 1 — Eliminar imports de `Wrench`:**

```tsx
// Línea 18 — cambiar:
import { Wrench, Loader2, AlertCircle, Mail, KeyRound, CheckCircle2, ArrowLeft } from 'lucide-react';
// por:
import { Loader2, AlertCircle, Mail, KeyRound, CheckCircle2, ArrowLeft } from 'lucide-react';
```

**Cambio 2 — Reemplazar el bloque del logo (líneas 150-157):**

```tsx
// REEMPLAZAR bloque del logo:
<div className="flex items-center justify-center mb-8">
  <img
    src="/autotronia-logo.png"
    alt="Autotronia"
    className="h-16 w-auto object-contain"
  />
</div>
```

**Cambio 3 — Actualizar copyright (línea 414):**

```tsx
// Cambiar:
© 2024 TallerPro. Sistema de Gestión Automotriz.
// por:
© 2025 Autotronia. El Motor de tu Negocio.
```

---

#### PASO 3.3 — Estilos mobile-first en Login.tsx

**Restricción absoluta:** Solo cambios de Tailwind CSS. No tocar handlers, hooks, llamadas API, ni lógica de storage.

El logo de Autotronia tiene fondo negro con gradiente teal (`#0891b2` → `#06b6d4`). La paleta de estilos:
- Fondo principal: `bg-black` o `bg-slate-950`
- Acentos: `from-cyan-600 to-cyan-400` (teal Autotronia)
- Cards: glassmorphism con borde teal sutil

**Cambios en la estructura del contenedor principal (línea 151):**

```tsx
// REEMPLAZAR className del div principal:
<div className={cn(
  "min-h-screen flex items-center justify-center p-4 transition-colors duration-500",
  // NUEVO: fondo oscuro siempre, más inmersivo
  isStaffMode
    ? "bg-slate-950"
    : "bg-gradient-to-br from-slate-950 via-slate-900 to-cyan-950"
)}>
```

**Cambios en decorative elements (líneas 156-171):**

```tsx
// REEMPLAZAR los dos divs decorativos:
<div className="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none">
  <div className={cn(
    "absolute -top-40 -left-40 w-96 h-96 rounded-full blur-3xl opacity-20",
    isStaffMode ? "bg-amber-500" : "bg-cyan-500"
  )} />
  <div className={cn(
    "absolute -bottom-40 -right-40 w-96 h-96 rounded-full blur-3xl opacity-10",
    isStaffMode ? "bg-amber-400" : "bg-cyan-400"
  )} />
</div>
```

**Cambios en la Card (línea 191):**

```tsx
// REEMPLAZAR className de Card:
<Card className={cn(
  "transition-all duration-500 border",
  isStaffMode
    ? "bg-slate-800/60 border-slate-700 backdrop-blur-sm"
    : "bg-slate-900/80 border-cyan-900/50 backdrop-blur-sm shadow-2xl shadow-cyan-950/50"
)}>
```

**Cambios en el botón submit (líneas 314-330):**

```tsx
// REEMPLAZAR className del Button submit:
<Button
  type="submit"
  className={cn(
    "w-full h-11 font-semibold rounded-lg transition-all duration-200",
    isStaffMode
      ? "bg-amber-500 hover:bg-amber-600 text-slate-900"
      : "bg-gradient-to-r from-cyan-600 to-cyan-500 hover:from-cyan-500 hover:to-cyan-400 text-white shadow-lg shadow-cyan-900/30"
  )}
  disabled={isLoading}
>
```

**Cambios en texto de toggle staff/customer (líneas 394-406):**

```tsx
// REEMPLAZAR className del button toggle:
<button
  type="button"
  onClick={() => setIsStaffMode(!isStaffMode)}
  className={cn(
    "text-sm transition-colors px-4 py-2 rounded-full border",
    isStaffMode
      ? "text-slate-300 hover:text-white border-slate-700 hover:border-slate-500"
      : "text-cyan-400 hover:text-cyan-300 border-cyan-900/50 hover:border-cyan-700"
  )}
>
```

---

#### PASO 3.4 — Estilos mobile-first en Register.tsx

**Misma paleta que Login.tsx. Solo Tailwind. Restricción absoluta aplica.**

**Contenedor principal (línea 145):**

```tsx
<div className="min-h-screen flex items-center justify-center p-3 sm:p-4 bg-gradient-to-br from-slate-950 via-slate-900 to-cyan-950">
```

**Fondo decorativo (línea 146):**

```tsx
<div className="absolute inset-0 overflow-hidden pointer-events-none">
  <div className="absolute -top-40 -left-40 w-96 h-96 rounded-full blur-3xl opacity-20 bg-cyan-500" />
  <div className="absolute -bottom-40 -right-40 w-96 h-96 rounded-full blur-3xl opacity-10 bg-cyan-400" />
</div>
```

**Card (línea 159):**

```tsx
<Card className="bg-slate-900/80 border border-cyan-900/50 backdrop-blur-sm shadow-2xl shadow-cyan-950/50">
```

**Botón submit en step 'form' (línea 293):**

```tsx
<Button
  type="submit"
  className="w-full h-11 font-semibold bg-gradient-to-r from-cyan-600 to-cyan-500 hover:from-cyan-500 hover:to-cyan-400 text-white rounded-lg shadow-lg shadow-cyan-900/30"
  disabled={isLoading}
>
```

### Verificación Fase 3

```bash
# Build sin errores
cd front-end-taller-pro && npm run build 2>&1 | tail -5

# Verificar que no queda ningún rastro de 'TallerPro' en páginas auth
grep -rn "TallerPro\|Taller Pro" src/pages/Login.tsx src/pages/Register.tsx
# Esperado: sin resultados

# Verificar que el logo img está en ambos archivos
grep -n "autotronia-logo" src/pages/Login.tsx src/pages/Register.tsx
# Esperado: al menos 1 línea por archivo
```

---

## 5. Tests unitarios requeridos

### Backend — Fase 1

**Archivo:** `apps/password_reset/tests.py`

Los tests deben usar `pytest` + `pytest-django` + las factories del `conftest.py`.

#### Test REQ-1: `send_registration_code` — email existente en otro tenant

```python
# apps/password_reset/tests.py

import pytest
from django.contrib.auth.models import User
from rest_framework.test import APIClient
from apps.tenants.models import Tenant, TenantUser
from apps.customers.models import Customer

@pytest.mark.django_db
class TestSendRegistrationCode:

    def test_email_nuevo_envia_codigo(self, tenant):
        """Email completamente nuevo → responde 200 con message"""
        client = APIClient()
        client.credentials(HTTP_X_TENANT_ID=tenant.slug)
        response = client.post('/api/auth/send-registration-code/', {
            'email': 'nuevo@email.com',
            'first_name': 'Juan',
            'last_name': 'Test',
        })
        assert response.status_code == 200
        assert 'message' in response.data
        assert response.data.get('existing_user') is None

    def test_email_existe_en_otro_tenant_retorna_existing_user(self, tenant):
        """Email con auth_user en otro tenant → responde 200 con existing_user: true"""
        # Crear user en otro tenant
        other_user = User.objects.create_user(
            username='otro@email.com',
            email='otro@email.com',
            password='password123',
        )
        client = APIClient()
        client.credentials(HTTP_X_TENANT_ID=tenant.slug)
        response = client.post('/api/auth/send-registration-code/', {
            'email': 'otro@email.com',
            'first_name': 'Juan',
            'last_name': 'Test',
        })
        assert response.status_code == 200
        assert response.data.get('existing_user') is True

    def test_email_existe_como_customer_en_mismo_tenant_retorna_error(self, tenant, customer):
        """Email ya registrado como Customer en este tenant → error 400"""
        client = APIClient()
        client.credentials(HTTP_X_TENANT_ID=tenant.slug)
        response = client.post('/api/auth/send-registration-code/', {
            'email': customer.email,  # customer del mismo tenant
            'first_name': 'Juan',
            'last_name': 'Test',
        })
        assert response.status_code == 400
        assert 'error' in response.data

@pytest.mark.django_db
class TestVerifyAndRegister:

    def test_registro_nuevo_usuario_crea_customer_y_tenantuser(self, tenant):
        """Usuario nuevo → crea User + Customer + TenantUser"""
        from django.core.cache import cache
        import json
        from datetime import timedelta
        from django.utils import timezone

        email = 'nuevo2@email.com'
        cache.set(f'registration_code_{email}', {
            'code': '123456',
            'expires_at': (timezone.now() + timedelta(minutes=10)).isoformat(),
            'first_name': 'Juan',
            'last_name': 'Test',
        }, timeout=900)

        client = APIClient()
        client.credentials(HTTP_X_TENANT_ID=tenant.slug)
        response = client.post('/api/auth/verify-and-register/', {
            'email': email,
            'code': '123456',
            'first_name': 'Juan',
            'last_name': 'Test',
            'phone': '5512345678',
            'password': 'pass1234',
        })
        assert response.status_code == 201
        assert Customer.objects.filter(email=email, tenant=tenant).exists()
        assert TenantUser.objects.filter(
            user__email=email, tenant=tenant, role='member'
        ).exists()

    def test_email_existente_reutiliza_auth_user(self, tenant):
        """Usuario con auth_user en otro tenant → reutiliza el User existente"""
        from django.core.cache import cache
        from django.utils import timezone
        from datetime import timedelta

        # Crear user en otro tenant
        existing_user = User.objects.create_user(
            username='multi@email.com',
            email='multi@email.com',
            password='pass1234',
        )
        email = 'multi@email.com'
        cache.set(f'registration_code_{email}', {
            'code': '654321',
            'expires_at': (timezone.now() + timedelta(minutes=10)).isoformat(),
            'first_name': 'Maria',
            'last_name': 'Gomez',
        }, timeout=900)

        client = APIClient()
        client.credentials(HTTP_X_TENANT_ID=tenant.slug)
        response = client.post('/api/auth/verify-and-register/', {
            'email': email,
            'code': '654321',
            'first_name': 'Maria',
            'last_name': 'Gomez',
            'phone': '5512345678',
            'password': 'nuevopass',  # ignorado: auth_user existente no cambia contraseña
        })
        assert response.status_code == 201
        # Verificar que NO se creó un nuevo auth_user
        assert User.objects.filter(email=email).count() == 1
        # Verificar que se creó Customer en el nuevo tenant
        assert Customer.objects.filter(email=email, tenant=tenant).exists()
```

**Comando de ejecución:**

```bash
docker compose -f docker-compose.dev.yml exec web pytest apps/password_reset/tests.py -v -m "not slow"
```

#### Test REQ-3: Exclusividad de roles

```python
# apps/customers/tests/test_role_exclusivity.py

import pytest
from apps.customers.models import Customer
from apps.tenants.models import TenantUser

@pytest.mark.django_db
class TestRoleExclusivity:

    def test_staff_admin_no_puede_ser_customer(self, authenticated_client, tenant, user):
        """Un user con TenantUser admin no puede tener Customer profile"""
        # Asegurar que el user es admin
        TenantUser.objects.filter(user=user, tenant=tenant).update(role='admin')

        response = authenticated_client.post('/api/customers/', {
            'user': user.id,
            'first_name': 'Admin',
            'last_name': 'User',
            'email': user.email,
            'phone': '5512345678',
        })
        assert response.status_code == 400

    def test_customer_no_puede_ser_staff(self, authenticated_client, tenant, customer):
        """Un Customer no puede recibir TenantUser con rol staff"""
        from apps.tenants.urls import TenantUserViewSet  # ajustar según URL real
        # Test de validación de serializer directamente
        from apps.tenants.serializers import TenantUserCreateSerializer
        serializer = TenantUserCreateSerializer(data={
            'user': customer.user.id,
            'tenant': tenant.id,
            'role': 'admin',
        })
        assert not serializer.is_valid()
        assert 'user' in serializer.errors
```

```bash
docker compose -f docker-compose.dev.yml exec web pytest apps/customers/tests/ apps/tenants/tests/ -v -k "exclusivity or role"
```

---

## 6. Variables de entorno

No se requieren nuevas variables de entorno para este spec. Las existentes que deben estar configuradas:

**Backend:**
- `GOOGLE_OAUTH_CLIENT_ID` — Ya requerido por plan_07
- `DEFAULT_FROM_EMAIL` — Para envío de código de verificación
- `EMAIL_HOST`, `EMAIL_HOST_USER`, `EMAIL_HOST_PASSWORD` — SMTP

**Frontend:**
- `VITE_API_URL` — Ya definido
- `VITE_GOOGLE_CLIENT_ID` — Ya requerido por plan_07

---

## 7. Checklist

### Fase 1 — Backend

- [x] **PASO 1.1** — `send_registration_code`: distingue email en otro tenant (retorna `existing_user: true`) vs Customer en mismo tenant (error 400)
- [x] **PASO 1.2** — `verify_and_register`: reutiliza `auth_user` existente en lugar de crear duplicado
- [x] **PASO 1.3** — `CustomJWTLoginView`: prefiere tenant de `X-Tenant-ID` sobre `is_current`
- [x] **PASO 1.4** — Validación de exclusividad de roles en `Customer.clean()`
- [x] **PASO 1.4** — Validación de exclusividad de roles en `verify_and_register`
- [x] Tests `send_registration_code` — los 3 casos pasan
- [x] Tests `verify_and_register` — los 2 casos pasan
- [x] Tests exclusividad de roles pasan
- [x] `pytest` sin regresiones (22/22 tests spec-08 pasan)

### Fase 2 — Frontend lógica

- [x] **PASO 2.1** — Botón Apple eliminado de `Login.tsx`
- [x] **PASO 2.2** — Estado `existing_user` manejado en `Register.tsx`
- [x] **PASO 2.2** — Tipo `Step` actualizado a `'form' | 'code' | 'success' | 'existing_user'`
- [x] **PASO 2.2** — UI del step `existing_user` implementada con botón "Ir al Login"
- [x] **PASO 2.3** — Enlace "Iniciar sesión" visible en la parte superior de la card en mobile
- [x] **PASO 2.4** — Imports de `GoogleLogin`, `API_URL`, `STORAGE_KEYS`, `setCurrentTenant`, `applyTenantTheme` agregados a `Register.tsx`
- [x] **PASO 2.4** — `handleGoogleSuccess` implementado en `Register.tsx`
- [x] **PASO 2.4** — Componente `<GoogleLogin>` con `text="signup_with"` visible en step 'form'
- [x] `npm run build` sin errores TypeScript
- [x] REQ-4: `GoogleAuthView` documentado como validado, sin cambios

### Fase 3 — Branding y estilos

- [x] **PASO 3.1** — `Login.tsx`: logo reemplazado por `<img src="/autotronia-logo.png">`
- [x] **PASO 3.1** — `Login.tsx`: copyright actualizado a "© 2025 Autotronia. El Motor de tu Negocio."
- [x] **PASO 3.2** — `Register.tsx`: logo reemplazado por `<img src="/autotronia-logo.png">`
- [x] **PASO 3.2** — `Register.tsx`: copyright actualizado
- [x] **PASO 3.3** — `Login.tsx`: fondo `from-slate-950 via-slate-900 to-cyan-950`
- [x] **PASO 3.3** — `Login.tsx`: Card con `bg-slate-900/80 border-cyan-900/50 backdrop-blur-sm`
- [x] **PASO 3.3** — `Login.tsx`: botón submit con gradiente teal
- [x] **PASO 3.4** — `Register.tsx`: mismos estilos aplicados
- [x] `grep -rn "TallerPro\|Taller Pro" src/pages/Login.tsx src/pages/Register.tsx` → sin resultados
- [x] `npm run build` sin errores

---

## 8. Riesgos y mitigaciones

| Riesgo | Probabilidad | Mitigación |
|--------|-------------|------------|
| Un usuario multi-tenant queda con `is_current=False` en todos sus tenants tras el ajuste PASO 1.3 | Baja | El fallback a `is_current=True` en PASO 1.3 cubre este caso. Si tampoco hay ninguno activo, el login responde sin `tenant` en el payload (comportamiento ya existente). |
| `verify_and_register` con usuario existente no actualiza la contraseña — el cliente ingresa una nueva contraseña que queda ignorada | Media | El step `existing_user` del frontend (PASO 2.2) impide que el formulario de registro llegue a `verify_and_register` para usuarios existentes. El backend también rechaza el código si `existing_user=True` en cache. |
| El logo `public/autotronia-logo.png` no existe en el servidor al hacer deploy | Baja | Verificar con `ls front-end-taller-pro/public/autotronia-logo.png` antes de deploy. Si falta, mantener el bloque actual del logo hasta que esté disponible. |
| `GoogleLogin` en Register.tsx duplica código con Login.tsx | Baja (deuda técnica) | Aceptable en esta iteración. Refactorizar a un componente `<GoogleAuthButton>` en una segunda iteración si es necesario. |
| Usuarios staff que lleguen al registro por error ven el error "pertenece a personal" en `verify_and_register`, que puede confundir | Baja | El mensaje es claro. Si se quiere mejorar UX, agregar la verificación también en `send_registration_code` (similar a PASO 1.1). |
| Los estilos de glassmorphism con `backdrop-blur-sm` pueden no renderizar bien en navegadores muy antiguos | Baja | Solo CSS, degradación elegante (sin blur, el fondo oscuro sigue siendo legible). |

---

## 9. Archivos a modificar (tabla por agente)

### Agente Backend

| Archivo | Tipo de cambio | Pasos |
|---------|---------------|-------|
| `apps/password_reset/views.py` | Modificar funciones existentes | 1.1, 1.2 |
| `apps/core/views.py` | Modificar `CustomJWTLoginView.post()` | 1.3 |
| `apps/customers/serializers.py` | Agregar `validate()` en `CustomerCreateSerializer` | 1.4 |
| `apps/tenants/serializers.py` | Agregar `validate()` en `TenantUserCreateSerializer` (crear si no existe) | 1.4 |
| `apps/password_reset/tests.py` | Agregar tests | Sección 5 |
| `apps/customers/tests/test_role_exclusivity.py` | Crear archivo de tests | Sección 5 |

### Agente Frontend

| Archivo | Tipo de cambio | Pasos |
|---------|---------------|-------|
| `src/pages/Login.tsx` | Eliminar botón Apple, reemplazar logo, actualizar copyright, estilos | 2.1, 3.1, 3.3 |
| `src/pages/Register.tsx` | Agregar GoogleLogin, manejo `existing_user`, enlace login mobile, reemplazar logo, estilos | 2.2, 2.3, 2.4, 3.2, 3.4 |

---

## Apéndice — Diagrama de flujo REQ-1 (Opción 3)

```
POST /api/auth/send-registration-code/
    │
    ├─ ¿Existe Customer con email en ESTE tenant?
    │      SÍ → 400 "Ya registrado en este taller"
    │      NO ↓
    │
    ├─ ¿Existe auth_user con este email (en cualquier tenant)?
    │      SÍ → 200 { existing_user: true, message: "..." }
    │             └─ Frontend muestra UI "Ya tienes cuenta" + botón "Ir al Login"
    │      NO ↓
    │
    └─ Generar código + guardar en cache → 200 { message: "Código enviado" }
           └─ Frontend avanza a step 'code'

POST /api/auth/verify-and-register/
    │
    ├─ Verificar código en cache (y que no sea existing_user=True en cache)
    │
    ├─ ¿Existe Customer con email en ESTE tenant? → 400
    │
    ├─ ¿Existe auth_user con este email?
    │      SÍ → Reutilizar ese User (no crear nuevo, no cambiar contraseña)
    │      NO → Crear nuevo User con contraseña proporcionada
    │
    └─ Crear Customer (tenant=este tenant) + TenantUser(role='member') → 201
```
