# Spec 10 — Frontend Auth: Login, Registro y Recuperación de Contraseña

> **Contexto:** El backend está completo y funcionando. El frontend necesita re-implementarse desde una rama limpia. Esta spec documenta exactamente qué construir, sin necesidad de tocar el backend.

---

## Estado

- [ ] En progreso

---

## Estructura de archivos a crear

```
src/
├── config.js                          # URL base de la API
├── lib/
│   ├── auth-context.tsx               # AuthProvider + useAuth hook
│   ├── tenant.ts                      # Lógica multi-tenant
│   └── types.ts                       # Tipo User
├── auth/
│   ├── api/
│   │   └── auth.api.ts                # Axios instance con interceptores
│   ├── actions/
│   │   └── auth.actions.ts            # Funciones async que llaman a auth.api.ts
│   ├── hooks/
│   │   ├── useAuthMutations.ts        # TanStack Query mutations
│   │   └── index.ts                   # Re-exports
│   ├── types/
│   │   ├── auth.types.ts              # Interfaces de payload/response
│   │   └── index.ts
│   ├── pages/
│   │   ├── Login.tsx                  # Página de login
│   │   ├── Register.tsx               # Página de registro (3 pasos)
│   │   └── index.ts
│   ├── components/
│   │   ├── ForgotPassword.tsx         # Flujo de recuperación (4 pasos)
│   │   └── index.ts
│   └── guardian/
│       ├── ProtectedRoute.tsx         # HOC de rutas protegidas por rol
│       ├── getDefaultRoute.ts         # Mapeo rol → ruta
│       └── index.ts
```

---

## 1. Variables de Entorno

```env
# .env.local (desarrollo)
VITE_API_URL=https://api.autotronia.com/api
VITE_TENANT_SLUG=           # Dejar vacío para detección automática
                            # O poner slug fijo: VITE_TENANT_SLUG=mi-taller

VITE_GOOGLE_CLIENT_ID=      # Solo si se habilita Google OAuth
```

---

## 2. `src/config.js`

```js
export const API_URL = import.meta.env.VITE_API_URL || "https://api.autotronia.com/api";
```

---

## 3. `src/lib/types.ts`

```ts
export type UserRole = 'owner' | 'admin' | 'mechanic' | 'advisor' | 'customer' | 'member';

export interface User {
  id: string | number;
  email: string;
  name: string;
  role: UserRole;
  avatar?: string;
}
```

---

## 4. `src/lib/auth-context.tsx`

### Contrato público del context

```ts
interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (data: any) => Promise<void>;
  logout: () => void;
  setUser: (user: User | null) => void;    // usado después del login via mutation
}
```

### localStorage keys

| Key | Contenido |
|-----|-----------|
| `taller_token` | JWT access token (string) |
| `taller_user` | JSON del User (`{ id, email, name, role }`) |
| `taller_tenant_slug` | Slug del tenant activo |
| `taller_tenant_config` | JSON del TenantConfig (logo, colores, etc.) |

### Comportamiento en mount (init)

1. Lee `taller_token` y `taller_user` de localStorage.
2. Si existen, parsea el usuario y lo pone en estado. `isLoading = false`.
3. Si no existen, `isLoading = false` y `user = null`.
4. **No** valida el token con el backend en mount (el interceptor Axios lo maneja).

### `login(email, password)`

```
POST /api/auth/login/
Body: { username: email, password }
```

Respuesta exitosa:
```json
{
  "token": "...",
  "user_id": 1,
  "email": "juan@email.com",
  "name": "Juan Pérez",
  "role": "customer",
  "tenant": {
    "id": 1,
    "name": "Mi Taller",
    "slug": "mi-taller",
    "logo": null,
    "primary_color": "#10B981",
    "secondary_color": "#3B82F6",
    "plan": "basic"
  }
}
```

Pasos tras login exitoso:
1. `localStorage.setItem('taller_token', data.token)`
2. `localStorage.setItem('taller_user', JSON.stringify({ id, email, name, role }))`
3. Si `data.tenant.slug` existe: `setCurrentTenant(slug)` + `localStorage.setItem('taller_tenant_config', JSON.stringify(tenant))` + `applyTenantTheme(tenant)`
4. `setUser(userData)`

### `logout()`

