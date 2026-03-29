# Spec 03 — Notificaciones de cita a admins del tenant correcto

## Problema

Cuando se agenda una cita bajo `taller_rojo`, la notificación WebSocket solo llega
al usuario `yadhirisvan11@gmail.com` (id=6, superadmin con `is_staff=True`), pero
no a `sergioaguirre@gmail.com` (id=9, admin real del taller con `TenantUser` en
`taller_rojo` y `groups=[Admins]`).

El WebSocket de `sergioaguirre` sí está conectado y unido al grupo `user_9`, pero
el signal nunca coloca el id=9 en la lista `user_ids` que se pasa a
`NotificationService.send_to_users`.

---

## Diagnóstico: por qué `sergioaguirre` no aparece en la query

### Bug raíz — doble condición que se anula mutuamente

La query en `_send_appointment_notification` es:

```python
users_with_role = User.objects.filter(
    is_active=True,
    tenant_memberships__tenant_id=appointment.tenant_id,
    groups__name__in=['advisors', 'admins', 'Advisors', 'Admins'],
).distinct()
```

Esta query hace un JOIN implícito entre las tablas:

```
auth_user
  JOIN tenants_tenantuser  ON (user_id = user_id  AND tenant_id = ?)
  JOIN auth_user_groups    ON (user_id = user_id)
  JOIN auth_group          ON (group_id = id AND name IN [...])
```

Con un `filter()` que encadena condiciones sobre tablas distintas, Django genera
un JOIN que exige que **la misma fila intermedia** satisfaga ambas condiciones al
mismo tiempo. Para tablas M2M distintas (membresías y grupos son tablas separadas)
Django puede crear un producto cartesiano incorrecto o requerir que existan filas
que vinculen ambas relaciones en la misma consulta.

El resultado observable: si el ORM no puede resolver el JOIN de forma que encuentre
a `sergioaguirre` cumpliendo AMBAS condiciones en la misma evaluación, la fila se
descarta, aunque el usuario sí tenga membresía Y sí pertenezca al grupo.

### Verificación en shell Django

```python
from django.contrib.auth.models import User

# Verificar membresía
User.objects.filter(
    tenant_memberships__tenant_id=3
).values_list('id', 'email')
# Debe incluir id=9

# Verificar grupo
User.objects.filter(
    groups__name='Admins'
).values_list('id', 'email')
# Debe incluir id=9

# La query combinada que falla
User.objects.filter(
    is_active=True,
    tenant_memberships__tenant_id=3,
    groups__name__in=['advisors', 'admins', 'Advisors', 'Admins'],
).distinct().values_list('id', 'email')
# Si id=9 no aparece aquí, el bug está confirmado en la query
```

### Solución: separar las dos condiciones en queries independientes

En lugar de un JOIN multi-tabla, ejecutar dos queries y unir los resultados con
Python (que ya se hace para `staff_users`, pero no correctamente para el caso de
membresía + grupo):

```python
# Query 1: usuarios con membresía en el tenant
members = User.objects.filter(
    is_active=True,
    tenant_memberships__tenant_id=appointment.tenant_id,
).values_list('id', flat=True)

# Query 2: usuarios con rol admin o advisor
staff_roles = User.objects.filter(
    is_active=True,
    groups__name__in=['Admins', 'Advisors'],
).values_list('id', flat=True)

# Intersección: miembros del tenant QUE ADEMÁS tienen el rol
notifiable_ids = set(members) & set(staff_roles)
```

La intersección en Python garantiza que se requiere AMBAS condiciones sin depender
del comportamiento del ORM ante JOINs multi-tabla.

### Por qué `yadhirisvan11` sí aparecía

La segunda query (`staff_users`) solo filtra por `is_staff=True` y membresía en el
tenant. `yadhirisvan11` tiene `is_staff=True` y tenía un `TenantUser` en
`taller_rojo` (creado explícitamente para depurar el bug), por eso sí era
encontrado. `sergioaguirre` no es `is_staff`, entonces no caía en esa rama.

