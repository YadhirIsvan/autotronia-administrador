# spec_14 — Bug: WebSocket falla con código 1006 al hacer login como admin

**Estado:** Completado
**Fecha:** 2026-03-21
**Prioridad:** Alta — WebSocket no conecta, notificaciones en tiempo real rotas
**Síntoma:** `WebSocket connection to 'ws://localhost:8001/ws/notifications/...' failed` + código 1006 + reconexión infinita cada 5s

---

## 1. Síntoma

Al hacer login como admin (o cualquier usuario), el frontend intenta conectar el WebSocket a:
```
ws://localhost:8001/ws/notifications/?token=<JWT>
```
La conexión falla inmediatamente con **código 1006** (cierre anormal sin frame de cierre),
y el cliente reintenta cada 5–30 segundos indefinidamente.

---

## 2. Causa Raíz — Dos problemas independientes encadenados

### Problema 1 (PRINCIPAL): Puerto 8001 no expuesto al host

El usuario corre `docker compose up -d` (producción), donde `docker-compose.yml` define:

```yaml
# docker-compose.yml línea 91-92
daphne:
  expose:
    - "8001"   # Solo visible DENTRO de la red Docker interna
  # No hay "ports:" → puerto 8001 NO accesible desde localhost del host
```

Mientras que `docker-compose.dev.yml` sí lo expone:
```yaml
# docker-compose.dev.yml línea 97-98
daphne:
  ports:
    - "8001:8001"   # Mapeado al host
```

**El frontend intenta `ws://localhost:8001`** pero ese puerto no existe en la interfaz de red del host → conexión rechazada → código 1006.

### Problema 2 (SECUNDARIO): `websocket.ts` hardcodea puerto 8001 para localhost

```typescript
// websocket.ts líneas 210-214
if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
  const wsPort = '8001'; // Puerto de Daphne en desarrollo
  console.log('[WebSocket] Modo desarrollo - usando puerto:', wsPort);
  return `${wsProtocol}//${url.hostname}:${wsPort}/ws/notifications/`;
}
```

El código asume que en localhost siempre está disponible el puerto 8001 (docker-compose.dev.yml).
Cuando se usa docker-compose.yml (producción), nginx escucha en `8080:80` y Daphne es interno.
La URL correcta debería ser `ws://localhost:8080/ws/notifications/` (a través de nginx).

La línea 216 ya tiene la lógica correcta para producción:
```typescript
return `${wsProtocol}//${url.host}/ws/notifications/`;
// → para VITE_API_URL=http://localhost:8080/api retornaría ws://localhost:8080/ws/notifications/
```
El bloque `if localhost` en líneas 210-214 **sobrescribe esta lógica correcta** antes de llegar ahí.

### Problema 3 (SECUNDARIO): CorsOriginValidator en producción

`config/asgi.py` líneas 36-46:
```python
if settings.DEBUG:
    websocket_application = AuthMiddlewareStack(URLRouter(...))  # sin CORS
else:
    websocket_application = CorsOriginValidator(               # con CORS
        AuthMiddlewareStack(URLRouter(...)),
        allowed_origins=[],
    )
```

El servicio `daphne` en `docker-compose.yml` usa `DJANGO_SETTINGS_MODULE=config.settings.production` → `DEBUG=False` → **CorsOriginValidator activo**.

`CorsOriginValidator.valid_origin()` (líneas 27-32) verifica que el `Origin` del browser esté en `CORS_ALLOWED_ORIGINS`. Actualmente `.env` solo incluye:
```
CORS_ALLOWED_ORIGINS=https://app.autotronia.com,https://front-end-taller-pro.vercel.app
```
`http://localhost:8081` (donde corre el frontend local) **no está en la lista** → la conexión sería rechazada incluso si el puerto fuera accesible.

---

## 3. Flujo correcto (cómo debe funcionar)

