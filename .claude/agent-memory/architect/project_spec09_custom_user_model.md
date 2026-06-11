---
name: spec_09_custom_user_model
description: Custom User Model sin username, contraseñas por tenant — implementar 2026-03-17
type: project
---

spec_09 aprobado y documentado en `backend-taller-pro/docs/specs/spec_09_custom_user_model.md`.

Decisiones tomadas:
- `apps/accounts.User` reemplaza `auth.User`
- `email` sin `unique` global — unicidad por `(email, tenant)` via `TenantEmailBackend`
- `username` eliminado para siempre
- Login: `email + password + tenant_slug`
- No hay datos reales en produccion — BD se borra y se regeneran migraciones
- Deadline: hoy 2026-03-17 antes de que entren datos reales

**Why:** El mismo email debe poder existir en múltiples tenants como usuarios independientes con contraseñas distintas. auth.User tiene unique=True en email y username obligatorio, lo que impide esto.

**How to apply:** Cuando se implemente o modifique autenticacion, recordar que el login ya no acepta `username` — solo `email + password + tenant_slug`. `TenantEmailBackend` es el unico backend en `AUTHENTICATION_BACKENDS`.

Archivos clave nuevos:
- `apps/accounts/models.py` — Custom User Model
- `apps/accounts/backends.py` — TenantEmailBackend
- `apps/accounts/tests/test_custom_user.py` — 13 tests

Archivos con cambios de mayor impacto:
- `apps/core/views.py` — CustomJWTLoginView y GoogleAuthView
- `apps/tenants/models.py` — TenantUser FK
- `apps/tenants/views.py` — TenantRegistrationView
- `apps/mechanics/serializers.py` — eliminar campo username
- `conftest.py` — UserFactory sin username
