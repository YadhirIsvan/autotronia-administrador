# spec_11 — Impacto de la migración Customer.user a ForeignKey (customer_profiles)

**Estado:** Completado
**Fecha:** 2026-03-20
**Prioridad:** Alta — Bug regresivo que rompe el panel completo de clientes

---

## 1. Problema

El modelo `Customer.user` fue migrado de `OneToOneField` (related_name `customer_profile`) a
`ForeignKey` (related_name `customer_profiles`). Esto es correcto para soportar multi-tenant:
un mismo usuario puede ser cliente en distintos talleres.

Sin embargo, el accessor en `request.user` cambió de comportamiento:

| Antes (OneToOneField) | Ahora (ForeignKey) |
|-----------------------|--------------------|
| `request.user.customer_profile` | `request.user.customer_profiles` |
| Devuelve objeto `Customer` directo | Devuelve `RelatedManager` |
| `AttributeError` si no existe | `.exists()` / `.filter()` / `.first()` |

Cualquier código que todavía use el nombre en singular (`customer_profile` como atributo de
acceso directo) produce `AttributeError` o `RelatedObjectDoesNotExist`, que los permisos
capturan silenciosamente y convierten en 403.

La migración de BD está correctamente aplicada en
`0002_alter_customer_unique_together_alter_customer_user_and_more.py`.
El problema es exclusivamente de **código Python** que no fue actualizado.

---

## 2. Inventario exhaustivo de referencias

### 2.1 Archivos de código activo

El siguiente análisis es el resultado de buscar `customer_profile[^s]` en todos los `.py` del
backend al 2026-03-20.

| Archivo | Línea | Texto actual | Estado |
|---------|-------|-------------|--------|
| `shared/permissions.py` | 9 | Comentario del docstring (`- customer_profile → Clientes`) | Cosmético — sin impacto funcional |
| `shared/permissions.py` | 21-33 | `IsCustomer.has_permission` | ✅ DONE — ya usa `customer_profiles.filter(tenant=...).exists()` |
| `shared/permissions.py` | 316 | `CanManageVehicles.has_permission` | ✅ DONE — ya usa `customer_profiles.exists()` |
| `shared/permissions.py` | 345 | `CanManageVehicles.has_object_permission` | ✅ DONE — ya usa `customer_profiles.exists()` |
| `apps/core/views.py` | 88 | Comentario (`3. customer_profile -> role = customer`) | Cosmético — sin impacto funcional |
| `apps/core/views.py` | 197-201 | `customer_profile = user.customer_profiles.filter(...)` | ✅ Correcto — ya usa el RelatedManager |
| `apps/core/views.py` | 463-467 | `customer_profile = user.customer_profiles.filter(...)` | ✅ Correcto — ya usa el RelatedManager |
| `apps/workshop/views.py` | 62 | `customer = self.request.user.customer_profiles.filter(...)` | ✅ Correcto |
| `apps/workshop/views.py` | 437 | `customer = request.user.customer_profiles.filter(...)` | ✅ Correcto |
| `apps/customers/views.py` | 309 | `customer = self.request.user.customer_profiles.filter(...)` | ✅ Correcto |
| `apps/appointments/views.py` | 80 | `customer = self.request.user.customer_profiles.filter(...)` | ✅ Correcto |
| `apps/customers/models.py` | 35 | `related_name='customer_profiles'` — definición del modelo | ✅ Correcto (es la fuente de verdad) |
| `apps/customers/services/customer_service.py` | 191 | `def update_customer_profile(self, user, data, tenant=None)` | ✅ Es nombre de método, no accessor de FK — sin impacto |

**Conclusion: No quedan referencias activas a `customer_profile` (singular) como accessor
de RelatedManager en código de producción.**

### 2.2 Migraciones (referencia histórica, no modificar)