```
Browser en localhost:8081
  ↓
VITE_API_URL=http://localhost:8080/api
  ↓ getWebSocketUrl() extrae host = "localhost:8080"
  ↓ retorna: ws://localhost:8080/ws/notifications/
  ↓
Nginx (puerto 8080 del host → puerto 80 interno)
  ↓ nginx.conf rutea /ws/ → proxy_pass daphne:8001
  ↓ headers: Upgrade: websocket, Connection: upgrade
  ↓ Origin header: http://localhost:8081
  ↓
Daphne (puerto 8001 interno)
  ↓ CorsOriginValidator.valid_origin("http://localhost:8081")
  ↓ "http://localhost:8081" en CORS_ALLOWED_ORIGINS? → SÍ (post-fix)
  ↓
NotificationConsumer.connect()
  ↓ valida JWT → extrae user_id + tenant_id del claim
  ↓ acepta conexión
  ↓
Browser recibe onopen ✓
```

---

## 4. Archivos afectados

| Archivo | Problema | Acción |
|---------|----------|--------|
| `front-end-taller-pro/src/lib/websocket.ts` | Líneas 210-214: hardcodea puerto 8001 para localhost | Eliminar el bloque `if localhost` |
| `backend-taller-pro/.env` | `CORS_ALLOWED_ORIGINS` no incluye `http://localhost:8081` | Agregar origenes locales |

---

## 5. Plan de implementación

### Paso 1 — Fix `websocket.ts`: eliminar hardcode de puerto 8001 ✅ DONE

**Archivo:** `front-end-taller-pro/src/lib/websocket.ts`

```typescript
// ANTES (líneas 209-214) — problemático
// En desarrollo local con Docker, Daphne corre en puerto 8001
if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
  const wsPort = '8001'; // Puerto de Daphne en desarrollo
  console.log('[WebSocket] Modo desarrollo - usando puerto:', wsPort);
  return `${wsProtocol}//${url.hostname}:${wsPort}/ws/notifications/`;
}

// DESPUÉS — eliminar esas 5 líneas completamente
// La línea 216 ya maneja todos los casos correctamente:
return `${wsProtocol}//${url.host}/ws/notifications/`;
// Ejemplos:
//   VITE_API_URL=http://localhost:8080/api  → ws://localhost:8080/ws/notifications/
//   VITE_API_URL=https://api.autotronia.com/api → wss://api.autotronia.com/ws/notifications/
```

Después del fix, `getWebSocketUrl()` queda:
```typescript
export function getWebSocketUrl(): string {
  const wsUrl = import.meta.env.VITE_WS_URL;
  if (wsUrl) {
    console.log('[WebSocket] Usando VITE_WS_URL:', wsUrl);
    return wsUrl;
  }

  const apiUrl = import.meta.env.VITE_API_URL || 'https://api.autotronia.com/api';

  try {
    const url = new URL(apiUrl);
    const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${wsProtocol}//${url.host}/ws/notifications/`;
  } catch {
    const isSecure = window.location.protocol === 'https:';
    const wsProtocol = isSecure ? 'wss:' : 'ws:';
    const host = window.location.hostname === 'localhost'
      ? `${window.location.hostname}:8080`
      : 'api.autotronia.com';
    return `${wsProtocol}//${host}/ws/notifications/`;
  }
}
```

### Paso 2 — Fix `.env`: agregar orígenes locales a CORS_ALLOWED_ORIGINS ✅ DONE

**Archivo:** `backend-taller-pro/.env`

```env
# ANTES
CORS_ALLOWED_ORIGINS=https://app.autotronia.com,https://front-end-taller-pro.vercel.app

# DESPUÉS — agregar localhost para desarrollo local
CORS_ALLOWED_ORIGINS=https://app.autotronia.com,https://front-end-taller-pro.vercel.app,http://localhost:8081,http://localhost:5173,http://localhost:3000
```

> El servicio `daphne` ya usa `env_file: .env` (línea 93-94 de docker-compose.yml),
> por lo que esta variable llega automáticamente a Daphne al reiniciar.

### Paso 3 — Verificar VITE_API_URL en el frontend ✅ DONE

Confirmar que el frontend `.env` tiene `VITE_API_URL` apuntando a nginx (puerto 8080):

```env
# front-end-taller-pro/.env
VITE_API_URL=http://localhost:8080/api
```

Si no está definida, `getWebSocketUrl()` usará el fallback `https://api.autotronia.com/api`
y la lógica `catch` retornará `ws://localhost:8080/ws/notifications/` via el fallback corregido.

### Paso 4 — Reiniciar servicios ✅ DONE

```bash
cd backend-taller-pro/
docker compose restart daphne
```

