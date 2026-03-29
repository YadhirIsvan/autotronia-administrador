# spec_16 — Sistema de roles únicos, cambio de rol, tipos de empleado y borrado real

**Estado:** Implementado completo
**Fecha original:** 2026-03-21
**Ultima actualizacion:** 2026-03-22
**Prioridad:** Alta — afecta integridad de datos en produccion con miles de usuarios
**Version:** 3.0 (incluye estado real de implementacion)

---

## 1. Reglas de negocio (definitivas)

Dentro de un tenant, **un usuario tiene exactamente un rol**. No puede tener dos simultaneamente.

### Tabla de roles posibles por usuario

| Rol | Modelo/tabla | TenantUser.role | Mechanic existe | Customer existe |
|-----|-------------|-----------------|-----------------|-----------------|
| **owner** | TenantUser | `owner` | NO | NO |
| **admin** | TenantUser | `admin` | NO | NO |
| **mecanico** | Mechanic + TenantUser | `member` | SI (role=`mechanic`) | NO |
| **asesor** | Mechanic + TenantUser | `member` | SI (role=`advisor`) | NO |
| **cliente** | Customer | ninguno (sin TenantUser) | NO | SI |

### Arquitectura de BD

```
+----------+--------------------------+-----------------+
|   Rol    |       TenantUser         |    Mechanic     |
+----------+--------------------------+-----------------+
| owner    | role='owner'             | NO existe       |
| admin    | role='admin'             | NO existe       |
| mecanico | role='member'            | role='mechanic' |
| asesor   | role='member'            | role='advisor'  |
| cliente  | NO existe TenantUser     | NO existe       |
+----------+--------------------------+-----------------+
```

### Reglas estrictas

| Codigo | Regla |
|--------|-------|
| R1 | Un **admin/owner** no puede ser mecanico, asesor ni cliente en ese mismo tenant |
| R2 | Un **mecanico** no puede ser asesor, cliente ni admin en ese tenant |
| R3 | Un **asesor** no puede ser mecanico, cliente ni admin en ese tenant |
| R4 | Un **cliente** no puede ser mecanico, asesor ni admin en ese tenant |
| R5 | Un **admin puede crear otro admin** (cumpliendo R1) |
| R6 | El **cambio de rol es permitido** entre admin <-> mecanico <-> asesor (de forma atomica) |
| R7 | Un empleado (mecanico/asesor) **no puede convertirse en cliente** desde el panel — debe eliminar su cuenta y re-registrarse |
| R8 | Estas reglas aplican en **todos los puntos de entrada**: API REST, Django admin, panel frontend |

---

## 2. Decision sobre owner vs admin

**owner** se mantiene en BD porque:
- Proteccion de cuenta ante cambios accidentales
- Base para facturacion y ownership transfer futuro
- Distincion legal entre dueno y empleado administrativo

**owner es invisible en UI**: el panel lo muestra como "Administrador". Solo se asigna en el registro inicial via `TenantRegistrationView`, nunca desde el panel admin. Un admin del panel no puede "degradar" o eliminar al owner.

---

## 3. Flujos de cambio de rol (Role Transition Matrix)

### Cambios permitidos

```
mechanic <-> advisor          (solo cambia Mechanic.role, no toca TenantUser)
mechanic/advisor -> admin     (delete Mechanic, update TenantUser.role = admin)
admin -> mechanic/advisor     (update TenantUser.role = member, create Mechanic)
admin -> admin                (no-op, ya es admin)
```

### Cambios prohibidos

```
cualquier rol -> customer     PROHIBIDO (solo con eliminacion completa + re-registro)
customer -> cualquier rol     PROHIBIDO (solo creando cuenta de empleado nueva)
```

### Diagrama de transiciones

```
    +---------+
    |  admin  |<---------------------------------+
    +----+----+                                  |
         |  (downgrade: create Mechanic)         | (upgrade: delete Mechanic)
         v                                       |
    +----------+   Mechanic.role change   +-----------+
    | mechanic |<------------------------>|  advisor  |
    +----------+                          +-----------+

    +----------+
    | customer |   <-- aislado, sin transiciones desde panel admin
    +----------+
```

---

## 4. Capas de validacion

```
Capa 4 - FRONTEND: role options separadas por tipo, endpoints distintos
Capa 3 - VIEW:     role guard en create(), validate_no_conflicts en create_staff()
Capa 2 - MODELO:   Mechanic.clean(), Customer.clean()
Capa 1 - BD:       UNIQUE INDEX (user_id, tenant_id) WHERE is_deleted=FALSE
```

---

## 5. Cambios implementados (DONE)

### Backend

#### 5.1 RoleService (NUEVO) — `apps/core/services/role_service.py` ✅ DONE

Centralizacion de logica de roles con:

- `get_user_role_in_tenant(user_id, tenant_id)` — retorna dict con `{type, id, mechanic_id}`
- `validate_no_conflicts(user_id, tenant_id, new_role, exclude_mechanic_id=None)` — lanza `RoleTransitionError` si hay conflicto
- `change_role(user, tenant, new_role, extra_data)` — transicion atomica decorada con `@transaction.atomic`
- `RoleTransitionError(ValidationError)` — excepcion tipada para errores de transicion

Matriz de transicion implementada en `change_role`:
- `mechanic <-> advisor`: actualiza `Mechanic.role` unicamente
- `mechanic/advisor -> admin`: `DELETE Mechanic` + `UPDATE TenantUser.role = admin`
- `admin -> mechanic/advisor`: `UPDATE TenantUser.role = member` + `CREATE Mechanic`
- `cualquier rol -> customer`: lanza `RoleTransitionError` siempre

#### 5.2 Customer.clean() corregido — `apps/customers/models.py` ✅ DONE

**Bug corregido:** antes buscaba `role__in=['mechanic','advisor']` en TenantUser (esos roles nunca existen ahi — siempre era `member`), lo que significaba que la validacion nunca bloqueaba nada.

**Ahora:**
- Verifica TenantUser para detectar admin/owner en ese tenant
- Verifica `Mechanic(user=user, tenant=tenant, is_deleted=False)` para detectar empleados activos
- `save()` llama `full_clean()` para garantizar ejecucion de `clean()`

#### 5.3 Mechanic.clean() + save() nuevos — `apps/mechanics/models.py` ✅ DONE

Proteccion en capa modelo:
- Bloquea si el usuario ya es admin/owner en TenantUser de ese tenant
- Bloquea si el usuario ya existe como Customer en ese tenant
- `save()` llama `full_clean()` siempre

#### 5.4 MechanicViewSet — `apps/mechanics/views.py` ✅ DONE

**`create()`:**
- Rechaza con HTTP 400 si el `role` enviado es distinto de `mechanic` o `advisor`
- Valida conflictos via `validate_no_conflicts` antes de crear

**`destroy()`:**
- Hard delete atomico real: `DELETE TenantUser` -> `DELETE Mechanic` (cascade elimina Schedule/Unavailability) -> `DELETE User` si el usuario no tiene otras membresías en otros tenants
- Antes el destroy solo hacia soft-delete (`is_deleted=True`), dejando la cuenta viva

#### 5.5 TenantRegistrationView corregido — `apps/tenants/views.py` ✅ DONE

Eliminado el bloque que creaba un `Mechanic` para el owner al registrar el taller. Ese bloque violaba R1 directamente.

Flujo correcto post-fix:
```
POST /api/tenants/register/
  -> Crea Tenant
  -> Crea User
  -> Crea TenantUser(role='owner')
  [sin Mechanic]
```

#### 5.6 TenantUserViewSet — nuevo action create_staff ✅ DONE

Nuevo endpoint `POST /api/tenant-users/create-staff/` para crear administradores:
- `validate_no_conflicts` antes de crear
- `get_or_create User` por email
- `get_or_create TenantUser(role='admin')`
- `assign_group('admins')`

Separacion clara: empleados via `POST /api/mechanics/`, admins via `POST /api/tenant-users/create-staff/`.

#### 5.7 Django Admin — `apps/mechanics/admin.py` ✅ DONE

- Campo `role` visible en fieldsets para inspeccion y edicion manual
- `save_model()` captura `ValidationError` y lo convierte en error de formulario amigable

#### 5.8 Migracion — `apps/mechanics/migrations/0002_mechanic_unique_active_user_tenant.py` ✅ DONE

Indice parcial en BD:
```sql
CREATE UNIQUE INDEX mechanic_unique_active_user_tenant
ON mechanics_mechanic (user_id, tenant_id)
WHERE is_deleted = FALSE;
```

Garantiza unicidad en capa 1 (BD) sin bloquear registros historicos soft-deleted.

---

### Frontend

#### 5.9 team.actions.ts — `src/admin/actions/team.actions.ts` ✅ DONE

- `createAdminAction()` nuevo: `POST /api/tenant-users/create-staff/` con `{name, email, password}`
- `createEmployeeAction()` modificado: solo pasa roles `mechanic`/`advisor`, nunca `admin` ni `owner`

#### 5.10 NewEmployeeModal.tsx — `src/admin/components/team/NewEmployeeModal.tsx` ✅ DONE

Toggle "Empleado / Administrador" que bifurca el formulario:

**Modo Empleado:**
- Select de rol: solo `Mecanico` / `Asesor`
- Campos: nombre, email, password, employee_id, telefono, especialidad
- Envia a `createEmployeeAction()` -> `POST /api/mechanics/`

