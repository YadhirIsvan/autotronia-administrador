# spec_15 — Bug: 401 Unauthorized en todas las llamadas API del panel admin

**Estado:** Completado
**Fecha:** 2026-03-21
**Prioridad:** Alta — el panel admin queda completamente inutilizable tras 15 minutos de uso
**Síntoma:** Todas las llamadas REST retornan 401 "El token dado no es valido para ningun tipo de token" mientras el WebSocket permanece conectado

---

## 1. Síntoma

Al entrar al panel admin, todas las llamadas a la API fallan con 401:

```
/api/customers/          → 401 Unauthorized
/api/mechanics/          → 401 Unauthorized
/api/tenants/current/    → 401 Unauthorized
/api/inventory/products/ → 401 Unauthorized
/api/workshop/work-orders/financial-summary/ → 401 Unauthorized
...
Error: El token dado no es valido para ningun tipo de token
    at admin.api.ts:53:32
```

Al mismo tiempo, el WebSocket **permanece conectado**:
```
[WebSocket] Conectado
[Notificaciones] Conectado: Conectado al sistema de notificaciones
```

---

## 2. Causa Raíz

### Problema 1 (PRINCIPAL): Access token de 15 minutos sin auto-refresh

`config/settings/base.py`:
```python
SIMPLE_JWT = {
    'ACCESS_TOKEN_LIFETIME': timedelta(minutes=15),  # ← MUY CORTO
    'REFRESH_TOKEN_LIFETIME': timedelta(days=30),
    'ROTATE_REFRESH_TOKENS': True,
    ...
}
```

El access token expira en **15 minutos**. La aplicación puede tardar más de 15 minutos
en usarse activamente (o el usuario puede reabrir el navegador con la sesión guardada).

**No había ningún interceptor de refresh en el frontend.** El refresh token (válido 30 días)
estaba guardado en localStorage pero nunca se usaba para renovar el access token.

### Problema 2 (SECUNDARIO): WebSocket usa validación de token solo al conectar

El `NotificationConsumer` en Daphne valida el JWT **una sola vez** al establecer la conexión
WebSocket. Una vez conectado, la conexión TCP persiste sin re-validación. Por eso el WS
aparece como "Conectado" incluso cuando el access token ya expiró y todas las llamadas
REST fallan.

---

## 3. Por qué SimpleJWT reporta "token not valid for any token type" y no "token expired"

SimpleJWT envuelve todos los errores de token en `InvalidToken`:

```python
# rest_framework_simplejwt/authentication.py
def get_validated_token(self, raw_token):
    messages = []
    for AuthToken in api_settings.AUTH_TOKEN_CLASSES:
        try:
            return AuthToken(raw_token)       # AccessToken(raw_token) lanza TokenError
        except TokenError as e:
            messages.append({'message': e.args[0], ...})  # "Token is expired"

    raise InvalidToken({
        'detail': _('Given token not valid for any token type'),  # ← Lo que se muestra
        'messages': messages,   # ← Aquí está el mensaje real "Token is expired"
    })
```

El error que llega al usuario es el wrapper "token not valid" aunque internamente
el mensaje real sea "Token is expired" / "El token ha caducado".

---

## 4. Confirmación del diagnóstico

Prueba con curl usando token fresco generado en Django shell:
```bash
curl -H "Authorization: Bearer $FRESH_TOKEN" -H "X-Tenant-ID: real-madrid" \
  http://localhost/api/tenants/current/
# → 200 ✅

curl -H "Authorization: Bearer $FRESH_TOKEN" -H "X-Tenant-ID: real-madrid" \
  http://localhost/api/mechanics/
# → 200 ✅
```

**Los endpoints son correctos.** El problema es 100% el token expirado en el browser.

---

## 5. Archivos afectados y acciones

| Archivo | Problema | Acción |
|---------|----------|--------|
| `config/settings/base.py` | `ACCESS_TOKEN_LIFETIME = 15 min` | Aumentado a 60 min ✅ DONE |
| `front-end-taller-pro/src/lib/auth-refresh.ts` | No existía lógica de refresh | Creado ✅ DONE |
| `src/admin/api/admin.api.ts` | Sin interceptor de refresh | Actualizado ✅ DONE |
| `src/advisor/api/advisor.api.ts` | Sin interceptor de refresh | Actualizado ✅ DONE |
| `src/mechanic/api/mechanic.api.ts` | Sin interceptor de refresh | Actualizado ✅ DONE |
| `src/customer/api/customer.api.ts` | Sin interceptor de refresh | Actualizado ✅ DONE |
| `src/api/axios.js` | Sin interceptores de ningún tipo | Actualizado ✅ DONE |
| `src/lib/api.ts` | Sin refresh en apiFetch | Actualizado ✅ DONE |

---

## 6. Solución implementada

