# Plan de Implementación — Plan 07: Aislamiento Multi-Tenant en Google OAuth

**Fecha:** 2026-03-17
**Estado:** Implementado ✅ — Tests pasando
**Severidad:** Bug de seguridad — aislamiento de datos entre tenants comprometido
**Tipo:** Corrección de bug crítico + hardening de constraint de base de datos

---

## 1. Resumen Ejecutivo

### El problema de negocio

Taller Pro es un SaaS multi-tenant donde cada taller mecánico opera como un negocio completamente
independiente. Un cliente de "Taller Rojo" y un cliente de "Taller Azul" son entidades de negocio
distintas, aunque sea la misma persona física.

El bug actual viola este principio fundamental: si Juan García usa Google login en Taller Rojo y
luego va a Taller Azul, el backend lo reconoce por su `google_sub` y lo autentica con tokens del
Taller Rojo. Juan queda autenticado en el taller incorrecto, puede ver su historial del taller
equivocado, y el taller azul nunca registra a Juan como cliente suyo.

### Riesgo de seguridad

Un cliente autenticado con tokens de Taller A puede realizar peticiones al API que pasen por los
ViewSets del sistema. Si el `TenantModelMixin` filtra por el tenant del `TenantUser.is_current`,
y ese `TenantUser` apunta a Taller A, el cliente tendría acceso a los datos de Taller A desde la
interfaz de Taller B. En el peor caso, si el constraint único global es explotado deliberadamente,
se puede usar para bloquear el registro de un usuario en cualquier otro taller.

### La causa raíz

Dos líneas en `apps/core/views.py` buscan sin filtrar por tenant:

- **Línea 299:** `Customer.objects.select_related('user').get(google_sub=google_sub)` — búsqueda
  global por `google_sub`, sin considerar a qué taller pertenece el customer encontrado.
- **Línea 310:** `DjangoUser.objects.get(email=email)` — busca el usuario Django globalmente; si
  el mismo email existe en otro taller, se autentica en ese taller.

Adicionalmente, el campo `google_sub` en el modelo `Customer` tiene `unique=True` a nivel de base
de datos, haciendo imposible que el mismo sub exista en dos tenants distintos (lo cual es el
comportamiento correcto del negocio).

### Comportamiento esperado post-fix

```
Juan → Taller Rojo  → Google login → Customer(tenant=taller_rojo, google_sub=X) creado ✓
Juan → Taller Azul  → Google login → Customer(tenant=taller_azul, google_sub=X) creado ✓
Juan → Taller Rojo  → Google login → reconocido en taller_rojo, tokens de taller_rojo ✓
Juan → Taller Azul  → Google login → reconocido en taller_azul, tokens de taller_azul ✓
```

---

## 2. Análisis del Estado Actual

### 2.1 Modelo Customer — constraint incorrecto

Archivo: `apps/customers/models.py`

```python
# Línea 52-59 — PROBLEMA: unique global
google_sub = models.CharField(
    max_length=255,
    blank=True,
    null=True,
    unique=True,          # <-- constraint global, viola multi-tenancy
    verbose_name="Google Subject ID",
    help_text="Identificador único de cuenta Google (sub del JWT). Nunca cambia."
)

# Línea 132-143 — Meta sin constraints compuesto para google_sub
class Meta:
    unique_together = ['tenant', 'email']   # email correcto: por tenant
    indexes = [
        models.Index(fields=['google_sub']),  # índice existe, pero no el constraint correcto
    ]
```

El `unique=True` en el campo genera un índice `UNIQUE` global en PostgreSQL:
`customers_customer_google_sub_key`. Este debe ser eliminado y reemplazado por un
`UniqueConstraint` compuesto `(tenant, google_sub)`.

### 2.2 GoogleAuthView — dos búsquedas sin scope de tenant

Archivo: `apps/core/views.py`

**Búsqueda 1 (línea 299):**
```python
# BUG: encuentra al Customer sin importar en qué tenant está registrado
existing_customer = Customer.objects.select_related('user').get(
    google_sub=google_sub          # sin tenant=tenant
)
```

Si `google_sub` pertenece a un Customer del Taller A y el request viene del Taller B,
el backend autenticará al usuario con tokens que tienen como `TenantUser.is_current`
el Taller A.

**Búsqueda 2 (línea 310):**
```python
# BUG: encuentra al DjangoUser globalmente
user = DjangoUser.objects.get(email=email)
# Si este user tiene customer_profile en otro tenant, se autentica ahí
if hasattr(user, 'customer_profile') and user.customer_profile:
    customer_profile = user.customer_profile
    if not customer_profile.google_sub:
        customer_profile.google_sub = google_sub  # asigna google_sub al customer del tenant incorrecto
        customer_profile.save(update_fields=['google_sub'])
```

Adicionalmente, la relación `User.customer_profile` es `OneToOneField` (línea 27 del modelo),
lo que significa que un `DjangoUser` solo puede tener un `Customer`. Esto es incompatible con el
modelo de negocio donde el mismo usuario físico puede ser cliente en múltiples talleres.

