# spec_09 — Custom User Model + Contraseñas por Tenant

**Estado:** Análisis de impacto
**Fecha:** 2026-03-17
**Prioridad:** Alta — afecta arquitectura base

---

## 1. Resumen ejecutivo

### Problema de negocio

Taller Pro es un SaaS multi-tenant. Un cliente real (persona) puede tener cuenta en múltiples talleres que usan la plataforma. Hoy ambos problemas coexisten:

1. **Contraseña compartida entre talleres**: si Juan tiene cuenta en "Taller Norte" y "Taller Sur", cambiar la contraseña en uno la cambia en el otro. Es inaceptable en un SaaS — los clientes de cada taller son entidades independientes desde la perspectiva del dueño del taller.

2. **`username` redundante**: el campo `username` de `auth_user` se llena con el email (workaround documentado en el código: `username=email` aparece en 7 lugares distintos). Tiene su propio índice `UNIQUE`, genera colisiones que se resuelven con UUID appended (`f"{email}_{uuid4().hex[:8]}"`), y se filtra hasta los test de `test_auth_roles.py` donde hay pruebas de login por `username` que no deberían existir en 2026.

### Riesgo técnico actual

- `User.objects.filter(username=username).exists()` aparece en **5 archivos distintos** como guardia antes de crear usuarios: si dos talleres registran al mismo email simultáneamente puede haber race condition.
- `EmailBackend.authenticate()` hace fallback a `username` (línea 21 de `backends.py`) — si algún usuario tiene un username diferente al email (cualquier admin creado por Django shell o migración vieja), puede autenticarse con ese username, saltando la lógica multi-tenant.
- `reset_password` en `password_reset/views.py` llama `user.set_password(new_password)` y `user.save()` — modifica la contraseña del `auth_user` global, afectando a todos los tenants donde ese usuario existe.

---

## 2. Estado actual del código

### 2.1 Modelo de usuario

No hay `AUTH_USER_MODEL` custom. El proyecto usa el `django.contrib.auth.models.User` estándar sin ninguna modificación al modelo. Confirmado por el grep: ningún archivo en apps/ define `AbstractUser`, `AbstractBaseUser`, o `AUTH_USER_MODEL =`.

Todas las migraciones declaran `migrations.swappable_dependency(settings.AUTH_USER_MODEL)` — lo que significa que están preparadas para un swap, pero nunca se ha hecho uno.

### 2.2 Usos de `username` (exhaustivo, excluyendo tests y migraciones)

| Archivo | Línea | Uso |
|---------|-------|-----|
| `password_reset/views.py` | 263 | `username=email` en `User()` temporal (no se guarda) |
| `password_reset/views.py` | 415-417 | `username = email`, collision check con UUID |
| `password_reset/views.py` | 419 | `User.objects.create_user(username=username, ...)` |
| `password_reset/views.py` | 478 | `'username': user.username` en respuesta JSON |
| `password_reset/views.py` | 54 | `user.get_full_name() or user.username` en email |
| `password_reset/models.py` | 24 | `f"{self.user.username} - {self.code}"` en `__str__` |
| `core/views.py` | 124 | `user.get_full_name() or user.username` |
| `core/views.py` | 357-362 | `username = email`, collision check con `google_sub[:8]` |
| `core/views.py` | 403 | `user.get_full_name() or user.username` |
| `core/backends.py` | 21 | `User.objects.get(username=username)` — fallback peligroso |
| `mechanics/views.py` | 102 | `username=data['username']` — el frontend envía campo `username` |
| `mechanics/serializers.py` | 230 | `username = serializers.CharField(max_length=150)` en `MechanicRegistrationSerializer` |
| `mechanics/serializers.py` | 240-243 | `validate_username()` — valida unicidad global de username |
| `mechanics/serializers.py` | 59 | `fields = ['id', 'username', ...]` — expuesto en API |
| `mechanics/serializers.py` | 206-207 | `get_username()` devuelve `obj.user.username` al frontend |
| `mechanics/services/mechanic_service.py` | 25 | `User.objects.filter(username=user_data['username']).exists()` |
| `customers/views.py` | 998 | `'username': serializer.validated_data['email']` |
| `customers/serializers.py` | 489 | `User.objects.filter(username=email).exists()` |
| `customers/services/customer_service.py` | 90 | `username=user_data.get('username')` |
| `tenants/views.py` | 78 | `User.objects.filter(username=email).exists()` (doble check) |
| `tenants/views.py` | 127 | `username=email` comentado explícitamente |
| `tenants/models.py` | 339 | `f"{self.user.username} → {self.tenant.name}"` en `__str__` |
| `tenants/admin.py` | 73 | `search_fields = ['user__username', ...]` |
| `tenants/serializers.py` | 232 | `obj.user.get_full_name() or obj.user.username` |
| `notifications/models.py` | 60 | `f"{self.title} - {self.user.username}"` |
| `notifications/admin.py` | 13 | `search_fields = ['user__username']` |
| `mechanics/models.py` | 211 | `self.user.username` fallback en nombre |