1. `localStorage.removeItem('taller_user')`
2. `localStorage.removeItem('taller_token')`
3. `clearTenant()` (limpia `taller_tenant_slug` y `taller_tenant_config`)
4. `setUser(null)`

**Nota:** El backend tiene un endpoint `/api/auth/logout/` para blacklistear el refresh token (JWT), pero el `auth-context.tsx` actual solo limpia localStorage. Si se quiere blacklist en logout, llamar a `POST /api/auth/logout/` con `{ refresh: refreshToken }` antes de limpiar.

### `isAuthenticated`

```ts
isAuthenticated: !!user
```

---

## 5. `src/lib/tenant.ts`

### Constantes localStorage

| Key | Uso |
|-----|-----|
| `taller_tenant_slug` | Slug del tenant activo |
| `taller_tenant_config` | JSON de TenantConfig cacheado |

### `TenantConfig` interface

```ts
export interface TenantConfig {
  id: number;
  name: string;
  slug: string;
  logo: string | null;
  logo_url?: string | null;
  primary_color: string;
  secondary_color: string;
  plan?: string;
  slogan?: string;
  hero_title?: string;
  hero_subtitle?: string;
  video_url?: string;
  whatsapp?: string;
  schedule?: Record<string, string>;
  social_links?: { facebook?: string; instagram?: string; tiktok?: string; };
  featured_services?: Array<{ icon: string; title: string; description: string; }>;
  landing_images?: Record<string, string>;
  address?: string;
  city?: string;
  state?: string;
  owner_phone?: string;
}
```

### `getTenantFromURL(): string`

Orden de prioridad (de mayor a menor):
1. `import.meta.env.VITE_TENANT_SLUG` si está definido y no vacío
2. Query param `?tenant=slug`
3. Subdominio (si no es `www`, `app`, `localhost`, `127`, `192`, `10`)
4. `localStorage.getItem('taller_tenant_slug')`
5. `'default'` como fallback

### `getCurrentTenant(): string`

1. `VITE_TENANT_SLUG` si existe
2. `localStorage.getItem('taller_tenant_slug') || 'default'`

### `setCurrentTenant(slug: string): void`

```ts
localStorage.setItem('taller_tenant_slug', slug)
```

### `clearTenant(): void`

```ts
localStorage.removeItem('taller_tenant_slug')
localStorage.removeItem('taller_tenant_config')
```

### `fetchTenantConfig(slug): Promise<TenantConfig | null>`

```
GET /api/tenants/by-slug/{slug}/public-config/
(sin headers de autenticación)
```

Guarda la respuesta en `taller_tenant_config` al obtenerla.

### `applyTenantTheme(config: TenantConfig): void`

Convierte `primary_color` (hex) a HSL y lo aplica a `--primary` y `--ring` del CSS root. Aplica `secondary_color` a `--tenant-secondary` y `--sidebar-primary`.

### `initTenant(): Promise<TenantConfig | null>`

Función de inicialización para usar en `App.tsx`:
1. `applyThemeFromCache()` — aplica colores desde cache síncronamente (evita flash)
2. `getTenantFromURL()` → slug
3. `setCurrentTenant(slug)`
4. `fetchTenantConfig(slug)` → obtiene del backend y actualiza cache
5. `applyTenantTheme(config)`

```tsx
// En App.tsx o main.tsx:
useEffect(() => {
  initTenant();
}, []);
```

---

## 6. `src/auth/api/auth.api.ts`

Instancia Axios con:
- `baseURL`: `import.meta.env.VITE_API_URL || 'https://api.autotronia.com/api'`
- Header `Content-Type: application/json`

### Interceptor de request

Agrega `X-Tenant-ID` a **todos** los requests si el tenant actual no es `'default'`:

```ts
const tenant = getCurrentTenant();
if (tenant && tenant !== 'default') {
  config.headers['X-Tenant-ID'] = tenant;
}
```

### Interceptor de response (manejo de errores)

Extrae el mensaje de error del response en este orden:
1. `data.detail`
2. `data.error`
3. `data.non_field_errors[0]`
4. Concatenación de todos los campos del objeto
5. `Error {status}: {statusText}`

Lanza `new Error(errorMessage)` para que los componentes puedan capturarlo con `err?.message`.

---

## 7. `src/auth/types/auth.types.ts`

