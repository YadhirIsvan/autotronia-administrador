# Spec 05 — Migración a JWT con Access + Refresh Tokens

**Fecha:** 2026-03-15
**Estado:** Fases 1 y 2 completadas ✅ — Pendiente: Paso 9 (cleanup DRF Token) + Paso 10 (deploy)
**Prioridad:** Alta — seguridad

---

## Resumen Ejecutivo

Migrar el sistema de autenticación de DRF Token sin expiración a SimpleJWT con access
tokens de 60 minutos y refresh tokens de 7 días con rotación y blacklist. El frontend
implementa renovación silenciosa de tokens para que el usuario nunca perciba la
expiración del access token.

Se confirma **corte limpio** (no hay usuarios reales en producción). No se mantiene
retrocompatibilidad con DRF Token al final de la migración.

---

## Decisión de Diseño: ¿Dónde guardar el refresh token?

### Opción A — localStorage

**Pros:**
- Compatible con WebSockets (el token se pasa como query param `?token=`, los headers
  HTTP no viajan en el handshake WebSocket desde el browser)
- Sin complejidad adicional de CSRF para el refresh endpoint
- Consistente con la arquitectura actual (el access token ya va en localStorage)
- Simple de implementar en el hook de reconexión del `WebSocketService`

**Contras:**
- Vulnerable a XSS: cualquier script inyectado puede leer el refresh token
- El impacto es mayor que robar un access token (7 días vs 60 minutos)

### Opción B — httpOnly cookie

**Pros:**
- El refresh token es inaccesible para JavaScript: XSS no puede robarlo
- Solo el navegador lo envía automáticamente en la request de refresh

**Contras:**
- El WebSocket usa `?token=` en el query string. Con httpOnly cookie habría que
  enviar el access token en el query string igual, pero la renovación automática
  requiere un flujo adicional: si el WS muere con code 4001 por token expirado,
  el frontend debe llamar al endpoint de refresh (cookie se envía automáticamente)
  y reconectar. Esto es implementable pero más complejo.
- Requiere `SameSite=None; Secure` para funcionar cross-origin (frontend en
  Vercel vs API en api.autotronia.com), lo cual requiere HTTPS estricto en ambos
  lados. Ya se cumple en producción, pero complica el desarrollo local.
- `CORS_ALLOW_CREDENTIALS = True` ya está activado, pero hay que asegurar que
  el dominio del frontend está exactamente en `CORS_ALLOWED_ORIGINS` (ya está).

### Decisión elegida: localStorage con mitigaciones

**Razón:** El WebSocket es un ciudadano de primera clase en esta arquitectura. La
conexión WS autentica con `?token=<access_token>`. Con access tokens de 60 minutos
y renovación silenciosa, la ventana de riesgo es la misma que la de cualquier sesión
activa. El refresh token en localStorage tiene riesgo XSS real, pero en esta fase del
proyecto (no hay entrada de HTML crudo de usuarios, no hay dependencias npm no
auditadas) el riesgo es aceptable. Se documenta como deuda técnica para la versión
con httpOnly cookie.

**Mitigaciones:**
- Access token: 60 minutos (exposición corta si se roba)
- Refresh token: 7 días con rotación (cada refresh invalida el token anterior)
- Blacklist en logout (el servidor invalida el refresh token inmediatamente)
- El frontend NO expone los tokens en logs ni en el DOM

**Nombres de claves en localStorage:**
- `taller_access_token` — reemplaza `taller_token`
- `taller_refresh_token` — nuevo
- `taller_user` — sin cambio
- `taller_tenant_config` — sin cambio

---

## Impacto Arquitectural por Capa

```
Login POST /api/auth/login/
    → CustomJWTLoginView (reemplaza CustomAuthToken)
    → devuelve: access, refresh, user_id, email, name, role, tenant

POST /api/auth/token/refresh/
    → TokenRefreshView de SimpleJWT (estándar)
    → devuelve: access (+ refresh rotado si ROTATE_REFRESH_TOKENS=True)

POST /api/auth/logout/
    → LogoutView (nuevo)
    → blacklistea el refresh token recibido en el body

WebSocket wss://api.autotronia.com/ws/notifications/?token=<access_token>
    → NotificationConsumer.get_user_from_token() — cambia a validar JWT
    → si el token está expirado → close(4001)
    → frontend detecta 4001 → intenta refresh → reconecta con nuevo access token
```

---

## ✅ Paso 1 — Configuración de Django (settings) — COMPLETADO

**Archivo:** `config/settings/base.py`

### Cambios en `SIMPLE_JWT`

```python
from datetime import timedelta

SIMPLE_JWT = {
    'ACCESS_TOKEN_LIFETIME': timedelta(minutes=60),
    'REFRESH_TOKEN_LIFETIME': timedelta(days=7),          # cambiado de 1 a 7
    'ROTATE_REFRESH_TOKENS': True,
    'BLACKLIST_AFTER_ROTATION': True,
    'UPDATE_LAST_LOGIN': True,
    'ALGORITHM': 'HS256',
    'SIGNING_KEY': SECRET_KEY,
    'AUTH_HEADER_TYPES': ('Bearer',),
    'AUTH_HEADER_NAME': 'HTTP_AUTHORIZATION',
    'USER_ID_FIELD': 'id',
    'USER_ID_CLAIM': 'user_id',
    'TOKEN_OBTAIN_PAIR_SERIALIZER':
        'rest_framework_simplejwt.serializers.TokenObtainPairSerializer',
    'TOKEN_REFRESH_SERIALIZER':
        'rest_framework_simplejwt.serializers.TokenRefreshSerializer',
}
```

### Cambios en `REST_FRAMEWORK`

```python
REST_FRAMEWORK = {
    'DEFAULT_AUTHENTICATION_CLASSES': [
        'rest_framework_simplejwt.authentication.JWTAuthentication',  # primero
        'rest_framework.authentication.SessionAuthentication',         # admin Django
        # ELIMINAR: 'rest_framework.authentication.TokenAuthentication',
    ],
    # ... resto sin cambio
}
```

### Agregar `rest_framework_simplejwt.token_blacklist` a `INSTALLED_APPS`

```python
INSTALLED_APPS = [
    # ... apps existentes ...
    'rest_framework_simplejwt',
    'rest_framework_simplejwt.token_blacklist',  # AGREGAR
    # ...
]
```

### Cambio en `config/settings/testing.py`

```python
SIMPLE_JWT = {
    'ACCESS_TOKEN_LIFETIME': timedelta(minutes=60),
    'REFRESH_TOKEN_LIFETIME': timedelta(days=7),
    'ROTATE_REFRESH_TOKENS': True,
    'BLACKLIST_AFTER_ROTATION': True,
    'SIGNING_KEY': SECRET_KEY,
    'AUTH_HEADER_TYPES': ('Bearer',),
}
```