**Total: 26 puntos de uso de `username` en código de producción.** Ninguno le da un valor distinto al email — son todos workarounds o displays del mismo dato.

### 2.3 Usos de `User.objects` relevantes para contraseñas

- `password_reset/views.py:191` — `user.set_password(new_password)` + `user.save()` modifica contraseña global.
- `password_reset/views.py:250` — `User.objects.filter(email=email).exists()` detecta usuarios existentes en _cualquier_ tenant y retorna `existing_user: True` con mensaje "usa tu contraseña existente para acceder aquí" — esto confirma que el problema de contraseña compartida es conocido y está documentado como workaround en el código.
- El flujo `verify_and_register` (línea 411) reutiliza el `auth_user` existente sin actualizar la contraseña — correcto para no sobrescribir, pero deja al usuario sin contraseña si se registró primero en otro taller con Google OAuth (`set_unusable_password()`).

### 2.4 `Customer.user` es `OneToOneField`

`customers/models.py:28` — `user = models.OneToOneField(User, ...)`. Esto significa que un `auth_user` solo puede tener UN `Customer` en toda la base de datos. Si el mismo email se registra como cliente en dos talleres distintos, el segundo `Customer.objects.get_or_create(user=user, tenant=tenant)` en `verify_and_register` produce un segundo Customer con el mismo `user` — lo cual viola el OneToOneField.

**Este es un bug activo**: el código en `password_reset/views.py:448` llama `Customer.objects.get_or_create(user=user, tenant=tenant)`, que intentaría crear dos registros con el mismo `user` si el cliente ya existe en otro tenant. El `OneToOneField` lanzaría `IntegrityError`.

---

## 3. Los dos cambios y sus opciones

### Cambio 1: Contraseñas independientes por tenant

#### Opción A — Modelo `TenantCredential`

```python
class TenantCredential(models.Model):
    user   = ForeignKey(User, on_delete=CASCADE)
    tenant = ForeignKey(Tenant, on_delete=CASCADE)
    password = CharField(max_length=128)  # Django hash
    class Meta:
        unique_together = ['user', 'tenant']
```

Flujo de autenticación: `EmailBackend` busca el `User` por email, luego busca `TenantCredential(user, tenant_from_request)` y llama `check_password()` sobre ese hash. El `User.password` queda como `set_unusable_password()` o como contraseña de "cuenta maestra" (nunca expuesta).

**Pros:**
- Un solo `auth_user` por persona real en el sistema — preserva el invariante actual.
- Migración no destructiva: se puede introducir en paralelo, migrar contraseñas existentes copiando el hash, y activar gradualmente.
- No requiere `SeparateDatabaseAndState` ni squash de migraciones.
- SimpleJWT sigue funcionando sin cambios — el JWT se emite para el `User` global.
- El Django Admin funciona igual.
- El `reset_password` se vuelve tenant-aware: cambia `TenantCredential.password`, no `User.password`.

**Contras:**
- Requiere un `AUTHENTICATION_BACKENDS` custom que reciba el tenant del request, lo cual es no estándar. `django.contrib.auth.authenticate()` no pasa tenant por defecto — hay que modificar `CustomJWTLoginView` para llamar al backend de forma explícita con `tenant=...` o inyectarlo en el `request`.
- `password_reset/views.py` necesita cambio completo de lógica: en lugar de `user.set_password()`, crear/actualizar `TenantCredential`.
- Si el usuario existe pero no tiene `TenantCredential` para este tenant (caso de migración incompleta o registro por Google), hay que decidir el fallback.
- Agrega una query extra en cada login: `TenantCredential.objects.get(user=user, tenant=tenant)`.
- El flujo de recuperación de contraseña requiere conocer el tenant — el email de reset debe incluir el slug del taller, o el endpoint debe recibirlo.

**Complejidad de implementación:** Media. No requiere migración destructiva pero sí cambios en 5-6 archivos críticos de auth.

#### Opción B — Un `auth_user` por (email, tenant)

Quitar el `unique=True` del email en `auth_user` y gestionar la "unicidad real" a nivel de `Customer(email, tenant)` y `TenantUser(user, tenant)`.

**Por qué esta opción no es viable en Django sin un custom user model:**