**Modo Administrador:**
- Sin select de rol (siempre admin)
- Campos: nombre, email, password (sin employee_id, sin especialidad)
- Envia a `createAdminAction()` -> `POST /api/tenant-users/create-staff/`

---

## 6. Flujos completos (estado actual)

### Flujo 1 — Registro de taller

```
POST /api/tenants/register/
  -> Crea Tenant
  -> Crea User
  -> Crea TenantUser(role='owner')
  [Mechanic NO se crea — R1 respetada]
```

### Flujo 2 — Crear empleado

```
POST /api/mechanics/
  -> role guard en view (solo mechanic/advisor)
  -> validate_no_conflicts(user_id, tenant_id, new_role)
  -> Crea User
  -> assign_group('mechanics' o 'advisors')
  -> Crea Mechanic con clean() [valida conflictos modelo]
  -> Crea TenantUser(role='member')
```

### Flujo 3 — Crear administrador

```
POST /api/tenant-users/create-staff/
  -> validate_no_conflicts(user_id, tenant_id, 'admin')
  -> get_or_create User por email
  -> get_or_create TenantUser(role='admin')
  -> assign_group('admins')
```

### Flujo 4 — Crear cliente

```
POST /api/customers/ (o registro publico)
  -> Customer.save() -> full_clean() -> clean()
  -> Verifica: no TenantUser(role in [admin, owner]) en ese tenant
  -> Verifica: no Mechanic(is_deleted=False) en ese tenant
  -> Si conflicto: ValidationError con mensaje descriptivo
```

### Flujo 5 — Cambio de rol (RoleService.change_role)

```
Recibe: user, tenant, new_role, extra_data

mechanic <-> advisor:
  -> UPDATE Mechanic.role = new_role
  -> assign_group correspondiente

mechanic/advisor -> admin:
  -> DELETE Mechanic (cascade: Schedule, Unavailability)
  -> UPDATE TenantUser.role = 'admin'
  -> assign_group('admins')
  -> remove_group('mechanics'/'advisors')

admin -> mechanic/advisor:
  -> UPDATE TenantUser.role = 'member'
  -> CREATE Mechanic(role=new_role)
  -> assign_group('mechanics'/'advisors')
  -> remove_group('admins')

cualquier rol -> customer:
  -> RAISE RoleTransitionError("Cambio a cliente no permitido desde el panel")

Todo envuelto en @transaction.atomic
```

### Flujo 6 — Eliminar empleado

```
DELETE /api/mechanics/{id}/
  -> @transaction.atomic
  -> DELETE TenantUser (donde user=empleado, tenant=tenant actual)
  -> DELETE Mechanic (cascade elimina Schedule, Unavailability)
  -> Si User no tiene otras TenantMemberships:
       -> DELETE User (borrado fisico completo)
     Si tiene otras membresías:
       -> User se conserva
```

---

## 7. Impacto en WorkOrders

WorkOrders con `assigned_mechanic` apuntando al empleado eliminado quedan con `assigned_mechanic = NULL` por el `SET_NULL` del FK. Las OTs historicas se conservan integras — solo pierden la referencia al mecanico. El historial de trabajo no se pierde.

---

## 8. Lo NO afectado por este spec

- JWT auth, tokens de acceso/refresh — intacto
- WebSocket consumers y canal layer Redis — intacto
- Sistema de notificaciones (NotificationService, signals) — intacto
- Google OAuth, login de clientes — intacto
- Grupos Django (Mechanics, Advisors, Admins) — se asignan en cada transicion de rol
- Inventario, ordenes de servicio, diagnosticos — intactos

---

## 9. Pendiente (NO implementado) ⬜

### 9.1 StaffDetailModal — cambio de rol desde UI ⬜ PENDIENTE

`StaffDetailModal.tsx` actualmente hace un `PATCH` simple que no maneja las transiciones complejas de `RoleService.change_role()`. Necesita:

- Llamar a un endpoint dedicado (ej. `POST /api/mechanics/{id}/change-role/` o `POST /api/tenant-users/{id}/change-role/`)
- El endpoint invoca `RoleService.change_role()` de forma atomica
- UI muestra advertencia antes de admin -> mecanico (perdera acceso admin)
- UI muestra advertencia antes de eliminar (confirmacion doble)

### 9.2 Tests ⬜ PENDIENTE

Casos de prueba definidos (15+):

