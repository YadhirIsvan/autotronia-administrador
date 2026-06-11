# Plan de Implementación — Spec 06: Google OAuth Login + Email SMTP

**Fecha:** 2026-03-15
**Estado:** Implementación completa ✅ — Pendiente: prueba E2E con Google real
**Basado en:** `spec_06_google_oauth_email.md`

---

## 1. Resumen Ejecutivo

### Parte A — Google OAuth Login

Conectar el botón "Continuar con Google" que ya existe en `Login.tsx` (actualmente decorativo)
con un nuevo endpoint `POST /api/auth/google/` en el backend. El flujo usa **ID Token** de
Google Identity Services: el popup de Google ocurre completamente en el frontend, que recibe
una credencial firmada y la envía al backend para validación.

El backend valida la firma con la librería `google-auth` (sin redireccionamientos), crea
al usuario como `customer` si es nuevo, o autentica con su rol actual si ya existe. La
respuesta es idéntica a `CustomJWTLoginView`: `access + refresh + user_id + role + tenant`.

El frontend guarda los tokens en `localStorage` con las mismas claves que el login normal
(`taller_token`, `taller_user`) y redirige según rol.

### Parte B — Cambio de Email SMTP

Actualizar las variables de entorno para enviar correos desde `autotronia.ventas@gmail.com`
usando una app password de Gmail. La configuración SMTP ya está estructurada en `base.py`
mediante `os.environ.get(...)`, por lo que el único cambio de código es reemplazar el texto
hardcodeado `AutoClimas Robles` en `password_reset/views.py` por una variable de settings.

### Por qué esta arquitectura

- **No django-allauth ni python-social-auth**: diseñados para sesiones Django, agregan 10+
  tablas innecesarias y son incompatibles con nuestra SPA + JWT.
- **ID Token flow**: el frontend ya tiene la credencial tras el popup; no hay redirección de
  página; compatible 100% con JWT (el backend solo necesita el `CLIENT_ID` para validar,
  no el secret).
- **Campo `google_sub` en Customer**: el `sub` de Google nunca cambia (a diferencia del
  email), permitiendo reconocer al mismo usuario Google aunque cambie su email.

---

## 2. Análisis del Estado Actual

### Lo que ya existe

| Elemento | Estado | Ubicación |
|----------|--------|-----------|
| Botón "Continuar con Google" en UI | Existe, decorativo, sin `onClick` | `Login.tsx` linea 132 |
| Botón "Continuar con Apple" | Existe, decorativo — NO implementar | `Login.tsx` linea 141 |
| `CustomJWTLoginView` con respuesta completa | Implementado | `apps/core/views.py` |
| `LogoutView` con blacklist | Implementado | `apps/core/views.py` |
| `TenantUser` con `role` y `is_current` | Implementado | `apps/tenants/models.py` |
| Customer con `user` OneToOne | Implementado | `apps/customers/models.py` |
| `conftest.py` con `CustomerFactory`, `TenantUserFactory` | Implementado | `conftest.py` |
| Configuración SMTP en `base.py` via env vars | Implementado | `config/settings/base.py` |
| `DEFAULT_FROM_EMAIL` en settings | Implementado | `config/settings/base.py` |
| `authenticate_client` fixture con JWT | Implementado | `conftest.py` linea 379 |

### Lo que falta

| Elemento | Accion |
|----------|--------|
| `google-auth==2.28.0` en dependencias | Agregar a `requirements/base.txt` |
| `GOOGLE_OAUTH_CLIENT_ID` en settings | Agregar a `config/settings/base.py` |
| `APP_NAME` en settings | Agregar a `config/settings/base.py` |
| Campo `google_sub` en `Customer` | Agregar campo + migración |
| `GoogleAuthView` | Crear en `apps/core/views.py` |
| URL `api/auth/google/` | Agregar a `config/urls.py` |
| Texto hardcodeado "AutoClimas Robles" | Reemplazar en `password_reset/views.py` |
| Fixture `google_customer` | Agregar a `conftest.py` |
| Tests `test_google_auth.py` | Crear en `apps/core/tests/` |
| `@react-oauth/google` | Instalar en frontend |
| `GoogleOAuthProvider` en `main.tsx` | Envolver `App` |
| Handler en `Login.tsx` | Conectar botón existente |
| `VITE_GOOGLE_CLIENT_ID` en `.env` frontend | Agregar variable |

### Observaciones críticas del código actual

1. **`auth-context.tsx` guarda `data.token` pero el spec devuelve `data.access`**: La
   función `login()` en linea 70 hace `localStorage.setItem('taller_token', data.token)`.
   Verificar si esto ya usa `data.access` (spec JWT migrado) o sigue con `data.token`. Si
   devuelve `access`, el handler de Google debe guardar con la misma clave.

2. **`tenant_slug` debe venir del contexto**: El botón Google solo aparece en modo cliente
   (`!isStaffMode`). El `tenant_slug` necesario para el endpoint `POST /api/auth/google/`
   debe obtenerse del `localStorage` (`taller_tenant_config`) o de la URL actual.

3. **`Customer.email` tiene `unique_together` con `tenant`**: Si el mismo email ya existe
   como Customer en el tenant, la creacion fallara con IntegrityError. La lógica de
   `GoogleAuthView` debe buscar primero antes de crear.

4. **Tests en `apps/core/tests/`**: Verificar si el directorio existe antes de crear el
   archivo de tests.

---

## 3. Arquitectura de la Solución

### Flujo completo — Parte A