| Archivo | Línea | Contenido |
|---------|-------|-----------|
| `apps/customers/migrations/0001_initial.py` | 44 | `related_name='customer_profile'` — refleja el estado ANTES de la migración. Es correcto que quede así (es historia). |
| `apps/customers/migrations/0002_...py` | 24 | `related_name='customer_profiles'` — refleja el estado DESPUÉS. Correcto. |

**No se deben modificar los archivos de migración.**

### 2.3 Documentación (no es código activo)

| Archivo | Líneas | Descripción |
|---------|--------|-------------|
| `TALLER_PRO_EXPORT.md` | 2462, 2485, 5705, 6070, 10459 | Referencias obsoletas al accessor singular. Solo documentación generada, no afecta ejecución. |

---

## 3. Estado de los comentarios cosmético (acción opcional)

Los siguientes comentarios son imprecisos pero no causan errores. Pueden actualizarse
en el mismo PR de los tests para mantener consistencia documental:

**`shared/permissions.py` línea 9:**
```python
# Antes:
   - customer_profile → Clientes
# Después:
   - customer_profiles (RelatedManager) → Clientes
```

**`apps/core/views.py` línea 88:**
```python
# Antes:
    3. customer_profile -> role = customer
# Después:
    3. customer_profiles (ForeignKey) -> role = customer
```

---

## 4. Tests existentes relacionados

### 4.1 Tests que cubren permisos de cliente (IsCustomer, CanManageVehicles)

Ningún test existente cubre directamente `IsCustomer` ni `CanManageVehicles`.

Los tests de permisos actuales están en:
- `apps/core/tests/test_auth_roles.py` — cubre roles `owner`, `admin`, `mechanic`,
  `advisor`, pero **no cubre el rol `customer`**
- `apps/customers/tests/test_api.py` — cubre CRUD de Customer/Vehicle pero usando
  `authenticated_client` que es un `admin_user`, no un usuario con rol `customer`
- `apps/customers/tests/test_models.py` — pruebas de modelo puro, sin permisos

### 4.2 Fixtures disponibles (conftest.py)

- `CustomerFactory` — crea `Customer` sin `user` asignado (campo opcional)
- `UserFactory` — crea `User` (custom model, sin username)
- `TenantUserFactory` — crea la relación User-Tenant
- No existe un fixture `customer_user` (usuario que es cliente en un tenant)

---

## 5. Plan de implementación

### Paso 1 — Comentarios cosméticos ✅ DONE

Actualizar los dos comentarios identificados en sección 3.

Archivos:
- `/home/yadhir/Documentos/vps/tallerv2/backend-taller-pro/shared/permissions.py` línea 9
- `/home/yadhir/Documentos/vps/tallerv2/backend-taller-pro/apps/core/views.py` línea 88

### Paso 2 — Agregar fixture `customer_user` al conftest global ✅ DONE

**Archivo:** `/home/yadhir/Documentos/vps/tallerv2/backend-taller-pro/conftest.py`

Agregar después del fixture `customer` (línea ~410):

```python
@pytest.fixture
def customer_user(db, tenant):
    """
    Usuario que es cliente en el tenant de prueba.
    Simula el caso de uso del panel de clientes:
    - User autenticado con JWT
    - Customer.user = ese usuario (ForeignKey a customer_profiles)
    - TenantUser con role='member'
    """
    from apps.tenants.models import TenantUser

    user = UserFactory(password='testpass123')
    # Crear el perfil de cliente vinculado al usuario en ese tenant
    customer = CustomerFactory(tenant=tenant, user=user)
    # Registrar la relación User-Tenant
    TenantUser.objects.create(
        user=user,
        tenant=tenant,
        role='member',
        is_current=True
    )
    return user, customer


@pytest.fixture
def customer_api_client(db, customer_user, tenant):
    """
    APIClient autenticado como cliente (rol customer).
    Inyecta Bearer token + X-Tenant-ID del tenant del cliente.
    """
    from rest_framework_simplejwt.tokens import RefreshToken as JWTRefreshToken
    user, _customer = customer_user
    refresh = JWTRefreshToken.for_user(user)
    access = str(refresh.access_token)
    client = APIClient()
    client.credentials(
        HTTP_AUTHORIZATION=f'Bearer {access}',
        HTTP_X_TENANT_ID=tenant.slug
    )
    return client
```