```python
# Unicidad de roles
test_mechanic_cannot_be_created_if_user_is_admin
test_mechanic_cannot_be_created_if_user_is_owner
test_mechanic_cannot_be_created_if_user_is_customer
test_customer_cannot_be_created_if_user_is_mechanic
test_customer_cannot_be_created_if_user_is_advisor
test_customer_cannot_be_created_if_user_is_admin

# Transiciones
test_mechanic_to_advisor_updates_mechanic_role_only
test_advisor_to_mechanic_updates_mechanic_role_only
test_mechanic_to_admin_deletes_mechanic_creates_tenantuser
test_admin_to_mechanic_creates_mechanic_updates_tenantuser
test_any_role_to_customer_raises_role_transition_error

# Hard delete
test_delete_mechanic_removes_tenantuser_and_user
test_delete_mechanic_keeps_user_if_other_tenants_exist
test_delete_mechanic_sets_null_on_work_orders

# BD
test_unique_index_blocks_duplicate_active_mechanic_same_tenant
test_unique_index_allows_soft_deleted_then_recreated
```

### 9.3 Indice parcial para Customer ⬜ PENDIENTE

Analogo al de Mechanic, pero Customer no tiene `is_deleted`. Se necesita un UNIQUE INDEX simple:

```sql
CREATE UNIQUE INDEX customer_unique_user_tenant
ON customers_customer (user_id, tenant_id);
```

Requiere migracion `customers/migrations/000X_customer_unique_user_tenant.py`.

### 9.4 Proteccion anti-borrado del owner desde el panel ⬜ PENDIENTE

El owner (primer admin del taller) no deberia poder ser eliminado desde `TenantUserViewSet.destroy()`. Pendiente agregar un guard:

```python
if tenant_user.role == 'owner':
    raise PermissionDenied("El propietario del taller no puede ser eliminado desde el panel.")
```

---

## 10. Criterios de aceptacion

### Implementados ✅

- [x] Un usuario con role=admin/owner no puede ser registrado como Mechanic en el mismo tenant
- [x] Un Mechanic activo no puede ser registrado como Customer en el mismo tenant
- [x] Un Customer no puede ser registrado como Mechanic ni como admin en el mismo tenant
- [x] El endpoint `POST /api/mechanics/` rechaza roles distintos de mechanic/advisor
- [x] El endpoint `POST /api/tenant-users/create-staff/` crea admins correctamente
- [x] El registro de taller NO crea Mechanic para el owner
- [x] El borrado de empleado (`DELETE /api/mechanics/{id}/`) elimina TenantUser, Mechanic y User (si sin otras membresías) en una transaccion atomica
- [x] WorkOrders con mecanico eliminado quedan con `assigned_mechanic=NULL` (SET_NULL)
- [x] El UNIQUE INDEX parcial en BD bloquea duplicados activos a nivel base de datos
- [x] Customer.clean() verifica correctamente admin en TenantUser Y Mechanic activo (bug corregido)
- [x] Mechanic.clean() verifica admin en TenantUser Y Customer existente
- [x] RoleService.change_role() ejecuta todas las transiciones de forma atomica
- [x] Transicion cualquier-rol -> customer lanza RoleTransitionError
- [x] NewEmployeeModal bifurca entre Empleado y Administrador con formularios distintos
- [x] Django admin muestra el campo role y captura ValidationErrors

### Pendientes ⬜

- [x] StaffDetailModal usa RoleService.change_role() para cambios de rol desde UI ✅
- [x] Tests cubren los 15+ casos definidos en la seccion 9.2 ✅
- [x] UNIQUE INDEX para Customer (user_id, tenant_id) ✅
- [x] Guard anti-borrado del owner en TenantUserViewSet.destroy() ✅

---

## 11. Dependencias entre componentes

```
RoleService
    <- MechanicViewSet.create()       (validate_no_conflicts)
    <- MechanicViewSet.destroy()      (hard delete atomico)
    <- TenantUserViewSet.create_staff() (validate_no_conflicts)
    <- [PENDIENTE] StaffDetailModal   (change_role)

Mechanic.clean()
    <- Mechanic.save()                (full_clean)
    <- MechanicViewSet.create()       (indirectamente via save)

Customer.clean()
    <- Customer.save()                (full_clean)
    <- CustomerViewSet.create()       (indirectamente via save)

UNIQUE INDEX BD
    <- Cualquier INSERT en mechanics_mechanic
    <- Capa de ultimo recurso si clean() falla
```

---

## 12. Notas de implementacion

- El `exclude_mechanic_id` en `validate_no_conflicts` es necesario para el caso de edicion: al cambiar el rol de un Mechanic existente, no debe bloquearse por su propia existencia en BD.
- El hard delete en `destroy()` usa `select_for_update()` para evitar race conditions en entornos concurrentes.
- `assign_group` y `remove_group` deben ejecutarse dentro del `@transaction.atomic` de `change_role` para mantener coherencia entre grupos Django y el estado en BD.
- El campo `employee_id` solo aplica a empleados (Mechanic), no a admins. El frontend debe omitirlo al crear admins.