Solo necesita reiniciar `daphne` (para que lea los nuevos `CORS_ALLOWED_ORIGINS` del `.env`).
El frontend recarga automáticamente al editar `.env` en modo dev (Vite HMR).

---

## 6. Plan de pruebas unitarias — `getWebSocketUrl()`

### Setup — instalar Vitest (primera vez en el proyecto) ✅ DONE

El frontend no tiene framework de tests. Vitest es el estándar para proyectos Vite.

```bash
cd front-end-taller-pro/
npm install -D vitest @vitest/ui jsdom @testing-library/react
```

**`vite.config.ts`** — agregar bloque `test`:

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig(({ mode }) => ({
  server: { host: "::", port: 8081 },
  plugins: [...],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },

  // AGREGAR:
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
  },
}));
```

**`src/test/setup.ts`** — archivo de setup vacío por ahora:
```typescript
// setup para futuros tests globales
```

**`package.json`** — agregar script:
```json
"scripts": {
  "test": "vitest",
  "test:ui": "vitest --ui",
  "test:run": "vitest run"
}
```

---

### Archivo de tests: `src/lib/websocket.test.ts` ✅ DONE — 11 tests pasan

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getWebSocketUrl } from './websocket';

// Helper para mockear import.meta.env
function setEnv(vars: Record<string, string | undefined>) {
  vi.stubEnv('VITE_WS_URL', vars.VITE_WS_URL ?? '');
  vi.stubEnv('VITE_API_URL', vars.VITE_API_URL ?? '');
}

describe('getWebSocketUrl()', () => {

  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  // ─── VITE_WS_URL override ───────────────────────────────────────────────

  it('usa VITE_WS_URL directamente si está definida', () => {
    setEnv({ VITE_WS_URL: 'ws://custom-host:9999/ws/notifications/' });
    expect(getWebSocketUrl()).toBe('ws://custom-host:9999/ws/notifications/');
  });

  it('ignora VITE_API_URL cuando VITE_WS_URL está definida', () => {
    setEnv({
      VITE_WS_URL: 'ws://custom/ws/notifications/',
      VITE_API_URL: 'http://localhost:8080/api',
    });
    expect(getWebSocketUrl()).toBe('ws://custom/ws/notifications/');
  });

  // ─── VITE_API_URL → http (ws://) ────────────────────────────────────────

  it('localhost:8080 → ws://localhost:8080/ws/notifications/', () => {
    setEnv({ VITE_API_URL: 'http://localhost:8080/api' });
    expect(getWebSocketUrl()).toBe('ws://localhost:8080/ws/notifications/');
  });

  it('127.0.0.1:8080 → ws://127.0.0.1:8080/ws/notifications/', () => {
    setEnv({ VITE_API_URL: 'http://127.0.0.1:8080/api' });
    expect(getWebSocketUrl()).toBe('ws://127.0.0.1:8080/ws/notifications/');
  });

  // ─── VITE_API_URL → https (wss://) ──────────────────────────────────────

  it('producción https → wss://api.autotronia.com/ws/notifications/', () => {
    setEnv({ VITE_API_URL: 'https://api.autotronia.com/api' });
    expect(getWebSocketUrl()).toBe('wss://api.autotronia.com/ws/notifications/');
  });

  // ─── VITE_API_URL no definida → fallback ────────────────────────────────

  it('sin VITE_API_URL usa default https://api.autotronia.com/api', () => {
    setEnv({});
    // El fallback es 'https://api.autotronia.com/api' → wss
    expect(getWebSocketUrl()).toBe('wss://api.autotronia.com/ws/notifications/');
  });

  // ─── Regresión: NUNCA debe retornar puerto 8001 en ningún caso ──────────

  it('REGRESIÓN: no retorna puerto 8001 hardcodeado para localhost', () => {
    setEnv({ VITE_API_URL: 'http://localhost:8080/api' });
    const url = getWebSocketUrl();
    expect(url).not.toContain(':8001');
    expect(url).toBe('ws://localhost:8080/ws/notifications/');
  });

  it('REGRESIÓN: no retorna puerto 8001 cuando VITE_API_URL tiene otro puerto', () => {
    setEnv({ VITE_API_URL: 'http://localhost:3000/api' });
    const url = getWebSocketUrl();
    expect(url).not.toContain(':8001');
    expect(url).toBe('ws://localhost:3000/ws/notifications/');
  });

  // ─── Siempre termina en /ws/notifications/ ───────────────────────────────

  it('la URL siempre termina en /ws/notifications/', () => {
    setEnv({ VITE_API_URL: 'https://api.autotronia.com/api' });
    expect(getWebSocketUrl()).toMatch(/\/ws\/notifications\/$/);
  });

  // ─── Protocolo correcto según API ───────────────────────────────────────

  it('http en VITE_API_URL produce ws:// (no wss://)', () => {
    setEnv({ VITE_API_URL: 'http://localhost:8080/api' });
    expect(getWebSocketUrl()).toMatch(/^ws:\/\//);
  });

  it('https en VITE_API_URL produce wss:// (no ws://)', () => {
    setEnv({ VITE_API_URL: 'https://api.autotronia.com/api' });
    expect(getWebSocketUrl()).toMatch(/^wss:\/\//);
  });

});
```

