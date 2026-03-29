# spec_09 — Custom User Model (sin username, contraseñas por tenant)

**Estado:** Listo para implementar
**Prioridad:** CRITICA — implementar hoy antes de datos de produccion
**Fecha:** 2026-03-17

---

## 1. Resumen ejecutivo

Django usa `auth.User` por defecto, que tiene `username` como campo obligatorio y `unique=True` en `email`. Esto impide que el mismo email exista en dos tenants con contraseñas distintas, que es exactamente lo que necesita Taller Pro.

La solucion es un Custom User Model (`accounts.User`) donde:
- `email` es el campo de identificacion (sin restriccion `unique` global).
- `username` no existe.
- La unicidad se garantiza por `(email, tenant)` via el backend de autenticacion `TenantEmailBackend`, no por constraint de BD en el modelo `User`.
- Cada taller puede crear su propio usuario para el mismo email con su propia contrasena.

No hay datos reales en produccion. Se borra la BD completa, se regeneran migraciones desde cero.

---

## 2. Que cambia exactamente (antes / despues)

### Modelo de usuario

| Aspecto | Antes (`auth.User`) | Despues (`accounts.User`) |
|---------|---------------------|---------------------------|
| Campo identidad | `username` (unique) | `email` (no unique global) |
| Email | `unique=True` | Sin restriccion global |
| Login | `username + password` | `email + password + tenant_slug` |
| Unicidad | Global en `auth_user` | Por `(email, tenant)` via backend |
| `USERNAME_FIELD` | `username` | `email` |
| `REQUIRED_FIELDS` | `email` | `[]` |

### Backend de autenticacion

| Aspecto | Antes (`EmailBackend`) | Despues (`TenantEmailBackend`) |
|---------|------------------------|--------------------------------|
| Busqueda | `User.objects.get(email=username)` | `TenantUser.objects.get(user__email=email, tenant__slug=tenant_slug)` |
| Contrasena compartida | Si (un user global) | No (cada user es independiente por tenant) |
| Login sin tenant | Funcionaba | Retorna `None` (correcto) |

### Archivos que dejan de referenciar `django.contrib.auth.models.User`

Cada archivo listado en la Fase 4 pasa de importar `django.contrib.auth.models.User` a usar `get_user_model()` o `settings.AUTH_USER_MODEL`.

---

## 3. Plan de implementacion

---

### Fase 1 — Crear app `accounts`

#### 1.1 Crear la estructura de directorios

```bash
mkdir -p apps/accounts/tests
touch apps/accounts/__init__.py
touch apps/accounts/apps.py
touch apps/accounts/models.py
touch apps/accounts/backends.py
touch apps/accounts/admin.py
touch apps/accounts/tests/__init__.py
touch apps/accounts/tests/test_custom_user.py
```

#### 1.2 `apps/accounts/apps.py`

```python
from django.apps import AppConfig


class AccountsConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'apps.accounts'
    verbose_name = 'Cuentas de Usuario'
```

#### 1.3 `apps/accounts/models.py`

```python
from django.contrib.auth.models import AbstractBaseUser, BaseUserManager, PermissionsMixin
from django.db import models


class UserManager(BaseUserManager):
    def create_user(self, email, password=None, **extra_fields):
        if not email:
            raise ValueError('El email es requerido')
        email = self.normalize_email(email)
        user = self.model(email=email, **extra_fields)
        user.set_password(password)
        user.save(using=self._db)
        return user

    def create_superuser(self, email, password, **extra_fields):
        extra_fields.setdefault('is_staff', True)
        extra_fields.setdefault('is_superuser', True)
        return self.create_user(email, password, **extra_fields)


class User(AbstractBaseUser, PermissionsMixin):
    email = models.EmailField(verbose_name='Email')  # NO unique globalmente
    first_name = models.CharField(max_length=150, blank=True)
    last_name = models.CharField(max_length=150, blank=True)
    is_active = models.BooleanField(default=True)
    is_staff = models.BooleanField(default=False)
    date_joined = models.DateTimeField(auto_now_add=True)

    objects = UserManager()
    USERNAME_FIELD = 'email'
    REQUIRED_FIELDS = []

    class Meta:
        verbose_name = 'Usuario'
        verbose_name_plural = 'Usuarios'

    def get_full_name(self):
        return f"{self.first_name} {self.last_name}".strip() or self.email

    def get_short_name(self):
        return self.first_name or self.email
```

#### 1.4 `apps/accounts/backends.py`

```python
class TenantEmailBackend:
    def authenticate(self, request, email=None, password=None, tenant_slug=None, **kwargs):
        from apps.accounts.models import User
        from apps.tenants.models import TenantUser
        if not email or not tenant_slug:
            return None
        try:
            tenant_user = TenantUser.objects.select_related('user', 'tenant').get(
                user__email=email,
                tenant__slug=tenant_slug,
                tenant__is_active=True,
                user__is_active=True,
            )
            user = tenant_user.user
            if user.check_password(password):
                return user
        except TenantUser.DoesNotExist:
            # Timing attack mitigation
            User().set_password(password)
        except TenantUser.MultipleObjectsReturned:
            pass
        return None

    def get_user(self, user_id):
        from apps.accounts.models import User
        try:
            return User.objects.get(pk=user_id)
        except User.DoesNotExist:
            return None
```

#### 1.5 `apps/accounts/admin.py`

```python
from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as BaseUserAdmin
from .models import User


@admin.register(User)
class UserAdmin(BaseUserAdmin):
    list_display = ['email', 'first_name', 'last_name', 'is_staff', 'is_active']
    list_filter = ['is_staff', 'is_active']
    search_fields = ['email', 'first_name', 'last_name']
    ordering = ['email']
    fieldsets = (
        (None, {'fields': ('email', 'password')}),
        ('Informacion personal', {'fields': ('first_name', 'last_name')}),
        ('Permisos', {'fields': ('is_active', 'is_staff', 'is_superuser', 'groups', 'user_permissions')}),
        ('Fechas', {'fields': ('last_login', 'date_joined')}),
    )
    add_fieldsets = (
        (None, {
            'classes': ('wide',),
            'fields': ('email', 'first_name', 'last_name', 'password1', 'password2', 'is_staff'),
        }),
    )
    # BaseUserAdmin usa 'username' internamente — sobreescribir
    username_field = 'email'
```

### Verificacion Fase 1

```bash
docker compose -f docker-compose.local.yml exec web python -c "
from apps.accounts.models import User
from apps.accounts.backends import TenantEmailBackend
print('OK: accounts.models y accounts.backends importan correctamente')
"
```

---

### Fase 2 — Settings

#### 2.1 `config/settings/base.py` — cambios a aplicar