---

## Modelo de roles: ¿grupos Django o campo `role` en `TenantUser`?

### Estado actual

`TenantUser` ya tiene un campo `role` con valores:

```python
role = models.CharField(
    choices=[('owner', 'Propietario'), ('admin', 'Administrador'), ('member', 'Miembro')],
    default='member',
)
```

Los grupos de Django (`Admins`, `Advisors`, `Mechanics`, `Customers`) son globales
y controlan permisos de la API (DRF permissions + Django admin).

### Conclusión sobre el modelo

No es necesario cambiar el modelo. El campo `TenantUser.role` es el lugar correcto
para expresar "este usuario es admin/dueño de ESTE tenant específico". Los grupos
de Django sirven para los permisos de acceso a endpoints y al admin de Django.

**Regla de negocio para notificaciones:**

> Reciben notificación de una cita los usuarios que tienen `TenantUser.role` en
> `['owner', 'admin']` en el tenant de la cita, MAS los usuarios en el grupo
> `Advisors` que tienen membresía en ese tenant.

Esto es más correcto y preciso que filtrar por grupos globales, porque:

1. Un usuario puede ser `Admins` en Django pero miembro de otro tenant — no debería
   recibir notificaciones de este taller.
2. El campo `role` en `TenantUser` captura exactamente "es admin de este taller".
3. Los `Advisors` también deben ser notificados porque gestionan las citas.

### Superadmins (`is_superuser=True`) sin `TenantUser`

**Decisión de diseño:** Los superadmins NO deben recibir notificaciones automáticas
de todos los tenants. Son administradores de la plataforma, no del taller.

Si un superadmin necesita ver notificaciones de un taller específico, debe tener un
`TenantUser` explícito en ese taller. Esto mantiene el aislamiento multi-tenant
coherente y evita que los superadmins sean inundados de notificaciones.

La rama `staff_users` de la query actual (`is_staff=True`) debe eliminarse.

---

## Impacto Arquitectural

### Backend — cambios mínimos necesarios

**Archivo a modificar:** `apps/appointments/signals.py`

**Función a modificar:** `_send_appointment_notification`

**Cambio:** Reemplazar la lógica de query de la sección "notificar a otros
asesores/admins del tenant" por una consulta en dos pasos usando `TenantUser.role`
para admins/owners y grupos Django solo para `Advisors`.

**No se modifica:**
- El modelo `TenantUser` (ya tiene el campo `role` necesario)
- `NotificationService` (funciona correctamente)
- `NotificationConsumer` (funciona correctamente)
- El modelo `Notification` (sin cambios)
- Ningún serializer ni ViewSet

### Frontend

Sin cambios. El sistema de notificaciones del frontend ya funciona cuando la
notificación llega al canal correcto.

---

## Plan de Implementación

### Paso 1 — Corrección del signal (único cambio de código)

**Archivo:** `/home/yadhir/Documentos/vps/tallerv2/backend-taller-pro/apps/appointments/signals.py`

Reemplazar el bloque de `_send_appointment_notification` desde la línea 110 hasta
la línea 133 con la siguiente lógica:

```python
# Tambien notificar a admins/owners y advisors del tenant
if appointment.tenant_id:
    from apps.tenants.models import TenantUser

    # IDs de admins y owners de este tenant específico (via TenantUser.role)
    admin_owner_ids = set(
        TenantUser.objects.filter(
            tenant_id=appointment.tenant_id,
            role__in=['owner', 'admin'],
            user__is_active=True,
        ).values_list('user_id', flat=True)
    )

    # IDs de asesores del tenant (grupo Advisors + membresía en el tenant)
    tenant_member_ids = set(
        TenantUser.objects.filter(
            tenant_id=appointment.tenant_id,
            user__is_active=True,
        ).values_list('user_id', flat=True)
    )
    advisor_ids = set(
        User.objects.filter(
            id__in=tenant_member_ids,
            groups__name='Advisors',
        ).values_list('id', flat=True)
    )

    notifiable_ids = admin_owner_ids | advisor_ids

    for uid in notifiable_ids:
        if uid not in user_ids:
            user_ids.append(uid)
```