```
[Usuario clic "Continuar con Google" en Login.tsx]
        |
        v
[Google popup — usuario elige cuenta]
        |
        v
[@react-oauth/google devuelve credential (ID token JWT firmado por Google)]
        |
        v
[Login.tsx llama POST /api/auth/google/]
  Body: {
    "id_token": "<credential>",
    "tenant_slug": "<slug del tenant_config en localStorage>"
  }
        |
        v
[GoogleAuthView — backend]
  1. Valida id_token con google.oauth2.id_token.verify_oauth2_token()
  2. Extrae sub, email, name del payload
  3. Busca Customer por google_sub
     |-- Si existe --> autentica el user asociado
  4. Busca User por email
     |-- Si existe --> actualiza google_sub en Customer, autentica
  5. Si usuario nuevo:
     --> crea User (username=email, set_unusable_password)
     --> crea Customer (tenant=tenant_del_slug, google_sub=sub)
     --> crea TenantUser (role='member', is_current=True)
  6. Genera RefreshToken.for_user(user)
  7. Retorna mismo formato que CustomJWTLoginView
        |
        v
[Login.tsx recibe { access, refresh, user_id, email, name, role, tenant }]
  --> guarda en localStorage con mismas claves que login normal
  --> redirige segun rol
```

### Decisiones de diseño

**Por qué `TenantUser.role = 'member'` en lugar de `'customer'`:**
El modelo `TenantUser` usa `member` para usuarios no-staff. El rol `customer` se infiere
en `CustomJWTLoginView` al detectar que existe `customer_profile` (linea 165 de `views.py`).
`GoogleAuthView` debe seguir la misma lógica.

**Por qué `google_sub` va en `Customer` y no en `User`:**
El modelo `User` de Django es el de `auth.User` — no debemos modificarlo. `Customer` ya
tiene `OneToOneField` a `User` y es el modelo correcto para datos de perfil del cliente.

**Por qué no hay `google_sub` en `User` staff:**
Los usuarios staff (mechanic, advisor, admin) no usan Google OAuth según las reglas de
negocio. Si su email coincide, se autentican con su rol existente — no necesitan `google_sub`.

---

## 4. Plan de Implementación Paso a Paso

> **Convencion de este plan:** Cada paso critico incluye un bloque `### Verificacion` al
> final con el comando exacto para confirmar que el paso funciono antes de continuar al
> siguiente. Un paso no esta completo hasta que su verificacion pasa.

Los pasos 1-6 son **backend** y los pasos 7-10 son **frontend**. Los pasos 7-10 pueden
ejecutarse en paralelo con los pasos 1-6 una vez definida la interfaz del endpoint
(disponible desde el paso 3).

---

### PASO 1 — Dependencia de backend ✅ COMPLETADO

**Archivo:** `requirements/base.txt`

**Cambio:** Agregar al final del archivo:

```
google-auth==2.28.0
```

No se necesita `google-auth-oauthlib` ni `google-auth-httplib2`. Para validar ID tokens,
`google-auth` solo requiere `google.oauth2.id_token` y `google.auth.transport.requests`.

**Comando:**
```bash
docker compose exec web pip install google-auth==2.28.0
```
(Para que tome efecto permanente, hacer rebuild del contenedor tras agregar al archivo.)

---

### PASO 2 — Settings: variables nuevas ✅ COMPLETADO

**Archivo:** `config/settings/base.py`

**Donde agregar:** Después del bloque `# SIMPLE JWT CONFIGURATION` (linea 222 aprox).

**Cambio — agregar estas dos lineas:**
```python
# ============================================
# GOOGLE OAUTH CONFIGURATION
# ============================================
GOOGLE_OAUTH_CLIENT_ID = os.environ.get('GOOGLE_OAUTH_CLIENT_ID', '')

# ============================================
# APP NAME (para emails)
# ============================================
APP_NAME = os.environ.get('APP_NAME', 'Autotronia')
```

**Observacion sobre EMAIL_BACKEND:** `base.py` define `EMAIL_BACKEND` DOS veces (lineas 305
y 347). La segunda definicion (linea 347 con SMTP) sobreescribe a la primera (console).
Esto es correcto para produccion pero debe revisarse para que en desarrollo local use console.
No requiere cambio para este spec, solo documentar.

---

### PASO 3 — Modelo Customer: campo google_sub ✅ COMPLETADO

**Archivo:** `apps/customers/models.py`

**Donde agregar:** Despues del campo `profile_image` (linea 50 aprox), antes de
`customer_type`.

**Cambio — agregar campo:**
```python
google_sub = models.CharField(
    max_length=255,
    blank=True,
    null=True,
    unique=True,
    verbose_name="Google Subject ID",
    help_text="Identificador unico de cuenta Google (sub del JWT). Nunca cambia."
)
```

**Por que `unique=True`:** Garantiza que un mismo sub de Google no pueda estar asociado
a dos clientes distintos. El campo es `null=True` entonces multiples registros con `null`
son permitidos (PostgreSQL trata cada NULL como distinto en constraints UNIQUE).

**Agregar indice en `Meta.indexes`:**
```python
models.Index(fields=['google_sub']),
```
La linea de indexes actual (linea 128-133) queda:
```python
indexes = [
    models.Index(fields=['email']),
    models.Index(fields=['phone']),
    models.Index(fields=['customer_type']),
    models.Index(fields=['is_deleted']),
    models.Index(fields=['google_sub']),  # nuevo
]
```

### Verificacion

```bash
# Verificar que Django reconoce el campo sin errores de configuracion
docker compose -f docker-compose.local.yml exec web python manage.py check
```

---

### PASO 4 — Migracion ✅ COMPLETADO

**Comandos exactos dentro del contenedor Docker:**

```bash
# Generar la migracion
docker compose exec web python manage.py makemigrations customers \
  --name customer_google_sub

# Aplicar la migracion
docker compose exec web python manage.py migrate customers
```

**Migracion generada:** `apps/customers/migrations/XXXX_customer_google_sub.py`

**Impacto en datos existentes:** Ninguno. El campo es `null=True, blank=True`.
Todos los Customer existentes tendran `google_sub=None`.

### Verificacion

```bash
# Verificar que la migracion se aplico sin errores pendientes
docker compose -f docker-compose.local.yml exec web python manage.py migrate --check

# Verificar que el campo existe en la base de datos
docker compose -f docker-compose.local.yml exec web python manage.py shell -c \
  "from apps.customers.models import Customer; f = Customer._meta.get_field('google_sub'); print('OK:', f)"
```