Django `auth_user` no tiene `unique=True` en el campo `email` por default — es decir, técnicamente ya sería posible crear dos users con el mismo email. Sin embargo:

1. El `EmailBackend` actual haría `User.objects.get(email=email)` y lanzaría `MultipleObjectsReturned` cuando haya dos usuarios con el mismo email, rompiendo el login de ambos.
2. SimpleJWT emite tokens con `user_id` — el frontend no tiene forma de distinguir qué `user_id` corresponde a qué taller sin cambios significativos.
3. `TenantUser.unique_together = ['user', 'tenant']` ya asume un user único por tenant, lo cual sería cierto, pero el usuario tendría dos filas en `auth_user` con el mismo email.
4. Las migraciones de `swappable_dependency` referencian `AUTH_USER_MODEL` — no se rompería, pero el admin de Django mostraría duplicados confusos.
5. `Customer.user = OneToOneField` — cada Customer en cada tenant necesitaría su propio `auth_user`, que es exactamente lo que genera dos users por email. Hay que cambiar el OneToOneField a ForeignKey para soportarlo.

**Calificación: Descartada.** Genera inconsistencias de datos estructurales difíciles de mantener. Es esencialmente un hackeo del modelo relacional de Django Auth.

#### Opción C — Custom User model con email como `USERNAME_FIELD` + `TenantCredential`

Crear `apps/accounts/User(AbstractBaseUser)` con `USERNAME_FIELD = 'email'`, sin campo `username`, y contraseñas en `TenantCredential`.

**Pros:**
- Solución "correcta" desde el punto de vista arquitectural.
- Elimina el problema del `username` al mismo tiempo.
- La identidad global queda perfectamente definida: un `User` = una persona real.

**Contras:**
- Requiere `AUTH_USER_MODEL = 'accounts.User'` — esto invalida **todas las migraciones existentes** de apps que hacen `ForeignKey(settings.AUTH_USER_MODEL, ...)`. Son 10 apps con migraciones que referencian `AUTH_USER_MODEL`.
- La única forma de hacer este swap con datos existentes es `SeparateDatabaseAndState` — una migración que le dice a Django "cambia el estado del ORM pero no toques la base de datos". Luego hay que hacer ALTER TABLE manualmente en PostgreSQL para reasignar las foreign keys. Con datos en producción, esto es una operación de cirugía mayor con riesgo de corrupción si algo falla a mitad.
- Si se hace antes de tener datos en producción (el proyecto aún no está en producción según contexto), es viable pero requiere squash de todas las migraciones o reinicio limpio del historial de migraciones.
- SimpleJWT usa `USER_ID_FIELD = 'id'` — compatible con cualquier custom user model que tenga `id`.

**Calificación: Correcta pero costosa. Solo recomendable si se hace ahora, antes de datos en producción.**

#### Recomendación para Cambio 1

**Opción A (`TenantCredential`) si ya hay datos en producción o en staging activo. Opción C si el proyecto puede hacer reset de migraciones ahora.**

Justificación real:

La Opción A es la única que se puede implementar sin riesgo de pérdida de datos y sin cirugía de migraciones. El costo en queries adicionales es mínimo (un `SELECT` por login). La complejidad del auth backend custom es manejable: el tenant ya está disponible en el `request` vía `TenantMiddleware`.

La Opción C es arquitecturalmente superior pero su ventaja sobre la Opción A es principalmente estética (`username` desaparece) — un beneficio que se puede obtener también con la Opción B del Cambio 2 (ver abajo) sin tocar el modelo de usuario. Si el equipo puede hacer un reset limpio de migraciones esta semana (sin datos de producción en riesgo), hacerlo ahora es correcto. Si ya hay datos, la Opción A es la respuesta.

---

### Cambio 2: Eliminar el campo `username`

#### Opción A — Custom User model (`AbstractBaseUser`)

Crear `apps/accounts/models.py` con `class User(AbstractBaseUser)` sin campo `username`, `USERNAME_FIELD = 'email'`.

**Análisis:**
Misma operación que la Opción C del Cambio 1. Ver análisis allí. En esencia, este cambio está completamente acoplado a definir un custom user model.

**Migraciones:** Requiere `SeparateDatabaseAndState` + ALTER TABLE manual en PostgreSQL para todas las FKs que apuntan a `auth_user`. Con 10 apps que tienen migraciones de esta dependencia, el riesgo de inconsistencia es alto con datos existentes.

**Django Admin:** Requiere definir `UserAdmin` custom con `fieldsets` que excluya `username`. Sin esto, el admin de Django lanza errores.