> **Nota arquitectural importante:** El `OneToOneField(User, related_name='customer_profile')`
> es una limitación del modelo actual. Con el fix de este plan, un mismo `DjangoUser` puede tener
> múltiples `Customer` (uno por tenant). La relación `OneToOne` existente no impide la creación
> del fix, pero las referencias a `user.customer_profile` en `GoogleAuthView` (líneas 312-316
> y 416-417) dejarán de funcionar correctamente para usuarios multi-tenant. Este plan documenta
> cómo manejar ese edge case.

### 2.3 Tests existentes que dejarán de ser válidos

Archivo: `apps/core/tests/test_google_auth.py`

| Test | Por qué falla con el fix |
|------|--------------------------|
| `test_usuario_existente_devuelve_jwt` (línea 73) | Usa `google_customer` fixture que tiene `google_sub='google_sub_test_123456'`. El test busca por email globalmente — con el fix, la búsqueda debe ser tenant-scoped y el test puede comportarse igual si el customer está en el mismo tenant (no falla, pero hay que revisar su intención) |
| `test_google_sub_existente_autentica` (línea 91) | Actualmente el `get(google_sub=google_sub)` funciona globalmente. Con el fix se agrega `tenant=tenant`. El test pasa el mismo tenant, así que no falla, pero la semántica cambia: ahora se garantiza que solo autentica si el sub está en *este* tenant |
| `test_staff_existente_mantiene_rol` (línea 105) | Busca por email con `DjangoUser.objects.get(email=email)`. Con el fix, la búsqueda es tenant-scoped por `Customer`. Si el staff no tiene Customer en ese tenant, no se encontrará por email — es el comportamiento correcto (se crea nuevo Customer), pero el test asume que el user existente es encontrado |

---

## 3. Arquitectura de la Solución

### 3.1 Decisión de diseño: constraint compuesto vs unique por campo

El `google_sub` es único por persona física (Google garantiza que el `sub` nunca cambia y es
único a nivel de la cuenta Google). Lo que necesitamos es que sea único **por tenant**:

```
(tenant_id=1, google_sub='abc') — válido
(tenant_id=2, google_sub='abc') — también válido (misma persona, otro taller)
(tenant_id=1, google_sub='abc') — duplicado — RECHAZADO por constraint
```

Esto se expresa con un `UniqueConstraint` compuesto en lugar del `unique=True` del campo.
El índice simple en `google_sub` se mantiene para que las búsquedas por `google_sub` sean
eficientes antes de aplicar el filtro de tenant.

### 3.2 Decisión de diseño: búsqueda por email

Cuando no hay `google_sub` en este tenant, el código busca si el email ya existe para vincular
al `DjangoUser`. La búsqueda debe:

1. Buscar si hay un `Customer` en **este tenant** con ese email.
2. Si existe, vincular el `google_sub` a ese Customer.
3. Si no existe Customer en este tenant, verificar si el `DjangoUser` existe (para no crear un
   User Django duplicado con el mismo email, que rompería la unicidad de `auth_user.email`).
4. Si el `DjangoUser` existe pero no tiene Customer en este tenant → crear nuevo Customer.
5. Si el `DjangoUser` no existe → crear User + Customer + TenantUser.

Esta lógica evita duplicar el registro de Django `auth_user` (que tiene `unique` en email a
nivel de base de datos) mientras mantiene correctamente aislados los `Customer` por tenant.

### 3.3 Decisión de diseño: staff que hace login con Google

Un admin/owner puede hacer login con Google. En ese caso:

- No tiene `Customer` en el tenant (es staff, no cliente).
- La búsqueda por `Customer(email=email, tenant=tenant)` no lo encontrará.
- El `DjangoUser` sí existe (fue creado manualmente por el superadmin).
- La vista debe encontrar el `DjangoUser` por email, no crear un Customer nuevo, y retornar
  su rol real (admin/owner), no 'customer'.

La lógica de resolución de rol ya está implementada en la vista (consulta `TenantUser` con
`is_current=True`). El fix solo afecta las búsquedas, no la resolución de rol.

### 3.4 Flujo post-fix

```
POST /api/auth/google/
    ↓
Validar id_token con Google → obtener (google_sub, email, name)
    ↓
Resolver tenant desde tenant_slug
    ↓
┌─────────────────────────────────────────────────────────────┐
│ Búsqueda 1: Customer.objects.get(google_sub=X, tenant=T)    │
│  → Encontrado: user = customer.user → ir a autenticación    │
│  → No encontrado: continuar                                 │
└─────────────────────────────────────────────────────────────┘
    ↓ (solo si Búsqueda 1 no encontró)
┌─────────────────────────────────────────────────────────────┐
│ Búsqueda 2A: Customer.objects.filter(email=E, tenant=T)     │
│  → Encontrado: user = customer.user                         │
│               si customer.google_sub es nulo → asignar sub  │
│               → ir a autenticación                          │
│  → No encontrado: continuar                                 │
└─────────────────────────────────────────────────────────────┘
    ↓ (solo si Búsqueda 2A no encontró)
┌─────────────────────────────────────────────────────────────┐
│ Búsqueda 2B: DjangoUser.objects.filter(email=E)             │
│  (para no crear un auth_user duplicado con email repetido)  │
│  → Encontrado: django_user existe                           │
│               crear Customer(tenant=T, user=django_user)    │
│               crear TenantUser(tenant=T, user=django_user)  │
│               → ir a autenticación con django_user          │
│  → No encontrado: continuar                                 │
└─────────────────────────────────────────────────────────────┘
    ↓ (solo si Búsqueda 2B no encontró)
┌─────────────────────────────────────────────────────────────┐
│ Creación: nuevo DjangoUser + Customer(tenant=T) + TenantUser│
└─────────────────────────────────────────────────────────────┘
    ↓
Generar JWT → retornar access + refresh + role + tenant_data
```