**Agregar** estas tres lineas (antes del bloque `INSTALLED_APPS` existente o dentro de el):

```python
AUTH_USER_MODEL = 'accounts.User'
AUTHENTICATION_BACKENDS = ['apps.accounts.backends.TenantEmailBackend']
SILENCED_SYSTEM_CHECKS = ['auth.W004']
```

**Agregar** `'apps.accounts'` a `INSTALLED_APPS`, antes de `'apps.core'`:

```python
INSTALLED_APPS = [
    'daphne',
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',

    # Third party
    'rest_framework',
    'rest_framework.authtoken',
    'rest_framework_simplejwt',
    'rest_framework_simplejwt.token_blacklist',
    'corsheaders',
    'django_filters',
    'channels',

    # Local apps
    'apps.accounts',   # <-- AGREGAR AQUI (antes de core)
    'apps.core',
    'apps.customers',
    'apps.services',
    'apps.appointments',
    'apps.workshop',
    'apps.mechanics',
    'apps.inventory',
    'apps.password_reset',
    'apps.tenants',
    'apps.notifications',
]
```

**Eliminar** o comentar el backend anterior (ya no se usa):

```python
# ANTES (eliminar):
AUTHENTICATION_BACKENDS = [
    'apps.core.backends.EmailBackend',
]
# REEMPLAZAR POR (ya definido arriba):
# AUTHENTICATION_BACKENDS = ['apps.accounts.backends.TenantEmailBackend']
```

#### 2.2 `config/settings/testing.py` — sin cambios adicionales

El archivo hereda de `base.py` con `from .base import *`, por lo que recibe `AUTH_USER_MODEL` automaticamente. No requiere modificacion.

### Verificacion Fase 2

```bash
docker compose -f docker-compose.local.yml exec web python -c "
from django.conf import settings
assert settings.AUTH_USER_MODEL == 'accounts.User', f'Fallo: {settings.AUTH_USER_MODEL}'
assert 'apps.accounts.backends.TenantEmailBackend' in settings.AUTHENTICATION_BACKENDS
print('OK: Settings configurados correctamente')
"
```

---

### Fase 3 — Reset BD y migraciones

> ADVERTENCIA: Esto destruye todos los datos. Confirmado que no hay datos reales en produccion a fecha 2026-03-17.

#### 3.1 Bajar contenedores y borrar volumenes

```bash
cd /home/yadhir/Documentos/vps/tallerv2/backend-taller-pro
docker compose -f docker-compose.local.yml down -v
```

#### 3.2 Borrar archivos de migracion existentes (conservar `__init__.py`)

```bash
find apps -path "*/migrations/0*.py" -delete
```

Verificar que solo queden `__init__.py` en cada carpeta de migraciones:

```bash
find apps -path "*/migrations/*.py" | sort
```

Cada app debe mostrar solo `apps/<app>/migrations/__init__.py`.

#### 3.3 Levantar contenedores

```bash
docker compose -f docker-compose.local.yml up -d db redis
# Esperar que postgres este listo (~5s)
docker compose -f docker-compose.local.yml up -d web
```

#### 3.4 Generar migraciones en orden correcto

Django requiere que `accounts` tenga su migracion inicial antes que cualquier app que referencie `settings.AUTH_USER_MODEL`.

```bash
# 1. Primero accounts (AUTH_USER_MODEL)
docker compose -f docker-compose.local.yml exec web python manage.py makemigrations accounts

# 2. Tenants (TenantUser referencia User)
docker compose -f docker-compose.local.yml exec web python manage.py makemigrations tenants

# 3. Resto de apps en un solo comando
docker compose -f docker-compose.local.yml exec web python manage.py makemigrations core customers services appointments workshop mechanics inventory notifications password_reset

# 4. Verificar que no haya migraciones pendientes
docker compose -f docker-compose.local.yml exec web python manage.py makemigrations --check
```

#### 3.5 Aplicar migraciones

```bash
docker compose -f docker-compose.local.yml exec web python manage.py migrate
```

#### 3.6 Setup de grupos y superusuario

```bash
docker compose -f docker-compose.local.yml exec web python manage.py setup_groups

docker compose -f docker-compose.local.yml exec web python manage.py createsuperuser
# Ingresara: email (no username), password
```

### Verificacion Fase 3

```bash
docker compose -f docker-compose.local.yml exec web python manage.py shell -c "
from apps.accounts.models import User
u = User.objects.create_user(email='test@verify.com', password='pass123')
print(f'OK: User creado con id={u.id}, email={u.email}')
assert not hasattr(u, 'username'), 'ERROR: username no debe existir'
u.delete()
print('OK: Sin campo username confirmado')
"
```

---

### Fase 4 — Actualizar codigo existente

Cada archivo tiene referencias a `django.contrib.auth.models.User`, `username`, o `create_user(username=...)` que deben actualizarse.

#### 4.1 `apps/core/views.py`

**Linea 95 — `CustomJWTLoginView.post()`:**

```python
# ANTES:
username = request.data.get('username', '').strip()
password = request.data.get('password', '').strip()

if not username or not password:
    ...

user = authenticate(request, username=username, password=password)
```

```python
# DESPUES:
email = request.data.get('email') or request.data.get('username', '')
email = email.strip()
password = request.data.get('password', '').strip()
tenant_slug = (
    request.data.get('tenant_slug', '').strip()
    or request.headers.get('X-Tenant-ID', '').strip()
)

if not email or not password:
    return Response(
        {'non_field_errors': ['Credenciales requeridas.']},
        status=status.HTTP_400_BAD_REQUEST,
    )

user = authenticate(request, email=email, password=password, tenant_slug=tenant_slug)
```

**Linea 124 — `name = user.get_full_name() or user.username`:**

```python
# ANTES:
name = user.get_full_name() or user.username

# DESPUES:
name = user.get_full_name() or user.email
```

**Lineas 329-369 — `GoogleAuthView.post()` — bloque "Usuario nuevo":**

```python
# ANTES (lineas 329-369):
from django.contrib.auth.models import User as DjangoUser
# ...
existing_django_user = DjangoUser.objects.get(email=email)
# ...
username = email
if DjangoUser.objects.filter(username=username).exists():
    username = f"{email}_{google_sub[:8]}"

user = DjangoUser.objects.create(
    username=username,
    email=email,
    first_name=first_name,
    last_name=last_name,
    is_active=True,
)

# DESPUES:
from django.contrib.auth import get_user_model
User = get_user_model()
# ...
# Buscar por email — tenant-scoped (2A ya usa Customer, no User directo)
# Bloque 2B: buscar staff existente en este tenant
try:
    existing_user = User.objects.filter(email=email).first()
    if existing_user:
        from apps.tenants.models import TenantUser
        if TenantUser.objects.filter(user=existing_user, tenant=tenant).exists():
            user = existing_user
except Exception:
    pass

# Bloque 3: Usuario nuevo
if user is None:
    from apps.tenants.models import TenantUser
    user = User.objects.create(
        email=email,
        first_name=first_name,
        last_name=last_name,
        is_active=True,
    )
    user.set_unusable_password()
    user.save()
    # ... resto igual
```