---

### PASO 5 — GoogleAuthView ✅ COMPLETADO

**Archivo:** `apps/core/views.py`

**Donde agregar:** Al final del archivo, despues de `LogoutView`.

**Cambio — nuevos imports al inicio del archivo (agregar a los existentes):**
```python
from django.conf import settings
import logging

logger = logging.getLogger(__name__)
```

**Cambio — nueva vista al final del archivo:**

```python
class GoogleAuthView(APIView):
    """
    Login / registro via Google OAuth (ID Token flow).

    POST /api/auth/google/
    Body: {
        "id_token": "<credential de Google Identity Services>",
        "tenant_slug": "<slug del taller>"
    }

    Response (misma estructura que CustomJWTLoginView):
    {
        "access": "<jwt_access>",
        "refresh": "<jwt_refresh>",
        "user_id": 1,
        "email": "user@gmail.com",
        "name": "Juan Perez",
        "role": "customer",
        "tenant": { ... }
    }

    Errores:
        400 — tenant_slug faltante o no existe
        401 — id_token invalido o expirado
    """
    permission_classes = [AllowAny]
    authentication_classes = []

    def post(self, request, *args, **kwargs):
        id_token_str = request.data.get('id_token', '').strip()
        tenant_slug = request.data.get('tenant_slug', '').strip()

        # Validar campos requeridos
        if not id_token_str:
            return Response(
                {'detail': 'El campo id_token es requerido.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if not tenant_slug:
            return Response(
                {'detail': 'El campo tenant_slug es requerido.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Resolver tenant
        try:
            from apps.tenants.models import Tenant
            tenant = Tenant.objects.get(
                slug=tenant_slug,
                is_active=True,
                is_deleted=False,
            )
        except Tenant.DoesNotExist:
            return Response(
                {'detail': 'Taller no encontrado.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Validar ID token con Google
        try:
            from google.oauth2 import id_token as google_id_token
            from google.auth.transport import requests as google_requests

            idinfo = google_id_token.verify_oauth2_token(
                id_token_str,
                google_requests.Request(),
                settings.GOOGLE_OAUTH_CLIENT_ID,
            )
        except ValueError as exc:
            logger.warning("Google ID token invalido: %s", exc)
            return Response(
                {'detail': 'Token de Google invalido o expirado.'},
                status=status.HTTP_401_UNAUTHORIZED,
            )

        google_sub = idinfo.get('sub')
        email = idinfo.get('email', '').lower()
        full_name = idinfo.get('name', '')
        first_name = idinfo.get('given_name', full_name.split()[0] if full_name else 'Usuario')
        last_name = idinfo.get('family_name', ' '.join(full_name.split()[1:]) if ' ' in full_name else '')

        user = None

        # 1. Buscar por google_sub (mas confiable que email)
        from apps.customers.models import Customer
        try:
            existing_customer = Customer.objects.select_related('user').get(
                google_sub=google_sub
            )
            user = existing_customer.user
        except Customer.DoesNotExist:
            pass

        # 2. Buscar por email
        if user is None:
            from django.contrib.auth.models import User
            try:
                user = User.objects.get(email=email)
                # Actualizar google_sub si el customer existe pero no lo tiene aun
                if hasattr(user, 'customer_profile') and user.customer_profile:
                    customer_profile = user.customer_profile
                    if not customer_profile.google_sub:
                        customer_profile.google_sub = google_sub
                        customer_profile.save(update_fields=['google_sub'])
            except User.DoesNotExist:
                pass

        # 3. Usuario nuevo: crear User + Customer + TenantUser
        if user is None:
            from django.contrib.auth.models import User
            from apps.tenants.models import TenantUser

            username = email  # mismo patron que verify_and_register
            # Garantizar username unico si ya existe
            if User.objects.filter(username=username).exists():
                username = f"{email}_{google_sub[:8]}"

            user = User.objects.create(
                username=username,
                email=email,
                first_name=first_name,
                last_name=last_name,
                is_active=True,
            )
            user.set_unusable_password()
            user.save()

            Customer.objects.create(
                user=user,
                tenant=tenant,
                first_name=first_name,
                last_name=last_name or 'Sin apellido',
                email=email,
                phone='',
                google_sub=google_sub,
            )

            TenantUser.objects.get_or_create(
                user=user,
                tenant=tenant,
                defaults={
                    'is_current': True,
                    'role': 'member',
                },
            )

        # Verificar cuenta activa
        if not user.is_active:
            return Response(
                {'detail': 'Cuenta desactivada.'},
                status=status.HTTP_401_UNAUTHORIZED,
            )

        # Generar par de tokens JWT (mismo codigo que CustomJWTLoginView)
        refresh = RefreshToken.for_user(user)
        access = refresh.access_token

        role = 'customer'
        name = user.get_full_name() or user.username
        mechanic_profile_data = None
        tenant_data = None

        if hasattr(user, 'mechanic_profile') and user.mechanic_profile:
            mechanic = user.mechanic_profile
            name = mechanic.full_name or name
            mechanic_profile_data = {
                'id': mechanic.id,
                'role': mechanic.role,
                'employee_id': getattr(mechanic, 'employee_id', None),
                'phone': getattr(mechanic, 'phone', ''),
                'status': getattr(mechanic, 'status', 'active'),
            }

        try:
            from apps.tenants.models import TenantUser
            tenant_user = TenantUser.objects.select_related('tenant').filter(
                user=user,
                is_current=True,
                tenant__is_active=True,
                tenant__is_deleted=False,
            ).first()

            if tenant_user:
                t = tenant_user.tenant
                tenant_data = {
                    'id': t.id,
                    'name': t.name,
                    'slug': t.slug,
                    'logo': (
                        request.build_absolute_uri(t.logo.url)
                        if t.logo else None
                    ),
                    'primary_color': t.primary_color,
                    'secondary_color': t.secondary_color,
                    'plan': t.plan,
                }
                if tenant_user.role in ['owner', 'admin']:
                    role = tenant_user.role
                elif tenant_user.role == 'member' and mechanic_profile_data:
                    role = mechanic_profile_data['role']
        except Exception:
            pass

        if role == 'customer' and hasattr(user, 'customer_profile') and user.customer_profile:
            name = user.customer_profile.display_name or name

        response_data = {
            'access': str(access),
            'refresh': str(refresh),
            'user_id': user.id,
            'email': user.email,
            'name': name,
            'role': role,
        }

        if mechanic_profile_data:
            response_data['mechanic_profile'] = mechanic_profile_data

        if tenant_data:
            response_data['tenant'] = tenant_data

        return Response(response_data, status=status.HTTP_200_OK)
```