**SimpleJWT:** Compatible. El token usa `user_id` no `username`.

**Calificación: Solo viable antes de producción.**

#### Opción B — `username` oculto (siempre = email, enforcement en código)

No cambiar el modelo. En cambio:
1. Agregar `email = EmailField(unique=True)` enforcement en la base de datos (actualmente `auth_user.email` no tiene `UNIQUE` constraint en Django por default).
2. Eliminar todos los usos de `username` en código de producción, reemplazando con `email`.
3. Asegurar que en todo punto de creación de usuario `username = email` (ya es el caso en 90% del código).
4. Eliminar el fallback `User.objects.get(username=username)` en `EmailBackend` (línea 21 de `backends.py`).
5. Eliminar el campo `username` de las respuestas de API (está expuesto en `mechanics/serializers.py:59` y en `password_reset/views.py:478`).

**Pros:**
- Cero migraciones destructivas — `email UNIQUE` es una migración additive simple.
- Compatible con Django Admin sin cambios.
- Compatible con SimpleJWT sin cambios.
- El campo `username` existe en la BD pero nunca se expone ni se usa en lógica nueva.
- Reversible si se necesita.

**Contras:**
- El campo `username` sigue existiendo en la tabla `auth_user` — es "deuda visible" pero no operacional.
- Si alguien crea un user por el Django Admin sin respetar la convención `username=email`, el `EmailBackend` podría fallar silenciosamente.
- Los tests de `test_auth_roles.py` tienen `username='testuser'`, `username='owner_user'`, etc. — valores distintos al email. Estos tests probarían comportamiento que no existe en producción.

**Calificación: Pragmática y segura. Resuelve el 95% del problema con 5% del riesgo.**

#### Opción C — Custom User model desde cero (reset de migraciones)

Ver Opción A. Es la misma operación.

**Condición de viabilidad:** Hacer esto ahora, en 2026-03-17, **antes** de desplegar a producción con datos reales. Si ya hay datos en la base de datos de producción, esta opción tiene riesgo de pérdida de datos.

Para ejecutarla limpiamente:
1. Borrar todas las migraciones (solo los archivos .py, no la BD de staging si existe).
2. Crear `apps/accounts/models.py` con `User(AbstractBaseUser)`.
3. Actualizar `AUTH_USER_MODEL = 'accounts.User'` en `base.py`.
4. Regenerar `makemigrations` para todas las apps.
5. `migrate --run-syncdb` sobre una BD vacía.

Si hay BD de staging con datos, se necesita un script de migración de datos adicional.

#### Recomendación para Cambio 2

**Opción B si hay datos. Opción C (+ Cambio 1 Opción C) si se puede hacer reset limpio ahora.**

La Opción B elimina el problema funcional (el `username` deja de tener relevancia operacional) sin riesgo. La Opción C es la solución "definitiva" pero su ventaja sobre B es solo architectural cleanliness — no resuelve ningún bug adicional que B no resuelva.

**El único argumento fuerte para Opción C es hacerla junto con Cambio 1 Opción C** — si ya se va a crear un custom user model para contraseñas por tenant, eliminar `username` al mismo tiempo tiene costo marginal cero. Hacerlos separados duplica la complejidad.

---

## 4. Impacto combinado

### Escenario 1: Opción A (TenantCredential) + Opción B (username oculto)

Los cambios son **independientes** pero se benefician del mismo deploy. Se pueden hacer en el mismo PR.

- No hay acoplamiento técnico entre ellos — se puede hacer uno sin el otro.
- El orden natural: primero Opción B (limpieza de código, sin riesgos), luego Opción A (nuevo modelo con lógica de auth).
- Resultado: sistema funcional con contraseñas por tenant y `username` erradicado del código, aunque siga en la BD.

### Escenario 2: Opción C (custom user model) + Opción C (sin username)

Los cambios son **completamente acoplados** — se hace todo en un solo paso: nuevo model, reset de migraciones, nuevo auth backend.

- Este es el "big bang" — alto riesgo pero deuda técnica cero.
- Solo recomendable si hay **cero datos en producción** y el equipo tiene tiempo para hacer el reset limpio esta semana.

### Escenario 3: Mezcla (Opción C + Opción B)

No tiene sentido. Si se crea un custom user model, eliminar `username` es gratuito — sería contraproducente mantenerlo en el modelo nuevo.

### Veredicto de acoplamiento

Los dos cambios están **lógicamente acoplados** (el custom user model resuelve ambos) pero **técnicamente independientes** si se usa la Opción A para contraseñas + Opción B para username. El camino menos arriesgado es empezar con A+B y programar C+C como trabajo futuro si se necesita una reescritura de migraciones por otra razón.