```ts
export interface LoginPayload {
  username: string;   // es el email
  password: string;
}

export interface LoginResponse {
  token: string;
  user_id: number;
  email: string;
  name: string;
  role: string;
  tenant?: {
    id: number; name: string; slug: string;
    logo: string | null; primary_color: string; secondary_color: string; plan: string;
  };
  mechanic_profile?: {
    id: number; role: string; employee_id: string; phone?: string; status?: string;
  };
}

export interface SendRegistrationCodePayload {
  email: string;
  first_name: string;
  last_name: string;
}

export interface SendRegistrationCodeResponse {
  message?: string;
  email?: string;
}

export interface VerifyAndRegisterPayload {
  email: string;
  code: string;
  first_name: string;
  last_name: string;
  phone: string;
  password: string;
}

export interface VerifyAndRegisterResponse {
  message?: string;
  user_id?: number;
  customer_id?: number;
  tenant?: { id: number; name: string; slug: string; };
}

export interface ForgotPasswordRequestPayload { email: string; }
export interface ForgotPasswordRequestResponse { message?: string; email?: string; }

export interface ForgotPasswordVerifyPayload { email: string; code: string; }
export interface ForgotPasswordVerifyResponse { message?: string; token_id?: number; }

export interface ForgotPasswordResetPayload { email: string; code: string; new_password: string; }
export interface ForgotPasswordResetResponse { message?: string; }
```

---

## 8. `src/auth/actions/auth.actions.ts`

### `loginAction(payload: LoginPayload)`

```
POST /api/auth/login/
Body: { username, password }
```

Después del login:
1. `localStorage.setItem('taller_token', data.token)`
2. `localStorage.setItem('taller_user', JSON.stringify({ id: data.user_id, email, name, role }))`
3. Si `data.tenant.slug`: `setCurrentTenant(slug)` + guardar tenant config + `applyTenantTheme`

### `sendRegistrationCodeAction(payload)`

```
POST /api/auth/send-registration-code/
Headers: X-Tenant-ID: {currentTenant}   ← inyectado por el interceptor
Body: {
  email: payload.email.trim().toLowerCase(),
  first_name: payload.first_name.trim(),
  last_name: payload.last_name.trim()
}
```

Errores posibles del backend:
- `400 "El header X-Tenant-ID es requerido para el registro."` → tenant no configurado
- `400 "Taller no encontrado o inactivo."` → slug inválido
- `400 "Este email ya está registrado en este taller."` → email duplicado en el tenant
- `400 "Esta cuenta es de un administrador del taller. Inicia sesión directamente en el panel de administrador."` → es staff
- `400 "Esta cuenta es de un miembro del personal del taller. Inicia sesión directamente en el panel de miembro del personal."` → es mechanic/advisor

### `verifyAndRegisterAction(payload)`

```
POST /api/auth/verify-and-register/
Headers: X-Tenant-ID: {currentTenant}
Body: {
  email, code, first_name, last_name,
  phone,       // con código de país, ej: "+521234567890"
  password
}
```

Respuesta exitosa (201):
```json
{
  "message": "Cuenta creada exitosamente",
  "user_id": 1,
  "email": "juan@email.com",
  "customer_id": 5,
  "tenant": { "id": 1, "name": "Mi Taller", "slug": "mi-taller" }
}
```

Errores de brute force: `"Código inválido. Te quedan 3 intento(s)."`, `"Demasiados intentos incorrectos. Solicita un nuevo código."`

### `forgotPasswordRequestAction(payload)`

```
POST /api/auth/forgot-password/
Body: { email }
```

Respuesta: `{ message: "Código enviado. Revisa tu email.", email }`

### `forgotPasswordVerifyAction(payload)`

```
POST /api/auth/verify-code/
Body: { email, code }
```

Respuesta: `{ message: "Código válido", token_id: 1 }`

### `forgotPasswordResetAction(payload)`

```
POST /api/auth/reset-password/
Body: { email, code, new_password }
```

Respuesta: `{ message: "Contraseña actualizada exitosamente" }`

---

## 9. `src/auth/hooks/useAuthMutations.ts`

Todos usan `useMutation` de TanStack Query (`@tanstack/react-query`):