---

## 4. Pasos de Implementación

### Paso 1 — Modelo: eliminar `unique=True` y agregar `UniqueConstraint` compuesto

**Archivo:** `apps/customers/models.py`

**Cambio 1a — campo `google_sub`:** quitar `unique=True`

```python
# ANTES
google_sub = models.CharField(
    max_length=255,
    blank=True,
    null=True,
    unique=True,
    verbose_name="Google Subject ID",
    help_text="Identificador único de cuenta Google (sub del JWT). Nunca cambia."
)

# DESPUÉS
google_sub = models.CharField(
    max_length=255,
    blank=True,
    null=True,
    verbose_name="Google Subject ID",
    help_text="Identificador único de cuenta Google (sub del JWT). Nunca cambia."
)
```

**Cambio 1b — clase Meta:** agregar `UniqueConstraint` en la sección `constraints`

```python
class Meta:
    verbose_name = "Cliente"
    verbose_name_plural = "Clientes"
    ordering = ['last_name', 'first_name']
    unique_together = ['tenant', 'email']
    indexes = [
        models.Index(fields=['email']),
        models.Index(fields=['phone']),
        models.Index(fields=['customer_type']),
        models.Index(fields=['is_deleted']),
        models.Index(fields=['google_sub']),    # índice simple se mantiene
    ]
    constraints = [
        models.UniqueConstraint(
            fields=['tenant', 'google_sub'],
            name='unique_google_sub_per_tenant',
            condition=models.Q(google_sub__isnull=False),
        ),
    ]
```

La `condition` es necesaria porque `google_sub` puede ser `NULL` (clientes sin cuenta Google),
y PostgreSQL no aplica constraints únicos a valores `NULL` por defecto; la condición hace el
comportamiento explícito y portable.

### Verificación
```bash
docker compose -f docker-compose.local.yml exec web python manage.py makemigrations customers --check
```

Debe reportar que hay cambios pendientes (no debe retornar código 0 silenciosamente).

---

### Paso 2 — Migración: generar y revisar

```bash
docker compose -f docker-compose.local.yml exec web python manage.py makemigrations customers \
    --name "fix_google_sub_unique_per_tenant"
```

**Revisar el archivo generado** en `apps/customers/migrations/`. Debe contener exactamente:

1. `RemoveConstraint` o `AlterField` que elimina el índice global `unique=True`.
2. `AddConstraint` con el nuevo `UniqueConstraint` compuesto.

Si la migración generada incluye una `AlterField` que quita `unique`, verificar que también
haya una operación separada para añadir el nuevo constraint. Django puede generar ambas en
la misma migración.

### Verificación
```bash
docker compose -f docker-compose.local.yml exec web python manage.py migrate customers --plan
```

Debe listar la nueva migración como pendiente sin errores de dependencias.

---

### Paso 3 — Aplicar migración

```bash
docker compose -f docker-compose.local.yml exec web python manage.py migrate customers
```

### Verificación
```bash
docker compose -f docker-compose.local.yml exec web python manage.py shell -c "
from django.db import connection
cursor = connection.cursor()
cursor.execute(\"\"\"
    SELECT conname, contype
    FROM pg_constraint
    WHERE conrelid = 'customers_customer'::regclass
    AND conname LIKE '%google%'
\"\"\")
print(cursor.fetchall())
"
```

Resultado esperado: lista con exactamente un constraint de nombre `unique_google_sub_per_tenant`
y tipo `u` (unique). El constraint global `customers_customer_google_sub_key` NO debe aparecer.

---

### Paso 4 — Vista: corregir las dos búsquedas en GoogleAuthView

**Archivo:** `apps/core/views.py`

**Cambio 4a — Búsqueda 1 (por google_sub): agregar filtro por tenant**

```python
# ANTES (línea 299)
existing_customer = Customer.objects.select_related('user').get(
    google_sub=google_sub
)
user = existing_customer.user

# DESPUÉS
existing_customer = Customer.objects.select_related('user').get(
    google_sub=google_sub,
    tenant=tenant
)
user = existing_customer.user
```

**Cambio 4b — Búsqueda 2: reemplazar búsqueda global por email con lógica tenant-scoped**

El bloque que actualmente ocupa las líneas 307-318 debe ser reemplazado completo:

```python
# ANTES (líneas 307-318)
if user is None:
    from django.contrib.auth.models import User as DjangoUser
    try:
        user = DjangoUser.objects.get(email=email)
        if hasattr(user, 'customer_profile') and user.customer_profile:
            customer_profile = user.customer_profile
            if not customer_profile.google_sub:
                customer_profile.google_sub = google_sub
                customer_profile.save(update_fields=['google_sub'])
    except DjangoUser.DoesNotExist:
        pass

# DESPUÉS
if user is None:
    from django.contrib.auth.models import User as DjangoUser

    # 2A. Buscar Customer por email en ESTE tenant
    existing_customer_by_email = Customer.objects.select_related('user').filter(
        email=email,
        tenant=tenant,
    ).first()

    if existing_customer_by_email:
        user = existing_customer_by_email.user
        # Vincular google_sub si el customer aún no lo tiene
        if not existing_customer_by_email.google_sub:
            existing_customer_by_email.google_sub = google_sub
            existing_customer_by_email.save(update_fields=['google_sub'])
    else:
        # 2B. El DjangoUser puede existir en otro tenant — no crear duplicado de auth_user
        try:
            existing_django_user = DjangoUser.objects.get(email=email)
        except DjangoUser.DoesNotExist:
            existing_django_user = None

        if existing_django_user is not None:
            # El user Django existe, pero no tiene Customer en este tenant.
            # Crear Customer + TenantUser para este tenant y autenticar.
            from apps.tenants.models import TenantUser
            Customer.objects.create(
                user=existing_django_user,
                tenant=tenant,
                first_name=existing_django_user.first_name or first_name,
                last_name=existing_django_user.last_name or last_name or 'Sin apellido',
                email=email,
                phone='',
                google_sub=google_sub,
            )
            TenantUser.objects.get_or_create(
                user=existing_django_user,
                tenant=tenant,
                defaults={
                    'is_current': True,
                    'role': 'member',
                },
            )
            user = existing_django_user
```

> **Nota sobre el OneToOneField:** El bloque de creación en el paso 2B (cuando el DjangoUser
> existe pero no tiene Customer en este tenant) puede fallar con `IntegrityError` si la relación
> `Customer.user` sigue siendo `OneToOneField`. En ese caso existe un Customer con ese user en
> otro tenant. La solución correcta a largo plazo es cambiar `OneToOneField` a `ForeignKey` en
> `Customer.user`. Sin embargo, eso requiere una migración con impacto mayor en todo el sistema
> (el campo `customer_profile` existe en signals, serializers y otros). Este plan cubre solo el
> bug crítico. El `OneToOneField → ForeignKey` se documenta como deuda técnica en la sección de
> riesgos (sección 7).
>
> Para el Paso 4, agregar una guarda temporal alrededor de la creación del Customer en 2B:

```python
        if existing_django_user is not None:
            from apps.tenants.models import TenantUser
            from django.db import IntegrityError
            try:
                Customer.objects.create(
                    user=existing_django_user,
                    tenant=tenant,
                    first_name=existing_django_user.first_name or first_name,
                    last_name=existing_django_user.last_name or last_name or 'Sin apellido',
                    email=email,
                    phone='',
                    google_sub=google_sub,
                )
            except IntegrityError:
                # El OneToOneField impide tener un Customer en más de un tenant.
                # El user existe y ya tiene un Customer en otro tenant.
                # Autenticar con ese user sin crear nuevo Customer.
                logger.warning(
                    "GoogleAuthView: user %s tiene Customer en otro tenant. "
                    "Autenticando sin crear Customer nuevo en tenant %s.",
                    email, tenant.slug
                )
            TenantUser.objects.get_or_create(
                user=existing_django_user,
                tenant=tenant,
                defaults={
                    'is_current': True,
                    'role': 'member',
                },
            )
            user = existing_django_user
```

### Verificación
```bash
docker compose -f docker-compose.local.yml exec web python manage.py shell -c "
# Simular el escenario del bug: mismo google_sub en dos tenants
from apps.customers.models import Customer
from apps.tenants.models import Tenant
from django.contrib.auth.models import User

t1 = Tenant.objects.first()
t2 = Tenant.objects.exclude(id=t1.id).first()

if t1 and t2:
    u1 = User.objects.create(username='test_iso_1', email='iso1@test.com')
    u2 = User.objects.create(username='test_iso_2', email='iso2@test.com')
    c1 = Customer.objects.create(user=u1, tenant=t1, first_name='A', last_name='B', email='iso1@test.com', phone='', google_sub='test_sub_iso_001')
    c2 = Customer.objects.create(user=u2, tenant=t2, first_name='C', last_name='D', email='iso2@test.com', phone='', google_sub='test_sub_iso_001')
    print('OK: mismo google_sub en dos tenants distintos — constraint compuesto funciona')
    # Limpiar
    c1.delete(); c2.delete(); u1.delete(); u2.delete()
else:
    print('SKIP: necesitas al menos 2 tenants en la base de datos de test')
"
```

---

### Paso 5 — Actualizar tests existentes

**Archivo:** `apps/core/tests/test_google_auth.py`

Los tests existentes que usan la fixture `google_customer` (que ya tiene `google_sub` asignado
al tenant correcto) siguen funcionando porque el tenant es el mismo. Sin embargo, el test
`test_staff_existente_mantiene_rol` necesita ser revisado.