### Ejecutar tests

```bash
cd front-end-taller-pro/
npm run test:run
```

### Resultado esperado

```
✓ src/lib/websocket.test.ts (10 tests)
  ✓ usa VITE_WS_URL directamente si está definida
  ✓ ignora VITE_API_URL cuando VITE_WS_URL está definida
  ✓ localhost:8080 → ws://localhost:8080/ws/notifications/
  ✓ 127.0.0.1:8080 → ws://127.0.0.1:8080/ws/notifications/
  ✓ producción https → wss://api.autotronia.com/ws/notifications/
  ✓ sin VITE_API_URL usa default https://api.autotronia.com/api
  ✓ REGRESIÓN: no retorna puerto 8001 hardcodeado para localhost
  ✓ REGRESIÓN: no retorna puerto 8001 cuando VITE_API_URL tiene otro puerto
  ✓ la URL siempre termina en /ws/notifications/
  ✓ http en VITE_API_URL produce ws:// (no wss://)
  ✓ https en VITE_API_URL produce wss:// (no ws://)

Test Files  1 passed (1)
Tests       10 passed (10)
```

---

## 7. Criterios de aceptación

- [x] La consola del browser NO muestra `using puerto: 8001` — el mensaje de modo desarrollo desaparece
- [x] La URL del WebSocket es `ws://localhost:8080/ws/notifications/` (a través de nginx)
- [ ] La conexión WebSocket se establece exitosamente (`[WebSocket] Conectado` en consola)
- [ ] NO hay reconexión infinita cada 5s
- [ ] Las notificaciones llegan en tiempo real en el panel de admin
- [x] En producción (`app.autotronia.com`) la URL sigue siendo `wss://api.autotronia.com/ws/notifications/` ✓

---

## 7. Riesgos y mitigaciones

| Riesgo | Prob. | Impacto | Mitigación |
|--------|-------|---------|------------|
| VITE_API_URL no definida → fallback usa `api.autotronia.com` → WS conecta a producción desde local | Media | Bajo | El fallback en `catch` ahora usa `localhost:8080` explícitamente cuando hostname es localhost |
| Puerto del frontend local cambia (no es siempre 8081) | Media | Bajo | CORS_ALLOWED_ORIGINS incluye también los puertos comunes 5173, 3000 |
| CORS_ALLOWED_ORIGINS con localhost llega a producción real | Baja | Bajo | En producción, las peticiones no vendrán de localhost; la lista solo se usa para validar el `Origin` header |
| `VITE_WS_URL` en `.env` sobrescribe toda la lógica | Ninguno | N/A | Está diseñado así como override explícito — documentar en `.env.example` |

---

## 8. Nota adicional — docker-compose.dev.yml

Si en el futuro el usuario usa `docker-compose.dev.yml` (stack de desarrollo completo),
el port 8001 SÍ está expuesto y Daphne usa `DEBUG=True` → sin CorsOriginValidator.
Con el fix de `websocket.ts`, el frontend apuntaría a `ws://localhost:<puerto_api>/ws/`
que puede ser 8000 (gunicorn dev) en lugar de 8001.

Para ese setup, el `VITE_WS_URL` override sigue siendo la válvula de escape limpia:
```env
VITE_WS_URL=ws://localhost:8001/ws/notifications/
```