```ts
export function useLogin() {
  return useMutation({ mutationFn: (payload: LoginPayload) => loginAction(payload) });
}

export function useSendRegistrationCode() {
  return useMutation({ mutationFn: (payload: SendRegistrationCodePayload) => sendRegistrationCodeAction(payload) });
}

export function useVerifyAndRegister() {
  return useMutation({ mutationFn: (payload: VerifyAndRegisterPayload) => verifyAndRegisterAction(payload) });
}

export function useForgotPasswordRequest() {
  return useMutation({ mutationFn: (payload: ForgotPasswordRequestPayload) => forgotPasswordRequestAction(payload) });
}

export function useForgotPasswordVerify() {
  return useMutation({ mutationFn: (payload: ForgotPasswordVerifyPayload) => forgotPasswordVerifyAction(payload) });
}

export function useForgotPasswordReset() {
  return useMutation({ mutationFn: (payload: ForgotPasswordResetPayload) => forgotPasswordResetAction(payload) });
}
```

---

## 10. `src/auth/pages/Login.tsx`

### Estado local

```ts
const [email, setEmail]                 = useState('');
const [password, setPassword]           = useState('');
const [showPassword, setShowPassword]   = useState(false);
const [error, setError]                 = useState('');
const [showForgotPassword, setShowForgotPassword] = useState(false);
```

### Flujo

1. Si `isAuthenticated && user` → `<Navigate to={getDefaultRouteByRole(user.role)} replace />`
2. Si `showForgotPassword` → renderizar `<ForgotPassword onBack={() => setShowForgotPassword(false)} />`
3. Submit del formulario:
   ```ts
   const loginResponse = await loginMutation.mutateAsync({ username: email, password });
   setUser({ id: String(loginResponse.user_id), email, name: loginResponse.name, role: loginResponse.role });
   navigate(getDefaultRouteByRole(loginResponse.role), { replace: true });
   ```
4. En error: mostrar `err?.message || 'Email o contraseña incorrectos. Intenta nuevamente.'`

### UI

- Fondo con `bg-[radial-gradient(ellipse_at_top,...)] from-primary/5 via-background to-background`
- Logo: icono `<Wrench>` en caja `bg-primary` + texto `Taller<span class="text-primary">Pro</span>`
- Card con clase `glass` (glassmorphism)
- Botones sociales decorativos (Google, Apple) — solo UI, sin funcionalidad real en esta versión
- Separador "o con email"
- Input email + input password con toggle eye (`showPassword`)
- Botón "¿Olvidaste tu contraseña?" → activa `showForgotPassword`
- Footer: `© 2024 TallerPro. Sistema de Gestión Automotriz.`

### Dependencias

- `useAuth` de `@/lib/auth-context`
- `useLogin`, `getDefaultRouteByRole` de `@/auth/hooks`, `@/auth/guardian/getDefaultRoute`
- `ForgotPassword` de `@/auth/components/ForgotPassword`
- shadcn: `Button`, `Input`, `Label`, `Card`, `Alert`
- lucide: `Wrench`, `Eye`, `EyeOff`, `Loader2`, `AlertCircle`

---

## 11. `src/auth/pages/Register.tsx`

### Estado

```ts
type Step = 'form' | 'code' | 'success';
const [step, setStep] = useState<Step>('form');
const [code, setCode] = useState('');
const [error, setError] = useState('');
const [formData, setFormData] = useState({
  first_name: '', last_name: '', email: '',
  phone: '',        // solo dígitos del número
  phone_full: '',   // número con código de país (+521234567890)
  password: '', password_confirm: ''
});
```

### Paso 1: `form` → Enviar código

Validaciones locales antes del submit:
- `password !== password_confirm` → error
- `password.length < 6` → error

Llamada al backend:
```ts
await sendCodeMutation.mutateAsync({
  email: formData.email,
  first_name: formData.first_name,
  last_name: formData.last_name,
});
// Si éxito → setStep('code')
```

### Paso 2: `code` → Verificar y crear cuenta

```ts
// 1. Verificar + crear
await verifyMutation.mutateAsync({
  email: formData.email,
  code: code.trim(),
  first_name: formData.first_name,
  last_name: formData.last_name,
  phone: formData.phone_full || formData.phone,
  password: formData.password,
});

// 2. Auto-login inmediato
const loginResponse = await loginMutation.mutateAsync({
  username: formData.email,
  password: formData.password,
});

// 3. Redirigir según rol
navigate(getDefaultRouteByRole(loginResponse.role), { replace: true });
```