**Nota importante sobre duplicacion de logica:** El bloque de construccion de `role`,
`tenant_data` y `response_data` es identico al de `CustomJWTLoginView`. En una refactorizacion
futura conviene extraer ese bloque a un metodo privado `_build_auth_response(user, request)`.
Para este spec, copiar es aceptable para no romper codigo existente.

---

### PASO 6 — URL del nuevo endpoint ✅ COMPLETADO

**Archivo:** `config/urls.py`

**Cambio en el import de la linea 10:**
```python
# Antes:
from apps.core.views import CustomJWTLoginView, LogoutView, HealthCheckView

# Despues:
from apps.core.views import CustomJWTLoginView, LogoutView, HealthCheckView, GoogleAuthView
```

**Cambio en `urlpatterns` — agregar despues de la linea de jwt_logout:**
```python
path('api/auth/google/', GoogleAuthView.as_view(), name='google_auth'),
```

El bloque de autenticacion queda:
```python
path('api/auth/login/', CustomJWTLoginView.as_view(), name='jwt_login'),
path('api/auth/token/refresh/', TokenRefreshView.as_view(), name='jwt_refresh'),
path('api/auth/logout/', LogoutView.as_view(), name='jwt_logout'),
path('api/auth/google/', GoogleAuthView.as_view(), name='google_auth'),
```

### Verificacion

```bash
# Correr solo los tests nuevos — deben pasar 8/8 antes de continuar al frontend
docker compose -f docker-compose.local.yml exec web pytest apps/core/tests/test_google_auth.py -v
```

---

### PASO 6B — Texto hardcodeado en password_reset (Parte B) ✅ COMPLETADO

**Archivo:** `apps/password_reset/views.py`

**Cambio — agregar import al inicio del archivo (despues de `from django.conf import settings`):**
```python
APP_NAME = getattr(settings, 'APP_NAME', 'Autotronia')
```

**Cambio en la funcion `forgot_password` (linea 49 y 62):**
```python
# Antes:
subject='Codigo de Recuperacion - AutoClimas Robles',
...
Saludos,
AutoClimas Robles

# Despues:
subject=f'Codigo de Recuperacion - {APP_NAME}',
...
Saludos,
El equipo de {APP_NAME}
```

**Cambio en `send_registration_code` (linea 284 y 296):**
```python
# Antes:
subject='Codigo de Verificacion - TallerPro',
...
El equipo de TallerPro

# Despues:
subject=f'Codigo de Verificacion - {APP_NAME}',
...
El equipo de {APP_NAME}
```

### Verificacion

```bash
# Verificar que no se rompieron los tests existentes de password_reset
docker compose -f docker-compose.local.yml exec web pytest apps/password_reset/ -v
```

---

### PASO 7 — Fixture google_customer ✅ COMPLETADO

**Archivo:** `conftest.py`

**Donde agregar:** Al final del archivo, despues del fixture `assertions`.

```python
@pytest.fixture
def google_customer(db, tenant):
    """
    Usuario creado via Google OAuth.
    Tiene password inutilizable y google_sub en el Customer.
    """
    user = UserFactory()
    user.set_unusable_password()
    user.save()
    customer = CustomerFactory(
        user=user,
        tenant=tenant,
        google_sub='google_sub_test_123456',
    )
    TenantUserFactory(user=user, tenant=tenant, role='member', is_current=True)
    return user
```

**Nota:** `CustomerFactory` requiere que el campo `google_sub` exista en el modelo (PASO 3)
antes de poder usar este fixture. Los fixtures se ejecutan en orden de dependencias.

### Verificacion

```bash
# Verificar que el fixture nuevo es recolectable por pytest
docker compose -f docker-compose.local.yml exec web pytest --collect-only -q 2>&1 | grep google_customer
```

---

### PASO 8 — Tests de backend ✅ COMPLETADO (8/8 tests pasan)

**Archivo a crear:** `apps/core/tests/test_google_auth.py`

Primero verificar si el directorio existe:
```bash
ls /home/yadhir/Documentos/vps/tallerv2/backend-taller-pro/apps/core/tests/
```

Si no existe `__init__.py`, crearlo:
```bash
docker compose exec web touch apps/core/tests/__init__.py
```

**Contenido del archivo de tests:**