---

## 5. Archivos afectados

### Escenario A+B (recomendado con datos existentes)

| Archivo | Cambio | Riesgo |
|---------|--------|--------|
| `apps/core/backends.py` | Eliminar fallback `username`, agregar lookup de `TenantCredential` | Alto — es el corazón del auth |
| `apps/core/views.py` | `CustomJWTLoginView`: pasar tenant al backend; `GoogleAuthView`: crear `TenantCredential` al crear user | Alto |
| `apps/password_reset/views.py` | `reset_password()`: cambiar `user.set_password()` por `TenantCredential.set_password()`; `verify_and_register()`: crear `TenantCredential` para el tenant actual | Alto |
| `apps/tenants/views.py` | `TenantRegistrationView`: crear `TenantCredential` al crear owner | Medio |
| `apps/mechanics/views.py` | `create_mechanic`: crear `TenantCredential` para el tenant | Medio |
| `apps/mechanics/serializers.py` | Eliminar campo `username` de `MechanicRegistrationSerializer` y `MechanicListSerializer`; cambiar `validate_username` por `validate_email` | Medio |
| `apps/mechanics/services/mechanic_service.py` | Reemplazar `username` check por `email` check; crear `TenantCredential` | Medio |
| `apps/customers/views.py` | Eliminar `username` del `create_user` call | Bajo |
| `apps/customers/serializers.py` | Eliminar check `User.objects.filter(username=email)` | Bajo |
| `apps/customers/services/customer_service.py` | Eliminar `username` del `create_user` call | Bajo |
| `apps/customers/models.py` | Cambiar `OneToOneField` a `ForeignKey` en `Customer.user` | **Crítico — migración de datos** |
| `apps/tenants/models.py` | Limpiar `__str__` que usa `user.username` | Bajo |
| `apps/tenants/admin.py` | Cambiar `search_fields` para quitar `user__username` | Bajo |
| `apps/notifications/models.py` | Limpiar `__str__` | Bajo |
| `apps/notifications/admin.py` | Cambiar `search_fields` | Bajo |
| `apps/tenants/serializers.py` | Quitar fallback a `user.username` | Bajo |
| `conftest.py` | Actualizar `UserFactory` — quitar `username` independiente del email | Medio |
| **NUEVO**: `apps/core/models.py` o nueva app | Crear `TenantCredential` model | Bajo |
| **NUEVO**: `apps/core/backends.py` | Reescribir `EmailBackend` para usar `TenantCredential` | Alto |

### Escenario C+C (reset de migraciones)

Todos los archivos de arriba, más:

| Archivo | Cambio | Riesgo |
|---------|--------|--------|
| `config/settings/base.py` | `AUTH_USER_MODEL = 'accounts.User'` | Crítico |
| `apps/accounts/models.py` | Nuevo archivo — custom User model | Crítico |
| `apps/accounts/admin.py` | Nuevo archivo — `UserAdmin` custom | Bajo |
| `apps/accounts/apps.py` | Nuevo archivo | Bajo |
| Todas las migraciones de todas las apps | Regenerar desde cero | Crítico |
| `conftest.py` | Actualizar `UserFactory` para `accounts.User` | Medio |

---

## 6. Migraciones necesarias

### Escenario A+B

**Migración 1: `TenantCredential`** (nueva tabla, no destructiva)
```bash
# Crear apps/core/migrations/00XX_tenantcredential.py
python manage.py makemigrations core --name tenantcredential
python manage.py migrate core
```

**Migración 2: `email UNIQUE` en `auth_user`** (additive, puede fallar si hay duplicados)
```bash
# Solo se puede hacer si no hay emails duplicados en auth_user
# Verificar ANTES:
# SELECT email, COUNT(*) FROM auth_user GROUP BY email HAVING COUNT(*) > 1;
python manage.py makemigrations --empty core --name email_unique_on_user
# Editar manualmente para usar SeparateDatabaseAndState o RunSQL
python manage.py migrate
```

**Migración 3: `Customer.user` de OneToOneField a ForeignKey** (destructiva en schema)
```bash
# ESTE CAMBIO ES OBLIGATORIO para soportar el mismo email en múltiples tenants
# Es destructivo si hay datos — PostgreSQL requiere DROP CONSTRAINT + ADD CONSTRAINT
python manage.py makemigrations customers --name user_fk_not_onetoone
python manage.py migrate customers
```

La migración 3 es la más invasiva del Escenario A+B. Requiere verificar que no haya violaciones en staging antes de correr en producción.

### Escenario C+C (reset)

