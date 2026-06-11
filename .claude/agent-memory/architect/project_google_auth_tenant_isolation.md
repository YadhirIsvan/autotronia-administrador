---
name: google_auth_tenant_isolation
description: Bug de seguridad en GoogleAuthView — aislamiento multi-tenant comprometido en login con Google OAuth
type: project
---

Bug crítico documentado en plan_07_google_oauth_tenant_isolation.md (2026-03-17).

**Why:** El campo `google_sub` en `Customer` tiene `unique=True` global, y `GoogleAuthView`
busca por `google_sub` sin filtrar por tenant. Un cliente de taller A puede ser autenticado
en taller B con tokens del taller incorrecto.

**How to apply:** El plan está en `backend-taller-pro/docs/specs/plan_07_google_oauth_tenant_isolation.md`.
Los dos cambios clave son:
1. Modelo `Customer`: quitar `unique=True`, agregar `UniqueConstraint(fields=['tenant', 'google_sub'], condition=Q(google_sub__isnull=False), name='unique_google_sub_per_tenant')` en `Meta.constraints`.
2. Vista `GoogleAuthView` (`apps/core/views.py`): las dos búsquedas deben ser tenant-scoped.

Deuda técnica relacionada: `Customer.user` es `OneToOneField` — impide que el mismo usuario Django
sea Customer en más de un tenant. Requiere plan separado para cambiar a `ForeignKey`.