**Linea 403 — `name = user.get_full_name() or user.username`:**

```python
# ANTES:
name = user.get_full_name() or user.username

# DESPUES:
name = user.get_full_name() or user.email
```

**Eliminar import:**
```python
# ELIMINAR esta linea (aparece en linea 329 y 354):
from django.contrib.auth.models import User as DjangoUser
```

#### 4.2 `apps/password_reset/views.py`

**Linea 5 — cambiar import:**

```python
# ANTES:
from django.contrib.auth.models import User

# DESPUES:
from django.contrib.auth import get_user_model
User = get_user_model()
```

**Linea 54 — `forgot_password` — `user.username` en email:**

```python
# ANTES:
message=f'''
Hola {user.get_full_name() or user.username},
...

# DESPUES:
message=f'''
Hola {user.get_full_name() or user.email},
...
```

**Linea 263 — `send_registration_code` — `User(email=email, username=email, ...)`:**

```python
# ANTES:
temp_user = User(
    email=email,
    username=email,  # temporal
    first_name=first_name or 'Usuario',
    last_name=last_name or 'Nuevo'
)

# DESPUES:
# Eliminar bloque completo de temp_user — no se usa para nada util
# El codigo y la expiracion van directo al cache (ya lo hace)
# Solo eliminar las 5 lineas del temp_user
```

**Linea 250 — `send_registration_code` — verificacion de user existente:**

```python
# ANTES:
if User.objects.filter(email=email).exists():
    return Response(
        {
            'existing_user': True,
            'message': 'Ya tienes cuenta en otro taller de Autotronia...',
        },
        status=status.HTTP_200_OK,
    )

# DESPUES — con Custom User Model, el mismo email puede existir en otro tenant
# Esta logica ya no aplica igual. Eliminar o cambiar segun decisiones de negocio:
# Con el nuevo modelo, cada user es por tenant, entonces no hay "cuenta en otro taller"
# a nivel de auth_user. Simplificar:
# (Eliminar el bloque entero o reemplazar por comentario explicativo)
```

**Linea 416 — `verify_and_register` — `User.objects.create_user(username=...)`:**

```python
# ANTES:
username = email
if User.objects.filter(username=username).exists():
    username = f"{email}_{_uuid.uuid4().hex[:8]}"
user = User.objects.create_user(
    username=username,
    email=email,
    password=password,
    first_name=first_name,
    last_name=last_name,
)

# DESPUES:
user = User.objects.create_user(
    email=email,
    password=password,
    first_name=first_name,
    last_name=last_name,
)
```

**Linea 479 — respuesta `'username': user.username`:**

```python
# ANTES:
response_data = {
    'message': 'Cuenta creada exitosamente',
    'user_id': user.id,
    'username': user.username,
    'customer_id': customer.id,
}

# DESPUES:
response_data = {
    'message': 'Cuenta creada exitosamente',
    'user_id': user.id,
    'email': user.email,
    'customer_id': customer.id,
}
```

**Nota sobre logica multi-tenant en `verify_and_register`:**
Con el nuevo modelo, el bloque `try: user = User.objects.get(email=email)` (linea 411) ya no tiene sentido — cada user es por tenant. Reemplazar por creacion directa siempre:

```python
# ANTES (lineas 408-425):
user_created = False
try:
    user = User.objects.get(email=email)
    # auth_user ya existe (en otro tenant) — NO actualizar contraseña
except User.DoesNotExist:
    username = email
    if User.objects.filter(username=username).exists():
        username = f"{email}_{_uuid.uuid4().hex[:8]}"
    user = User.objects.create_user(
        username=username,
        email=email,
        password=password,
        first_name=first_name,
        last_name=last_name,
    )
    user_created = True

# DESPUES — siempre crear nuevo user (cada user es por tenant):
user = User.objects.create_user(
    email=email,
    password=password,
    first_name=first_name,
    last_name=last_name,
)
```

#### 4.3 `apps/tenants/views.py`

**Linea 8 — import:**

```python
# ANTES:
from django.contrib.auth.models import User

# DESPUES:
from django.contrib.auth import get_user_model
User = get_user_model()
```

**Lineas 76-79 — validacion email unico en `TenantRegistrationView`:**

```python
# ANTES:
if email and User.objects.filter(email=email).exists():
    errors['email'] = 'Este email ya está registrado'
if email and User.objects.filter(username=email).exists():
    errors['email'] = 'Este email ya está registrado'

# DESPUES — con Custom User Model, el mismo email puede existir en otro tenant.
# La unicidad real es (email, tenant), asi que aqui no validar duplicado de email global.
# Eliminar ambas lineas de validacion o reemplazar por verificacion de tenant existente:
# (Eliminar las 4 lineas de validacion de email)
```

**Linea 126 — `User.objects.create_user(username=email, ...)`:**

```python
# ANTES:
user = User.objects.create_user(
    username=email,
    email=email,
    password=data.get('password'),
    first_name=first_name,
    last_name=last_name,
    is_active=True,
    is_staff=False,
)

# DESPUES:
user = User.objects.create_user(
    email=email,
    password=data.get('password'),
    first_name=first_name,
    last_name=last_name,
    is_active=True,
    is_staff=False,
)
```

#### 4.4 `apps/tenants/models.py`

**Linea 2 — import:**

```python
# ANTES:
from django.contrib.auth.models import User

# DESPUES:
from django.conf import settings
```

**Linea 304 (TenantUser.user ForeignKey):**

```python
# ANTES:
user = models.ForeignKey(
    User,
    on_delete=models.CASCADE,
    related_name='tenant_memberships'
)

# DESPUES:
user = models.ForeignKey(
    settings.AUTH_USER_MODEL,
    on_delete=models.CASCADE,
    related_name='tenant_memberships'
)
```

**Linea 339 — `__str__`:**

```python
# ANTES:
def __str__(self):
    return f"{self.user.username} → {self.tenant.name}"

# DESPUES:
def __str__(self):
    return f"{self.user.email} → {self.tenant.name}"
```

#### 4.5 `apps/customers/models.py`

**Linea 5 — import:**

```python
# ANTES:
from django.contrib.auth.models import User

# DESPUES:
from django.conf import settings
```

**Linea 28 — `Customer.user` OneToOneField:**