### Paso 3 — Crear archivo de tests de permisos de cliente ✅ DONE

**Archivo nuevo:** `/home/yadhir/Documentos/vps/tallerv2/backend-taller-pro/apps/customers/tests/test_customer_permissions.py`

Ver sección 6 para el código completo de los tests.

### Paso 4 — Ejecutar los tests y verificar que pasan ✅ DONE — 13/13 passed

```bash
cd /home/yadhir/Documentos/vps/tallerv2/backend-taller-pro
pytest apps/customers/tests/test_customer_permissions.py -v
```

### Paso 5 — Actualizar comentarios cosméticos ✅ DONE

---

## 6. Plan de pruebas — Código completo

**Archivo:** `apps/customers/tests/test_customer_permissions.py`

```python
"""
Tests de permisos para el rol customer.

Cubre la migración Customer.user de OneToOneField a ForeignKey:
  - related_name cambió de 'customer_profile' a 'customer_profiles'
  - IsCustomer debe usar customer_profiles.filter(tenant=...).exists()
  - CanManageVehicles debe permitir clientes para sus propios vehículos

Estos tests previenen regresión del bug: 403 en panel de clientes
tras cambio a ForeignKey multi-tenant.
"""
import pytest
from rest_framework import status
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import RefreshToken as JWTRefreshToken

pytestmark = [pytest.mark.django_db, pytest.mark.api]


# =============================================================================
# Fixtures locales
# =============================================================================

@pytest.fixture
def customer_with_user(db, tenant):
    """
    Devuelve (user, customer): un usuario autenticado que es cliente
    en 'tenant'. Simula el caso de panel de clientes.
    """
    from conftest import UserFactory, CustomerFactory
    from apps.tenants.models import TenantUser

    user = UserFactory()
    customer = CustomerFactory(tenant=tenant, user=user)
    TenantUser.objects.create(
        user=user,
        tenant=tenant,
        role='member',
        is_current=True
    )
    return user, customer


@pytest.fixture
def client_as_customer(customer_with_user, tenant):
    """APIClient autenticado como cliente."""
    user, _customer = customer_with_user
    refresh = JWTRefreshToken.for_user(user)
    client = APIClient()
    client.credentials(
        HTTP_AUTHORIZATION=f'Bearer {str(refresh.access_token)}',
        HTTP_X_TENANT_ID=tenant.slug
    )
    return client


# =============================================================================
# Tests de IsCustomer
# =============================================================================

class TestIsCustomerPermission:
    """
    Verifica que IsCustomer.has_permission funciona correctamente
    con la nueva estructura ForeignKey (customer_profiles RelatedManager).
    """

    def test_customer_user_can_access_customer_panel(
        self, client_as_customer
    ):
        """
        Un usuario con Customer.user = ese usuario puede acceder
        al endpoint GET /api/customers/me/ (panel propio).

        Regresión: antes fallaba con 403 porque el código buscaba
        request.user.customer_profile (singular, OneToOneField).
        """
        response = client_as_customer.get('/api/customers/me/')
        assert response.status_code == status.HTTP_200_OK, (
            f"Cliente con customer_profiles válido recibió {response.status_code}. "
            f"Posible regresión a customer_profile singular."
        )

    def test_non_customer_user_cannot_access_customer_panel(
        self, db, tenant
    ):
        """
        Un usuario autenticado sin Customer vinculado recibe 403
        al intentar acceder al panel de cliente.
        """
        from conftest import UserFactory, TenantUserFactory
        user = UserFactory()
        TenantUserFactory(user=user, tenant=tenant, role='member', is_current=True)

        refresh = JWTRefreshToken.for_user(user)
        client = APIClient()
        client.credentials(
            HTTP_AUTHORIZATION=f'Bearer {str(refresh.access_token)}',
            HTTP_X_TENANT_ID=tenant.slug
        )

        response = client.get('/api/customers/me/')
        assert response.status_code == status.HTTP_403_FORBIDDEN

    def test_unauthenticated_cannot_access_customer_panel(self, api_client):
        """Usuario no autenticado recibe 401."""
        response = api_client.get('/api/customers/me/')
        assert response.status_code == status.HTTP_401_UNAUTHORIZED

    def test_is_customer_permission_class_directly_with_tenant(
        self, rf, customer_with_user, tenant
    ):
        """
        Test unitario de IsCustomer.has_permission con tenant en el request.
        Verifica que el filtro por tenant es correcto.
        """
        from shared.permissions import IsCustomer
        from unittest.mock import MagicMock

        user, _customer = customer_with_user
        user.refresh_from_db()

        request = MagicMock()
        request.user = user
        request.user.is_authenticated = True
        request.tenant = tenant

        permission = IsCustomer()
        assert permission.has_permission(request, None) is True

    def test_is_customer_permission_wrong_tenant_returns_false(
        self, rf, customer_with_user, tenant
    ):
        """
        IsCustomer devuelve False si el usuario tiene customer_profile
        pero en un tenant diferente al del request.
        """
        from shared.permissions import IsCustomer
        from conftest import TenantFactory
        from unittest.mock import MagicMock

        user, _customer = customer_with_user  # customer en 'tenant'
        other_tenant = TenantFactory()         # tenant diferente

        request = MagicMock()
        request.user = user
        request.user.is_authenticated = True
        request.tenant = other_tenant          # tenant incorrecto

        permission = IsCustomer()
        assert permission.has_permission(request, None) is False, (
            "IsCustomer no debe dar acceso si el customer_profile "
            "no pertenece al tenant del request."
        )

    def test_user_can_be_customer_in_multiple_tenants(self, db):
        """
        Un usuario puede tener customer_profiles en N tenants.
        IsCustomer devuelve True solo para el tenant correcto.
        Esto prueba la razón del cambio de OneToOneField a ForeignKey.
        """
        from shared.permissions import IsCustomer
        from conftest import UserFactory, TenantFactory, CustomerFactory
        from apps.tenants.models import TenantUser
        from unittest.mock import MagicMock

        user = UserFactory()
        tenant_a = TenantFactory()
        tenant_b = TenantFactory()

        # El mismo usuario es cliente en dos talleres distintos
        CustomerFactory(tenant=tenant_a, user=user)
        CustomerFactory(tenant=tenant_b, user=user)

        permission = IsCustomer()

        for tenant in [tenant_a, tenant_b]:
            request = MagicMock()
            request.user = user
            request.user.is_authenticated = True
            request.tenant = tenant
            assert permission.has_permission(request, None) is True, (
                f"IsCustomer debe dar acceso al tenant {tenant.slug}"
            )


# =============================================================================
# Tests de CanManageVehicles para clientes
# =============================================================================

class TestCanManageVehiclesForCustomer:
    """
    Verifica que CanManageVehicles permite a clientes gestionar
    sus propios vehículos (no los ajenos).
    """

    def test_customer_can_list_their_own_vehicles(
        self, client_as_customer, customer_with_user, vehicle
    ):
        """
        El cliente puede hacer GET /api/vehicles/ y ver sus vehículos.
        """
        _user, customer = customer_with_user
        # 'vehicle' del fixture global puede no pertenecer a este customer.
        # Creamos uno explícito.
        from conftest import VehicleFactory
        my_vehicle = VehicleFactory(owner=customer, tenant=customer.tenant)

        response = client_as_customer.get('/api/vehicles/')
        assert response.status_code == status.HTTP_200_OK

    def test_customer_can_view_own_vehicle_detail(
        self, client_as_customer, customer_with_user
    ):
        """El cliente puede ver el detalle de su propio vehículo."""
        from conftest import VehicleFactory
        _user, customer = customer_with_user
        my_vehicle = VehicleFactory(owner=customer, tenant=customer.tenant)

        response = client_as_customer.get(f'/api/vehicles/{my_vehicle.id}/')
        assert response.status_code == status.HTTP_200_OK

    def test_customer_cannot_view_other_customers_vehicle(
        self, client_as_customer, tenant
    ):
        """
        El cliente no puede ver el vehículo de otro cliente.
        CanManageVehicles.has_object_permission verifica obj.owner.user == request.user.
        """
        from conftest import CustomerFactory, VehicleFactory
        other_customer = CustomerFactory(tenant=tenant)
        other_vehicle = VehicleFactory(owner=other_customer, tenant=tenant)

        response = client_as_customer.get(f'/api/vehicles/{other_vehicle.id}/')
        assert response.status_code in [
            status.HTTP_403_FORBIDDEN,
            status.HTTP_404_NOT_FOUND
        ], (
            "Cliente no debe poder acceder al vehículo de otro cliente."
        )

    def test_can_manage_vehicles_permission_class_for_customer(
        self, customer_with_user, tenant
    ):
        """
        Test unitario de CanManageVehicles.has_permission para un cliente.
        """
        from shared.permissions import CanManageVehicles
        from unittest.mock import MagicMock

        user, _customer = customer_with_user

        request = MagicMock()
        request.user = user
        request.user.is_authenticated = True
        request.user.is_superuser = False
        # Simular que no tiene mechanic_profile
        type(request.user).mechanic_profile = property(
            lambda self: (_ for _ in ()).throw(AttributeError())
        )

        permission = CanManageVehicles()
        # has_permission usa customer_profiles.exists() (sin filtro de tenant)
        assert permission.has_permission(request, None) is True

    def test_can_manage_vehicles_object_permission_own_vehicle(
        self, customer_with_user, tenant
    ):
        """
        CanManageVehicles.has_object_permission devuelve True para vehículo propio.
        """
        from shared.permissions import CanManageVehicles
        from conftest import VehicleFactory
        from unittest.mock import MagicMock

        user, customer = customer_with_user
        vehicle = VehicleFactory(owner=customer, tenant=tenant)

        request = MagicMock()
        request.user = user
        request.user.is_authenticated = True
        request.user.is_superuser = False

        permission = CanManageVehicles()
        assert permission.has_object_permission(request, None, vehicle) is True

    def test_can_manage_vehicles_object_permission_other_vehicle(
        self, customer_with_user, tenant
    ):
        """
        CanManageVehicles.has_object_permission devuelve False para vehículo ajeno.
        """
        from shared.permissions import CanManageVehicles
        from conftest import CustomerFactory, VehicleFactory
        from unittest.mock import MagicMock

        user, _my_customer = customer_with_user
        other_customer = CustomerFactory(tenant=tenant)
        other_vehicle = VehicleFactory(owner=other_customer, tenant=tenant)

        request = MagicMock()
        request.user = user
        request.user.is_authenticated = True
        request.user.is_superuser = False

        permission = CanManageVehicles()
        assert permission.has_object_permission(request, None, other_vehicle) is False


# =============================================================================
# Tests de aislamiento multi-tenant
# =============================================================================

class TestCustomerMultiTenantIsolation:
    """
    Verifica que el aislamiento multi-tenant funciona correctamente
    para usuarios con rol customer en múltiples tenants.
    """

    def test_customer_in_tenant_a_cannot_access_vehicles_in_tenant_b(
        self, db
    ):
        """
        Un usuario cliente del tenant A no puede acceder a vehículos
        del tenant B, aunque sea cliente en ambos.
        """
        from conftest import UserFactory, TenantFactory, CustomerFactory, VehicleFactory
        from apps.tenants.models import TenantUser

        user = UserFactory()
        tenant_a = TenantFactory()
        tenant_b = TenantFactory()

        # El usuario es cliente en ambos tenants
        customer_a = CustomerFactory(tenant=tenant_a, user=user)
        CustomerFactory(tenant=tenant_b, user=user)
        TenantUser.objects.create(user=user, tenant=tenant_a, role='member', is_current=True)

        vehicle_b = VehicleFactory(
            owner=CustomerFactory(tenant=tenant_b),
            tenant=tenant_b
        )

        # Autenticado como cliente del tenant A
        refresh = JWTRefreshToken.for_user(user)
        client = APIClient()
        client.credentials(
            HTTP_AUTHORIZATION=f'Bearer {str(refresh.access_token)}',
            HTTP_X_TENANT_ID=tenant_a.slug
        )

        response = client.get(f'/api/vehicles/{vehicle_b.id}/')
        assert response.status_code in [
            status.HTTP_403_FORBIDDEN,
            status.HTTP_404_NOT_FOUND
        ], "Vehículo de otro tenant no debe ser accesible."
```