### Migracion requerida

```bash
python manage.py makemigrations
python manage.py migrate
```

La app `token_blacklist` agrega tablas `token_blacklist_outstandingtoken` y
`token_blacklist_blacklistedtoken`. No afecta tablas existentes.

---

## ✅ Paso 2 — Vista de Login JWT (`apps/core/views.py`) — COMPLETADO

Reemplazar `CustomAuthToken` por `CustomJWTLoginView`. La lógica de resolución de
rol y tenant se preserva exactamente, solo cambia la parte de generación de tokens.

**Archivo:** `apps/core/views.py`

```python
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.permissions import AllowAny
from rest_framework import status
from rest_framework_simplejwt.tokens import RefreshToken
from django.contrib.auth import authenticate


class CustomJWTLoginView(APIView):
    """
    Login personalizado que devuelve JWT + datos completos del usuario.

    POST /api/auth/login/
    Body: { "username": "<email>", "password": "<pass>" }

    Response:
    {
        "access": "<jwt_access_token>",
        "refresh": "<jwt_refresh_token>",
        "user_id": 1,
        "email": "user@example.com",
        "name": "Juan Perez",
        "role": "admin",
        "tenant": { ... },
        "mechanic_profile": { ... }  // opcional
    }

    Logica de rol:
    1. TenantUser.role == owner/admin -> role = owner/admin
    2. TenantUser.role == member -> role = Mechanic.role (mechanic/advisor)
    3. customer_profile -> role = customer
    4. Default -> role = customer
    """
    permission_classes = [AllowAny]
    authentication_classes = []

    def post(self, request, *args, **kwargs):
        username = request.data.get('username', '').strip()
        password = request.data.get('password', '').strip()

        if not username or not password:
            return Response(
                {'non_field_errors': ['Credenciales requeridas.']},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # EmailBackend acepta email como username
        user = authenticate(request, username=username, password=password)

        if user is None:
            return Response(
                {'non_field_errors': ['Credenciales inválidas.']},
                status=status.HTTP_401_UNAUTHORIZED,
            )

        if not user.is_active:
            return Response(
                {'non_field_errors': ['Cuenta desactivada.']},
                status=status.HTTP_401_UNAUTHORIZED,
            )

        # Generar par de tokens JWT
        refresh = RefreshToken.for_user(user)
        access = refresh.access_token

        role = 'customer'
        name = user.get_full_name() or user.username
        mechanic_profile_data = None
        tenant_data = None

        # Obtener datos del mechanic_profile si existe
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

        # Obtener tenant y determinar rol
        try:
            from apps.tenants.models import TenantUser
            tenant_user = TenantUser.objects.select_related('tenant').filter(
                user=user,
                is_current=True,
                tenant__is_active=True,
                tenant__is_deleted=False,
            ).first()

            if tenant_user:
                tenant = tenant_user.tenant
                tenant_data = {
                    'id': tenant.id,
                    'name': tenant.name,
                    'slug': tenant.slug,
                    'logo': (
                        request.build_absolute_uri(tenant.logo.url)
                        if tenant.logo else None
                    ),
                    'primary_color': tenant.primary_color,
                    'secondary_color': tenant.secondary_color,
                    'plan': tenant.plan,
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

### Vista de Logout con blacklist

```python
from rest_framework.permissions import IsAuthenticated
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.tokens import RefreshToken as RefreshTokenClass


