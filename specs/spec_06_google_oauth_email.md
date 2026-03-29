# Spec 06 — Google OAuth Login + Configuración de Email SMTP

**Fecha:** 2026-03-15
**Estado:** Pendiente de implementación
**Prioridad:** Media — mejora de UX + operacional

---

## Parte A — Google OAuth Login

### Resumen

Conectar el botón "Continuar con Google" que ya existe en `Login.tsx` (actualmente
decorativo, sin lógica) con el backend para permitir registro e inicio de sesión de
clientes usando su cuenta Google. Los usuarios registrados vía Google siempre reciben
rol `customer` (si son nuevos). Si el email ya existe como staff, se autentica con el
rol que tenga asignado.

---

### Decisión de Arquitectura: ID Token Flow (no OAuth Redirect)

**Opción elegida:** Google Identity Services (GIS) en el frontend obtiene un
**ID Token** y lo envía al backend. El backend lo valida con la librería `google-auth`.

**Por qué no django-allauth ni python-social-auth:**
- Están diseñados para autenticación basada en sesión Django, no JWT.
- Añaden 10+ tablas al modelo sin necesidad real.
- El flujo de redirección OAuth es incompatible con nuestra SPA + Vercel.

**Por qué el ID Token flow:**
- El frontend (SPA React) ya tiene la credencial directamente tras el popup de Google.
- No hay redirección de página; el popup se cierra y el usuario queda autenticado.
- Compatible 100% con nuestra arquitectura JWT (el backend devuelve `access` + `refresh`).
- La librería `google-auth` solo necesita el `CLIENT_ID` para validar — no el secret.

---

### Flujo completo

```
[Usuario hace clic en "Continuar con Google"]
    ↓
[Google popup] → el usuario elige cuenta
    ↓
Frontend recibe credential (ID token JWT firmado por Google)
    ↓
POST /api/auth/google/
  Body: { "id_token": "<credential>", "tenant_slug": "<slug_actual>" }
    ↓
Backend:
  1. Valida ID token con google-auth (verifica firma + expiración + audience)
  2. Extrae { email, name, picture, sub } del payload
  3. Busca User por email
     ├── Si existe → autentica, devuelve JWT con su rol actual
     └── Si no existe → crea User + Customer bajo el tenant enviado → rol customer
    ↓
Response: { access, refresh, user_id, email, name, role, tenant }
    ↓
Frontend: guarda tokens en localStorage, redirige según rol
```

---

### Reglas de negocio

| Escenario | Comportamiento |
|-----------|---------------|
| Email nuevo | Crea User (`set_unusable_password`) + Customer + TenantUser(`customer`) |
| Email existe, rol customer | Login como customer |
| Email existe, rol staff (mechanic, advisor, admin, owner) | Login con su rol real (no se degrada) |
| tenant_slug no existe | 400 — "Taller no encontrado" |
| tenant_slug faltante | 400 — "tenant_slug es requerido" |
| ID token inválido / expirado | 401 — "Token de Google inválido" |
| El botón Google solo aparece en modo cliente (`!isStaffMode`) | Staff no puede acceder al flujo por UI; el endpoint está disponible pero el rol que tienen ya es staff |

---

### Impacto Backend

#### Archivos modificados

**`requirements/base.txt`**
```
google-auth==2.28.0     # validación de ID tokens de Google
```
Sin otros cambios de dependencias. No se necesita `google-auth-oauthlib`.

---

**`config/settings/base.py`**

Agregar:
```python
GOOGLE_OAUTH_CLIENT_ID = os.environ.get('GOOGLE_OAUTH_CLIENT_ID', '')
```
No hay `GOOGLE_OAUTH_CLIENT_SECRET` — para validar ID tokens solo se necesita el Client ID.

---

**`apps/customers/models.py`**

Agregar campo `google_sub` al modelo `Customer`:
```python
google_sub = models.CharField(
    max_length=255,
    blank=True,
    null=True,
    unique=True,
    verbose_name="Google Subject ID",
    help_text="Identificador único de cuenta Google (sub del JWT)"
)
```

**Por qué `google_sub`:**
- El `sub` de Google no cambia nunca (a diferencia del email).
- Permite detectar si el mismo usuario de Google ya existe aunque cambie su email.
- Si el `sub` ya existe → autentica directamente sin buscar por email.
- Migración requerida: `makemigrations customers` + `migrate`.

---

**`apps/core/views.py`**

Nueva vista `GoogleAuthView`:
```python
POST /api/auth/google/
permission_classes = [AllowAny]
authentication_classes = []

Body: { "id_token": "...", "tenant_slug": "..." }
```