```python
# ANTES:
user = models.OneToOneField(
    User,
    on_delete=models.SET_NULL,
    ...
)

# DESPUES:
user = models.OneToOneField(
    settings.AUTH_USER_MODEL,
    on_delete=models.SET_NULL,
    ...
)
```

#### 4.6 `apps/mechanics/views.py`

**Linea 16 — import:**

```python
# ANTES:
from django.contrib.auth.models import User, Group

# DESPUES:
from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group
User = get_user_model()
```

**Linea 101 — `User.objects.create_user(username=...)`:**

```python
# ANTES:
user = User.objects.create_user(
    username=data['username'],
    password=data['password'],
    first_name=data['first_name'],
    last_name=data['last_name'],
    email=data['email'],
    is_staff=False,
    is_active=True,
)

# DESPUES:
user = User.objects.create_user(
    email=data['email'],
    password=data['password'],
    first_name=data['first_name'],
    last_name=data['last_name'],
    is_staff=False,
    is_active=True,
)
```

**Linea 142 — log con `user.username`:**

```python
# ANTES:
logger.info(f"✅ TenantUser creado: {user.username} → {tenant.name}")

# DESPUES:
logger.info(f"✅ TenantUser creado: {user.email} → {tenant.name}")
```

#### 4.7 `apps/mechanics/serializers.py`

**Linea 59 — `UserSerializer.Meta.fields`:**

```python
# ANTES:
fields = ['id', 'username', 'first_name', 'last_name', 'email']

# DESPUES:
fields = ['id', 'email', 'first_name', 'last_name']
```

**Lineas 88-90 y 131-133 — `get_full_name` fallback:**

```python
# ANTES:
return name if name else obj.user.username

# DESPUES (ambas ocurrencias):
return name if name else obj.user.email
```

**Linea 169 y 178 — `username` SerializerMethodField:**

```python
# ANTES:
username = serializers.SerializerMethodField()
# ...
fields = ['id', 'employee_id', 'username', 'full_name', ...]

# DESPUES — eliminar el campo username de MechanicDetailSerializer:
# Eliminar la linea: username = serializers.SerializerMethodField()
# Eliminar 'username' de fields
# Eliminar el metodo get_username
```

**Linea 194 — `get_full_name` en MechanicDetailSerializer:**

```python
# ANTES:
return name if name else obj.user.username

# DESPUES:
return name if name else obj.user.email
```

**Linea 230 — `MechanicRegistrationSerializer`:**

```python
# ANTES:
username = serializers.CharField(max_length=150)
# ...
def validate_username(self, value):
    if User.objects.filter(username=value, is_active=True).exists():
        raise serializers.ValidationError("El nombre de usuario ya existe")
    return value

# DESPUES — eliminar campo username completamente:
# Eliminar: username = serializers.CharField(max_length=150)
# Eliminar: def validate_username(self, value): ...
```

**Linea 313 — fallback en `get_mechanic_name`:**

```python
# ANTES:
return obj.mechanic.user.get_full_name() or obj.mechanic.user.username

# DESPUES:
return obj.mechanic.user.get_full_name() or obj.mechanic.user.email
```

#### 4.8 `apps/mechanics/services/mechanic_service.py`

**Linea 5 — import:**

```python
# ANTES:
from django.contrib.auth.models import User

# DESPUES:
from django.contrib.auth import get_user_model
User = get_user_model()
```

**Lineas 25-28 — `create_mechanic` (este metodo no es llamado por las views actuales, pero actualizar de todas formas):**

```python
# ANTES:
if User.objects.filter(username=user_data['username']).exists():
    raise ValidationException("El nombre de usuario ya existe")
user = User.objects.create_user(**user_data)

# DESPUES:
# Eliminar la validacion de username (ya no existe)
# user_data no debe contener 'username'
user = User.objects.create_user(**user_data)
```

#### 4.9 `apps/customers/services/customer_service.py`

**Linea 6 — import:**

```python
# ANTES:
from django.contrib.auth.models import User

# DESPUES:
from django.contrib.auth import get_user_model
User = get_user_model()
```

**Lineas 88-95 — `create_customer_with_user`:**

```python
# ANTES:
user = User.objects.create_user(
    username=user_data.get('username'),
    email=user_data.get('email'),
    password=user_data.get('password'),
    first_name=customer_data.get('first_name'),
    last_name=customer_data.get('last_name'),
)

# DESPUES:
user = User.objects.create_user(
    email=user_data.get('email'),
    password=user_data.get('password'),
    first_name=customer_data.get('first_name'),
    last_name=customer_data.get('last_name'),
)
```

#### 4.10 `apps/tenants/serializers.py`

**`get_user_name` fallback (linea 232):**

```python
# ANTES:
return obj.user.get_full_name() or obj.user.username

# DESPUES:
return obj.user.get_full_name() or obj.user.email
```

#### 4.11 `apps/tenants/admin.py`

```python
# ANTES:
from django.contrib.auth.models import User

# DESPUES:
from django.contrib.auth import get_user_model
User = get_user_model()
```

#### 4.12 `apps/notifications/consumers.py`

**Linea 8 — import:**

```python
# ANTES:
from django.contrib.auth.models import AnonymousUser, User

# DESPUES:
from django.contrib.auth.models import AnonymousUser
from django.contrib.auth import get_user_model
```

Agregar en el cuerpo del metodo `get_user_from_token` (o donde use `User`):

```python
User = get_user_model()
```

#### 4.13 `apps/notifications/admin.py` y `apps/notifications/models.py`

```python
# En cualquier archivo que tenga:
from django.contrib.auth.models import User

# Reemplazar por:
from django.conf import settings
# Y cambiar ForeignKey(User, ...) por ForeignKey(settings.AUTH_USER_MODEL, ...)
```

#### 4.14 `apps/password_reset/models.py`

**Linea 2 — import:**

```python
# ANTES:
from django.contrib.auth.models import User

# DESPUES:
from django.conf import settings
```

**Linea 12 — ForeignKey:**

```python
# ANTES:
user = models.ForeignKey(User, on_delete=models.CASCADE)

# DESPUES:
user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
```

**Linea 24 — `__str__`:**

```python
# ANTES:
return f"{self.user.username} - {self.code}"

# DESPUES:
return f"{self.user.email} - {self.code}"
```

#### 4.15 `apps/notifications/services.py`

```python
# Buscar referencias a User.objects y reemplazar con get_user_model()
# Ejemplo comun:
from django.contrib.auth import get_user_model
User = get_user_model()
```

#### 4.16 `apps/core/backends.py`

Este archivo (`EmailBackend`) queda **obsoleto**. Mantenerlo no causa errores (no esta en `AUTHENTICATION_BACKENDS` ya), pero para limpiar:

```python
# Agregar al inicio del archivo:
# OBSOLETO: Reemplazado por apps.accounts.backends.TenantEmailBackend (spec_09)
# Este archivo se conserva para referencia historica.
```