**Por qué este enfoque es correcto:**

- `TenantUser.role__in=['owner', 'admin']` usa el campo dedicado para identificar
  admins de UN tenant específico, sin ambigüedad de grupos globales.
- Para `Advisors`, se hace primero la query de membresía (lista de ids), luego se
  filtra por grupo — dos queries simples, sin JOIN multi-tabla problemático.
- Se elimina la rama `is_staff=True` que era el parche que traía a `yadhirisvan11`.
- Compatible con el modelo existente sin migraciones.

### Paso 2 — Verificación del campo `role` en datos existentes

Antes de desplegar, verificar en el shell que `sergioaguirre` tenga `role='admin'`
o `role='owner'` en su `TenantUser`:

```python
from apps.tenants.models import TenantUser
TenantUser.objects.filter(
    user__email='sergioaguirre@gmail.com'
).values('tenant__slug', 'role', 'is_current')
```

Si el `role` es `'member'` (el default), actualizarlo:

```python
TenantUser.objects.filter(
    user__email='sergioaguirre@gmail.com',
    tenant__slug='taller_rojo'
).update(role='admin')
```

### Paso 3 — Prueba manual end-to-end

1. Conectar WebSocket de `sergioaguirre` en el frontend (o via wscat).
2. Agendar una cita en `taller_rojo` desde el booking público.
3. Verificar en los logs del backend:
   ```
   [Notificaciones] Enviando a N usuarios: [9, ...]
   ```
   El id=9 debe aparecer.
4. Verificar que el toast de notificación aparece en la sesión de `sergioaguirre`.

### Paso 4 — Test unitario (opcional pero recomendado)

Agregar en `apps/appointments/tests/test_signals.py`:

```python
@pytest.mark.django_db
def test_notificacion_llega_a_admin_del_tenant(tenant, admin_user, appointment_factory):
    """El admin del tenant debe recibir notificación al crear una cita."""
    from apps.tenants.models import TenantUser
    TenantUser.objects.filter(user=admin_user, tenant=tenant).update(role='admin')

    with patch('apps.notifications.services.NotificationService.send_to_users') as mock_send:
        appointment = appointment_factory(tenant=tenant)
        called_ids = mock_send.call_args[1]['user_ids']
        assert admin_user.id in called_ids
```

---

## Consideraciones de Seguridad

- El filtrado por `tenant_id` del appointment garantiza que solo se notifica a
  usuarios del mismo tenant. No hay cross-tenant leak.
- Se elimina la dependencia de `is_staff` para determinar destinatarios de
  notificaciones de negocio, lo que evita que usuarios con privilegios de plataforma
  sean expuestos a datos de tenants que no gestionan.
- Los permisos DRF (`IsAdminUser`, `IsTenantMember`) no cambian, solo la lógica de
  destino de notificaciones.

---

## Resumen de Cambios

| Archivo | Tipo de cambio | Descripción |
|---------|---------------|-------------|
| `apps/appointments/signals.py` | Modificación | Reemplazar query multi-tabla por dos queries simples + intersección por `TenantUser.role` |

**No requiere:**
- Migraciones de base de datos
- Cambios en modelos
- Cambios en serializers o ViewSets
- Cambios en el frontend
- Cambios en `NotificationService` o `NotificationConsumer`

El campo `TenantUser.role` ya existe en el modelo y en la base de datos. Solo es
necesario asegurarse de que los datos existentes tengan el valor correcto (`admin` u
`owner`) para los usuarios que deben ser notificados.