El step `'success'` existe en el código pero **normalmente nunca se ve** porque el auto-login redirige antes. Si el login falla tras el registro, el componente queda en step `'success'` con botón para ir a `/login`.

### Componente `PhoneInput`

```tsx
<PhoneInput
  id="phone"
  value={formData.phone}
  onChange={(digits, fullNumber) => {
    setFormData(prev => ({
      ...prev,
      phone: digits,         // solo el número sin prefijo
      phone_full: fullNumber  // "+52 55 1234 5678"
    }));
  }}
  defaultCountry="MX"
  required
/>
```

El componente `PhoneInput` está en `src/components/ui/phone-input.tsx`. Acepta:
- `value: string` — dígitos locales
- `onChange(digits: string, fullNumber: string)` — callback con ambos formatos
- `defaultCountry: string` — código ISO del país por defecto
- `required`, `disabled`

### Input de código (6 dígitos)

```tsx
onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
// Estilo: text-center text-2xl tracking-widest font-mono
// Submit deshabilitado si code.length !== 6
```

### Dependencias

- `useSendRegistrationCode`, `useVerifyAndRegister`, `useLogin`
- `getDefaultRouteByRole`
- `PhoneInput` de `@/components/ui/phone-input`
- shadcn: `Button`, `Input`, `Label`, `Card`, `Alert`
- lucide: `Wrench`, `Loader2`, `AlertCircle`, `Mail`, `KeyRound`, `CheckCircle2`, `ArrowLeft`
- `toast` de `sonner`

---

## 12. `src/auth/components/ForgotPassword.tsx`

### Props

```ts
interface ForgotPasswordProps {
  onBack?: () => void;    // Callback al presionar ArrowLeft en el primer paso
}
```

### Estado

```ts
type Step = 'email' | 'code' | 'password' | 'success';
const [step, setStep] = useState<Step>('email');
const [email, setEmail]             = useState('');
const [code, setCode]               = useState('');
const [newPassword, setNewPassword] = useState('');
const [confirmPassword, setConfirmPassword] = useState('');
const [error, setError]             = useState('');
```

### Flujo de 4 pasos

| Paso | Título | Descripción | Acción |
|------|--------|-------------|--------|
| `email` | Recuperar Contraseña | Ingresa tu email | `POST /api/auth/forgot-password/` |
| `code` | Verificar Código | Código de 6 dígitos | `POST /api/auth/verify-code/` |
| `password` | Nueva Contraseña | Mínimo 6 caracteres + confirmar | `POST /api/auth/reset-password/` |
| `success` | ¡Listo! | Contraseña actualizada | Botón → `onBack()` o `/login` |

### Paso `email`

```ts
await requestMutation.mutateAsync({ email });
// Éxito → setStep('code')
```

### Paso `code`

```ts
await verifyMutation.mutateAsync({ email, code });
// Éxito → setStep('password')
```

Input del código:
```tsx
onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
```

### Paso `password`

Validaciones locales:
- `newPassword.length < 6` → error
- `newPassword !== confirmPassword` → error

```ts
await resetMutation.mutateAsync({ email, code, new_password: newPassword });
// Éxito → setStep('success')
```

### Paso `success`

```tsx
<Button onClick={() => onBack ? onBack() : window.location.href = '/login'}>
  Ir a Iniciar Sesión
</Button>
```

### Dependencias

- `useForgotPasswordRequest`, `useForgotPasswordVerify`, `useForgotPasswordReset`
- shadcn: `Button`, `Input`, `Label`, `Card`, `Alert`
- lucide: `Mail`, `Lock`, `KeyRound`, `ArrowLeft`, `CheckCircle2`
- `toast` de `sonner`

---

## 13. `src/auth/guardian/getDefaultRoute.ts`

```ts
export function getDefaultRouteByRole(role: string | undefined | null): string {
  if (!role) return '/';
  const r = role.toLowerCase();
  if (r === 'owner' || r === 'admin') return '/dashboard';
  if (r === 'mechanic')  return '/mechanic';
  if (r === 'advisor')   return '/advisor';
  if (r === 'customer')  return '/customer';
  return '/';
}
```

---

## 14. `src/auth/guardian/ProtectedRoute.tsx`

### Props

```ts
interface ProtectedRouteProps {
  allowedRoles: string[];
  children?: React.ReactNode;
}
```

### Lógica