#### 4.17 `apps/core/middleware.py`

Buscar referencias a `User` y reemplazar por `get_user_model()`:

```python
# Si importa:
from django.contrib.auth.models import User
# Reemplazar por:
from django.contrib.auth import get_user_model
```

#### 4.18 `apps/core/mixins.py` y `apps/core/utils.py`

Mismo patron: reemplazar `from django.contrib.auth.models import User` por `get_user_model()`.

#### 4.19 `apps/core/views.py` — eliminar import directo

```python
# El import al inicio de GoogleAuthView:
from django.contrib.auth.models import User as DjangoUser
# eliminar (aparece como import local dentro de metodo)
```

### Verificacion Fase 4

```bash
docker compose -f docker-compose.local.yml exec web python -c "
import django
django.setup()
# Verificar que no queden imports directos a auth.User en produccion
import subprocess
result = subprocess.run(
    ['grep', '-rn', 'from django.contrib.auth.models import User', 'apps/',
     '--include=*.py',
     '--exclude-dir=migrations',
     '--exclude=backends.py'],  # backends.py conservado
    capture_output=True, text=True
)
if result.stdout.strip():
    print('ADVERTENCIA — imports directos restantes:')
    print(result.stdout)
else:
    print('OK: Sin imports directos a auth.User')
"
```

---

### Fase 5 — Actualizar conftest y factories

#### 5.1 `conftest.py` — `UserFactory`

```python
# ANTES:
from django.contrib.auth.models import User

class UserFactory(DjangoModelFactory):
    class Meta:
        model = User
        skip_postgeneration_save = True

    username = factory.LazyAttribute(lambda _: fake.user_name())
    email = factory.LazyAttribute(lambda _: fake.email())
    first_name = factory.LazyAttribute(lambda _: fake.first_name())
    last_name = factory.LazyAttribute(lambda _: fake.last_name())
    is_active = True

# DESPUES:
from django.contrib.auth import get_user_model

class UserFactory(DjangoModelFactory):
    class Meta:
        model = 'accounts.User'  # string reference evita import circular
        skip_postgeneration_save = True

    # SIN username
    email = factory.LazyAttribute(lambda _: fake.email())
    first_name = factory.LazyAttribute(lambda _: fake.first_name())
    last_name = factory.LazyAttribute(lambda _: fake.last_name())
    is_active = True
```

**Modificar `admin_user` fixture — quitar `is_superuser=True` si no se necesita para tests, o mantenerlo:**

No requiere cambios de logica, pero verificar que `UserFactory()` no pase `username`.

#### 5.2 `conftest.py` — eliminar import de `django.contrib.auth.models.User`

```python
# ANTES (linea 14):
from django.contrib.auth.models import User

# DESPUES — eliminar esta linea (ya no se usa directamente)
```

#### 5.3 Tests que usan `username` como campo de login

Archivo: `apps/core/tests/test_jwt_login.py`

Todos los tests pasan `{'username': user.email, 'password': ...}`. El `CustomJWTLoginView` seguira aceptando el campo `username` como alias de `email` (ver cambio en 4.1), pero lo ideal es actualizarlos gradualmente a `{'email': ..., 'tenant_slug': ...}`.

Por ahora, en `CustomJWTLoginView`:

```python
email = request.data.get('email') or request.data.get('username', '')
```

Esto mantiene compatibilidad con los tests existentes sin romperlos.

**Actualizar fixtures locales en `test_jwt_login.py`:**

```python
# ANTES:
@pytest.fixture
def user_with_tenant(db, tenant):
    from conftest import UserFactory, TenantUserFactory
    user = UserFactory(password='testpass123')
    TenantUserFactory(user=user, tenant=tenant, role='admin', is_current=True)
    return user

# El test envia: {'username': user_with_tenant.email, 'password': 'testpass123'}
# Esto seguira funcionando porque CustomJWTLoginView acepta 'username' como alias.
# ADEMAS agregar tenant_slug al body para que TenantEmailBackend funcione:

@pytest.fixture
def user_with_tenant(db, tenant):
    from conftest import UserFactory, TenantUserFactory
    user = UserFactory(password='testpass123')
    TenantUserFactory(user=user, tenant=tenant, role='admin', is_current=True)
    return user

# Y en cada test que hace POST a /api/auth/login/:
response = client.post(
    '/api/auth/login/',
    {
        'email': user_with_tenant.email,
        'password': 'testpass123',
        'tenant_slug': tenant.slug,      # <-- AGREGAR
    },
    format='json',
)
```

### Verificacion Fase 5

```bash
docker compose -f docker-compose.local.yml exec web bash -c "
DJANGO_SETTINGS_MODULE=config.settings.testing pytest conftest.py --collect-only -q 2>&1 | head -20
"
```

---

### Fase 6 — Tests de la nueva funcionalidad

#### 6.1 Crear `apps/accounts/tests/test_custom_user.py`