```bash
# 1. Borrar archivos de migración (no la BD)
find apps/ -path "*/migrations/*.py" -not -name "__init__.py" -delete

# 2. Crear nueva app accounts
python manage.py startapp accounts
# Mover User model allí

# 3. Actualizar AUTH_USER_MODEL en base.py

# 4. Regenerar todo
python manage.py makemigrations
python manage.py migrate
```

**Nota crítica sobre el reset:** Si hay datos en alguna BD (dev, staging, prod), este proceso destruye todo. Solo es seguro si se hace sobre una BD vacía o se escribe un script de data migration completo.

---

## 7. Tests que se rompen

### Con Escenario A+B

**`apps/core/tests/test_auth_roles.py`** — Múltiples tests crean usuarios con `username='testuser'`, `username='owner_user'`, etc. (valores distintos al email). Con la Opción B, el `EmailBackend` elimina el fallback por username — los tests que usen `username='testuser'` y luego intenten login con email seguirán funcionando, pero el test `test_login_with_username_still_works` (línea 42) explícitamente verifica login por username distinto al email — este test **documenta comportamiento que queremos eliminar** y debe borrarse, no arreglarse.

**`apps/mechanics/tests/test_services.py:153`** — `assert result.user.username == 'new.mechanic.test@example.com'` — esto seguiría pasando si se mantiene `username=email`, pero si se elimina el campo del serializer de respuesta, los tests que verifican `username` en la respuesta de la API fallan.

**`apps/mechanics/tests/test_services.py:155`** — `test_create_mechanic_duplicate_username` — verifica validación de username duplicado. Con la nueva lógica, la validación sería por `email` duplicado, no por `username`. El test hay que reescribirlo.

**`apps/mechanics/tests/test_api.py:30`** — El payload de creación de mecánico incluye `'username': 'nuevo.mecanico@test.com'`. Si `MechanicRegistrationSerializer` elimina el campo `username`, este test falla con 400.

**`apps/mechanics/tests/test_models.py:44-49`** — `test_mechanic_full_name_fallback_username` — crea un user con `username='juan123'` distinto al email y verifica que el fallback muestre el username. Con Opción B, este fallback debería mostrar el email, no el username. El test hay que actualizar la expectativa.

**`conftest.py` (UserFactory)** — La factory genera `username = factory.LazyAttribute(lambda _: fake.user_name())` — un valor independiente del email. Si se hace `email UNIQUE`, los usuarios creados por la factory tendrán username aleatorio, lo cual está bien. Pero si se elimina el fallback en `EmailBackend`, el test `test_login_with_username_still_works` falla — y debe fallar, porque ese comportamiento ya no debe existir.

**`apps/core/tests/test_spec08_auth_registro.py`** — Línea 478 verifica `'username'` en la respuesta del `verify_and_register` endpoint. Si se elimina ese campo de la respuesta, el test falla. Hay que actualizar para no verificar `username` o verificar que no está presente.

### Con Escenario C+C (adicionales)

Todo lo anterior, más cualquier test que use `User.objects.create_user(username=...)` directamente — todos los tests en `test_auth_roles.py` pasan username explícitamente y fallarían si el modelo no tiene ese campo.

---

## 8. Plan de implementación recomendado

Se recomienda el **Escenario A+B** por ser el camino seguro con datos existentes.

### Fase 0: Preparación (sin cambios en producción)

1. Verificar en BD de staging/producción que no hay emails duplicados en `auth_user`:
   ```sql
   SELECT email, COUNT(*) FROM auth_user GROUP BY email HAVING COUNT(*) > 1;
   ```
2. Verificar que `Customer.user` no tiene duplicados que violarían la futura FK:
   ```sql
   SELECT user_id, COUNT(*) FROM customers_customer GROUP BY user_id HAVING COUNT(*) > 1;
   ```
3. Documentar el conteo de usuarios activos para validar post-migración.

### Fase 1: Cambio 2 Opción B — Limpiar `username` del código (sin migraciones)

1. Eliminar `test_login_with_username_still_works` de `test_auth_roles.py` — documenta comportamiento a eliminar.
2. En `apps/core/backends.py`: eliminar el bloque `except User.DoesNotExist: user = User.objects.get(username=username)`. Solo buscar por email.
3. En todos los serializers de mechanics: eliminar campo `username` de `MechanicRegistrationSerializer.fields` y de `MechanicListSerializer`. Eliminar `validate_username()`. Agregar `validate_email()` que verifique unicidad.
4. En `customers/serializers.py:489`: simplificar a solo `User.objects.filter(email=email).exists()`.
5. En `tenants/views.py:78`: eliminar el check redundante por username.
6. En todos los `__str__` y `search_fields` que usan `user.username`: reemplazar por `user.email`.
7. Correr tests. Esta fase no debería romper nada en producción.