Lógica interna:
1. Recibe `id_token` y `tenant_slug`
2. Llama `google.oauth2.id_token.verify_oauth2_token(id_token, requests.Request(), CLIENT_ID)`
3. Extrae `sub`, `email`, `name` del payload
4. Busca `Customer` por `google_sub` → si existe, autentica
5. Busca `User` por `email` → si existe, actualiza `google_sub` y autentica
6. Si es usuario nuevo: crea `User` + `Customer` bajo el tenant + `TenantUser(role='customer')`
7. Genera JWT pair con `RefreshToken.for_user(user)`
8. Retorna misma estructura que `CustomJWTLoginView`

---

**`config/urls.py`**

```python
from apps.core.views import CustomJWTLoginView, LogoutView, HealthCheckView, GoogleAuthView

path('api/auth/google/', GoogleAuthView.as_view(), name='google_auth'),
```

---

**`conftest.py`**

Nuevo fixture:
```python
@pytest.fixture
def google_customer(db, tenant):
    """Usuario creado via Google OAuth (sin password, con google_sub)."""
    from conftest import UserFactory
    user = UserFactory(password=None)
    user.set_unusable_password()
    user.save()
    customer = CustomerFactory(user=user, tenant=tenant, google_sub='google_sub_123456')
    TenantUserFactory(user=user, tenant=tenant, role='customer', is_current=True)
    return user
```

---

**Tests nuevos: `apps/core/tests/test_google_auth.py`**

Clases:
- `TestGoogleAuthView` — mock de `verify_oauth2_token`
  - `test_nuevo_usuario_crea_customer` — usuario inexistente → crea y retorna JWT
  - `test_usuario_existente_devuelve_jwt` — email ya existe → login
  - `test_google_sub_existente_autentica` — mismo sub, diferente email → autentica por sub
  - `test_token_invalido_devuelve_401` — `verify_oauth2_token` lanza ValueError
  - `test_sin_tenant_slug_devuelve_400` — cuerpo sin tenant_slug
  - `test_tenant_inexistente_devuelve_400` — slug no existe en BD
  - `test_staff_existente_mantiene_rol` — email de mechanic → rol mechanic, no customer

---

### Impacto Frontend

#### Archivos modificados

**`package.json`**
```json
"@react-oauth/google": "^0.12.1"
```
Librería oficial de Google Identity Services para React.

---

**`src/main.tsx`**

Envolver `App` con `GoogleOAuthProvider`:
```tsx
import { GoogleOAuthProvider } from '@react-oauth/google';

<GoogleOAuthProvider clientId={import.meta.env.VITE_GOOGLE_CLIENT_ID}>
  <App />
</GoogleOAuthProvider>
```

---

**`src/pages/Login.tsx`**

El botón Google ya existe visualmente (línea 132). Solo necesita:
1. Importar `useGoogleLogin` de `@react-oauth/google`
2. Agregar estado `isGoogleLoading`
3. Conectar el `onClick` del botón existente al handler de Google
4. El handler llama a `POST /api/auth/google/` con el `credential`
5. Redirigir según rol igual que el login normal

**Cambio mínimo** — el SVG del logo Google y el texto ya están presentes.

---

**`src/hooks/useNotifications.ts`**

Sin cambios — el WebSocket recibe el `access` token igual que antes.

---

**`src/lib/auth-context.tsx`**

Sin cambios en la interfaz. Se puede añadir una función `loginWithGoogle(idToken)` que
llama a `/api/auth/google/` y maneja la respuesta igual que `login()`. O se puede
reutilizar directamente desde `Login.tsx` con `apiFetch`.

---

**Variables de entorno nuevas**

Frontend (`.env`):
```env
VITE_GOOGLE_CLIENT_ID=<client_id_de_google_cloud>
```

Backend (`.env`):
```env
GOOGLE_OAUTH_CLIENT_ID=<mismo_client_id>
```

> El **Client Secret** NO se necesita en el backend para validar ID tokens.
> Solo se necesita en el frontend como `clientId` del provider.
> Guardarlo de todas formas en `.env` como `GOOGLE_OAUTH_CLIENT_SECRET` para
> referencia futura (si se implementa httpOnly cookie con refresh via backend).

---

### Migraciones necesarias

```bash
# Agregar google_sub a Customer
make makemigrations   # genera apps/customers/migrations/000X_customer_google_sub.py
make migrate
```

Sin impacto en datos existentes — el campo es `null=True, blank=True`.

---

### Checklist post-implementación

```
[ ] POST /api/auth/google/ devuelve access + refresh para usuario nuevo
[ ] POST /api/auth/google/ devuelve access + refresh para usuario existente
[ ] Usuario nuevo tiene Customer creado bajo el tenant correcto
[ ] Usuario existente como staff mantiene su rol
[ ] Botón Google en Login.tsx dispara el popup de Google
[ ] Tras login con Google, redirección correcta según rol
[ ] Token inválido devuelve 401
[ ] Tests de backend: 7/7 pass
```

---

---

## Parte B — Cambio de Email SMTP

### Resumen