```python
"""
Tests para apps/accounts — Custom User Model y TenantEmailBackend.

pytest apps/accounts/tests/test_custom_user.py -v
"""
import pytest
from django.contrib.auth import get_user_model, authenticate

User = get_user_model()


# ─────────────────────────────────────────────────────────────────────────────
# Fixtures
# ─────────────────────────────────────────────────────────────────────────────

@pytest.fixture
def tenant_a(db):
    from conftest import TenantFactory
    return TenantFactory(slug='tenant-a')


@pytest.fixture
def tenant_b(db):
    from conftest import TenantFactory
    return TenantFactory(slug='tenant-b')


@pytest.fixture
def user_tenant_a(db, tenant_a):
    """Usuario en tenant A con contraseña 'pass-a'."""
    from conftest import TenantUserFactory
    user = User.objects.create_user(
        email='shared@example.com',
        password='pass-a',
        first_name='Juan',
        last_name='En A',
    )
    from apps.tenants.models import TenantUser
    TenantUser.objects.create(user=user, tenant=tenant_a, role='admin', is_current=True)
    return user


@pytest.fixture
def user_tenant_b(db, tenant_b):
    """Usuario en tenant B con contraseña 'pass-b' (mismo email que A)."""
    user = User.objects.create_user(
        email='shared@example.com',
        password='pass-b',
        first_name='Pedro',
        last_name='En B',
    )
    from apps.tenants.models import TenantUser
    TenantUser.objects.create(user=user, tenant=tenant_b, role='admin', is_current=True)
    return user


# ─────────────────────────────────────────────────────────────────────────────
# Tests del modelo User
# ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.django_db
class TestCustomUserModel:

    def test_crear_usuario_sin_username(self, db):
        """User no tiene campo username."""
        user = User.objects.create_user(email='nouser@test.com', password='pass123')
        assert not hasattr(user, 'username'), "username no debe existir en el modelo"
        assert user.email == 'nouser@test.com'

    def test_superuser_sin_username(self, db):
        """create_superuser funciona sin username."""
        su = User.objects.create_superuser(email='admin@test.com', password='admin123')
        assert su.is_superuser is True
        assert su.is_staff is True
        assert not hasattr(su, 'username')

    def test_username_field_es_email(self, db):
        """USERNAME_FIELD debe ser 'email'."""
        assert User.USERNAME_FIELD == 'email'

    def test_required_fields_vacio(self, db):
        """REQUIRED_FIELDS no debe incluir nada extra."""
        assert User.REQUIRED_FIELDS == []

    def test_get_full_name_con_datos(self, db):
        """get_full_name retorna 'first last'."""
        user = User.objects.create_user(
            email='full@test.com', password='x', first_name='Juan', last_name='Perez'
        )
        assert user.get_full_name() == 'Juan Perez'

    def test_get_full_name_fallback_email(self, db):
        """get_full_name retorna email si no hay nombre."""
        user = User.objects.create_user(email='only@email.com', password='x')
        assert user.get_full_name() == 'only@email.com'


# ─────────────────────────────────────────────────────────────────────────────
# Tests del backend TenantEmailBackend
# ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.django_db
class TestTenantEmailBackend:

    def test_mismo_email_dos_tenants_contraseñas_independientes(
        self, user_tenant_a, user_tenant_b, tenant_a, tenant_b
    ):
        """El mismo email puede existir en dos tenants con contraseñas distintas."""
        result_a = authenticate(
            request=None,
            email='shared@example.com',
            password='pass-a',
            tenant_slug='tenant-a',
        )
        result_b = authenticate(
            request=None,
            email='shared@example.com',
            password='pass-b',
            tenant_slug='tenant-b',
        )
        assert result_a is not None, "Debe autenticar en tenant A con pass-a"
        assert result_b is not None, "Debe autenticar en tenant B con pass-b"
        assert result_a.id != result_b.id, "Deben ser usuarios distintos"

    def test_contraseña_tenant_a_no_funciona_en_tenant_b(
        self, user_tenant_a, user_tenant_b
    ):
        """La contraseña de tenant A no sirve para autenticar en tenant B."""
        result = authenticate(
            request=None,
            email='shared@example.com',
            password='pass-a',       # password de A
            tenant_slug='tenant-b',  # intentando en B
        )
        assert result is None, "No debe autenticar con contraseña del tenant equivocado"

    def test_login_sin_tenant_slug_retorna_none(self, user_tenant_a):
        """Autenticacion sin tenant_slug siempre retorna None."""
        result = authenticate(
            request=None,
            email='shared@example.com',
            password='pass-a',
            # Sin tenant_slug
        )
        assert result is None

    def test_login_contraseña_incorrecta_retorna_none(self, user_tenant_a, tenant_a):
        """Contraseña incorrecta retorna None."""
        result = authenticate(
            request=None,
            email='shared@example.com',
            password='contraseña-mala',
            tenant_slug='tenant-a',
        )
        assert result is None

    def test_tenant_email_backend_autentica_correctamente(self, user_tenant_a, tenant_a):
        """Backend autentica con email + password + tenant_slug correctos."""
        result = authenticate(
            request=None,
            email='shared@example.com',
            password='pass-a',
            tenant_slug='tenant-a',
        )
        assert result is not None
        assert result.email == 'shared@example.com'
        assert result.id == user_tenant_a.id

    def test_login_email_inexistente_retorna_none(self, tenant_a):
        """Email que no existe en ningun tenant retorna None."""
        result = authenticate(
            request=None,
            email='noexiste@test.com',
            password='cualquier',
            tenant_slug='tenant-a',
        )
        assert result is None

    def test_login_tenant_inexistente_retorna_none(self, user_tenant_a):
        """Tenant que no existe retorna None."""
        result = authenticate(
            request=None,
            email='shared@example.com',
            password='pass-a',
            tenant_slug='no-existe',
        )
        assert result is None
```

### Verificacion Fase 6

```bash
docker compose -f docker-compose.local.yml exec web bash -c "
DJANGO_SETTINGS_MODULE=config.settings.testing pytest apps/accounts/tests/test_custom_user.py -v --override-ini='addopts='
"
```

Todos los tests deben pasar (7 tests).

---

### Fase 7 — Verificacion E2E

#### 7.1 Verificar login desde la API

```bash
# Crear usuario de prueba
docker compose -f docker-compose.local.yml exec web python manage.py shell -c "
from apps.accounts.models import User
from apps.tenants.models import Tenant, TenantUser

tenant = Tenant.objects.create(
    name='Taller E2E',
    slug='taller-e2e',
    owner_name='Test',
    owner_email='owner@e2e.com',
    plan='free',
)
user = User.objects.create_user(email='test@e2e.com', password='test123')
TenantUser.objects.create(user=user, tenant=tenant, role='admin', is_current=True)
print(f'Creado: user_id={user.id}, tenant_slug={tenant.slug}')
"

# Llamar al endpoint de login
curl -s -X POST http://localhost:8000/api/auth/login/ \
  -H 'Content-Type: application/json' \
  -d '{
    "email": "test@e2e.com",
    "password": "test123",
    "tenant_slug": "taller-e2e"
  }' | python -m json.tool
```

Resultado esperado:

```json
{
    "access": "<token>",
    "refresh": "<token>",
    "user_id": <id>,
    "email": "test@e2e.com",
    "name": "test@e2e.com",
    "role": "admin",
    "tenant": {
        "id": <id>,
        "name": "Taller E2E",
        "slug": "taller-e2e",
        ...
    }
}
```

#### 7.2 Verificar mismo email en dos tenants

```bash
docker compose -f docker-compose.local.yml exec web python manage.py shell -c "
from apps.accounts.models import User
from apps.tenants.models import Tenant, TenantUser
from django.contrib.auth import authenticate

# Crear tenant B
tenant_b = Tenant.objects.create(
    name='Taller B', slug='taller-b',
    owner_name='Test B', owner_email='b@b.com', plan='free',
)

# Mismo email, contrasena diferente
user_b = User.objects.create_user(email='test@e2e.com', password='otro-pass')
TenantUser.objects.create(user=user_b, tenant=tenant_b, role='admin', is_current=True)

# Autenticar en cada tenant
r_a = authenticate(request=None, email='test@e2e.com', password='test123', tenant_slug='taller-e2e')
r_b = authenticate(request=None, email='test@e2e.com', password='otro-pass', tenant_slug='taller-b')

assert r_a is not None, 'FALLO: No autentico en taller-e2e'
assert r_b is not None, 'FALLO: No autentico en taller-b'
assert r_a.id != r_b.id, 'FALLO: Son el mismo user, deben ser distintos'

print(f'OK: user_a.id={r_a.id}, user_b.id={r_b.id}')
print('PASS: Mismo email, contrasenas independientes por tenant')
"
```