```python
"""
Tests para GoogleAuthView — POST /api/auth/google/
Todos los tests mockean google.oauth2.id_token.verify_oauth2_token
para evitar llamadas reales a Google.
"""
import pytest
from unittest.mock import patch, MagicMock
from rest_framework import status
from rest_framework.test import APIClient


GOOGLE_AUTH_URL = '/api/auth/google/'

VALID_IDINFO = {
    'sub': 'google_sub_test_999',
    'email': 'nuevo@gmail.com',
    'name': 'Juan Perez',
    'given_name': 'Juan',
    'family_name': 'Perez',
    'email_verified': True,
}


@pytest.mark.django_db
class TestGoogleAuthView:

    @pytest.fixture(autouse=True)
    def setup(self, tenant):
        self.client = APIClient()
        self.tenant = tenant
        self.url = GOOGLE_AUTH_URL

    def _post(self, id_token='valid_token', tenant_slug=None):
        slug = tenant_slug or self.tenant.slug
        return self.client.post(self.url, {
            'id_token': id_token,
            'tenant_slug': slug,
        }, format='json')

    # ------------------------------------------------------------------
    # Happy paths
    # ------------------------------------------------------------------

    @patch('apps.core.views.google_id_token.verify_oauth2_token')
    def test_nuevo_usuario_crea_customer(self, mock_verify):
        """Usuario inexistente -> crea User + Customer + TenantUser, retorna JWT."""
        mock_verify.return_value = VALID_IDINFO

        response = self._post()

        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert 'access' in data
        assert 'refresh' in data
        assert data['role'] == 'customer'
        assert data['email'] == 'nuevo@gmail.com'

        # Verificar que se crearon los objetos
        from django.contrib.auth.models import User
        from apps.customers.models import Customer
        from apps.tenants.models import TenantUser

        user = User.objects.get(email='nuevo@gmail.com')
        assert not user.has_usable_password()

        customer = Customer.objects.get(user=user)
        assert customer.google_sub == 'google_sub_test_999'
        assert customer.tenant == self.tenant

        tenant_user = TenantUser.objects.get(user=user, tenant=self.tenant)
        assert tenant_user.is_current is True

    @patch('apps.core.views.google_id_token.verify_oauth2_token')
    def test_usuario_existente_devuelve_jwt(self, mock_verify, google_customer):
        """Email ya existe (google_customer fixture) -> login sin crear duplicados."""
        mock_verify.return_value = {
            **VALID_IDINFO,
            'sub': 'google_sub_test_123456',  # mismo sub del fixture
            'email': google_customer.email,
        }

        from apps.customers.models import Customer
        initial_count = Customer.objects.filter(tenant=self.tenant).count()

        response = self._post()

        assert response.status_code == status.HTTP_200_OK
        assert response.json()['user_id'] == google_customer.id
        # No se crearon clientes extra
        assert Customer.objects.filter(tenant=self.tenant).count() == initial_count

    @patch('apps.core.views.google_id_token.verify_oauth2_token')
    def test_google_sub_existente_autentica(self, mock_verify, google_customer):
        """Mismo sub de Google aunque cambie el email -> autentica por sub."""
        mock_verify.return_value = {
            **VALID_IDINFO,
            'sub': 'google_sub_test_123456',
            'email': 'diferente@gmail.com',  # email distinto al del fixture
        }

        response = self._post()

        assert response.status_code == status.HTTP_200_OK
        # Autentica al usuario correcto (el del fixture)
        assert response.json()['user_id'] == google_customer.id

    @patch('apps.core.views.google_id_token.verify_oauth2_token')
    def test_staff_existente_mantiene_rol(self, mock_verify, admin_user):
        """Email de admin existente -> autentica con rol admin, no degrada a customer."""
        mock_verify.return_value = {
            **VALID_IDINFO,
            'email': admin_user.email,
            'sub': 'google_sub_admin_999',
        }

        response = self._post()

        assert response.status_code == status.HTTP_200_OK
        assert response.json()['role'] in ['admin', 'owner', 'mechanic', 'advisor']

    # ------------------------------------------------------------------
    # Error cases
    # ------------------------------------------------------------------

    @patch('apps.core.views.google_id_token.verify_oauth2_token')
    def test_token_invalido_devuelve_401(self, mock_verify):
        """verify_oauth2_token lanza ValueError -> 401."""
        mock_verify.side_effect = ValueError('Token expired or invalid')

        response = self._post()

        assert response.status_code == status.HTTP_401_UNAUTHORIZED
        assert 'invalido' in response.json()['detail'].lower()

    def test_sin_tenant_slug_devuelve_400(self):
        """Body sin tenant_slug -> 400."""
        response = self.client.post(self.url, {
            'id_token': 'cualquier_token',
        }, format='json')

        assert response.status_code == status.HTTP_400_BAD_REQUEST

    def test_tenant_inexistente_devuelve_400(self):
        """Slug de tenant que no existe en BD -> 400."""
        with patch('apps.core.views.google_id_token.verify_oauth2_token') as mock_verify:
            mock_verify.return_value = VALID_IDINFO
            response = self._post(tenant_slug='slug-que-no-existe-xyz')

        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert 'Taller' in response.json()['detail']

    def test_sin_id_token_devuelve_400(self):
        """Body sin id_token -> 400."""
        response = self.client.post(self.url, {
            'tenant_slug': self.tenant.slug,
        }, format='json')

        assert response.status_code == status.HTTP_400_BAD_REQUEST
```

---

### PASO 9 — Frontend: instalar dependencia ✅ COMPLETADO

**Archivo:** `package.json` del frontend

**Comando desde el directorio del frontend:**
```bash
cd /home/yadhir/Documentos/vps/tallerv2/front-end-taller-pro
npm install @react-oauth/google@^0.12.1
```

Esto agrega automaticamente `"@react-oauth/google": "^0.12.1"` a `dependencies` en
`package.json`.

---

### PASO 10 — Frontend: GoogleOAuthProvider en main.tsx ✅ COMPLETADO

**Archivo:** `src/main.tsx`

**Cambio completo del archivo:**
```tsx
import { createRoot } from "react-dom/client";
import { GoogleOAuthProvider } from "@react-oauth/google";
import App from "./App.tsx";
import "./index.css";
import { applyThemeFromCache } from "./lib/tenant";

// Aplicar colores del tenant ANTES de renderizar React
// Evita el flash del color default al recargar (F5)
applyThemeFromCache();

createRoot(document.getElementById("root")!).render(
  <GoogleOAuthProvider clientId={import.meta.env.VITE_GOOGLE_CLIENT_ID || ""}>
    <App />
  </GoogleOAuthProvider>
);
```

**Por que no usar `<StrictMode>`:** El proyecto no lo usa actualmente (el `main.tsx`
original no lo tiene). No agregar cambios de comportamiento no relacionados.

---

### PASO 11 — Frontend: conectar botón Google en Login.tsx ✅ COMPLETADO

**Archivo:** `src/pages/Login.tsx`

**Cambio 1 — Nuevos imports al inicio del archivo:**
```tsx
import { useGoogleLogin } from '@react-oauth/google';
import { API_URL } from '@/config';
```

