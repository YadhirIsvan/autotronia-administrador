# CLAUDE.md — Taller Pro (Raíz del Proyecto)

## Descripción General

**Taller Pro** (autotronia.com) es un sistema de gestión para talleres mecánicos multi-tenant. Permite administrar citas, órdenes de trabajo, inventario, clientes, vehículos, mecánicos y notificaciones en tiempo real.

## Estructura del Repositorio

```
tallerv2/
├── backend-taller-pro/     # API REST Django + WebSockets (Daphne)
├── front-end-taller-pro/   # SPA React + TypeScript + Vite
└── ARQUITECTURA_BACKEND.html
```

## Stack Tecnológico

| Capa | Tecnología |
|------|-----------|
| Backend | Django 5.0.2 + DRF 3.14 + Python 3.11 |
| WebSockets | Django Channels 4.0 + Daphne + Redis |
| Base de Datos | PostgreSQL 15 |
| Cache / Channels | Redis 7 |
| Frontend | React 18 + TypeScript 5.8 + Vite 5.4 |
| UI | shadcn-ui (Radix) + Tailwind CSS 3.4 |
| Proxy / SSL | Nginx 1.25 + Let's Encrypt (Certbot) |
| Contenedores | Docker + Docker Compose |
| WhatsApp | WAHA (devlikeapro/waha) |

## Orquestación con Docker Compose

### Producción

```bash
cd backend-taller-pro/
docker compose up -d
```

**Servicios y puertos:**

| Servicio | Container | Puerto Host | Descripción |
|----------|-----------|-------------|-------------|
| `web` | taller_backend | interno | Gunicorn (API REST) |
| `daphne` | taller_daphne | interno | ASGI / WebSockets |
| `nginx` | taller_nginx | 80, 443 | Reverse proxy + SSL |
| `db` | taller_db | 5433 | PostgreSQL |
| `redis` | taller_redis | 6379 | Cache + Channels |
| `pgadmin` | taller_pgadmin | 5050 | Admin BD |
| `waha` | taller_waha | 3000 | WhatsApp API |
| `certbot` | taller_certbot | — | Renovación SSL |

### Desarrollo Local

```bash
cd backend-taller-pro/
docker compose -f docker-compose.dev.yml up --build
```

### Script de Deploy

```bash
./deploy.sh primera-vez    # Setup inicial completo
./deploy.sh actualizar     # git pull + rebuild + restart
./deploy.sh ssl            # Configurar SSL con Certbot
./deploy.sh backup         # Backup de base de datos
./deploy.sh logs           # Tail de logs de servicios
./deploy.sh status         # Health check de todos los servicios
./deploy.sh restart        # Reiniciar todos los servicios
```

## Dominios

- **Frontend:** `https://app.autotronia.com`
- **API / Backend:** `https://api.autotronia.com`
- **WebSockets:** `wss://api.autotronia.com/ws/`

## Routing de Nginx

| Path | Destino | Protocolo |
|------|---------|-----------|
| `/api/` | Gunicorn :8000 | HTTP |
| `/admin/` | Gunicorn :8000 | HTTP |
| `/ws/` | Daphne :8001 | WebSocket Upgrade |
| `/static/` | Archivos estáticos | Directo |
| `/media/` | Archivos media | Directo |

> **IMPORTANTE:** El bloque `/ws/` con WebSocket headers (`Upgrade`, `Connection`) solo está definido en el server de HTTPS (443). El server HTTP (80) no enruta WebSockets.

## Variables de Entorno Críticas

Todas en `backend-taller-pro/.env`:

```env
# Django
SECRET_KEY=
DJANGO_SETTINGS_MODULE=config.settings.production
ALLOWED_HOSTS=api.autotronia.com
DEBUG=False

# Base de datos
DB_NAME=taller_pro
DB_USER=postgres
DB_PASSWORD=
DB_HOST=db

# Redis
REDIS_URL=redis://redis:6379/0

# CORS — Frontend debe estar aquí para WebSockets
CORS_ALLOWED_ORIGINS=https://app.autotronia.com,https://front-end-taller-pro.vercel.app
CSRF_TRUSTED_ORIGINS=https://api.autotronia.com

# WhatsApp
WAHA_API_URL=http://waha:3000
WAHA_API_KEY=
WAHA_SESSION_NAME=default
```

## Arquitectura Multi-Tenant

Cada taller opera como un **tenant** aislado. El tenant se identifica con el header `X-Tenant-ID` en cada request. Los middlewares `TenantMiddleware` y `TenantFromUserMiddleware` resuelven el tenant del usuario autenticado automáticamente.

## Roles de Usuario

| Rol | Acceso |
|-----|--------|
| `superadmin` | Todos los tenants |
| `admin` / `owner` | Su tenant completo |
| `advisor` | Citas + clientes |
| `mechanic` | Sus tareas + órdenes asignadas |
| `customer` | Su historial y reservas |

## Flujo Principal

```
Cliente reserva cita (Booking público)
    ↓
Asesor confirma cita → WebSocket notifica a staff
    ↓
Cliente hace check-in → Orden de trabajo creada
    ↓
Mecánico ejecuta tareas → Actualiza estado OT
    ↓
OT "lista" → Notificación a asesores
    ↓
Entrega → OT y cita marcadas como completadas
```

## Comandos de Mantenimiento Rápido

```bash
# Ver logs en tiempo real
docker compose logs -f web daphne

# Ejecutar comando Django dentro del container
docker compose exec web python manage.py shell

# Crear superusuario
docker compose exec web python manage.py createsuperuser

# Migraciones
docker compose exec web python manage.py migrate

# Setup inicial de grupos/permisos
docker compose exec web python manage.py setup_groups
```

## Documentación Específica

- **Backend:** `backend-taller-pro/CLAUDE.md`
- **Frontend:** `front-end-taller-pro/CLAUDE.md`
- **Arquitectura visual:** `ARQUITECTURA_BACKEND.html`
- **Guía de deploy:** `backend-taller-pro/DEPLOYMENT.md`