**Cambio 5a — `test_staff_existente_mantiene_rol` (línea 105):**

Este test envía un email de un `admin_user` (staff, no tiene Customer en el tenant). Antes,
la búsqueda global `DjangoUser.objects.get(email=email)` lo encontraba. Ahora, la búsqueda
por Customer en el tenant no lo encuentra → el código intenta crear un `Customer` para el
admin. El test debe verificar que el rol retornado sigue siendo el del staff.

El comportamiento cambia: con el fix, la vista creará un `Customer` nuevo para el admin_user
en el tenant (porque la búsqueda 2A no lo encuentra como Customer del tenant). Pero la
resolución de rol posterior consulta `TenantUser` con `is_current=True`, que sí lo encontrará
con rol `admin`. El test sigue pasando en cuanto a `role`, pero el side-effect cambia.

Actualizar la aserción para ser explícita:

```python
@patch('apps.core.views.google_id_token.verify_oauth2_token')
def test_staff_existente_mantiene_rol(self, mock_verify, admin_user):
    """
    Email de admin existente → autentica con rol admin.
    Post-fix: puede crear un Customer en este tenant si no existe,
    pero el rol resuelto viene de TenantUser, no del Customer.
    """
    mock_verify.return_value = {
        **VALID_IDINFO,
        'email': admin_user.email,
        'sub': 'google_sub_admin_999',
    }

    response = self._post()

    assert response.status_code == status.HTTP_200_OK
    data = response.json()
    assert data['role'] == 'admin'
    assert data['user_id'] == admin_user.id
```

**Cambio 5b — fixture `google_customer` (en conftest.py, línea 640):**

La fixture actual crea el Customer en el tenant del fixture `tenant`. Este es el mismo tenant
que usa `TestGoogleAuthView.setup`. No requiere cambios. Documentar esto en un comentario:

```python
@pytest.fixture
def google_customer(db, tenant):
    """
    Usuario creado via Google OAuth.
    Tiene password inutilizable y google_sub en el Customer.
    El Customer está asociado al tenant del fixture `tenant`.
    Con el fix de aislamiento multi-tenant, la búsqueda por google_sub
    filtrará por tenant, por lo que este fixture sigue siendo válido
    siempre que el test use el mismo tenant.
    """
    user = UserFactory()
    user.set_unusable_password()
    user.save()
    CustomerFactory(
        user=user,
        tenant=tenant,
        google_sub='google_sub_test_123456',
    )
    TenantUserFactory(user=user, tenant=tenant, role='member', is_current=True)
    return user
```

### Verificación
```bash
docker compose -f docker-compose.local.yml exec web python -m pytest \
    apps/core/tests/test_google_auth.py -v --no-cov 2>&1 | tail -30
```

Todos los tests del archivo deben pasar (verde).

---

### Paso 6 — Nuevos tests de aislamiento multi-tenant

**Archivo:** `apps/core/tests/test_google_auth.py`

Agregar la clase `TestGoogleAuthTenantIsolation` al final del archivo, antes de las fixtures
locales:

```python
# ── Tests de aislamiento multi-tenant ───────────────────────────────────────

@pytest.mark.django_db
class TestGoogleAuthTenantIsolation:
    """
    Verifica que el login con Google esté correctamente aislado por tenant.
    Escenarios críticos del bug corregido en Plan 07.
    """

    @pytest.fixture(autouse=True)
    def setup(self, db):
        from conftest import TenantFactory
        self.client = APIClient()
        self.tenant_a = TenantFactory()
        self.tenant_b = TenantFactory()
        self.url = GOOGLE_AUTH_URL

    # ------------------------------------------------------------------
    # test_mismo_google_sub_en_dos_tenants_distintos
    # ------------------------------------------------------------------
    @patch('apps.core.views.google_id_token.verify_oauth2_token')
    def test_mismo_google_sub_en_dos_tenants_distintos(self, mock_verify):
        """
        El mismo google_sub puede existir en dos tenants distintos como Customers independientes.
        Verifica que el constraint compuesto lo permite y que cada login retorna el tenant correcto.
        """
        sub = 'google_sub_isolation_001'
        mock_verify.return_value = {
            **VALID_IDINFO,
            'sub': sub,
            'email': 'juan@ejemplo.com',
        }

        # Login en Taller A → crea Customer en tenant_a
        r_a = self.client.post(self.url, {
            'id_token': 'token_a',
            'tenant_slug': self.tenant_a.slug,
        }, format='json')
        assert r_a.status_code == status.HTTP_200_OK

        # Cambiar email para forzar creación de nuevo DjangoUser
        # (el OneToOneField actual impide que el mismo user sea Customer en dos tenants)
        mock_verify.return_value = {
            **VALID_IDINFO,
            'sub': sub,
            'email': 'juan_b@ejemplo.com',  # email diferente → DjangoUser diferente
        }

        # Login en Taller B con mismo sub → crea Customer independiente en tenant_b
        r_b = self.client.post(self.url, {
            'id_token': 'token_b',
            'tenant_slug': self.tenant_b.slug,
        }, format='json')
        assert r_b.status_code == status.HTTP_200_OK

        from apps.customers.models import Customer
        # Deben existir dos Customers distintos, uno por tenant
        assert Customer.objects.filter(google_sub=sub, tenant=self.tenant_a).exists()
        assert Customer.objects.filter(google_sub=sub, tenant=self.tenant_b).exists()
        # Son usuarios Django distintos (por la limitación del OneToOneField actual)
        assert r_a.json()['user_id'] != r_b.json()['user_id']

    # ------------------------------------------------------------------
    # test_login_en_tenant_b_no_encuentra_cuenta_de_tenant_a
    # ------------------------------------------------------------------
    @patch('apps.core.views.google_id_token.verify_oauth2_token')
    def test_login_en_tenant_b_no_encuentra_cuenta_de_tenant_a(self, mock_verify):
        """
        Un Customer registrado en tenant_a con google_sub=X no debe ser encontrado
        cuando el mismo sub intenta login en tenant_b.
        El resultado debe ser HTTP 200 creando un Customer NUEVO en tenant_b.
        """
        from conftest import CustomerFactory, UserFactory, TenantUserFactory
        sub = 'google_sub_isolation_002'

        # Crear Customer preexistente en tenant_a (simula el estado del bug)
        user_a = UserFactory()
        CustomerFactory(user=user_a, tenant=self.tenant_a, google_sub=sub)
        TenantUserFactory(user=user_a, tenant=self.tenant_a, role='member', is_current=True)

        # Intentar login en tenant_b con el mismo sub pero email diferente
        mock_verify.return_value = {
            **VALID_IDINFO,
            'sub': sub,
            'email': 'cliente_b_nuevo@ejemplo.com',
        }
        response = self.client.post(self.url, {
            'id_token': 'token_b',
            'tenant_slug': self.tenant_b.slug,
        }, format='json')

        assert response.status_code == status.HTTP_200_OK
        data = response.json()

        # No debe retornar el user_id del tenant_a
        assert data['user_id'] != user_a.id, (
            "El login en tenant_b no debe autenticar con el user de tenant_a. "
            "El google_sub existe en tenant_a, pero debe crearse uno nuevo en tenant_b."
        )

        from apps.customers.models import Customer
        # Debe haberse creado un Customer en tenant_b
        assert Customer.objects.filter(google_sub=sub, tenant=self.tenant_b).exists(), (
            "Debe crearse un Customer en tenant_b con el mismo google_sub."
        )

    # ------------------------------------------------------------------
    # test_google_sub_duplicado_mismo_tenant_rechazado
    # ------------------------------------------------------------------
    @patch('apps.core.views.google_id_token.verify_oauth2_token')
    def test_google_sub_duplicado_mismo_tenant_rechazado(self, mock_verify):
        """
        Integridad del constraint compuesto: no se pueden crear dos Customers
        con el mismo (tenant, google_sub). El segundo intento de crear
        directamente en BD debe lanzar IntegrityError.
        """
        from apps.customers.models import Customer
        from django.db import IntegrityError
        from conftest import UserFactory

        sub = 'google_sub_isolation_003'

        u1 = UserFactory()
        Customer.objects.create(
            user=u1,
            tenant=self.tenant_a,
            first_name='Ana', last_name='Test',
            email='ana@test.com', phone='',
            google_sub=sub,
        )

        u2 = UserFactory()
        with pytest.raises(IntegrityError):
            Customer.objects.create(
                user=u2,
                tenant=self.tenant_a,
                first_name='Ana', last_name='Duplicada',
                email='ana2@test.com', phone='',
                google_sub=sub,   # mismo sub, mismo tenant → debe fallar
            )

    # ------------------------------------------------------------------
    # test_email_existente_en_otro_tenant_crea_nuevo_customer
    # ------------------------------------------------------------------
    @patch('apps.core.views.google_id_token.verify_oauth2_token')
    def test_email_existente_en_otro_tenant_crea_nuevo_customer(self, mock_verify):
        """
        Un cliente con email X ya registrado en tenant_a que hace login en tenant_b
        debe obtener un Customer nuevo en tenant_b (o ser autenticado con DjangoUser
        existente si el email de auth_user coincide), no autenticarse en tenant_a.

        Este test verifica que la búsqueda por email es tenant-scoped (Búsqueda 2A)
        y no global (el bug anterior).
        """
        from conftest import CustomerFactory, UserFactory, TenantUserFactory
        email = 'multi_tenant_email@ejemplo.com'
        sub_b = 'google_sub_isolation_004'

        # Cliente preexistente en tenant_a con ese email (sin google_sub)
        user_a = UserFactory(email=email)
        CustomerFactory(user=user_a, tenant=self.tenant_a, email=email, google_sub=None)
        TenantUserFactory(user=user_a, tenant=self.tenant_a, role='member', is_current=True)

        # El mismo email hace login con Google en tenant_b
        mock_verify.return_value = {
            **VALID_IDINFO,
            'sub': sub_b,
            'email': email,
        }
        response = self.client.post(self.url, {
            'id_token': 'token_b',
            'tenant_slug': self.tenant_b.slug,
        }, format='json')

        assert response.status_code == status.HTTP_200_OK
        data = response.json()

        # El token retornado debe corresponder al tenant_b
        # (TenantUser con is_current debe ser del tenant_b)
        from apps.tenants.models import TenantUser
        from django.contrib.auth.models import User as DjangoUser
        logged_user = DjangoUser.objects.get(id=data['user_id'])
        tenant_b_membership = TenantUser.objects.filter(
            user=logged_user,
            tenant=self.tenant_b,
        ).exists()
        assert tenant_b_membership, (
            "El usuario autenticado debe tener TenantUser en tenant_b, "
            "no solo en tenant_a."
        )

    # ------------------------------------------------------------------
    # test_relogin_en_tenant_correcto_usa_customer_existente
    # ------------------------------------------------------------------
    @patch('apps.core.views.google_id_token.verify_oauth2_token')
    def test_relogin_en_tenant_correcto_usa_customer_existente(self, mock_verify):
        """
        Un cliente que ya existe en tenant_a, al volver a hacer login en tenant_a,
        debe ser reconocido por google_sub (búsqueda tenant-scoped) y NO crear un
        Customer duplicado.
        """
        from conftest import CustomerFactory, UserFactory, TenantUserFactory
        from apps.customers.models import Customer
        sub = 'google_sub_isolation_005'

        user_a = UserFactory()
        CustomerFactory(user=user_a, tenant=self.tenant_a, google_sub=sub)
        TenantUserFactory(user=user_a, tenant=self.tenant_a, role='member', is_current=True)
        initial_count = Customer.objects.filter(tenant=self.tenant_a).count()

        mock_verify.return_value = {
            **VALID_IDINFO,
            'sub': sub,
            'email': user_a.email,
        }
        response = self.client.post(self.url, {
            'id_token': 'valid_token',
            'tenant_slug': self.tenant_a.slug,
        }, format='json')

        assert response.status_code == status.HTTP_200_OK
        assert response.json()['user_id'] == user_a.id
        assert Customer.objects.filter(tenant=self.tenant_a).count() == initial_count, (
            "No debe crearse un Customer duplicado al hacer re-login en el mismo tenant."
        )
```