### Fase 2: Migración de `Customer.user` a `ForeignKey`

1. Modificar `apps/customers/models.py`: cambiar `OneToOneField` a `ForeignKey(User, null=True, blank=True)`.
2. Generar y revisar la migración — Django hará `DROP CONSTRAINT` + `ADD COLUMN` en la tabla.
3. Verificar en staging que no hay errores.
4. Correr en producción con ventana de mantenimiento (segundos, no minutos).

**Nota:** Esta migración es necesaria independientemente de si se implementa `TenantCredential` o no. El bug del `OneToOneField` existe hoy y puede romper el registro de clientes multi-tenant en producción.

### Fase 3: Modelo `TenantCredential`

1. Crear `apps/core/models.py` (o nueva app `apps/credentials/`): agregar `TenantCredential` con `(user, tenant)` unique.
2. Agregar método `set_password(raw_password)` y `check_password(raw_password)` que usen `make_password` y `check_password` de Django — no reinventar hashing.
3. Generar migración (no destructiva).
4. Correr migración.
5. Escribir script de management command que copie `user.password` a `TenantCredential` para todos los `TenantUser` existentes:
   ```
   python manage.py migrate_passwords_to_tenant_credentials
   ```
   Este script crea una `TenantCredential` por cada `(user, tenant)` existente usando el hash actual de `User.password`. Así no hay pérdida de acceso durante la transición.

### Fase 4: Reescribir `EmailBackend` para `TenantCredential`

1. Modificar `apps/core/backends.py`: el método `authenticate()` recibe `tenant` como kwarg adicional.
2. `CustomJWTLoginView`: extraer tenant del `request.tenant` (ya puesto por `TenantMiddleware`) y pasarlo al `authenticate()` call.
3. Si no hay `TenantCredential` para ese `(user, tenant)` (usuario que aún no tiene credencial en este taller), decidir fallback: rechazar o usar `User.password`. **Recomendación: rechazar con error claro** — si el script de Fase 3 corrió correctamente, no debería haber usuarios sin `TenantCredential`.
4. Correr tests del auth flow completo.

### Fase 5: Actualizar `password_reset` para ser tenant-aware

1. `forgot_password()`: ya funciona — busca `User` por email, que es global. No cambia.
2. `verify_code()`: ya funciona — verifica el token, no la contraseña.
3. `reset_password()`: cambiar `user.set_password()` + `user.save()` por lookup de `TenantCredential(user, tenant)` y actualización del hash ahí. Requiere que el endpoint reciba o infiera el tenant (del header `X-Tenant-ID`).
4. `send_registration_code()`: sin cambios — no toca contraseñas.
5. `verify_and_register()`: después de crear el user, crear `TenantCredential` con la contraseña del body.

### Fase 6: Actualizar `GoogleAuthView` y flujos de creación de empleados

1. `GoogleAuthView`: al crear usuario nuevo, crear `TenantCredential` con `set_unusable_password()` para ese tenant.
2. `mechanics/views.py`: al crear mecánico, crear `TenantCredential` para el tenant actual.
3. `tenants/views.py` (TenantRegistrationView): al crear el owner, crear `TenantCredential` con la contraseña del body.

### Fase 7: Tests y limpieza

1. Actualizar `conftest.py` `UserFactory` y `TenantUserFactory` para crear `TenantCredential` automáticamente.
2. Reescribir tests de `test_auth_roles.py` que usaban username.
3. Reescribir `test_create_mechanic_duplicate_username` como `test_create_mechanic_duplicate_email`.
4. Eliminar `test_login_with_username_still_works`.
5. Verificar cobertura de los nuevos flujos.

---

## 9. Riesgos y rollback

### Riesgo 1: Script de migración de contraseñas incompleto

**Escenario:** El management command de Fase 3 no crea `TenantCredential` para algunos usuarios (error, excepción silenciosa, usuario con tenant inactivo).

**Síntoma:** Esos usuarios no pueden hacer login después de activar Fase 4.

**Rollback:** El `EmailBackend` puede tener un flag de feature toggle: si `TENANT_CREDENTIAL_AUTH = False` en settings, usa el comportamiento viejo (`User.password`). Al activar Fase 4, poner `TENANT_CREDENTIAL_AUTH = True`. Si hay problemas, `TENANT_CREDENTIAL_AUTH = False` restaura el comportamiento anterior sin migración.

**Prevención:** Correr el script con `--dry-run` primero, verificar que el conteo de `TenantCredential` creadas == conteo de `TenantUser` activos.