### Backend: Aumentar ACCESS_TOKEN_LIFETIME

```python
# config/settings/base.py
SIMPLE_JWT = {
    'ACCESS_TOKEN_LIFETIME': timedelta(minutes=60),  # antes: 15 min
    ...
}
```

60 minutos cubre una sesión de trabajo normal. El refresh automático del frontend
manejará sesiones más largas.

### Frontend: Shared refresh utility (`src/lib/auth-refresh.ts`)

Patrón de queue para manejar múltiples 401 simultáneos con una sola llamada
al endpoint de refresh:

```typescript
let isRefreshing = false;
let pendingRequests: Array<(token: string) => void> = [];

export async function refreshAccessToken(): Promise<string> {
  if (isRefreshing) {
    // Encolar: esperar que termine el refresh en progreso
    return new Promise((resolve, reject) => {
      pendingRequests.push(resolve);
      rejectPending.push(reject);
    });
  }

  isRefreshing = true;
  try {
    const response = await axios.post(`${BASE_URL}/auth/token/refresh/`, {
      refresh: localStorage.getItem('taller_refresh_token'),
    });
    const newToken = response.data.access;
    localStorage.setItem('taller_token', newToken);
    if (response.data.refresh) {
      localStorage.setItem('taller_refresh_token', response.data.refresh);
    }
    onRefreshSuccess(newToken);
    return newToken;
  } catch (error) {
    onRefreshFailure(error);
    // Limpiar sesión y redirigir a login
    localStorage.removeItem('taller_token');
    localStorage.removeItem('taller_refresh_token');
    localStorage.removeItem('taller_user');
    localStorage.removeItem('taller_tenant_config');
    window.location.href = '/login';
    throw error;
  } finally {
    isRefreshing = false;
  }
}
```

### Frontend: Interceptor en todas las instancias Axios

```typescript
// Patrón aplicado a admin, advisor, mechanic, customer, axios.js
import { refreshAccessToken } from '@/lib/auth-refresh';

axiosInstance.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;
      try {
        const newToken = await refreshAccessToken();
        originalRequest.headers.Authorization = `Bearer ${newToken}`;
        return axiosInstance(originalRequest);
      } catch {
        return Promise.reject(error);
      }
    }

    // Formateo de errores existente...
    if (error.response) {
      const { status, data } = error.response;
      const errorMessage = data?.detail || data?.error || `Error ${status}`;
      return Promise.reject(new Error(errorMessage));
    }
    return Promise.reject(error);
  }
);
```

### Frontend: Retry en apiFetch (`src/lib/api.ts`)

```typescript
export async function apiFetch<T>(endpoint: string, options = {}, _isRetry = false): Promise<T> {
  // ...existing code...

  if (response.status === 401 && !_isRetry) {
    try {
      await refreshAccessToken();
      return apiFetch<T>(endpoint, options, true);  // retry con nuevo token
    } catch {
      throw new Error('Session expired');
    }
  }
  // ...
}
```

---

## 7. Flujo post-fix

```
Usuario usa el panel durante > 60 min
    ↓
Token expira
    ↓
TanStack Query refetch → Axios interceptor recibe 401
    ↓
refreshAccessToken() llamada (una sola vez por cola)
    ↓
POST /api/auth/token/refresh/ → nuevo access token (30 días de refresh token)
    ↓
Nuevo token guardado en localStorage
    ↓
Request original reintentada con nuevo token → 200 ✅
    ↓
Usuario no nota nada — sesión transparente
```

Si el refresh token también expiró (después de 30 días):
```
POST /api/auth/token/refresh/ → 401
    ↓
refreshAccessToken() limpia localStorage y redirige a /login
    ↓
Usuario hace login nuevamente
```

---

## 8. Criterios de aceptación

- [x] `ACCESS_TOKEN_LIFETIME` aumentado a 60 minutos
- [x] `auth-refresh.ts` creado con patrón de queue
- [x] 5 instancias Axios actualizadas con interceptor de refresh
- [x] `apiFetch` actualizado con retry en 401
- [ ] El panel admin funciona correctamente por más de 60 minutos sin 401
- [ ] Después de 60 min, el refresh ocurre transparentemente (sin logout forzado)
- [ ] Cuando el refresh token expira (30 días), se redirige a `/login`

---

## 9. Nota sobre el WebSocket

El WebSocket no necesita refresh automático porque la conexión TCP persiste y no re-valida
el token en cada mensaje. Sin embargo, si el usuario recarga la página y el access token
ha expirado:
1. `refreshAccessToken()` se llama implícitamente por el primer API call que falla
2. El nuevo token se guarda en localStorage
3. `useNotifications` reconecta el WebSocket con el nuevo token

Si se quiere refresh proactivo del WS, se puede llamar `refreshAccessToken()` en el
hook de reconexión del WebSocket — considerarlo para una mejora futura.