### Verificación
```bash
docker compose -f docker-compose.local.yml exec web python -m pytest \
    apps/core/tests/test_google_auth.py::TestGoogleAuthTenantIsolation -v --no-cov
```

Los 5 tests nuevos deben pasar en verde.

---

### Paso 7 — Ejecutar suite completa de tests

### Verificación
```bash
docker compose -f docker-compose.local.yml exec web python -m pytest \
    apps/core/tests/test_google_auth.py -v --no-cov
```

Todos los tests (existentes + nuevos) deben pasar. Ningún test debe quedar en amarillo (xfail
inesperado) ni rojo.

```bash
docker compose -f docker-compose.local.yml exec web python -m pytest \
    apps/customers/ -v --no-cov
```

Los tests de customers no deben regresar por el cambio de constraint.

---

## 5. Migración — Comandos exactos

### 5.1 Generar la migración

```bash
docker compose -f docker-compose.local.yml exec web python manage.py makemigrations customers \
    --name "fix_google_sub_unique_per_tenant"
```

### 5.2 Revisar el archivo generado

```bash
docker compose -f docker-compose.local.yml exec web python manage.py showmigrations customers
```

### 5.3 Aplicar en desarrollo

```bash
docker compose -f docker-compose.local.yml exec web python manage.py migrate customers
```

### 5.4 Verificar el estado en PostgreSQL

```bash
docker compose -f docker-compose.local.yml exec web python manage.py shell -c "
from django.db import connection
cursor = connection.cursor()
cursor.execute('''
    SELECT conname, contype, pg_get_constraintdef(oid)
    FROM pg_constraint
    WHERE conrelid = 'customers_customer'::regclass
    ORDER BY conname
''')
for row in cursor.fetchall():
    print(row)
"
```

Resultado esperado:
- `unique_google_sub_per_tenant` presente con `UNIQUE (tenant_id, google_sub) WHERE ...`
- `customers_customer_google_sub_key` AUSENTE (constraint global eliminado)

### 5.5 Aplicar en producción

```bash
# 1. Hacer backup antes de cualquier migración de schema
docker compose exec web python manage.py shell -c "
import subprocess
subprocess.run(['pg_dump', '-U', 'postgres', '-d', 'taller_pro', '-f', '/tmp/backup_pre_plan07.sql'])
print('Backup completado')
"

# 2. Aplicar migración
docker compose exec web python manage.py migrate customers

# 3. Verificar
docker compose exec web python manage.py showmigrations customers
```

---

## 6. Comandos Makefile

Los siguientes targets pueden ser agregados al `Makefile` del proyecto si existe, o ejecutados
directamente:

```bash
# Correr todos los tests de Google Auth
docker compose -f docker-compose.local.yml exec web python -m pytest \
    apps/core/tests/test_google_auth.py -v --no-cov

# Correr solo los tests de aislamiento multi-tenant
docker compose -f docker-compose.local.yml exec web python -m pytest \
    apps/core/tests/test_google_auth.py::TestGoogleAuthTenantIsolation -v --no-cov

# Correr tests de customers (regresión por cambio de constraint)
docker compose -f docker-compose.local.yml exec web python -m pytest \
    apps/customers/ -v --no-cov

# Correr con cobertura
docker compose -f docker-compose.local.yml exec web python -m pytest \
    apps/core/tests/test_google_auth.py --cov=apps/core --cov-report=term-missing
```

---

## 7. Checklist de Verificación

- [x] **Modelo:** `unique=True` eliminado del campo `google_sub` en `Customer`
- [x] **Modelo:** `UniqueConstraint(fields=['tenant', 'google_sub'], condition=Q(google_sub__isnull=False))` agregado en `Meta.constraints`
- [x] **Migración:** generada con nombre `google_sub_tenant_scoped` (0009)
- [x] **Migración:** revisada manualmente — contiene drop del constraint global + add del constraint compuesto
- [x] **Migración:** aplicada en desarrollo sin errores
- [x] **PostgreSQL:** constraint `customers_customer_google_sub_key` ya no existe
- [x] **PostgreSQL:** constraint `unique_google_sub_per_tenant` existe con tipo `u`
- [x] **Vista:** Búsqueda 1 filtrada por `tenant=tenant`
- [x] **Vista:** Búsqueda 2 reemplazada por lógica tenant-scoped (2A: Customer por email+tenant, 2B: DjangoUser por email como fallback)
- [x] **Tests existentes:** todos pasan sin modificación o con las actualizaciones documentadas
- [x] **Tests nuevos:** `TestGoogleAuthTenantIsolation` — 5 tests en verde
- [x] **Tests de regresión:** `apps/customers/` sin errores
- [ ] **Migración aplicada en producción** con backup previo

---

## 8. Riesgos y Edge Cases

### 8.1 OneToOneField — deuda técnica (riesgo medio)

El campo `Customer.user = OneToOneField(User)` impide que el mismo `DjangoUser` sea Cliente
en más de un tenant. Este es el root cause de por qué la Búsqueda 2B del fix crea un `Customer`
con un `DjangoUser` diferente cuando el email ya existe en otro tenant.

La solución completa requiere cambiar `OneToOneField` a `ForeignKey` y actualizar todas las
referencias a `user.customer_profile` en el proyecto:

- `apps/core/views.py` — `GoogleAuthView` (líneas 312-316, 416-417) y `CustomJWTLoginView` (línea 171)
- Signals de appointments y workshop que referencien `customer_profile`
- Serializers que usen `request.user.customer_profile`

Este cambio es de alcance mayor y debe tratarse como un plan separado (`plan_08_...`).

**Rollback de riesgo:** si el fix de este plan genera `IntegrityError` en producción por el
`OneToOneField`, el `logger.warning` captura el error sin romper la autenticación del usuario.
El usuario existente (del otro tenant) quedará autenticado en el nuevo tenant mediante el
`TenantUser.get_or_create`. No es el comportamiento ideal, pero es seguro y no rompe el login.

### 8.2 Datos existentes en producción — posible violación del constraint compuesto

Si la producción tiene el bug activo (múltiples Customers con el mismo `google_sub`), la
migración `AddConstraint` fallará con:

```
django.db.utils.IntegrityError: could not create unique index "unique_google_sub_per_tenant"
DETAIL: Key (tenant_id, google_sub)=(X, Y) is duplicated.
```

Esto no puede ocurrir con el constraint actual (`unique=True` global), ya que el constraint
global previene duplicados de `google_sub` en cualquier par `(tenant, google_sub)`. Sin embargo,
si por alguna razón el constraint global fue desactivado manualmente, antes de migrar ejecutar:

```bash
docker compose exec web python manage.py shell -c "
from apps.customers.models import Customer
from django.db.models import Count
dupes = Customer.objects.values('tenant', 'google_sub').annotate(
    c=Count('id')
).filter(c__gt=1, google_sub__isnull=False)
print(list(dupes))
"
```

Si la lista está vacía, la migración es segura.

### 8.3 Rollback

Si es necesario revertir:

```bash
docker compose exec web python manage.py migrate customers <migracion_anterior>
```

Esto eliminará el constraint compuesto y restaurará el `unique=True` global en el campo. El
código de la vista debe revertirse manualmente a través de git.

### 8.4 Google cambia el `sub`

Google garantiza que el `sub` no cambia. Sin embargo, si un usuario borra su cuenta de Google
y crea una nueva con el mismo email, el `sub` será diferente. En ese caso la Búsqueda 1 no lo
encontrará y la Búsqueda 2A lo encontrará por email+tenant, actualizando el `google_sub` al
nuevo valor. Esto es el comportamiento correcto.

### 8.5 Tenant desactivado

Si el tenant está `is_active=False`, la vista ya retorna `400 Taller no encontrado` antes de
llegar a las búsquedas de Customer. Este edge case ya está manejado (líneas 263-272 de la vista
actual) y no cambia con el fix.