### Riesgo 2: Migración de `Customer.user` de OneToOneField a ForeignKey

**Escenario:** La migración falla en producción porque PostgreSQL no puede eliminar la constraint con transacciones activas.

**Rollback:** Django genera migraciones reversibles por default. `python manage.py migrate customers 000X` (versión anterior) revierte el campo.

**Prevención:** Usar `ATOMIC_MIGRATION = False` si PostgreSQL lanza error en la eliminación del constraint dentro de una transacción. Alternativa: hacer la migración con `SeparateDatabaseAndState` y ejecutar el DDL manualmente con `SET statement_timeout`.

### Riesgo 3: `forgot_password` / `reset_password` en producción sin tenant

**Escenario:** El email de reset se envía sin contexto de tenant (el endpoint es público, sin header `X-Tenant-ID`). Después de Fase 5, el `reset_password` necesita el tenant — si el cliente accede desde un enlace de email genérico sin saber a qué taller pertenece, el endpoint falla.

**Mitigación:** El flujo de reset debe incluir el tenant en la URL del email. El template del email debe construirse con el slug del taller: `https://app.autotronia.com/taller/{slug}/reset-password?token=...`. Esto requiere cambios mínimos en el template del email de recuperación.

### Riesgo 4: Usuarios con múltiples tenants

**Escenario:** Un usuario está en 3 tenants. Cambia contraseña en uno. Los otros dos tenants deberían mantener su contraseña anterior.

**Comportamiento esperado con `TenantCredential`:** Correcto por diseño — cada `TenantCredential` es independiente.

**Caso edge:** Usuario que solo tiene `TenantCredential` en un tenant intenta hacer login en otro tenant donde tiene `TenantUser` pero no `TenantCredential`. Esto podría ocurrir si el script de Fase 3 no cubrió todos los casos.

**Manejo:** `EmailBackend` debe retornar error claro "no tienes contraseña configurada en este taller, usa Google OAuth o solicita al administrador" en lugar de `Invalid credentials`.

### Riesgo 5: `email UNIQUE` en `auth_user`

**Escenario:** Ya existen emails duplicados en la BD (usuarios creados desde el admin de Django o por scripts sin respetar la convención).

**Prevención:** Correr la query de verificación de Fase 0 antes de la migración. Si hay duplicados, consolidarlos manualmente primero.

---

## 10. Decisión requerida del producto

Antes de implementar, se necesitan respuestas a estas preguntas:

**D1. ¿Hay datos en producción con usuarios reales ahora mismo?**

Si sí: usar Escenario A+B (TenantCredential + username oculto). Si no: evaluar Escenario C+C (reset limpio).

**D2. Cuando un usuario "olvida su contraseña" en el flujo de reset, ¿qué debería pasar?**

Opción A: Reset solo para el taller desde donde se solicita (reseta `TenantCredential` de ese tenant). Implica que el email de reset tiene que saber qué taller es.

Opción B: Reset para todos los talleres del usuario (reseta todas sus `TenantCredential`). Rompe el aislamiento de contraseñas por tenant.

Opción C: No permitir reset desde el flujo público — el cliente debe contactar al taller. Los administradores pueden cambiar la contraseña desde el panel.

La Opción A es la correcta para un SaaS, pero requiere que el frontend envíe el `tenant_slug` en el request de forgot_password (o que el email de reset incluya un link tenant-specific).

**D3. ¿El mecánico/asesor creado por el admin puede tener contraseña diferente en tenants donde fue movido?**

Actualmente un empleado puede estar en un solo tenant (un `TenantUser` tiene `unique_together = ['user', 'tenant']` pero un usuario puede tener múltiples filas). Si el mismo mecánico trabaja en dos talleres del mismo dueño, ¿deberían tener contraseñas independientes? Probablemente sí — la respuesta a D1 aplica aquí también.

**D4. ¿Se elimina el campo `username` del contrato de la API de mecánicos?**

`MechanicRegistrationSerializer` expone `username` como campo requerido. Si se elimina, el frontend que consume ese endpoint (página de creación de empleados) necesita actualización. ¿Está el frontend preparado para este cambio?

**D5. ¿Se hace el cambio de `Customer.user` de OneToOneField a ForeignKey?**

Este cambio es independiente de los otros dos pero es un bug bloqueante: hoy si el mismo email se registra como cliente en dos talleres, el segundo registro lanza `IntegrityError`. Se recomienda hacerlo en este mismo ciclo independientemente de la decisión sobre contraseñas.

---

*Análisis generado el 2026-03-17 con base en lectura directa del código de producción.*