#### 7.3 Ejecutar suite completa de tests

```bash
docker compose -f docker-compose.local.yml exec web bash -c "
DJANGO_SETTINGS_MODULE=config.settings.testing pytest \
  apps/accounts/tests/ \
  apps/core/tests/test_jwt_login.py \
  -v --override-ini='addopts='
"
```

---

## 4. Archivos a modificar (tabla completa)

| Archivo | Tipo de cambio | Detalle |
|---------|---------------|---------|
| `apps/accounts/models.py` | Nuevo | Custom User Model |
| `apps/accounts/backends.py` | Nuevo | TenantEmailBackend |
| `apps/accounts/admin.py` | Nuevo | Admin para accounts.User |
| `apps/accounts/apps.py` | Nuevo | AppConfig |
| `apps/accounts/tests/test_custom_user.py` | Nuevo | 7 tests |
| `config/settings/base.py` | Modificar | AUTH_USER_MODEL, AUTHENTICATION_BACKENDS, SILENCED_SYSTEM_CHECKS, INSTALLED_APPS |
| `apps/core/views.py` | Modificar | authenticate() con email+tenant_slug, eliminar username, get_user_model |
| `apps/core/backends.py` | Comentar | Marcar como obsoleto |
| `apps/tenants/models.py` | Modificar | ForeignKey a AUTH_USER_MODEL, __str__ sin username |
| `apps/tenants/views.py` | Modificar | get_user_model(), create_user sin username |
| `apps/tenants/serializers.py` | Modificar | get_full_name fallback sin username |
| `apps/tenants/admin.py` | Modificar | get_user_model() |
| `apps/customers/models.py` | Modificar | OneToOneField a AUTH_USER_MODEL |
| `apps/customers/services/customer_service.py` | Modificar | get_user_model(), create_user sin username |
| `apps/mechanics/views.py` | Modificar | get_user_model(), create_user sin username |
| `apps/mechanics/serializers.py` | Modificar | Eliminar username de fields y validate_username |
| `apps/mechanics/services/mechanic_service.py` | Modificar | get_user_model(), eliminar validacion username |
| `apps/notifications/consumers.py` | Modificar | get_user_model() |
| `apps/notifications/admin.py` | Modificar | get_user_model() o AUTH_USER_MODEL |
| `apps/notifications/models.py` | Modificar | ForeignKey a AUTH_USER_MODEL |
| `apps/notifications/services.py` | Modificar | get_user_model() |
| `apps/password_reset/models.py` | Modificar | ForeignKey a AUTH_USER_MODEL, __str__ sin username |
| `apps/password_reset/views.py` | Modificar | get_user_model(), create_user sin username, eliminar logica de user existente |
| `apps/core/middleware.py` | Verificar/Modificar | get_user_model() si referencia User directamente |
| `apps/core/mixins.py` | Verificar/Modificar | get_user_model() si referencia User directamente |
| `apps/core/utils.py` | Verificar/Modificar | get_user_model() si referencia User directamente |
| `conftest.py` | Modificar | UserFactory sin username, model='accounts.User' |
| `apps/core/tests/test_jwt_login.py` | Modificar | Agregar tenant_slug al body del login |
| `Makefile` | Agregar | Target test-spec09 |

---

## 5. Comandos reset BD

```bash
# 1. Bajar servicios y eliminar volumen de datos
cd /home/yadhir/Documentos/vps/tallerv2/backend-taller-pro
docker compose -f docker-compose.local.yml down -v

# 2. Borrar archivos de migracion (conservar __init__.py)
find apps -path "*/migrations/0*.py" -delete

# 3. Verificar que solo queden __init__.py
find apps -path "*/migrations/*.py" | sort

# 4. Levantar DB y Redis primero
docker compose -f docker-compose.local.yml up -d db redis

# 5. Esperar que Postgres este listo (verificar con logs)
docker compose -f docker-compose.local.yml logs db | tail -5

# 6. Levantar web
docker compose -f docker-compose.local.yml up -d web

# 7. Generar migraciones en orden
docker compose -f docker-compose.local.yml exec web python manage.py makemigrations accounts
docker compose -f docker-compose.local.yml exec web python manage.py makemigrations tenants
docker compose -f docker-compose.local.yml exec web python manage.py makemigrations core customers services appointments workshop mechanics inventory notifications password_reset

# 8. Verificar sin migraciones pendientes
docker compose -f docker-compose.local.yml exec web python manage.py makemigrations --check

# 9. Aplicar migraciones
docker compose -f docker-compose.local.yml exec web python manage.py migrate

# 10. Setup de grupos
docker compose -f docker-compose.local.yml exec web python manage.py setup_groups

# 11. Crear superusuario (pedira email y password, NO username)
docker compose -f docker-compose.local.yml exec web python manage.py createsuperuser
```

---

## 6. Tests requeridos

### Archivo: `apps/accounts/tests/test_custom_user.py`

| Test | Clase | Descripcion |
|------|-------|-------------|
| `test_crear_usuario_sin_username` | `TestCustomUserModel` | `User` no tiene campo `username` |
| `test_superuser_sin_username` | `TestCustomUserModel` | `create_superuser` funciona sin `username` |
| `test_username_field_es_email` | `TestCustomUserModel` | `USERNAME_FIELD == 'email'` |
| `test_required_fields_vacio` | `TestCustomUserModel` | `REQUIRED_FIELDS == []` |
| `test_get_full_name_con_datos` | `TestCustomUserModel` | `get_full_name()` retorna nombre completo |
| `test_get_full_name_fallback_email` | `TestCustomUserModel` | Fallback a email si no hay nombre |
| `test_mismo_email_dos_tenants_contraseñas_independientes` | `TestTenantEmailBackend` | Core requirement — dos users, mismo email, passwords distintos |
| `test_contraseña_tenant_a_no_funciona_en_tenant_b` | `TestTenantEmailBackend` | Aislamiento de credenciales |
| `test_login_sin_tenant_slug_retorna_none` | `TestTenantEmailBackend` | Sin tenant_slug = falla |
| `test_login_contraseña_incorrecta_retorna_none` | `TestTenantEmailBackend` | Password incorrecto = falla |
| `test_tenant_email_backend_autentica_correctamente` | `TestTenantEmailBackend` | Happy path |
| `test_login_email_inexistente_retorna_none` | `TestTenantEmailBackend` | Email que no existe |
| `test_login_tenant_inexistente_retorna_none` | `TestTenantEmailBackend` | Tenant que no existe |