**Cambio 2 — Nuevo estado dentro del componente `Login` (despues de `const [showForgotPassword...]`):**
```tsx
const [isGoogleLoading, setIsGoogleLoading] = useState(false);
```

**Cambio 3 — Nueva funcion handler (despues de `handleSubmit`):**
```tsx
const handleGoogleSuccess = async (credentialResponse: { credential?: string }) => {
  if (!credentialResponse.credential) return;
  setIsGoogleLoading(true);
  setError('');

  try {
    // Obtener tenant del localStorage (guardado tras visitar el booking o login previo)
    const tenantConfig = localStorage.getItem('taller_tenant_config');
    const tenantSlug = tenantConfig
      ? JSON.parse(tenantConfig).slug
      : '';

    if (!tenantSlug) {
      setError('No se pudo identificar el taller. Recarga la pagina e intenta de nuevo.');
      return;
    }

    const response = await fetch(`${API_URL}/auth/google/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id_token: credentialResponse.credential,
        tenant_slug: tenantSlug,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || 'Error al autenticar con Google');
    }

    const data = await response.json();

    // Guardar tokens y datos de usuario (mismas claves que login normal)
    localStorage.setItem('taller_token', data.access);
    localStorage.setItem('taller_user', JSON.stringify({
      id: data.user_id,
      email: data.email,
      name: data.name,
      role: data.role,
    }));

    if (data.tenant && data.tenant.slug) {
      const { setCurrentTenant, applyTenantTheme } = await import('@/lib/tenant');
      setCurrentTenant(data.tenant.slug);
      localStorage.setItem('taller_tenant_config', JSON.stringify(data.tenant));
      applyTenantTheme(data.tenant);
    }

    // Redirigir segun rol (misma logica que handleSubmit)
    switch (data.role) {
      case 'mechanic':
        navigate('/mechanic');
        break;
      case 'customer':
        navigate('/customer');
        break;
      case 'advisor':
        navigate('/advisor');
        break;
      case 'superadmin':
      case 'admin':
      default:
        navigate('/dashboard');
        break;
    }
  } catch (err: any) {
    setError(err.message || 'Error al iniciar sesion con Google. Intenta de nuevo.');
    toast.error('Error con Google Sign-In');
  } finally {
    setIsGoogleLoading(false);
  }
};

const googleLogin = useGoogleLogin({
  onSuccess: handleGoogleSuccess,
  onError: () => {
    setError('El inicio de sesion con Google fue cancelado o fallo.');
    setIsGoogleLoading(false);
  },
  flow: 'implicit',
});
```

**Cambio 4 — Reemplazar el boton de Google existente (linea 132):**

El boton actual:
```tsx
<Button variant="outline" className="w-full gap-2" type="button">
  <svg ...>...</svg>
  Continuar con Google
</Button>
```

Se reemplaza por:
```tsx
<Button
  variant="outline"
  className="w-full gap-2"
  type="button"
  onClick={() => { setIsGoogleLoading(true); googleLogin(); }}
  disabled={isGoogleLoading}
>
  {isGoogleLoading ? (
    <Loader2 className="w-4 h-4 animate-spin" />
  ) : (
    <svg className="w-5 h-5" viewBox="0 0 24 24">
      <path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
      <path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
      <path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
      <path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
    </svg>
  )}
  {isGoogleLoading ? 'Conectando...' : 'Continuar con Google'}
</Button>
```

**Nota sobre `auth-context.tsx`:** El handler de Google en `Login.tsx` guarda los tokens
directamente en `localStorage` y llama `navigate()` manualmente, sin pasar por el
`AuthContext.login()`. Esto es intencionado para evitar duplicar la logica de fetch y
mantener el handler autocontenido. Sin embargo, significa que `useAuth().user` no se
actualiza en memoria hasta el proximo montaje del componente. Para sincronizar el estado
del contexto, se puede llamar `window.location.href = '/customer'` en lugar de
`navigate('/customer')` para forzar un remontaje completo, o exponer una funcion
`loginWithExternalData(data)` en `auth-context.tsx`. Ver seccion de Riesgos.

---

## 5. Migraciones Necesarias

```bash
# 1. Generar migracion del campo google_sub en Customer
docker compose exec web python manage.py makemigrations customers \
  --name customer_google_sub

# 2. Aplicar migracion
docker compose exec web python manage.py migrate

# 3. Verificar que la migracion se aplico
docker compose exec web python manage.py showmigrations customers
```

**Rollback si hay un problema:**
```bash
# Revertir la migracion (usa el numero de migracion anterior)
docker compose exec web python manage.py migrate customers XXXX_nombre_migracion_anterior
```

**Verificacion en PostgreSQL:**
```bash
docker compose exec db psql -U postgres -d taller_pro -c \
  "\d customers_customer" | grep google_sub
```

---

## 6. Variables de Entorno

### Backend — `backend-taller-pro/.env`

Agregar las siguientes variables (SIN los valores reales):

```env
# Google OAuth
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=

# App name (para emails)
APP_NAME=Autotronia