1. Si `isLoading` → spinner centrado
2. Si `!isAuthenticated` → `<Navigate to="/login" replace />`
3. Si `user.role` no está en `allowedRoles` → `<Navigate to={getDefaultRouteByRole(user.role)} replace />`
4. Si hay `children` → `<>{children}</>`, si no → `<Outlet />`

### Uso en rutas

```tsx
<Route element={<ProtectedRoute allowedRoles={['owner', 'admin']} />}>
  <Route path="/dashboard" element={<Dashboard />} />
</Route>

<Route element={<ProtectedRoute allowedRoles={['customer']} />}>
  <Route path="/customer" element={<CustomerPortal />} />
</Route>
```

---

## 15. Endpoints del Backend (resumen completo)

| Método | Endpoint | Header requerido | Descripción |
|--------|----------|-----------------|-------------|
| `POST` | `/api/auth/login/` | — | Login con email+password |
| `POST` | `/api/auth/send-registration-code/` | `X-Tenant-ID` | Envía código al email |
| `POST` | `/api/auth/verify-and-register/` | `X-Tenant-ID` | Verifica código y crea cuenta |
| `POST` | `/api/auth/forgot-password/` | — | Envía código de recuperación |
| `POST` | `/api/auth/verify-code/` | — | Verifica código de recuperación |
| `POST` | `/api/auth/reset-password/` | — | Cambia la contraseña |
| `POST` | `/api/auth/logout/` | Authorization | Blacklistea el refresh token |
| `GET` | `/api/tenants/by-slug/{slug}/public-config/` | — | Config pública del tenant |

---

## 16. Reglas de negocio importantes (backend)

Estas reglas están implementadas en el backend. El frontend solo necesita manejar bien los mensajes de error:

1. **Tenant requerido para registro:** `send-registration-code` y `verify-and-register` requieren `X-Tenant-ID`. Si el tenant es `'default'`, el interceptor NO envía el header y el backend retorna `400`.

2. **Staff bloqueado del registro de clientes:** Si el email pertenece a admin/owner/mechanic/advisor del tenant, el backend retorna:
   - `"Esta cuenta es de un administrador del taller. Inicia sesión directamente en el panel de administrador."`
   - `"Esta cuenta es de un miembro del personal del taller. Inicia sesión directamente en el panel de miembro del personal."`

3. **Usuarios Google:** Un usuario registrado vía Google (sin contraseña) puede registrarse por email para establecer contraseña. El backend lo permite.

4. **Multi-tenant:** El mismo email puede ser cliente en múltiples talleres. No hay bloqueo cross-tenant.

5. **Brute force en registro:** Máximo 5 intentos de código. Al superar el límite: `"Demasiados intentos incorrectos. Solicita un nuevo código."` y el cache se borra.

6. **Expiración del código:** 15 minutos tanto para registro como para recuperación de contraseña.

---

## 17. Dependencias npm necesarias

```json
{
  "dependencies": {
    "axios": "^1.x",
    "@tanstack/react-query": "^5.x",
    "react-router-dom": "^6.x",
    "sonner": "^1.x",
    "lucide-react": "^0.x"
  }
}
```

shadcn/ui components necesarios:
- `button`, `input`, `label`, `card`, `alert`

Componente personalizado necesario:
- `src/components/ui/phone-input.tsx` — PhoneInput con selector de país y formateo internacional

---

## 18. Notas de implementación

### Token storage

El token de acceso se guarda en `localStorage` bajo `taller_token`. **No se usa** `access`/`refresh` separados en esta implementación — solo un token. Si en el futuro se migra a refresh tokens, actualizar `auth-context.tsx`.

### Tenant en requests autenticados

Para requests a la API con el usuario ya autenticado (no solo auth), crear una segunda instancia Axios (`api.ts`) que además del `X-Tenant-ID` también inyecte `Authorization: Bearer {token}`.

### Theming dinámico

Al hacer login, si el response incluye `tenant.primary_color` y `tenant.secondary_color`, llamar `applyTenantTheme(tenant)` para aplicar los colores del taller al CSS root (variables `--primary`, `--ring`, `--sidebar-primary`).

### Routing

Rutas públicas: `/login`, `/register`
Rutas protegidas por rol:
- `owner`/`admin` → `/dashboard`
- `mechanic` → `/mechanic`
- `advisor` → `/advisor`
- `customer` → `/customer`