---

## 7. Checklist

### Preparacion
- [ ] Confirmar que no hay datos reales en produccion
- [ ] Hacer backup de la estructura actual (opcional, no hay datos)

### Fase 1 — app accounts
- [ ] Crear estructura de directorios
- [ ] `apps/accounts/apps.py` creado
- [ ] `apps/accounts/models.py` con `User(AbstractBaseUser)` sin `username`
- [ ] `apps/accounts/backends.py` con `TenantEmailBackend`
- [ ] `apps/accounts/admin.py` con `UserAdmin`
- [ ] Verificacion Fase 1 pasa

### Fase 2 — Settings
- [ ] `AUTH_USER_MODEL = 'accounts.User'` en `base.py`
- [ ] `AUTHENTICATION_BACKENDS = ['apps.accounts.backends.TenantEmailBackend']` en `base.py`
- [ ] `SILENCED_SYSTEM_CHECKS = ['auth.W004']` en `base.py`
- [ ] `'apps.accounts'` agregado a `INSTALLED_APPS` antes de `apps.core`
- [ ] Backend `EmailBackend` removido de `AUTHENTICATION_BACKENDS`
- [ ] Verificacion Fase 2 pasa

### Fase 3 — Reset BD
- [ ] `docker compose down -v` ejecutado
- [ ] Migraciones `0*.py` borradas de todas las apps
- [ ] Contenedores levantados nuevamente
- [ ] `makemigrations accounts` generado primero
- [ ] `makemigrations tenants` generado segundo
- [ ] Resto de apps migradas
- [ ] `--check` sin pendientes
- [ ] `migrate` aplicado exitosamente
- [ ] `setup_groups` ejecutado
- [ ] `createsuperuser` creado (pide solo email, no username)
- [ ] Verificacion Fase 3 pasa

### Fase 4 — Codigo existente
- [ ] `apps/core/views.py` — `authenticate(email=, tenant_slug=)`
- [ ] `apps/core/views.py` — sin referencias a `user.username`
- [ ] `apps/core/views.py` — `GoogleAuthView` sin generacion de username
- [ ] `apps/tenants/models.py` — `ForeignKey(settings.AUTH_USER_MODEL)`
- [ ] `apps/tenants/views.py` — `create_user` sin `username=`
- [ ] `apps/customers/models.py` — `OneToOneField(settings.AUTH_USER_MODEL)`
- [ ] `apps/customers/services/customer_service.py` — sin `username=`
- [ ] `apps/mechanics/views.py` — sin `username=` en create_user
- [ ] `apps/mechanics/serializers.py` — `username` eliminado de fields y validators
- [ ] `apps/mechanics/services/mechanic_service.py` — sin validacion de username
- [ ] `apps/password_reset/models.py` — `ForeignKey(settings.AUTH_USER_MODEL)`
- [ ] `apps/password_reset/views.py` — sin `username=` en create_user
- [ ] `apps/notifications/consumers.py` — `get_user_model()`
- [ ] `apps/notifications/models.py` — `AUTH_USER_MODEL`
- [ ] Verificacion Fase 4 pasa

### Fase 5 — conftest
- [ ] `UserFactory` sin campo `username`
- [ ] `UserFactory.Meta.model = 'accounts.User'`
- [ ] Import `from django.contrib.auth.models import User` eliminado de `conftest.py`
- [ ] Tests de login actualizados con `tenant_slug`
- [ ] Verificacion Fase 5 pasa

### Fase 6 — Tests
- [ ] `apps/accounts/tests/test_custom_user.py` creado
- [ ] 13 tests pasan al 100%
- [ ] Verificacion Fase 6 pasa

### Fase 7 — E2E
- [ ] Login via curl retorna access token
- [ ] Mismo email en dos tenants con passwords distintos funciona
- [ ] Suite completa de tests pasa

---

## 8. Rollback

No aplica: se decidio que no hay datos reales en produccion y la migracion se hace antes de que entren datos reales (2026-03-17).

Si por algun motivo se necesita revertir a `auth.User`:

1. Restaurar `AUTH_USER_MODEL` a `auth.User` en `base.py`
2. Restaurar `AUTHENTICATION_BACKENDS` a `['apps.core.backends.EmailBackend']`
3. Borrar `apps/accounts/`
4. Eliminar `'apps.accounts'` de `INSTALLED_APPS`
5. Revertir todos los cambios de la Fase 4 (restituir `from django.contrib.auth.models import User`)
6. Reset BD y migraciones nuevamente

---

## Makefile

Agregar al `Makefile` existente el siguiente target:

```makefile
# WEB debe estar definido previamente, ejemplo:
# WEB = docker compose -f docker-compose.local.yml exec web

test-spec09:
	$(WEB) bash -c "DJANGO_SETTINGS_MODULE=config.settings.testing pytest apps/accounts/tests/ -v --override-ini='addopts='"
```

---

## Notas de implementacion importantes

### Por que `email` no tiene `unique=True` en el modelo `User`

La unicidad `(email, tenant)` esta garantizada por `TenantEmailBackend`: busca `TenantUser.objects.get(user__email=email, tenant__slug=tenant_slug)`. Si dos users con el mismo email existen, ambos tendran `TenantUser` en tenants distintos. El `get()` es por `tenant__slug`, por lo que nunca hay ambiguedad.

Un `UniqueConstraint(fields=['email'])` en `User` rompe el requisito. No se agrega.

### Por que `TenantUser.unique_together = ['user', 'tenant']` se mantiene

Esto garantiza que un `User` especifico no pueda pertenecer dos veces al mismo tenant. Es correcto y no cambia.

### Compatibilidad con `Customer.user = OneToOneField`

Antes: un `auth.User` global podia tener un solo `Customer` por limitacion del `OneToOneField`. Ahora: cada `User` es por tenant, entonces el mismo email tiene un `User` distinto en cada tenant, y cada `User` puede tener su `Customer` vinculado. El `OneToOneField` sigue funcionando correctamente.

### `SILENCED_SYSTEM_CHECKS = ['auth.W004']`

Django emite la advertencia `auth.W004` cuando `USERNAME_FIELD` no tiene `unique=True`. En nuestro caso es intencional (el email no es unico globalmente). Silenciar el check es correcto.

### `TenantRegistrationView` en `tenants/views.py`

Con el nuevo modelo, la validacion `User.objects.filter(email=email).exists()` (linea 76) ya no tiene sentido como "email ya registrado globalmente". Se elimina. Si el mismo email ya existe en otro tenant, eso es valido. La validacion que si aplica es: verificar que no exista ya un `TenantUser` con ese email en ESTE tenant especifico (lo cual es imposible porque el tenant aun no existe al momento del registro).
