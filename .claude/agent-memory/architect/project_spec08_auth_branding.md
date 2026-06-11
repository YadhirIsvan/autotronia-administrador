---
name: spec_08_auth_branding
description: Estado y decisiones del spec_08 — Auth multi-tenant, branding Autotronia, UI mobile-first
type: project
---

Plan ejecutable en `/backend-taller-pro/docs/specs/spec_08_auth_registro_ui_autotronia.md`.

**Decisión clave — Opción 3 (auth_user compartido):** Un email = un `auth_user` global. Si el email ya existe en otro tenant, el endpoint `send_registration_code` responde `{"existing_user": true}` (HTTP 200) en lugar de bloquear. `verify_and_register` reutiliza el `auth_user` existente sin cambiar la contraseña.

**Por qué:** Evitar duplicados de `auth_user` para el mismo email real. El usuario usa su contraseña existente para acceder al nuevo taller.

**How to apply:** Al revisar o implementar el flujo de registro, recordar que el gap principal está en `apps/password_reset/views.py` líneas 234 y 378 (actualmente bloquean si `User.objects.filter(email=email).exists()`). Deben corregirse en Fase 1.

**Branding:** "TallerPro" → "Autotronia". Logo: `public/autotronia-logo.png` (fondo negro, gradiente teal #0891b2→#06b6d4). Copyright "© 2025 Autotronia. El Motor de tu Negocio."

**Archivos backend a modificar:**
- `apps/password_reset/views.py` — funciones `send_registration_code` y `verify_and_register`
- `apps/core/views.py` — `CustomJWTLoginView.post()` para preferir tenant de `X-Tenant-ID`
- `apps/customers/serializers.py` — `CustomerCreateSerializer.validate()`
- `apps/tenants/serializers.py` — `TenantUserCreateSerializer.validate()` (puede necesitar crearse)

**Archivos frontend a modificar:**
- `src/pages/Login.tsx` — eliminar botón Apple, logo, copyright, estilos teal
- `src/pages/Register.tsx` — GoogleLogin, existing_user step, enlace login mobile, logo, copyright, estilos

**REQ-4 (Google OAuth):** Validado como completado en plan_07. `GoogleAuthView` en `apps/core/views.py` ya crea Customer + TenantUser correctamente.

**Estado al 2026-03-17:** Plan creado, pendiente de implementación.