---

## 7. Criterios de aceptación

- [x] `pytest apps/customers/tests/test_customer_permissions.py -v` pasa al 100% — **13/13 passed**
- [x] Un usuario con `Customer` vinculado (`user` FK) recibe 200 en `GET /api/customers/me/profile/`
- [x] Un usuario sin `Customer` vinculado recibe 403 en `GET /api/customers/me/profile/`
- [x] `IsCustomer.has_permission` filtra por tenant cuando `request.tenant` está disponible
- [x] `CanManageVehicles.has_permission` retorna `True` para clientes (con `customer_profiles.exists()`)
- [x] `CanManageVehicles.has_object_permission` retorna `False` para vehículos de otro cliente
- [x] Un usuario puede tener `customer_profiles` en N tenants (OneToOneField no aplica)
- [x] El comentario del docstring en `shared/permissions.py` línea 9 refleja la estructura actual
- [ ] `pytest --cov=apps --cov-fail-under=65` sigue pasando (pendiente verificar cobertura global)

---

## 8. Archivos a modificar

| Archivo | Acción | Tipo |
|---------|--------|------|
| `conftest.py` | Agregar fixtures `customer_with_user` y `customer_api_client` | ✅ DONE |
| `apps/customers/tests/test_customer_permissions.py` | Crear archivo nuevo | ✅ DONE |
| `shared/permissions.py` línea 9 | Actualizar comentario cosmético | ✅ DONE |
| `apps/core/views.py` línea 88 | Actualizar comentario cosmético | ✅ DONE |