El sistema de recuperación de contraseña envía correos usando la configuración SMTP de
`base.py`. Cambiar el remitente a `autotronia.ventas@gmail.com` con contraseña de
aplicación de Gmail.

---

### Impacto: mínimo — solo variables de entorno

El código **no cambia**. `password_reset/views.py` ya usa `settings.DEFAULT_FROM_EMAIL`
y Django lee la configuración de `EMAIL_HOST_USER`/`EMAIL_HOST_PASSWORD` desde `.env`.

---

### Archivos afectados

#### `backend-taller-pro/.env` (producción y local)

```env
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_USE_TLS=True
EMAIL_HOST_USER=autotronia.ventas@gmail.com
EMAIL_HOST_PASSWORD=<app_password_16_chars_sin_espacios>
DEFAULT_FROM_EMAIL=Autotronia <autotronia.ventas@gmail.com>
```

> Las contraseñas de aplicación de Gmail se generan con espacios como separadores
> visuales (grupos de 4 letras). Django acepta ambos formatos, pero para mayor
> compatibilidad usar la versión **sin espacios** en `.env`.

---

#### `apps/password_reset/views.py` — ajuste menor de texto

El email tiene actualmente hardcodeado "AutoClimas Robles" en el subject y body:
```python
subject='Código de Recuperación - AutoClimas Robles',
...
Saludos,
AutoClimas Robles
```

Esto debe cambiarse para usar el nombre del tenant o una variable de settings:
```python
subject='Código de Recuperación - Autotronia',
...
Saludos,
El equipo de Autotronia
```

O mejor, leer el nombre desde la configuración:
```python
from django.conf import settings
APP_NAME = getattr(settings, 'APP_NAME', 'Autotronia')
subject=f'Código de Recuperación - {APP_NAME}',
```

Y agregar en `base.py`:
```python
APP_NAME = os.environ.get('APP_NAME', 'Autotronia')
```

---

### Configuración en Google Cloud Console

Antes de implementar, verificar en la consola de Google Cloud del mismo correo:

1. **OAuth consent screen** → Authorized domains → incluir `autotronia.com` y `vercel.app`
2. **Credentials → OAuth 2.0 Client ID** → Authorized JavaScript origins:
   - `https://app.autotronia.com`
   - `http://localhost:8081` (desarrollo)
3. **Authorized redirect URIs** → No aplica para el ID token flow (no hay redirect)

---

### Seguridad — notas importantes

| Credencial | Dónde va | Dónde NO va |
|-----------|----------|-------------|
| `GOOGLE_OAUTH_CLIENT_ID` | Frontend `.env` + Backend `.env` | No es secreto, puede estar en código fuente |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Backend `.env` únicamente | Nunca en frontend, nunca en git |
| `EMAIL_HOST_PASSWORD` (app password) | Backend `.env` únicamente | Nunca en código fuente |
| Gmail app password | `.env` producción | Nunca en `.env.example` ni en git |

> **CRÍTICO:** La contraseña de aplicación de Gmail y el Client Secret de Google
> solo deben existir en el archivo `.env` del servidor de producción y en el local
> de cada desarrollador autorizado. Nunca en el repositorio.

---

## Resumen de Archivos a Modificar

### Backend

| Archivo | Cambio |
|---------|--------|
| `requirements/base.txt` | `+google-auth==2.28.0` |
| `config/settings/base.py` | `+GOOGLE_OAUTH_CLIENT_ID`, `+APP_NAME` |
| `apps/customers/models.py` | `+google_sub` field en `Customer` |
| `apps/core/views.py` | `+GoogleAuthView` |
| `config/urls.py` | `+path('api/auth/google/', ...)` |
| `apps/password_reset/views.py` | texto del email (hardcode → settings) |
| `conftest.py` | `+google_customer` fixture |
| `.env` (local y producción) | variables EMAIL_* + GOOGLE_OAUTH_CLIENT_ID |

### Frontend

| Archivo | Cambio |
|---------|--------|
| `package.json` | `+@react-oauth/google` |
| `src/main.tsx` | wrap con `GoogleOAuthProvider` |
| `src/pages/Login.tsx` | conectar botón Google existente |
| `.env` (local y producción) | `+VITE_GOOGLE_CLIENT_ID` |

### Archivos nuevos

| Archivo | Contenido |
|---------|-----------|
| `apps/core/tests/test_google_auth.py` | 7 tests con mock de Google |
| `apps/customers/migrations/000X_customer_google_sub.py` | campo `google_sub` |

---

## Estimación de Complejidad

| Tarea | Complejidad |
|-------|-------------|
| Backend: `GoogleAuthView` + `google_sub` migration | Media |
| Frontend: conectar botón existente | Baja — el botón ya existe en la UI |
| Email: cambiar `.env` + texto hardcoded | Muy baja |
| Tests backend | Media |
| Configurar Google Cloud Console | Muy baja (ya tienes el cliente creado) |