# Email SMTP (Parte B)
EMAIL_BACKEND=django.core.mail.backends.smtp.EmailBackend
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_USE_TLS=True
EMAIL_HOST_USER=
EMAIL_HOST_PASSWORD=
DEFAULT_FROM_EMAIL=
```

**Notas de seguridad:**
- `GOOGLE_OAUTH_CLIENT_ID`: No es secreto, puede estar en codigo. Igual va en `.env` para
  flexibilidad entre entornos (dev/staging/prod pueden tener distintos proyectos de GCP).
- `GOOGLE_OAUTH_CLIENT_SECRET`: Guardar en `.env` para referencia futura, NO se usa en
  el ID token flow actual.
- `EMAIL_HOST_PASSWORD`: App password de Gmail (16 chars sin espacios). Nunca en git.

### Frontend — `front-end-taller-pro/.env`

Agregar:

```env
VITE_GOOGLE_CLIENT_ID=
```

**Mismo valor que `GOOGLE_OAUTH_CLIENT_ID` del backend.** El Client ID es publico (se
expone en el HTML del bundle de Vite de todas formas).

### Para entorno local de desarrollo:

Copiar `.env.example` si existe, o agregar las variables directamente a `.env`.
El `EmailBackend` para dev local puede dejarse como `console`:
```env
EMAIL_BACKEND=django.core.mail.backends.console.EmailBackend
```

---

## 7. Configuracion en Google Cloud Console

Antes de desplegar, verificar estos puntos en la consola de GCP del proyecto:

1. **APIs & Services > OAuth consent screen**
   - Authorized domains: `autotronia.com`, `vercel.app`
   - Scopes: `email`, `profile`, `openid` (minimos necesarios)

2. **APIs & Services > Credentials > OAuth 2.0 Client ID**
   - Application type: **Web application**
   - Authorized JavaScript origins:
     - `https://app.autotronia.com`
     - `http://localhost:8081` (desarrollo)
   - Authorized redirect URIs: No aplica para ID token flow

3. **Mismo Client ID** en `VITE_GOOGLE_CLIENT_ID` (frontend) y
   `GOOGLE_OAUTH_CLIENT_ID` (backend).

---

## 8. Orden de Testing

### Backend — ejecutar en este orden

```bash
# 1. Verificar que la migracion es correcta
docker compose exec web python manage.py migrate --check

# 2. Solo los tests nuevos (rapido)
docker compose exec web pytest apps/core/tests/test_google_auth.py -v

# 3. Suite completa del core
docker compose exec web pytest apps/core/ -v

# 4. Suite completa (regresion)
docker compose exec web pytest --tb=short

# 5. Con cobertura
docker compose exec web pytest --cov=apps --cov-report=term-missing
```

**Tests manuales con curl:**
```bash
# Token invalido -> debe devolver 401
curl -X POST https://api.autotronia.com/api/auth/google/ \
  -H "Content-Type: application/json" \
  -d '{"id_token": "token_invalido", "tenant_slug": "mi-taller"}'

# Sin tenant_slug -> debe devolver 400
curl -X POST https://api.autotronia.com/api/auth/google/ \
  -H "Content-Type: application/json" \
  -d '{"id_token": "cualquier_token"}'
```

### Frontend — verificar en este orden

1. Abrir `http://localhost:8081/login` en modo cliente (`!isStaffMode`)
2. Verificar que el boton "Continuar con Google" abre el popup de Google
3. Completar el flujo con una cuenta Google de prueba
4. Verificar en DevTools > Application > LocalStorage:
   - `taller_token` contiene un JWT valido (`eyJ...`)
   - `taller_user` contiene `{ id, email, name, role: "customer" }`
   - `taller_tenant_config` contiene datos del tenant
5. Verificar que la redireccion a `/customer` ocurre correctamente
6. Recargar la pagina — verificar que no se pierde la sesion
7. Hacer logout y volver a loguear con Google — verificar que no crea usuario duplicado

---

## 9. Checklist de Verificacion

### Backend

- [x] `google-auth==2.28.0` en `requirements/base.txt`
- [x] `GOOGLE_OAUTH_CLIENT_ID` en `config/settings/base.py`
- [x] `APP_NAME` en `config/settings/base.py`
- [x] Campo `google_sub` en `apps/customers/models.py` con `unique=True, null=True`
- [x] Indice `google_sub` en `Meta.indexes` del modelo Customer
- [x] Migracion generada: `apps/customers/migrations/XXXX_customer_google_sub.py`
- [x] Migracion aplicada: `python manage.py migrate` sin errores
- [x] `GoogleAuthView` en `apps/core/views.py`
- [x] URL `api/auth/google/` en `config/urls.py`
- [x] Import de `GoogleAuthView` en `config/urls.py`
- [x] Texto hardcodeado "AutoClimas Robles" reemplazado en `password_reset/views.py`
- [x] Variables EMAIL_* en `.env` de produccion
- [x] Fixture `google_customer` en `conftest.py`
- [x] `apps/core/tests/test_google_auth.py` creado
- [x] `pytest apps/core/tests/test_google_auth.py` — 8/8 tests pasan

### Frontend

- [x] `@react-oauth/google` en `package.json` dependencies
- [x] `node_modules/@react-oauth/google` instalado (`npm install`)
- [x] `GoogleOAuthProvider` envuelve `App` en `main.tsx`
- [x] `VITE_GOOGLE_CLIENT_ID` en `.env` del frontend
- [x] Handler `handleGoogleSuccess` y `googleLogin` en `Login.tsx`
- [x] Boton Google conectado con `onClick={() => googleLogin()}`
- [x] Boton deshabilitado durante carga (`disabled={isGoogleLoading}`)
- [x] Spinner visible durante carga del Google flow

### Verificacion E2E

- [ ] `POST /api/auth/google/` devuelve `access + refresh` para usuario nuevo
- [ ] `POST /api/auth/google/` devuelve `access + refresh` para usuario existente
- [ ] Usuario nuevo tiene `Customer` creado bajo el tenant correcto
- [ ] Usuario existente staff mantiene su rol (no se degrada a customer)
- [ ] Token invalido devuelve 401 con mensaje legible
- [ ] Boton Google en `Login.tsx` abre popup de Google
- [ ] Tras login con Google, redireccion correcta segun rol
- [ ] Email de recuperacion de contrasena llega desde `autotronia.ventas@gmail.com`
- [ ] Subject del email dice "Autotronia" en lugar de "AutoClimas Robles"

---

## 10. Riesgos y Mitigaciones

### Riesgo 1: `auth-context.tsx` no sincroniza al login con Google

**Problema:** El handler de Google en `Login.tsx` guarda tokens en `localStorage` directamente
pero no llama `setUser()` del `AuthContext`. Si otro componente lee `useAuth().user`
inmediatamente despues del login con Google (sin recargar), obtendra `null`.