**No modificar:**
- Archivos de migración
- `TALLER_PRO_EXPORT.md` (documentación generada)
- Ningún archivo de código activo — todos ya usan `customer_profiles` correctamente

---

## 9. Notas de implementación

### Por qué se cambió a ForeignKey

El cambio de `OneToOneField` a `ForeignKey` fue intencional para el modelo multi-tenant:
un usuario registrado en Google puede ser cliente de dos talleres distintos. Con
`OneToOneField` solo podía pertenecer a uno. La restricción de unicidad se maneja ahora
con `unique_together = [('user', 'tenant')]` en la migración 0002.

### Patrón correcto para resolver el Customer del request

```python
# INCORRECTO (OneToOneField antiguo)
customer = request.user.customer_profile  # AttributeError si no existe

# CORRECTO (ForeignKey actual)
tenant = getattr(request, 'tenant', None)
customer = request.user.customer_profiles.filter(tenant=tenant).first()
if not customer:
    return Response({'detail': 'Perfil de cliente no encontrado.'}, status=404)
```

### Patrón correcto para verificar si el usuario es cliente

```python
# Con tenant resuelto (preferido)
is_customer = request.user.customer_profiles.filter(tenant=request.tenant).exists()

# Sin tenant (fallback)
is_customer = request.user.customer_profiles.exists()
```