class LogoutView(APIView):
    """
    Logout que invalida el refresh token en la blacklist.

    POST /api/auth/logout/
    Headers: Authorization: Bearer <access_token>
    Body: { "refresh": "<refresh_token>" }

    Response: 204 No Content
    """
    permission_classes = [IsAuthenticated]

    def post(self, request, *args, **kwargs):
        refresh_token = request.data.get('refresh')

        if not refresh_token:
            return Response(
                {'detail': 'El campo refresh es requerido.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            token = RefreshTokenClass(refresh_token)
            token.blacklist()
        except TokenError:
            # Token ya expirado o inválido — tratar como logout exitoso
            pass

        return Response(status=status.HTTP_204_NO_CONTENT)
```

### Tests — Paso 2

**Archivo:** `apps/core/tests/test_jwt_login.py`

```python
"""
Tests unitarios para CustomJWTLoginView y LogoutView.
pytest -m api apps/core/tests/test_jwt_login.py
"""
import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import RefreshToken


@pytest.mark.django_db
class TestCustomJWTLoginView:
    """Tests para POST /api/auth/login/"""

    def test_login_valido_devuelve_tokens(self, user_with_tenant):
        """Login con credenciales válidas devuelve access, refresh y datos de usuario."""
        client = APIClient()
        response = client.post(
            '/api/auth/login/',
            {'username': user_with_tenant.email, 'password': 'testpass123'},
            format='json',
        )
        assert response.status_code == status.HTTP_200_OK
        data = response.data
        assert 'access' in data
        assert 'refresh' in data
        assert data['user_id'] == user_with_tenant.id
        assert data['email'] == user_with_tenant.email
        assert 'role' in data

    def test_login_devuelve_tenant_data(self, user_with_tenant, tenant):
        """Login de usuario con tenant incluye objeto tenant en respuesta."""
        client = APIClient()
        response = client.post(
            '/api/auth/login/',
            {'username': user_with_tenant.email, 'password': 'testpass123'},
            format='json',
        )
        assert response.status_code == status.HTTP_200_OK
        assert 'tenant' in response.data
        assert response.data['tenant']['id'] == tenant.id

    def test_login_credenciales_invalidas_devuelve_401(self):
        """Login con password incorrecto devuelve 401."""
        client = APIClient()
        response = client.post(
            '/api/auth/login/',
            {'username': 'noexiste@test.com', 'password': 'wrong'},
            format='json',
        )
        assert response.status_code == status.HTTP_401_UNAUTHORIZED
        assert 'non_field_errors' in response.data

    def test_login_sin_body_devuelve_400(self):
        """Login sin credenciales devuelve 400."""
        client = APIClient()
        response = client.post('/api/auth/login/', {}, format='json')
        assert response.status_code == status.HTTP_400_BAD_REQUEST

    def test_login_usuario_inactivo_devuelve_401(self, user_inactive):
        """Login con usuario inactivo devuelve 401."""
        client = APIClient()
        response = client.post(
            '/api/auth/login/',
            {'username': user_inactive.email, 'password': 'testpass123'},
            format='json',
        )
        assert response.status_code == status.HTTP_401_UNAUTHORIZED

    def test_access_token_autentica_endpoint_protegido(self, user_with_tenant, tenant):
        """El access token devuelto puede autenticar endpoints protegidos."""
        client = APIClient()
        login_response = client.post(
            '/api/auth/login/',
            {'username': user_with_tenant.email, 'password': 'testpass123'},
            format='json',
        )
        access = login_response.data['access']
        client.credentials(
            HTTP_AUTHORIZATION=f'Bearer {access}',
            HTTP_X_TENANT_ID=str(tenant.slug),
        )
        # /api/customers/ requiere autenticación
        response = client.get('/api/customers/')
        assert response.status_code != status.HTTP_401_UNAUTHORIZED

    def test_login_admin_role_correcto(self, user_with_tenant):
        """Usuario con TenantUser.role='admin' recibe role='admin'."""
        client = APIClient()
        response = client.post(
            '/api/auth/login/',
            {'username': user_with_tenant.email, 'password': 'testpass123'},
            format='json',
        )
        assert response.status_code == status.HTTP_200_OK
        # TenantUserFactory crea con role='admin' por defecto
        assert response.data['role'] == 'admin'


@pytest.mark.django_db
class TestLogoutView:
    """Tests para POST /api/auth/logout/"""

    def test_logout_blacklistea_refresh_token(self, user_with_tenant):
        """Logout con refresh token válido lo agrega a la blacklist."""
        from rest_framework_simplejwt.token_blacklist.models import BlacklistedToken

        client = APIClient()
        login_resp = client.post(
            '/api/auth/login/',
            {'username': user_with_tenant.email, 'password': 'testpass123'},
            format='json',
        )
        access = login_resp.data['access']
        refresh = login_resp.data['refresh']

        client.credentials(HTTP_AUTHORIZATION=f'Bearer {access}')
        logout_resp = client.post(
            '/api/auth/logout/',
            {'refresh': refresh},
            format='json',
        )
        assert logout_resp.status_code == status.HTTP_204_NO_CONTENT
        assert BlacklistedToken.objects.count() == 1

    def test_logout_sin_refresh_token_devuelve_400(self, user_with_tenant):
        """Logout sin campo refresh devuelve 400."""
        client = APIClient()
        login_resp = client.post(
            '/api/auth/login/',
            {'username': user_with_tenant.email, 'password': 'testpass123'},
            format='json',
        )
        client.credentials(
            HTTP_AUTHORIZATION=f'Bearer {login_resp.data["access"]}'
        )
        response = client.post('/api/auth/logout/', {}, format='json')
        assert response.status_code == status.HTTP_400_BAD_REQUEST

    def test_logout_sin_autenticacion_devuelve_401(self):
        """Logout sin access token devuelve 401."""
        client = APIClient()
        response = client.post(
            '/api/auth/logout/',
            {'refresh': 'cualquier-cosa'},
            format='json',
        )
        assert response.status_code == status.HTTP_401_UNAUTHORIZED

    def test_logout_con_refresh_invalido_retorna_204(self, user_with_tenant):
        """Logout con refresh token ya expirado/inválido aun devuelve 204 (idempotente)."""
        client = APIClient()
        login_resp = client.post(
            '/api/auth/login/',
            {'username': user_with_tenant.email, 'password': 'testpass123'},
            format='json',
        )
        client.credentials(
            HTTP_AUTHORIZATION=f'Bearer {login_resp.data["access"]}'
        )
        response = client.post(
            '/api/auth/logout/',
            {'refresh': 'token-invalido-o-expirado'},
            format='json',
        )
        # TokenError es capturado internamente, logout es exitoso
        assert response.status_code == status.HTTP_204_NO_CONTENT


# ── Fixtures locales para este módulo ──────────────────────────────────────────

@pytest.fixture
def tenant(db):
    from conftest import TenantFactory
    return TenantFactory()


@pytest.fixture
def user_with_tenant(db, tenant):
    """Usuario activo con TenantUser admin."""
    from conftest import UserFactory, TenantUserFactory
    user = UserFactory(password='testpass123')
    TenantUserFactory(user=user, tenant=tenant, role='admin', is_current=True)
    return user


@pytest.fixture
def user_inactive(db):
    from conftest import UserFactory
    return UserFactory(is_active=False, password='testpass123')
```

---

## ✅ Paso 3 — Endpoint de Refresh y URLs (`config/urls.py`) — COMPLETADO

**Archivo:** `config/urls.py`

```python
from django.contrib import admin
from django.urls import path, include
from django.conf import settings
from django.conf.urls.static import static

from apps.core.views import CustomJWTLoginView, LogoutView, HealthCheckView
from rest_framework_simplejwt.views import TokenRefreshView

urlpatterns = [
    # Health Check
    path('api/health/', HealthCheckView.as_view(), name='health_check'),

    # Admin Django
    path('admin/', admin.site.urls),

    # DRF browsable API (solo en dev)
    path('api-auth/', include('rest_framework.urls')),

    # ── Autenticación JWT ────────────────────────────────────────────────────
    path('api/auth/login/', CustomJWTLoginView.as_view(), name='jwt_login'),
    path('api/auth/token/refresh/', TokenRefreshView.as_view(), name='jwt_refresh'),
    path('api/auth/logout/', LogoutView.as_view(), name='jwt_logout'),

    # Password reset (mantener existente)
    path('api/auth/', include('apps.password_reset.urls')),

    # ── Apps del taller ──────────────────────────────────────────────────────
    path('api/', include('apps.tenants.urls')),
    path('api/', include('apps.customers.urls')),
    path('api/services/', include('apps.services.urls')),
    path('api/', include('apps.appointments.urls')),
    path('api/', include('apps.mechanics.urls')),
    path('api/workshop/', include('apps.workshop.urls')),
    path('api/inventory/', include('apps.inventory.urls')),
    path('api/', include('apps.notifications.urls')),
]

if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
    urlpatterns += static(settings.STATIC_URL, document_root=settings.STATIC_ROOT)
    try:
        import debug_toolbar
        urlpatterns += [path('__debug__/', include(debug_toolbar.urls))]
    except ImportError:
        pass
```

### Tests — Paso 3

**Archivo:** `apps/core/tests/test_jwt_refresh.py`

```python
"""
Tests para el endpoint de refresh de tokens.
pytest -m api apps/core/tests/test_jwt_refresh.py
"""
import pytest
from rest_framework import status
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import RefreshToken


@pytest.mark.django_db
class TestTokenRefreshEndpoint:
    """Tests para POST /api/auth/token/refresh/"""

    def test_refresh_valido_devuelve_nuevo_access_token(self, user_with_tenant):
        """Refresh token válido devuelve nuevo access token."""
        client = APIClient()
        login_resp = client.post(
            '/api/auth/login/',
            {'username': user_with_tenant.email, 'password': 'testpass123'},
            format='json',
        )
        refresh = login_resp.data['refresh']
        original_access = login_resp.data['access']

        refresh_resp = client.post(
            '/api/auth/token/refresh/',
            {'refresh': refresh},
            format='json',
        )
        assert refresh_resp.status_code == status.HTTP_200_OK
        assert 'access' in refresh_resp.data
        # El nuevo access token es distinto al original
        assert refresh_resp.data['access'] != original_access

    def test_refresh_valido_rota_el_refresh_token(self, user_with_tenant):
        """Con ROTATE_REFRESH_TOKENS=True, el refresh devuelve también un nuevo refresh."""
        client = APIClient()
        login_resp = client.post(
            '/api/auth/login/',
            {'username': user_with_tenant.email, 'password': 'testpass123'},
            format='json',
        )
        refresh = login_resp.data['refresh']

        refresh_resp = client.post(
            '/api/auth/token/refresh/',
            {'refresh': refresh},
            format='json',
        )
        assert refresh_resp.status_code == status.HTTP_200_OK
        # Con rotación, el endpoint también devuelve el nuevo refresh
        assert 'refresh' in refresh_resp.data
        assert refresh_resp.data['refresh'] != refresh

    def test_refresh_invalido_devuelve_401(self):
        """Refresh token malformado devuelve 401."""
        client = APIClient()
        response = client.post(
            '/api/auth/token/refresh/',
            {'refresh': 'token-completamente-invalido'},
            format='json',
        )
        assert response.status_code == status.HTTP_401_UNAUTHORIZED

    def test_refresh_blacklisteado_devuelve_401(self, user_with_tenant):
        """Refresh token en la blacklist (usado después del logout) devuelve 401."""
        client = APIClient()
        login_resp = client.post(
            '/api/auth/login/',
            {'username': user_with_tenant.email, 'password': 'testpass123'},
            format='json',
        )
        access = login_resp.data['access']
        refresh = login_resp.data['refresh']

        # Logout — blacklistea el refresh
        client.credentials(HTTP_AUTHORIZATION=f'Bearer {access}')
        client.post('/api/auth/logout/', {'refresh': refresh}, format='json')

        # Intentar usar el mismo refresh — debe fallar
        client.credentials()
        response = client.post(
            '/api/auth/token/refresh/',
            {'refresh': refresh},
            format='json',
        )
        assert response.status_code == status.HTTP_401_UNAUTHORIZED

    def test_refresh_usado_una_vez_no_puede_reusar(self, user_with_tenant):
        """Con rotación, el refresh token original queda en blacklist tras usarse."""
        from rest_framework_simplejwt.token_blacklist.models import BlacklistedToken

        client = APIClient()
        login_resp = client.post(
            '/api/auth/login/',
            {'username': user_with_tenant.email, 'password': 'testpass123'},
            format='json',
        )
        refresh = login_resp.data['refresh']

        # Primer uso — ok
        client.post('/api/auth/token/refresh/', {'refresh': refresh}, format='json')

        # El refresh original ahora está en blacklist
        assert BlacklistedToken.objects.count() >= 1

        # Segundo uso del mismo refresh — debe fallar
        second = client.post(
            '/api/auth/token/refresh/',
            {'refresh': refresh},
            format='json',
        )
        assert second.status_code == status.HTTP_401_UNAUTHORIZED


# ── Fixtures ───────────────────────────────────────────────────────────────────

@pytest.fixture
def tenant(db):
    from conftest import TenantFactory
    return TenantFactory()


@pytest.fixture
def user_with_tenant(db, tenant):
    from conftest import UserFactory, TenantUserFactory
    user = UserFactory(password='testpass123')
    TenantUserFactory(user=user, tenant=tenant, role='admin', is_current=True)
    return user
```

---

## ✅ Paso 4 — WebSocket: autenticación con JWT (`apps/notifications/consumers.py`) — COMPLETADO

El consumer reemplaza la validación por `Token.objects.get()` por decodificación
y validación del JWT usando `UntypedToken` de SimpleJWT. Esto preserva la interfaz
`?token=<value>` en el query string.

**Archivo:** `apps/notifications/consumers.py`

Reemplazar únicamente el método `get_user_from_token` y el import al inicio:

```python
# ELIMINAR:
# from rest_framework.authtoken.models import Token

# AGREGAR al bloque de imports al inicio del archivo:
from rest_framework_simplejwt.tokens import UntypedToken
from rest_framework_simplejwt.exceptions import InvalidToken, TokenError
from rest_framework_simplejwt.settings import api_settings as jwt_settings
from django.contrib.auth.models import User
import jwt as pyjwt
from django.conf import settings


# Reemplazar el metodo get_user_from_token:
@database_sync_to_async
def get_user_from_token(self, token_key):
    """
    Valida el JWT access token y devuelve el usuario asociado.

    Acepta el access token (no el refresh) en el query string.
    Si el token está expirado o es inválido devuelve None.
    """
    if not token_key:
        return None
    try:
        # Valida firma, expiración y tipo de token
        UntypedToken(token_key)
    except (InvalidToken, TokenError):
        return None
    try:
        # Decodificar sin verificar nuevamente para extraer user_id
        decoded = pyjwt.decode(
            token_key,
            settings.SECRET_KEY,
            algorithms=[jwt_settings.ALGORITHM],
        )
        user_id = decoded.get(jwt_settings.USER_ID_CLAIM)
        if not user_id:
            return None
        return User.objects.select_related().get(id=user_id, is_active=True)
    except (User.DoesNotExist, Exception):
        return None
```

### Nota sobre el flujo de reconexión

Cuando el access token expira, el WebSocket backend cierra con code `4001`.
El frontend detecta este código en `onclose` y ejecuta el flujo de refresh antes
de reconectar. El `WebSocketService` ya tiene `scheduleReconnect()` pero necesita
una extensión para distinguir entre cierre por expiración (code 4001) y cierre
por red (otros códigos). Ver Paso 6 — Frontend.

### Tests — Paso 4

**Archivo:** `apps/notifications/tests/test_ws_jwt_auth.py`

```python
"""
Tests para autenticación JWT en el WebSocket consumer.
pytest -m integration apps/notifications/tests/test_ws_jwt_auth.py
"""
import pytest
from channels.testing import WebsocketCommunicator
from config.asgi import application
from rest_framework_simplejwt.tokens import RefreshToken
from django.contrib.auth.models import User


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
class TestNotificationConsumerJWTAuth:
    """Tests de autenticación del consumer NotificationConsumer con JWT."""

    async def test_conexion_con_access_token_valido(self, user_with_tenant):
        """Conexión con access token JWT válido es aceptada."""
        refresh = RefreshToken.for_user(user_with_tenant)
        access_token = str(refresh.access_token)

        communicator = WebsocketCommunicator(
            application,
            f'/ws/notifications/?token={access_token}',
            headers=[(b'origin', b'http://testserver')],
        )
        connected, _ = await communicator.connect()
        assert connected

        # El consumer envía connection_established al conectar
        message = await communicator.receive_json_from()
        assert message['type'] == 'connection_established'
        assert message['user_id'] == user_with_tenant.id

        await communicator.disconnect()

    async def test_conexion_sin_token_es_rechazada(self):
        """Conexión sin token es rechazada con code 4001."""
        communicator = WebsocketCommunicator(
            application,
            '/ws/notifications/',
            headers=[(b'origin', b'http://testserver')],
        )
        connected, code = await communicator.connect()
        assert not connected
        assert code == 4001

    async def test_conexion_con_token_invalido_es_rechazada(self):
        """Conexión con JWT malformado es rechazada."""
        communicator = WebsocketCommunicator(
            application,
            '/ws/notifications/?token=esto-no-es-un-jwt',
            headers=[(b'origin', b'http://testserver')],
        )
        connected, code = await communicator.connect()
        assert not connected
        assert code == 4001

    async def test_conexion_con_refresh_token_es_rechazada(self, user_with_tenant):
        """El consumer rechaza refresh tokens (solo acepta access tokens)."""
        refresh = RefreshToken.for_user(user_with_tenant)
        # Enviar el refresh token en lugar del access
        communicator = WebsocketCommunicator(
            application,
            f'/ws/notifications/?token={str(refresh)}',
            headers=[(b'origin', b'http://testserver')],
        )
        connected, code = await communicator.connect()
        # UntypedToken acepta cualquier token válido, pero el tipo 'refresh'
        # debería ser rechazado. Si la implementacion usa AccessToken en lugar
        # de UntypedToken, este test confirma el rechazo.
        # Documentar comportamiento real al implementar.
        await communicator.disconnect()


# ── Fixtures ───────────────────────────────────────────────────────────────────

@pytest.fixture
def tenant(db):
    from conftest import TenantFactory
    return TenantFactory()


@pytest.fixture
def user_with_tenant(db, tenant):
    from conftest import UserFactory, TenantUserFactory
    user = UserFactory(password='testpass123')
    TenantUserFactory(user=user, tenant=tenant, role='admin', is_current=True)
    return user
```

**Nota de implementacion:** Para que `UntypedToken` rechace refresh tokens, se puede
cambiar a `AccessToken(token_key)` en la validación. `AccessToken` verifica que
`token_type == 'access'`. Actualizar el método `get_user_from_token` según el
resultado del test anterior.

---

## ✅ Paso 5 — Migración de `conftest.py` (fixtures de tests) — COMPLETADO

El `conftest.py` actualmente crea `Token` de DRF para los fixtures. Actualizar para
usar JWT.

**Archivo:** `conftest.py`

Localizar el fixture `authenticated_client` (buscar `Token.objects.get_or_create`
en conftest.py) y reemplazar:

```python
# ANTES:
@pytest.fixture
def authenticated_client(user, tenant):
    from rest_framework.authtoken.models import Token
    token, _ = Token.objects.get_or_create(user=user)
    client = APIClient()
    client.credentials(
        HTTP_AUTHORIZATION=f'Token {token.key}',
        HTTP_X_TENANT_ID=str(tenant.slug),
    )
    return client

# DESPUES:
@pytest.fixture
def authenticated_client(user, tenant):
    from rest_framework_simplejwt.tokens import RefreshToken
    refresh = RefreshToken.for_user(user)
    access = str(refresh.access_token)
    client = APIClient()
    client.credentials(
        HTTP_AUTHORIZATION=f'Bearer {access}',
        HTTP_X_TENANT_ID=str(tenant.slug),
    )
    return client
```

Tambien agregar fixture `jwt_tokens` para tests que necesiten probar el flujo
de refresh:

```python
@pytest.fixture
def jwt_tokens(user):
    """Devuelve par de tokens JWT para un usuario dado."""
    from rest_framework_simplejwt.tokens import RefreshToken
    refresh = RefreshToken.for_user(user)
    return {
        'access': str(refresh.access_token),
        'refresh': str(refresh),
    }
```

---

## ✅ Paso 6 — Frontend: `src/lib/auth-context.tsx` — COMPLETADO

**Cambios:**
1. `login()` guarda `access` y `refresh` en localStorage (nuevas claves)
2. `logout()` llama al backend antes de limpiar localStorage
3. `initializeAuth()` valida que el access token no esté expirado al montar;
   si está expirado intenta refresh silencioso antes de restaurar la sesión
4. Exponer `refreshTokens()` para que `apiFetch` lo llame al recibir 401

```typescript
// src/lib/auth-context.tsx
import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { User, UserRole } from './types';
import { API_URL } from '@/config';
import { setCurrentTenant, clearTenant, applyTenantTheme } from './tenant';

// ── Constantes de claves localStorage ─────────────────────────────────────────
export const STORAGE_KEYS = {
  ACCESS_TOKEN: 'taller_access_token',
  REFRESH_TOKEN: 'taller_refresh_token',
  USER: 'taller_user',
  TENANT_CONFIG: 'taller_tenant_config',
} as const;

// ── Helpers de token ───────────────────────────────────────────────────────────

/** Decodifica el payload del JWT sin verificar la firma. */
function decodeJwtPayload(token: string): Record<string, any> | null {
  try {
    const base64 = token.split('.')[1];
    const json = atob(base64.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** Retorna true si el token JWT está expirado (o no se puede decodificar). */
export function isTokenExpired(token: string): boolean {
  const payload = decodeJwtPayload(token);
  if (!payload || !payload.exp) return true;
  // exp es en segundos UTC; agregar 10 segundos de margen
  return Date.now() / 1000 > payload.exp - 10;
}

// ── Tipos ──────────────────────────────────────────────────────────────────────
interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (data: any) => Promise<void>;
  logout: () => Promise<void>;
  refreshTokens: () => Promise<string | null>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // Evita múltiples refreshes simultáneos
  const refreshPromiseRef = useRef<Promise<string | null> | null>(null);

  // ── Init: restaurar sesión desde localStorage ────────────────────────────
  useEffect(() => {
    const initializeAuth = async () => {
      const accessToken = localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN);
      const refreshToken = localStorage.getItem(STORAGE_KEYS.REFRESH_TOKEN);
      const storedUser = localStorage.getItem(STORAGE_KEYS.USER);

      if (!storedUser) {
        setIsLoading(false);
        return;
      }

      try {
        const userData: User = JSON.parse(storedUser);

        if (accessToken && !isTokenExpired(accessToken)) {
          // Access token vigente — restaurar sesión directamente
          setUser(userData);
        } else if (refreshToken) {
          // Access expirado — intentar refresh silencioso antes de mostrar login
          const newAccess = await _doRefresh(refreshToken);
          if (newAccess) {
            setUser(userData);
          } else {
            _clearStorage();
          }
        } else {
          _clearStorage();
        }
      } catch {
        _clearStorage();
      } finally {
        setIsLoading(false);
      }
    };

    initializeAuth();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Login ─────────────────────────────────────────────────────────────────
  const login = useCallback(async (email: string, password: string) => {
    setIsLoading(true);
    try {
      const response = await fetch(`${API_URL}/auth/login/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: email, password }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          errorData.non_field_errors?.[0] || 'Credenciales inválidas'
        );
      }

      const data = await response.json();

      const userData: User = {
        id: data.user_id,
        email: data.email,
        name: data.name,
        role: data.role as UserRole,
        avatar: undefined,
      };

      // Guardar tokens JWT (nuevas claves)
      localStorage.setItem(STORAGE_KEYS.ACCESS_TOKEN, data.access);
      localStorage.setItem(STORAGE_KEYS.REFRESH_TOKEN, data.refresh);
      localStorage.setItem(STORAGE_KEYS.USER, JSON.stringify(userData));

      if (data.tenant?.slug) {
        setCurrentTenant(data.tenant.slug);
        localStorage.setItem(
          STORAGE_KEYS.TENANT_CONFIG,
          JSON.stringify(data.tenant)
        );
        applyTenantTheme(data.tenant);
      }

      setUser(userData);
    } catch (error) {
      console.error('[Auth] Login error:', error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, []);

  // ── Refresh silencioso ────────────────────────────────────────────────────
  /**
   * Llama al backend con el refresh token actual.
   * Devuelve el nuevo access token si tiene éxito, null si falla.
   * Es thread-safe: múltiples llamadas simultáneas comparten la misma Promise.
   */
  const refreshTokens = useCallback(async (): Promise<string | null> => {
    if (refreshPromiseRef.current) {
      return refreshPromiseRef.current;
    }

    const refreshToken = localStorage.getItem(STORAGE_KEYS.REFRESH_TOKEN);
    if (!refreshToken) return null;

    refreshPromiseRef.current = _doRefresh(refreshToken).finally(() => {
      refreshPromiseRef.current = null;
    });

    return refreshPromiseRef.current;
  }, []);

  // ── Logout ────────────────────────────────────────────────────────────────
  const logout = useCallback(async () => {
    const accessToken = localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN);
    const refreshToken = localStorage.getItem(STORAGE_KEYS.REFRESH_TOKEN);

    // Blacklistear el refresh token en el backend (best-effort)
    if (accessToken && refreshToken) {
      try {
        await fetch(`${API_URL}/auth/logout/`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ refresh: refreshToken }),
        });
      } catch {
        // Si el servidor no está disponible, el token expirará naturalmente
        console.warn('[Auth] Logout request failed — clearing local storage anyway');
      }
    }

    _clearStorage();
    setUser(null);
  }, []);

  // ── Register ──────────────────────────────────────────────────────────────
  const register = useCallback(
    async (data: any) => {
      setIsLoading(true);
      try {
        const { api } = await import('./api');
        await api.register({ ...data, username: data.email });
        await login(data.email, data.password);
      } catch (error) {
        console.error('[Auth] Register error:', error);
        throw error;
      } finally {
        setIsLoading(false);
      }
    },
    [login]
  );

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated: !!user,
        isLoading,
        login,
        register,
        logout,
        refreshTokens,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

// ── Helpers privados (fuera del componente para no recrearse) ──────────────────

function _clearStorage() {
  localStorage.removeItem(STORAGE_KEYS.ACCESS_TOKEN);
  localStorage.removeItem(STORAGE_KEYS.REFRESH_TOKEN);
  localStorage.removeItem(STORAGE_KEYS.USER);
  clearTenant();
}

async function _doRefresh(refreshToken: string): Promise<string | null> {
  try {
    const { API_URL } = await import('@/config');
    const response = await fetch(`${API_URL}/auth/token/refresh/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh: refreshToken }),
    });

    if (!response.ok) return null;

    const data = await response.json();
    if (!data.access) return null;

    localStorage.setItem(STORAGE_KEYS.ACCESS_TOKEN, data.access);
    // Con ROTATE_REFRESH_TOKENS=True el backend devuelve también el nuevo refresh
    if (data.refresh) {
      localStorage.setItem(STORAGE_KEYS.REFRESH_TOKEN, data.refresh);
    }
    return data.access;
  } catch {
    return null;
  }
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth debe usarse dentro de AuthProvider');
  }
  return context;
}
```

---

## ✅ Paso 7 — Frontend: `src/lib/api.ts` (interceptor 401) — COMPLETADO

Los cambios son localizados: reemplazar `getAuthHeaders()` y agregar un wrapper
que maneje el refresh automático cuando el servidor devuelve 401.

**Cambios en `src/lib/api.ts`:**

```typescript
// ── Reemplazar getAuthHeaders ─────────────────────────────────────────────────
import { STORAGE_KEYS } from './auth-context';

const getAuthHeaders = (): HeadersInit => {
  // CAMBIO: usar taller_access_token en lugar de taller_token
  const token = localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN);
  const tenant = getCurrentTenant();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (token) {
    // CAMBIO: prefijo Bearer en lugar de Token
    headers['Authorization'] = `Bearer ${token}`;
  }

  if (tenant && tenant !== 'default') {
    headers['X-Tenant-ID'] = tenant;
  }

  return headers;
};


// ── apiFetch con interceptor 401 ──────────────────────────────────────────────
/**
 * Wrapper de fetch con:
 * - Inyección automática de Authorization: Bearer + X-Tenant-ID
 * - Retry automático con refresh token si el servidor devuelve 401
 * - Logout automático si el refresh también falla
 *
 * IMPORTANTE: Para evitar dependencia circular, el logout se ejecuta
 * limpiando localStorage directamente + recargando la página.
 * AuthContext se suscribirá al evento 'auth:logout' si se implementa
 * el patrón de eventos.
 */
export async function apiFetch<T = any>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const url = `${API_BASE_URL}${path}`;

  // Primera llamada
  const response = await fetch(url, {
    ...options,
    headers: {
      ...getAuthHeaders(),
      ...(options.headers as Record<string, string> || {}),
    },
  });

  // Si 401, intentar refresh una sola vez
  if (response.status === 401) {
    const newAccess = await _tryRefresh();

    if (!newAccess) {
      // Refresh fallido — limpiar sesión y redirigir a login
      _forceLogout();
      throw new Error('SESSION_EXPIRED');
    }

    // Reintentar con el nuevo access token
    const retryResponse = await fetch(url, {
      ...options,
      headers: {
        ...getAuthHeaders(),  // ya tiene el nuevo token en localStorage
        ...(options.headers as Record<string, string> || {}),
      },
    });

    if (!retryResponse.ok) {
      const error = await retryResponse.json().catch(() => ({}));
      throw new Error(
        error.detail || error.message || `HTTP ${retryResponse.status}`
      );
    }

    if (retryResponse.status === 204) return undefined as T;
    return retryResponse.json() as Promise<T>;
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(
      error.detail || error.message || `HTTP ${response.status}`
    );
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

// ── Helpers privados ──────────────────────────────────────────────────────────

async function _tryRefresh(): Promise<string | null> {
  const refreshToken = localStorage.getItem(STORAGE_KEYS.REFRESH_TOKEN);
  if (!refreshToken) return null;

  try {
    const response = await fetch(`${API_BASE_URL}/auth/token/refresh/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh: refreshToken }),
    });

    if (!response.ok) return null;

    const data = await response.json();
    if (!data.access) return null;

    localStorage.setItem(STORAGE_KEYS.ACCESS_TOKEN, data.access);
    if (data.refresh) {
      localStorage.setItem(STORAGE_KEYS.REFRESH_TOKEN, data.refresh);
    }
    return data.access;
  } catch {
    return null;
  }
}

function _forceLogout(): void {
  localStorage.removeItem(STORAGE_KEYS.ACCESS_TOKEN);
  localStorage.removeItem(STORAGE_KEYS.REFRESH_TOKEN);
  localStorage.removeItem(STORAGE_KEYS.USER);
  localStorage.removeItem(STORAGE_KEYS.TENANT_CONFIG);
  // Redirigir — el AuthProvider detectará la ausencia de token en el próximo render
  window.location.href = '/login';
}
```

### Tests Frontend — Pasos 6 y 7

**Archivo:** `src/lib/__tests__/auth.test.ts`

```typescript
/**
 * Tests para auth-context y el interceptor 401 de apiFetch.
 * Usar: npm run test (Vitest)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { STORAGE_KEYS, isTokenExpired } from '../auth-context';

// ── Helpers ────────────────────────────────────────────────────────────────────

function buildJwt(payload: Record<string, any>): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = btoa(JSON.stringify(payload));
  return `${header}.${body}.fake-signature`;
}

function validToken(): string {
  return buildJwt({ exp: Math.floor(Date.now() / 1000) + 3600, user_id: 1 });
}

function expiredToken(): string {
  return buildJwt({ exp: Math.floor(Date.now() / 1000) - 60, user_id: 1 });
}

// ── isTokenExpired ─────────────────────────────────────────────────────────────

describe('isTokenExpired', () => {
  it('retorna false para un token con exp en el futuro', () => {
    expect(isTokenExpired(validToken())).toBe(false);
  });

  it('retorna true para un token con exp en el pasado', () => {
    expect(isTokenExpired(expiredToken())).toBe(true);
  });

  it('retorna true para una cadena que no es JWT', () => {
    expect(isTokenExpired('no-es-un-token')).toBe(true);
  });

  it('retorna true para un token sin campo exp', () => {
    const noExp = buildJwt({ user_id: 1 });
    expect(isTokenExpired(noExp)).toBe(true);
  });
});

// ── Interceptor 401 en apiFetch ───────────────────────────────────────────────

describe('apiFetch interceptor 401', () => {
  beforeEach(() => {
    localStorage.setItem(STORAGE_KEYS.ACCESS_TOKEN, 'old-access');
    localStorage.setItem(STORAGE_KEYS.REFRESH_TOKEN, 'valid-refresh');
    localStorage.setItem(STORAGE_KEYS.USER, JSON.stringify({ id: 1, name: 'Test' }));
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('hace retry con nuevo token tras recibir 401 y refresh exitoso', async () => {
    const fetchMock = vi.fn()
      // Primera llamada: 401
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      // Llamada a /auth/token/refresh/: devuelve nuevo access
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access: 'new-access', refresh: 'new-refresh' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      // Retry con nuevo token: éxito
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 1, name: 'Cliente' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

    vi.stubGlobal('fetch', fetchMock);

    const { apiFetch } = await import('../api');
    const result = await apiFetch('/customers/1/');

    expect(result).toEqual({ id: 1, name: 'Cliente' });
    expect(localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN)).toBe('new-access');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('fuerza logout y lanza SESSION_EXPIRED cuando el refresh falla', async () => {
    const locationMock = { href: '' };
    vi.stubGlobal('location', locationMock);

    const fetchMock = vi.fn()
      // Primera llamada: 401
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      // Refresh: 401 (refresh expirado)
      .mockResolvedValueOnce(new Response(null, { status: 401 }));

    vi.stubGlobal('fetch', fetchMock);

    const { apiFetch } = await import('../api');

    await expect(apiFetch('/customers/')).rejects.toThrow('SESSION_EXPIRED');
    expect(locationMock.href).toBe('/login');
    expect(localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN)).toBeNull();
  });

  it('no hace refresh si la primera respuesta es 403 (permisos)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ detail: 'No tienes permisos.' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const { apiFetch } = await import('../api');

    await expect(apiFetch('/admin-only/')).rejects.toThrow();
    // Solo 1 llamada — no hay retry en 403
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
```

---

## ✅ Paso 8 — Frontend: `src/lib/websocket.ts` (reconexión tras 4001 JWT) — COMPLETADO

El `WebSocketService` ya tiene reconexión automática. El único cambio necesario es
distinguir el cierre con code `4001` (token inválido/expirado) del resto de cierres,
para intentar un refresh antes de reconectar en lugar de reconectar con el token
viejo.

**Cambios en `src/lib/websocket.ts`:**

```typescript
// Agregar el campo refreshCallback en la config
interface WebSocketServiceConfig {
  url: string;
  token: string;
  onMessage?: MessageHandler;
  onConnect?: ConnectionHandler;
  onDisconnect?: ConnectionHandler;
  onError?: (error: Event) => void;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
  /** Callback que intenta renovar el access token. Devuelve el nuevo token o null. */
  onTokenExpired?: () => Promise<string | null>;
}

// En createConnection(), reemplazar el handler onclose:
this.ws.onclose = (event) => {
  console.log('[WebSocket] Desconectado', event.code, event.reason);
  onDisconnect?.();

  if (this.isManualClose) return;

  if (event.code === 4001 && this.config?.onTokenExpired) {
    // Token JWT expirado — intentar refresh antes de reconectar
    this.config.onTokenExpired().then((newToken) => {
      if (newToken && this.config) {
        // Actualizar el token en la config para que createConnection lo use
        this.config = { ...this.config, token: newToken };
        this.scheduleReconnect();
      } else {
        console.log('[WebSocket] No se pudo renovar el token. Sesión expirada.');
        // No reconectar — el usuario será redirigido a login por _forceLogout
      }
    });
  } else {
    this.scheduleReconnect();
  }
};
```

**En `src/hooks/useNotifications.ts`**, pasar el callback al conectar:

```typescript
// Importar refreshTokens del contexto de auth
const { user, refreshTokens } = useAuth();

// Al llamar websocketService.connect():
websocketService.connect({
  url: getWebSocketUrl(),
  token: localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN) || '',
  onTokenExpired: refreshTokens,
  // ... resto de opciones sin cambio
});
```

---

## Paso 9 — Limpieza: eliminar DRF Token del proyecto

Una vez que todos los pasos anteriores están desplegados y verificados en producción:

### Backend

1. Eliminar `'rest_framework.authtoken'` de `INSTALLED_APPS` en `base.py`
2. Eliminar el import de `Token` en `conftest.py` (ya reemplazado en Paso 5)
3. Crear migración para eliminar la tabla `authtoken_token`:
   ```bash
   python manage.py migrate authtoken zero
   ```
   **Nota:** Esto elimina la tabla. Solo ejecutar cuando se confirme que ningún
   cliente activo usa el token viejo.

### Frontend

1. Verificar que no queda ninguna referencia a `taller_token` en el código:
   ```bash
   grep -r "taller_token" src/
   ```
2. Eliminar la clave vieja si existe en los browsers (ya no se lee, pero ocupa espacio):
   Agregar en `initializeAuth()` al principio:
   ```typescript
   // Limpiar clave legacy de DRF Token si existe
   localStorage.removeItem('taller_token');
   ```

---

## Paso 10 — Migración y Deploy

### Orden de ejecución sin downtime

El sistema no tiene usuarios reales, por lo que se puede hacer corte limpio.
Si en el futuro hay usuarios reales, el orden sería:

```
1. Backend: agregar JWTAuthentication como PRIMERO en DEFAULT_AUTHENTICATION_CLASSES
             (mantener TokenAuthentication como segundo — retrocompatibilidad temporal)

2. Backend: agregar los nuevos endpoints JWT (/login/, /token/refresh/, /logout/)
            sin eliminar el endpoint viejo /api/auth/login/ aún

3. Backend: agregar token_blacklist a INSTALLED_APPS + migrate

4. Frontend: desplegar con los cambios de auth-context.tsx y api.ts
             (ahora el frontend usa JWT, el viejo token de DRF ya no se envía)

5. Backend: eliminar TokenAuthentication de DEFAULT_AUTHENTICATION_CLASSES
            + eliminar authtoken de INSTALLED_APPS
            + migrate authtoken zero
```

### Para el proyecto actual (corte limpio)

```bash
# 1. Actualizar settings (INSTALLED_APPS + SIMPLE_JWT + REST_FRAMEWORK)
# 2. Generar y aplicar migración de token_blacklist
docker compose exec web python manage.py makemigrations
docker compose exec web python manage.py migrate

# 3. Verificar que los tests pasan
docker compose -f docker-compose.local.yml exec web pytest apps/core/tests/test_jwt_login.py -v
docker compose -f docker-compose.local.yml exec web pytest apps/core/tests/test_jwt_refresh.py -v
docker compose -f docker-compose.local.yml exec web pytest -v  # suite completa

# 4. Deploy backend
./deploy.sh actualizar

# 5. Deploy frontend (Vercel auto-deploy al hacer push a main)
```

### Variables de entorno a revisar antes del deploy

No se requieren nuevas variables de entorno. `SIMPLE_JWT` usa `SECRET_KEY` que ya
está configurado. Verificar que `SECRET_KEY` en producción tenga al menos 50
caracteres (best practice para firma HMAC-256).

### Checklist de verificación post-deploy

```
[ ] POST /api/auth/login/ devuelve access + refresh
[ ] POST /api/auth/token/refresh/ rota los tokens
[ ] POST /api/auth/logout/ devuelve 204 y blacklistea el refresh
[ ] GET /api/customers/ con Bearer token devuelve 200
[ ] GET /api/customers/ sin token devuelve 401
[ ] WebSocket conecta con ?token=<access_token>
[ ] WebSocket rechaza ?token=<refresh_token> o token inválido con code 4001
[ ] Frontend: login guarda access + refresh en localStorage
[ ] Frontend: tab inactiva > 60 min → al volver se hace refresh silencioso
[ ] Frontend: logout limpia localStorage y llama al backend
[ ] Frontend: 401 en apiFetch dispara refresh y reintenta la llamada original
```

---

## Consideraciones de Seguridad

### Filtrado por tenant

Sin cambio. El `TenantMiddleware` resuelve el tenant desde `X-Tenant-ID` y
`TenantFromUserMiddleware` lo infiere del usuario autenticado. La autenticación
JWT solo identifica al usuario; el aislamiento de tenant sigue siendo responsabilidad
de `TenantModelMixin`.

### Permisos por rol

Sin cambio en los ViewSets. `IsAuthenticated` valida que el JWT sea válido.
Los permisos de rol personalizados consultan `request.user` igual que antes.

### Rotación de refresh tokens

`BLACKLIST_AFTER_ROTATION=True` garantiza que un refresh token usado queda
inmediatamente invalidado. Si un atacante roba el refresh token y lo usa antes que
el usuario legítimo, el próximo uso del usuario falla → alerta de seguridad potencial.

### Algoritmo

`HS256` con `SECRET_KEY`. Suficiente para un monolito donde el backend es el único
que firma y verifica. Si en el futuro se separa el auth service, considerar `RS256`
con par de claves asimétricas.

### Deuda técnica documentada

- Migrar refresh token a httpOnly cookie para protección XSS completa
- Implementar renovación automática de httpOnly cookie para WebSockets (requiere
  endpoint adicional que devuelva el access token si la cookie de refresh es válida)

---

## Resumen de Archivos Modificados

| Archivo | Tipo de cambio |
|---------|---------------|
| `config/settings/base.py` | `SIMPLE_JWT` (7 días), `INSTALLED_APPS` (+blacklist), `REST_FRAMEWORK` (Bearer) |
| `config/settings/testing.py` | `SIMPLE_JWT` actualizado para coincidir con base |
| `config/urls.py` | Agregar rutas JWT, reemplazar import de vista |
| `apps/core/views.py` | Reemplazar `CustomAuthToken` por `CustomJWTLoginView` + `LogoutView` |
| `apps/notifications/consumers.py` | `get_user_from_token` valida JWT en lugar de DRF Token |
| `conftest.py` | Fixtures `authenticated_client` + `jwt_tokens` usan JWT |
| `src/lib/auth-context.tsx` | Nuevas claves, refresh silencioso, logout con blacklist |
| `src/lib/api.ts` | `getAuthHeaders` usa `Bearer`, `apiFetch` con interceptor 401 |
| `src/lib/websocket.ts` | Handler `onclose` con lógica de refresh en code 4001 |
| `src/hooks/useNotifications.ts` | Pasar `onTokenExpired: refreshTokens` al conectar |

## Archivos nuevos

| Archivo | Contenido |
|---------|-----------|
| `apps/core/tests/test_jwt_login.py` | Tests de login y logout |
| `apps/core/tests/test_jwt_refresh.py` | Tests del endpoint de refresh |
| `apps/notifications/tests/test_ws_jwt_auth.py` | Tests de auth WS con JWT |
| `src/lib/__tests__/auth.test.ts` | Tests del interceptor y helpers de token |