**Mitigacion:** Usar `window.location.href = '/customer'` en lugar de `navigate('/customer')`
para forzar un remontaje completo de React. El `AuthProvider` lee `localStorage` en `useEffect`
al montar, entonces el usuario quedara correctamente cargado.

**Alternativa a largo plazo:** Exponer una funcion `loginWithExternalData(userData, tokens)`
en `auth-context.tsx` que haga `setUser()` ademas de guardar en `localStorage`.

---

### Riesgo 2: tenant_slug no disponible en Login.tsx

**Problema:** El handler de Google necesita `tenant_slug`, pero el componente `Login`
no siempre tiene acceso al slug del taller. El `taller_tenant_config` en `localStorage`
podria estar vacio si el usuario llega directamente a `/login` sin haber visitado el
booking ni otra pagina del taller.

**Mitigacion A (recomendada):** Leer el slug desde la URL (`window.location.pathname` o
`useSearchParams`) si la URL de login incluye el tenant (ej: `/login?tenant=mi-taller`).

**Mitigacion B:** Mostrar un mensaje de error claro: "Para continuar con Google, accede
desde la pagina de tu taller." con un link al booking publico.

**Mitigacion C:** Si `taller_tenant_config` tiene el `slug` del ultimo tenant visitado,
usarlo como fallback (ya implementado en el paso 11).

---

### Riesgo 3: `unique_together = ['tenant', 'email']` en Customer

**Problema:** Si el mismo email ya existe como Customer en el mismo tenant (registrado
con contrasena), `GoogleAuthView` intentara crear un Customer duplicado y fallara con
`IntegrityError`.

**Mitigacion:** La logica del paso 5 busca por `email` en `User` ANTES de crear uno nuevo.
Si el `User` existe y tiene `customer_profile`, solo actualiza `google_sub`. El `IntegrityError`
solo ocurriria si hay un `Customer` con ese email pero sin `User` asociado — caso raro
(customers sin cuenta del sistema). En ese caso, el view devolveria un 500 no manejado.

**Mejora recomendada:** Agregar un bloque `try/except IntegrityError` en el paso 3 de
creacion del Customer, con respuesta 409: "Ya existe una cuenta con este email. Intenta
iniciar sesion con contrasena."

---

### Riesgo 4: GOOGLE_OAUTH_CLIENT_ID vacio en backend

**Problema:** Si `GOOGLE_OAUTH_CLIENT_ID` no esta configurado en `.env`, la funcion
`verify_oauth2_token` validara el token contra un `audience` vacio, lo que puede causar
comportamiento inesperado (aprobar cualquier token o lanzar excepcion distinta a ValueError).

**Mitigacion:** Agregar validacion al inicio de `GoogleAuthView.post`:
```python
if not settings.GOOGLE_OAUTH_CLIENT_ID:
    logger.error("GOOGLE_OAUTH_CLIENT_ID no esta configurado")
    return Response(
        {'detail': 'Google OAuth no esta configurado en el servidor.'},
        status=status.HTTP_503_SERVICE_UNAVAILABLE,
    )
```

---

### Riesgo 5: Rebuild del contenedor necesario tras agregar google-auth

**Problema:** Agregar `google-auth` a `requirements/base.txt` no instala la libreria en
el contenedor en ejecucion. El `pip install` manual del paso 1 es temporal.

**Mitigacion:** En produccion, siempre hacer:
```bash
docker compose build web
docker compose up -d web
```

En desarrollo local con `docker-compose.dev.yml`:
```bash
docker compose -f docker-compose.dev.yml build web
docker compose -f docker-compose.dev.yml up -d web
```

---

### Plan de Rollback

Si la implementacion causa regresiones:

**Backend:**
```bash
# Revertir la migracion de google_sub
docker compose exec web python manage.py migrate customers <migracion_anterior>

# Revertir cambios de codigo
git revert HEAD  # si se hizo commit
```

**Frontend:**
```bash
# Revertir npm install de @react-oauth/google
npm uninstall @react-oauth/google
# Revertir main.tsx y Login.tsx a version anterior
git checkout -- src/main.tsx src/pages/Login.tsx
```

El endpoint `POST /api/auth/google/` es **aditivo** — no modifica endpoints existentes.
El login con email/password (`CustomJWTLoginView`) no se toca. El rollback no afecta
usuarios activos con sesion normal.

---

## Appendix: Archivos Modificados por Agente

### Agente Backend (puede ejecutarse completamente primero)

| Paso | Archivo | Tipo de cambio |
|------|---------|----------------|
| 1 | `requirements/base.txt` | Agregar linea |
| 2 | `config/settings/base.py` | Agregar bloque de variables |
| 3 | `apps/customers/models.py` | Agregar campo + indice |
| 4 | `apps/customers/migrations/` | Generar via manage.py |
| 5 | `apps/core/views.py` | Agregar imports + clase GoogleAuthView |
| 6 | `config/urls.py` | Agregar import + path |
| 6B | `apps/password_reset/views.py` | Reemplazar texto hardcodeado |
| 7 | `conftest.py` | Agregar fixture google_customer |
| 8 | `apps/core/tests/test_google_auth.py` | Crear archivo nuevo |

### Agente Frontend (puede comenzar en paralelo desde el paso 9)

| Paso | Archivo | Tipo de cambio |
|------|---------|----------------|
| 9 | `package.json` | npm install @react-oauth/google |
| 10 | `src/main.tsx` | Envolver App con GoogleOAuthProvider |
| 11 | `src/pages/Login.tsx` | Agregar imports, estado, handlers, conectar boton |
| — | `.env` frontend | Agregar VITE_GOOGLE_CLIENT_ID |

### Solo variables de entorno (no requiere agente)

| Archivo | Variables a agregar |
|---------|---------------------|
| `backend-taller-pro/.env` (local + prod) | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `APP_NAME`, `EMAIL_*` |
| `front-end-taller-pro/.env` (local) | `VITE_GOOGLE_CLIENT_ID` |
| Vercel env vars (prod frontend) | `VITE_GOOGLE_CLIENT_ID` |
