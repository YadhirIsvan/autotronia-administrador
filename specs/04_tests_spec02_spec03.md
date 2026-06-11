# Spec 04 — Tests unitarios e integración: Spec-02 y Spec-03

**Fecha:** 2026-03-13
**Dependencias:** Spec-02 completado (pasos 1-4), Spec-03 completado

---

## Resumen Ejecutivo

Plan de implementación de tests para los cambios introducidos en Spec-02 (fix tenant
en booking público) y Spec-03 (notificaciones a admins del tenant correcto).

**Total de archivos:** 13 creados o modificados (9 backend, 4 frontend)
**Incremento estimado de coverage backend:** +5.3%
**Estado inicial del frontend:** sin infraestructura de testing — se configura desde cero

---

## Estado actual de testing

| | Backend | Frontend |
|---|---|---|
| Framework | pytest 8.0.0 + pytest-django 4.8.0 | **Ninguno** |
| Coverage mínimo | 65% (configurado en pytest.ini) | N/A |
| Archivos de test | 5 archivos, ~1700 casos | 0 archivos |
| Factories | factory-boy 3.3.0 + Faker 38.2.0 | N/A |
| Cobertura `apps/notifications/` | **0%** (directorio sin tests) | N/A |

---

## Paso 0 — Infraestructura (BLOQUEANTE para Paso 5)

### 0.1 Instalar `pytest-asyncio`

`pytest-asyncio` no está en el proyecto. Sin él, pytest no puede ejecutar
`async def test_*` y los tests del consumer WebSocket no corren.

**Archivo:** `backend-taller-pro/requirements.txt`

Agregar al final:

```
pytest-asyncio==0.23.6
```

Instalar en el container:

```bash
docker compose exec web pip install pytest-asyncio==0.23.6
```

### 0.2 Modificar `pytest.ini`

**Archivo:** `backend-taller-pro/pytest.ini`

Agregar `asyncio_mode = auto` dentro de `[pytest]`:

```ini
[pytest]
DJANGO_SETTINGS_MODULE = config.settings.testing
python_files = tests.py test_*.py *_tests.py
python_classes = Test*
python_functions = test_*
asyncio_mode = auto
addopts =
    -v
    --tb=short
    --strict-markers
    -ra
    --cov=apps
    --cov-report=term-missing
    --cov-report=html:htmlcov
    --cov-fail-under=65

markers =
    slow: marks tests as slow (deselect with '-m "not slow"')
    integration: marks tests as integration tests
    api: marks tests as API tests
    unit: marks tests as unit tests
    smoke: marks tests as smoke tests (quick sanity checks)

filterwarnings =
    ignore::DeprecationWarning
    ignore::PendingDeprecationWarning

testpaths = apps
```

Con `asyncio_mode = auto`, pytest-asyncio detecta automáticamente las funciones
`async def test_*` sin necesidad del decorador `@pytest.mark.asyncio` en cada test.

### 0.3 Agregar `InMemoryChannelLayer` a `config/settings/testing.py`

**Archivo:** `backend-taller-pro/config/settings/testing.py`

Agregar al final del archivo:

```python
# Channel Layer en memoria para tests (sin Redis)
CHANNEL_LAYERS = {
    "default": {
        "BACKEND": "channels.layers.InMemoryChannelLayer"
    }
}
```

Sin esto, los consumers intentan conectarse a Redis durante los tests y fallan.
`InMemoryChannelLayer` es el backend oficial de Django Channels para testing —
soporta `group_send`, `group_add`, `group_discard` en memoria.

---

## Paso 1 — `apps/tenants/tests/test_api.py` (MODIFICAR)

**Acción:** Agregar la clase `TestActiveSingleEndpoint` al final del archivo existente.
No modificar ningún test existente.

**Cubre:** endpoint `GET /api/tenants/active-single/` del Spec-02 Paso 1.

**Fixtures reutilizadas del conftest:** `api_client`, `db`. Sin fixtures nuevas.

**Delta coverage:** +0.3%

```python
class TestActiveSingleEndpoint:
    """
    Tests para GET /api/tenants/active-single/
    Endpoint público (AllowAny) — Spec-02 Paso 1.
    """

    def test_returns_slug_when_exactly_one_active_tenant(self, api_client, db):
        """Caso nominal: un tenant activo -> devuelve slug, name, id."""
        from apps.tenants.models import Tenant
        Tenant.objects.all().delete()
        t = TenantFactory(is_active=True, is_deleted=False)

        response = api_client.get('/api/tenants/active-single/')

        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert data['slug'] == t.slug
        assert data['name'] == t.name
        assert data['id'] == t.id

    def test_returns_404_when_no_active_tenants(self, api_client, db):
        """Sin tenants activos -> 404 con mensaje de error."""
        from apps.tenants.models import Tenant
        Tenant.objects.all().delete()

        response = api_client.get('/api/tenants/active-single/')

        assert response.status_code == status.HTTP_404_NOT_FOUND
        assert 'error' in response.json()

    def test_returns_404_when_multiple_active_tenants(self, api_client, db):
        """Más de un tenant activo -> 404 (sistema multi-tenant real)."""
        from apps.tenants.models import Tenant
        Tenant.objects.all().delete()
        TenantFactory(is_active=True, is_deleted=False)
        TenantFactory(is_active=True, is_deleted=False)

        response = api_client.get('/api/tenants/active-single/')

        assert response.status_code == status.HTTP_404_NOT_FOUND

    def test_ignores_inactive_tenants_in_count(self, api_client, db):
        """Un activo + uno inactivo -> devuelve el activo (cuenta solo 1)."""
        from apps.tenants.models import Tenant
        Tenant.objects.all().delete()
        active = TenantFactory(is_active=True, is_deleted=False)
        TenantFactory(is_active=False, is_deleted=False)

        response = api_client.get('/api/tenants/active-single/')

        assert response.status_code == status.HTTP_200_OK
        assert response.json()['slug'] == active.slug

    def test_ignores_soft_deleted_tenants_in_count(self, api_client, db):
        """Un activo + uno soft-deleted -> devuelve el activo."""
        from apps.tenants.models import Tenant
        Tenant.objects.all().delete()
        active = TenantFactory(is_active=True, is_deleted=False)
        TenantFactory(is_active=True, is_deleted=True)

        response = api_client.get('/api/tenants/active-single/')

        assert response.status_code == status.HTTP_200_OK
        assert response.json()['slug'] == active.slug

    def test_endpoint_is_public_no_auth_required(self, api_client, db):
        """Sin token no debe dar 401/403 (AllowAny)."""
        from apps.tenants.models import Tenant
        Tenant.objects.all().delete()
        TenantFactory(is_active=True, is_deleted=False)

        response = api_client.get('/api/tenants/active-single/')

        assert response.status_code != status.HTTP_401_UNAUTHORIZED
        assert response.status_code != status.HTTP_403_FORBIDDEN

    def test_response_schema_has_required_fields(self, api_client, db):
        """La respuesta exitosa contiene exactamente: slug, name, id."""
        from apps.tenants.models import Tenant
        Tenant.objects.all().delete()
        TenantFactory(is_active=True, is_deleted=False)

        response = api_client.get('/api/tenants/active-single/')
        data = response.json()

        assert 'slug' in data
        assert 'name' in data
        assert 'id' in data
```

---

## Paso 2 — `apps/appointments/tests/test_api.py` (MODIFICAR)

**Acción:** Agregar la clase `TestPerformCreateTenantResolution` al final del archivo
existente. No modificar ningún test existente.

**Cubre:** los 3 mecanismos de resolución de tenant en `perform_create` — Spec-02 Paso 3.

**Fixture nueva** (definida localmente en el archivo):

```python
@pytest.fixture
def booking_payload(customer, vehicle, appointment_type):
    """Payload mínimo válido para crear una cita via booking público."""
    from datetime import date, timedelta
    return {
        'customer': customer.id,
        'vehicle': vehicle.id,
        'appointment_type': appointment_type.id,
        'scheduled_date': str(date.today() + timedelta(days=3)),
        'scheduled_time': '10:00:00',
        'reason': 'Mantenimiento preventivo',
    }
```

**Delta coverage:** +0.5%

```python
@pytest.mark.django_db
class TestPerformCreateTenantResolution:
    """
    Tests para los 3 mecanismos de resolución de tenant en
    AppointmentViewSet.perform_create() — Spec-02 Paso 3.
    """

    def test_create_with_header_sets_tenant(self, authenticated_client, tenant,
                                             booking_payload):
        """
        Mecanismo 1: header X-Tenant-ID presente -> cita queda con ese tenant.
        authenticated_client ya envía HTTP_X_TENANT_ID via conftest.
        """
        from apps.appointments.models import Appointment
        response = authenticated_client.post(
            '/api/appointments/', booking_payload, format='json'
        )
        assert response.status_code == status.HTTP_201_CREATED
        appt = Appointment.objects.get(id=response.data['id'])
        assert appt.tenant_id == tenant.id

    def test_create_with_tenant_slug_body_sets_tenant(self, api_client, tenant,
                                                       booking_payload):
        """
        Mecanismo 2: sin header pero con tenant_slug en body -> cita queda con ese tenant.
        """
        from apps.appointments.models import Appointment
        from rest_framework.authtoken.models import Token

        user = UserFactory()
        TenantUserFactory(user=user, tenant=tenant, role='admin')
        token, _ = Token.objects.get_or_create(user=user)
        api_client.credentials(HTTP_AUTHORIZATION=f'Token {token.key}')

        payload = {**booking_payload, 'tenant_slug': tenant.slug}
        response = api_client.post('/api/appointments/', payload, format='json')

        assert response.status_code == status.HTTP_201_CREATED
        appt = Appointment.objects.get(id=response.data['id'])
        assert appt.tenant_id == tenant.id

    def test_create_with_invalid_tenant_slug_ignores_slug(self, api_client, tenant,
                                                           booking_payload):
        """
        Mecanismo 2 con slug inválido: el slug no existe en BD -> no se asigna.
        Si hay un solo tenant activo, cae al mecanismo 3.
        """
        from rest_framework.authtoken.models import Token

        user = UserFactory()
        TenantUserFactory(user=user, tenant=tenant, role='admin')
        token, _ = Token.objects.get_or_create(user=user)
        api_client.credentials(HTTP_AUTHORIZATION=f'Token {token.key}')

        payload = {**booking_payload, 'tenant_slug': 'slug-que-no-existe'}
        response = api_client.post('/api/appointments/', payload, format='json')

        assert response.status_code == status.HTTP_201_CREATED

    def test_create_fallback_single_tenant(self, api_client, tenant, booking_payload):
        """
        Mecanismo 3: sin header y sin tenant_slug válido, pero hay exactamente
        un tenant activo -> cita se asigna a ese tenant.
        """
        from apps.appointments.models import Appointment
        from apps.tenants.models import Tenant
        from rest_framework.authtoken.models import Token

        Tenant.objects.exclude(id=tenant.id).update(is_active=False)

        user = UserFactory()
        TenantUserFactory(user=user, tenant=tenant, role='admin')
        token, _ = Token.objects.get_or_create(user=user)
        api_client.credentials(HTTP_AUTHORIZATION=f'Token {token.key}')

        response = api_client.post('/api/appointments/', booking_payload, format='json')

        assert response.status_code == status.HTTP_201_CREATED
        appt = Appointment.objects.get(id=response.data['id'])
        assert appt.tenant_id == tenant.id

    def test_create_no_tenant_resolved_when_multiple_active(self, api_client,
                                                             booking_payload):
        """
        Sin header, sin slug en body, más de 1 tenant activo ->
        tenant queda None (no hay fallback posible).
        """
        from apps.appointments.models import Appointment
        from apps.tenants.models import Tenant
        from rest_framework.authtoken.models import Token
        from datetime import date, timedelta

        t1 = TenantFactory(is_active=True, is_deleted=False)
        TenantFactory(is_active=True, is_deleted=False)

        user = UserFactory()
        TenantUserFactory(user=user, tenant=t1, role='admin')
        token, _ = Token.objects.get_or_create(user=user)
        api_client.credentials(HTTP_AUTHORIZATION=f'Token {token.key}')

        customer = CustomerFactory(tenant=t1)
        vehicle = VehicleFactory(owner=customer, tenant=t1)
        apt_type = AppointmentTypeFactory(tenant=t1)
        payload = {
            'customer': customer.id,
            'vehicle': vehicle.id,
            'appointment_type': apt_type.id,
            'scheduled_date': str(date.today() + timedelta(days=3)),
            'scheduled_time': '10:00:00',
            'reason': 'Test',
        }

        response = api_client.post('/api/appointments/', payload, format='json')

        if response.status_code == status.HTTP_201_CREATED:
            appt = Appointment.objects.get(id=response.data['id'])
            assert appt.tenant_id is None
```

---

## Paso 3 — `apps/appointments/tests/test_signals.py` (CREAR — mayor impacto)

**Archivo nuevo:** `backend-taller-pro/apps/appointments/tests/test_signals.py`

**Cubre:** `_send_appointment_notification` completa — Spec-03 (el bug raíz).

**Delta coverage:** +2.5% (el mayor incremento del plan)

**Imports y fixtures locales:**

```python
import pytest
from unittest import mock
from django.contrib.auth.models import Group
from conftest import (
    TenantFactory, UserFactory, TenantUserFactory,
    AppointmentFactory, CustomerFactory, VehicleFactory, AppointmentTypeFactory,
)


@pytest.fixture
def advisor_user(db, tenant):
    """Usuario en grupo Advisors + TenantUser.role=member en el tenant."""
    user = UserFactory(is_active=True)
    group, _ = Group.objects.get_or_create(name='Advisors')
    user.groups.add(group)
    TenantUserFactory(user=user, tenant=tenant, role='member')
    return user


@pytest.fixture
def owner_user(db, tenant):
    """Usuario con TenantUser.role=owner en el tenant."""
    user = UserFactory(is_active=True)
    TenantUserFactory(user=user, tenant=tenant, role='owner')
    return user


@pytest.fixture
def admin_tenant_user(db, tenant):
    """Usuario con TenantUser.role=admin en el tenant."""
    user = UserFactory(is_active=True)
    TenantUserFactory(user=user, tenant=tenant, role='admin')
    return user


@pytest.fixture
def appointment_with_tenant(db, tenant, customer, vehicle, appointment_type):
    """Cita vinculada al tenant, sin advisor asignado."""
    return AppointmentFactory(
        tenant=tenant,
        customer=customer,
        vehicle=vehicle,
        appointment_type=appointment_type,
        advisor=None,
        status='scheduled',
    )
```

**Nota crítica sobre el mock:** El mock debe apuntar a donde vive el objeto, no donde
se importa en signals.py:

```python
# CORRECTO:
mock.patch('apps.notifications.services.NotificationService.send_to_users')

# INCORRECTO (el import local en signals.py hace que este path no funcione):
mock.patch('apps.appointments.signals.NotificationService.send_to_users')
```

### Clase `TestSendAppointmentNotification` (unit tests)

```python
@pytest.mark.django_db
@pytest.mark.unit
class TestSendAppointmentNotification:
    """
    Tests unitarios para _send_appointment_notification() — Spec-03.
    Mockea NotificationService para no necesitar Redis.
    """

    def test_notifies_assigned_advisor(self, appointment_with_tenant):
        """Cuando hay advisor asignado, su ID aparece en user_ids."""
        advisor = UserFactory(is_active=True)
        appointment_with_tenant.advisor = advisor
        appointment_with_tenant.save()

        with mock.patch(
            'apps.notifications.services.NotificationService.send_to_users'
        ) as mock_send:
            from apps.appointments.signals import _send_appointment_notification
            _send_appointment_notification(
                appointment_with_tenant,
                notification_type='appointment',
                title='Test',
                message='Test msg',
            )
            call_kwargs = mock_send.call_args
            user_ids = call_kwargs[1].get('user_ids') or call_kwargs[0][0]
            assert advisor.id in user_ids

    def test_notifies_tenant_admin(self, appointment_with_tenant, admin_tenant_user):
        """Usuarios con TenantUser.role=admin reciben la notificación."""
        with mock.patch(
            'apps.notifications.services.NotificationService.send_to_users'
        ) as mock_send:
            from apps.appointments.signals import _send_appointment_notification
            _send_appointment_notification(
                appointment_with_tenant,
                notification_type='appointment',
                title='Test',
                message='Test msg',
            )
            call_kwargs = mock_send.call_args
            user_ids = call_kwargs[1].get('user_ids') or call_kwargs[0][0]
            assert admin_tenant_user.id in user_ids

    def test_notifies_tenant_owner(self, appointment_with_tenant, owner_user):
        """Usuarios con TenantUser.role=owner reciben la notificación."""
        with mock.patch(
            'apps.notifications.services.NotificationService.send_to_users'
        ) as mock_send:
            from apps.appointments.signals import _send_appointment_notification
            _send_appointment_notification(
                appointment_with_tenant,
                notification_type='appointment',
                title='Test',
                message='Test msg',
            )
            call_kwargs = mock_send.call_args
            user_ids = call_kwargs[1].get('user_ids') or call_kwargs[0][0]
            assert owner_user.id in user_ids

    def test_notifies_tenant_advisors_via_group(self, appointment_with_tenant,
                                                advisor_user):
        """Usuarios en grupo Advisors + miembros del tenant reciben notificación."""
        with mock.patch(
            'apps.notifications.services.NotificationService.send_to_users'
        ) as mock_send:
            from apps.appointments.signals import _send_appointment_notification
            _send_appointment_notification(
                appointment_with_tenant,
                notification_type='appointment',
                title='Test',
                message='Test msg',
            )
            call_kwargs = mock_send.call_args
            user_ids = call_kwargs[1].get('user_ids') or call_kwargs[0][0]
            assert advisor_user.id in user_ids

    def test_advisor_not_duplicated_when_also_admin(
            self, appointment_with_tenant, advisor_user):
        """
        Si el advisor asignado también es admin/owner del tenant,
        su ID no debe aparecer duplicado en user_ids.
        """
        from apps.tenants.models import TenantUser
        TenantUser.objects.filter(
            user=advisor_user, tenant=appointment_with_tenant.tenant
        ).update(role='admin')
        appointment_with_tenant.advisor = advisor_user
        appointment_with_tenant.save()

        with mock.patch(
            'apps.notifications.services.NotificationService.send_to_users'
        ) as mock_send:
            from apps.appointments.signals import _send_appointment_notification
            _send_appointment_notification(
                appointment_with_tenant,
                notification_type='appointment',
                title='Test',
                message='Test msg',
            )
            call_kwargs = mock_send.call_args
            user_ids = call_kwargs[1].get('user_ids') or call_kwargs[0][0]
            assert user_ids.count(advisor_user.id) == 1

    def test_excludes_inactive_users(self, appointment_with_tenant, tenant):
        """Usuarios inactivos no reciben notificación aunque sean admin."""
        inactive_admin = UserFactory(is_active=False)
        TenantUserFactory(user=inactive_admin, tenant=tenant, role='admin')

        with mock.patch(
            'apps.notifications.services.NotificationService.send_to_users'
        ) as mock_send:
            from apps.appointments.signals import _send_appointment_notification
            _send_appointment_notification(
                appointment_with_tenant,
                notification_type='appointment',
                title='Test',
                message='Test msg',
            )
            call_kwargs = mock_send.call_args
            user_ids = call_kwargs[1].get('user_ids') or call_kwargs[0][0]
            assert inactive_admin.id not in user_ids

    def test_no_notification_sent_when_no_users(self, db):
        """Si la cita no tiene tenant ni advisor, no se llama send_to_users."""
        appt = AppointmentFactory(tenant=None, advisor=None)

        with mock.patch(
            'apps.notifications.services.NotificationService.send_to_users'
        ) as mock_send:
            from apps.appointments.signals import _send_appointment_notification
            _send_appointment_notification(
                appt,
                notification_type='appointment',
                title='Test',
                message='Test msg',
            )
            mock_send.assert_not_called()

    def test_notification_data_contains_appointment_fields(
            self, appointment_with_tenant, admin_tenant_user):
        """El dict data enviado contiene appointment_id, status y campos clave."""
        with mock.patch(
            'apps.notifications.services.NotificationService.send_to_users'
        ) as mock_send:
            from apps.appointments.signals import _send_appointment_notification
            _send_appointment_notification(
                appointment_with_tenant,
                notification_type='appointment',
                title='Test',
                message='Test msg',
            )
            call_kwargs = mock_send.call_args[1]
            data = call_kwargs.get('data') or mock_send.call_args[0][4]
            assert data['appointment_id'] == appointment_with_tenant.id
            assert 'status' in data
            assert 'scheduled_date' in data

    def test_advisor_from_different_tenant_not_notified(
            self, appointment_with_tenant):
        """Un admin de otro tenant no recibe la notificación."""
        other_tenant = TenantFactory()
        advisor_other = UserFactory(is_active=True)
        TenantUserFactory(user=advisor_other, tenant=other_tenant, role='admin')

        with mock.patch(
            'apps.notifications.services.NotificationService.send_to_users'
        ) as mock_send:
            from apps.appointments.signals import _send_appointment_notification
            _send_appointment_notification(
                appointment_with_tenant,
                notification_type='appointment',
                title='Test',
                message='Test msg',
            )
            if mock_send.call_args:
                call_kwargs = mock_send.call_args
                user_ids = call_kwargs[1].get('user_ids') or call_kwargs[0][0]
                assert advisor_other.id not in user_ids

    def test_member_role_does_not_receive_notification(
            self, appointment_with_tenant, tenant):
        """
        Usuarios con TenantUser.role=member NO reciben notificación.
        Solo owner y admin son notificados por rol.
        """
        member_user = UserFactory(is_active=True)
        TenantUserFactory(user=member_user, tenant=tenant, role='member')

        with mock.patch(
            'apps.notifications.services.NotificationService.send_to_users'
        ) as mock_send:
            from apps.appointments.signals import _send_appointment_notification
            _send_appointment_notification(
                appointment_with_tenant,
                notification_type='appointment',
                title='Test',
                message='Test msg',
            )
            if mock_send.call_args:
                call_kwargs = mock_send.call_args
                user_ids = call_kwargs[1].get('user_ids') or call_kwargs[0][0]
                assert member_user.id not in user_ids
```

### Clase `TestSignalDispatch` (integration tests)

```python
@pytest.mark.django_db
@pytest.mark.integration
class TestSignalDispatch:
    """
    Tests de integración: verifican que el signal post_save dispara
    _send_appointment_notification en los momentos correctos.
    """

    def test_signal_fires_on_appointment_creation(self, tenant, customer,
                                                   vehicle, appointment_type):
        """Al crear una cita, el signal post_save dispara notificación."""
        with mock.patch(
            'apps.appointments.signals._send_appointment_notification'
        ) as mock_fn:
            AppointmentFactory(
                tenant=tenant, customer=customer,
                vehicle=vehicle, appointment_type=appointment_type,
            )
            assert mock_fn.called

    def test_signal_fires_on_status_change_to_confirmed(
            self, appointment_with_tenant):
        """Al cambiar status a 'confirmed', el signal dispara notificación."""
        with mock.patch(
            'apps.appointments.signals._send_appointment_notification'
        ) as mock_fn:
            appointment_with_tenant.status = 'confirmed'
            appointment_with_tenant.save()
            assert mock_fn.called

    def test_signal_fires_on_status_change_to_checked_in(
            self, appointment_with_tenant):
        """Al cambiar status a 'checked_in', el signal dispara notificación."""
        appointment_with_tenant.status = 'confirmed'
        appointment_with_tenant.save()

        with mock.patch(
            'apps.appointments.signals._send_appointment_notification'
        ) as mock_fn:
            appointment_with_tenant.status = 'checked_in'
            appointment_with_tenant.save()
            assert mock_fn.called

    def test_signal_does_not_fire_on_non_status_field_update(
            self, appointment_with_tenant):
        """Actualizar un campo que no es status no dispara notificación extra."""
        with mock.patch(
            'apps.appointments.signals._send_appointment_notification'
        ) as mock_fn:
            appointment_with_tenant.reason = 'Razón actualizada'
            appointment_with_tenant.save()
            mock_fn.assert_not_called()
```

---

## Paso 4 — `apps/notifications/tests/` (CREAR directorio + `test_services.py`)

**Archivos a crear:**
- `backend-taller-pro/apps/notifications/tests/__init__.py` (vacío)
- `backend-taller-pro/apps/notifications/tests/test_services.py`

**Cubre:** `NotificationService.send_to_user` y `send_to_users` — funcionalidad
transversal a Spec-02 y Spec-03.

**Delta coverage:** +0.8%

**Fixture local:**

```python
@pytest.fixture
def user_with_tenant(db, tenant):
    """Usuario con TenantUser.is_current=True apuntando al tenant."""
    user = UserFactory(is_active=True)
    TenantUserFactory(user=user, tenant=tenant, role='admin', is_current=True)
    return user
```

### Clase `TestNotificationServiceSendToUser`

```python
@pytest.mark.django_db
@pytest.mark.unit
class TestNotificationServiceSendToUser:
    """Tests para NotificationService.send_to_user() con channel_layer mockeado."""

    def test_creates_notification_in_db_when_save_true(self, user_with_tenant):
        """Con save=True, se crea el registro en Notification."""
        from apps.notifications.models import Notification
        from apps.notifications.services import NotificationService

        with mock.patch('apps.notifications.services.get_channel_layer') as mock_layer:
            mock_layer.return_value = mock.MagicMock()
            NotificationService.send_to_user(
                user_id=user_with_tenant.id,
                notification_type='appointment',
                title='Test titulo',
                message='Test mensaje',
            )

        assert Notification.objects.filter(
            user=user_with_tenant, title='Test titulo'
        ).exists()

    def test_sets_tenant_from_is_current_membership(self, user_with_tenant, tenant):
        """La notificación en BD queda vinculada al tenant is_current del usuario."""
        from apps.notifications.models import Notification
        from apps.notifications.services import NotificationService

        with mock.patch('apps.notifications.services.get_channel_layer') as mock_layer:
            mock_layer.return_value = mock.MagicMock()
            NotificationService.send_to_user(
                user_id=user_with_tenant.id,
                notification_type='appointment',
                title='Test tenant',
                message='Msg',
            )

        notif = Notification.objects.get(user=user_with_tenant, title='Test tenant')
        assert notif.tenant_id == tenant.id

    def test_does_not_save_when_save_false(self, user_with_tenant):
        """Con save=False, no se escribe en BD."""
        from apps.notifications.models import Notification
        from apps.notifications.services import NotificationService

        with mock.patch('apps.notifications.services.get_channel_layer') as mock_layer:
            mock_layer.return_value = mock.MagicMock()
            NotificationService.send_to_user(
                user_id=user_with_tenant.id,
                notification_type='appointment',
                title='No guardar',
                message='Msg',
                save=False,
            )

        assert not Notification.objects.filter(
            user=user_with_tenant, title='No guardar'
        ).exists()

    def test_returns_false_for_nonexistent_user(self, db):
        """Con user_id que no existe, retorna False sin lanzar excepción."""
        from apps.notifications.services import NotificationService

        result = NotificationService.send_to_user(
            user_id=99999,
            notification_type='system',
            title='No existe',
            message='Msg',
        )
        assert result is False

    def test_sends_to_ws_group_via_channel_layer(self, user_with_tenant):
        """Se llama group_send con el grupo 'user_{id}' correcto."""
        from apps.notifications.services import NotificationService

        with mock.patch('apps.notifications.services.get_channel_layer') as mock_layer:
            channel_layer = mock.MagicMock()
            mock_layer.return_value = channel_layer

            with mock.patch('apps.notifications.services.async_to_sync') as mock_async:
                mock_async.return_value = mock.MagicMock()
                NotificationService.send_to_user(
                    user_id=user_with_tenant.id,
                    notification_type='appointment',
                    title='WS Test',
                    message='Msg',
                )

            mock_async.assert_called_once_with(channel_layer.group_send)
```

### Clase `TestNotificationServiceSendToUsers`

```python
@pytest.mark.django_db
@pytest.mark.unit
class TestNotificationServiceSendToUsers:
    """Tests para send_to_users() — itera sobre lista de IDs."""

    def test_calls_send_to_user_for_each_id(self, user_with_tenant):
        """send_to_users llama send_to_user una vez por cada ID."""
        from apps.notifications.services import NotificationService

        user2 = UserFactory(is_active=True)
        TenantUserFactory(user=user2, is_current=True)

        with mock.patch.object(NotificationService, 'send_to_user') as mock_send:
            NotificationService.send_to_users(
                user_ids=[user_with_tenant.id, user2.id],
                notification_type='appointment',
                title='Multi',
                message='Msg',
            )
            assert mock_send.call_count == 2

    def test_empty_list_does_not_call_send(self):
        """Lista vacía de user_ids no llama send_to_user."""
        from apps.notifications.services import NotificationService

        with mock.patch.object(NotificationService, 'send_to_user') as mock_send:
            NotificationService.send_to_users(
                user_ids=[],
                notification_type='appointment',
                title='Vacío',
                message='Msg',
            )
            mock_send.assert_not_called()
```

---

## Paso 5 — `apps/notifications/tests/test_consumer.py` (CREAR — requiere Paso 0)

**Archivo:** `backend-taller-pro/apps/notifications/tests/test_consumer.py`

**Requiere:** `pytest-asyncio` instalado (Paso 0.1) + `InMemoryChannelLayer` (Paso 0.3).

**Nota crítica:** Los tests de WebSocket consumer requieren
`@pytest.mark.django_db(transaction=True)` porque el consumer corre en una coroutine
separada que necesita ver los datos comprometidos en la transacción. Sin
`transaction=True`, los `database_sync_to_async` pueden quedar bloqueados por el
atomic block de pytest-django.

**Delta coverage:** +1.2%

```python
import pytest
import json
from channels.testing import WebsocketCommunicator
from channels.db import database_sync_to_async
from rest_framework.authtoken.models import Token
from conftest import UserFactory, TenantFactory, TenantUserFactory


@pytest.mark.django_db(transaction=True)
class TestNotificationConsumerConnect:
    """
    Tests del ciclo connect/disconnect del NotificationConsumer.
    Cubre get_user_tenant_id() — Spec-02 Paso 4.
    """

    async def test_connect_with_valid_token_accepts(self, db):
        """Token válido -> conexión aceptada, mensaje connection_established enviado."""
        from config.asgi import application

        user = await database_sync_to_async(UserFactory)()
        token, _ = await database_sync_to_async(
            Token.objects.get_or_create
        )(user=user)

        communicator = WebsocketCommunicator(
            application,
            f'/ws/notifications/?token={token.key}'
        )
        connected, _ = await communicator.connect()
        assert connected

        response = await communicator.receive_json_from()
        assert response['type'] == 'connection_established'
        assert response['user_id'] == user.id

        await communicator.disconnect()

    async def test_connect_without_token_closes_with_4001(self, db):
        """Sin token -> conexión rechazada con código 4001."""
        from config.asgi import application

        communicator = WebsocketCommunicator(
            application,
            '/ws/notifications/'
        )
        connected, code = await communicator.connect()
        assert not connected
        assert code == 4001

    async def test_connect_with_invalid_token_closes_with_4001(self, db):
        """Token inválido (no existe en BD) -> rechazado con 4001."""
        from config.asgi import application

        communicator = WebsocketCommunicator(
            application,
            '/ws/notifications/?token=tokeninvalido12345'
        )
        connected, code = await communicator.connect()
        assert not connected
        assert code == 4001

    async def test_connect_sends_unread_count(self, db):
        """Tras conectar, se envía mensaje unread_count."""
        from config.asgi import application

        user = await database_sync_to_async(UserFactory)()
        token, _ = await database_sync_to_async(
            Token.objects.get_or_create
        )(user=user)

        communicator = WebsocketCommunicator(
            application,
            f'/ws/notifications/?token={token.key}'
        )
        await communicator.connect()
        await communicator.receive_json_from()  # connection_established

        response = await communicator.receive_json_from()
        assert response['type'] == 'unread_count'
        assert 'count' in response
        await communicator.disconnect()

    async def test_get_user_tenant_id_returns_correct_tenant(self, db):
        """
        get_user_tenant_id() devuelve el tenant_id del TenantUser con is_current=True.
        Test directo del método corregido en Spec-02 Paso 4.
        """
        user = await database_sync_to_async(UserFactory)()
        tenant = await database_sync_to_async(TenantFactory)()
        await database_sync_to_async(TenantUserFactory)(
            user=user, tenant=tenant, is_current=True
        )

        from apps.notifications.consumers import NotificationConsumer
        consumer = NotificationConsumer()
        consumer.user = user

        tenant_id = await consumer.get_user_tenant_id()
        assert tenant_id == tenant.id

    async def test_get_user_tenant_id_returns_none_without_membership(self, db):
        """get_user_tenant_id() retorna None si el usuario no tiene TenantUser."""
        user = await database_sync_to_async(UserFactory)()

        from apps.notifications.consumers import NotificationConsumer
        consumer = NotificationConsumer()
        consumer.user = user

        tenant_id = await consumer.get_user_tenant_id()
        assert tenant_id is None

    async def test_get_user_tenant_id_ignores_non_current(self, db):
        """get_user_tenant_id() ignora membresías con is_current=False."""
        user = await database_sync_to_async(UserFactory)()
        tenant = await database_sync_to_async(TenantFactory)()
        await database_sync_to_async(TenantUserFactory)(
            user=user, tenant=tenant, is_current=False
        )

        from apps.notifications.consumers import NotificationConsumer
        consumer = NotificationConsumer()
        consumer.user = user

        tenant_id = await consumer.get_user_tenant_id()
        assert tenant_id is None


@pytest.mark.django_db(transaction=True)
class TestNotificationConsumerActions:
    """Tests para acciones receive() del consumer."""

    async def test_mark_read_action_marks_notification(self, db):
        """action='mark_read' con notification_id válido marca la notificación como leída."""
        from config.asgi import application
        from apps.notifications.models import Notification

        user = await database_sync_to_async(UserFactory)()
        token, _ = await database_sync_to_async(
            Token.objects.get_or_create
        )(user=user)

        notif = await database_sync_to_async(Notification.objects.create)(
            user=user, type='system', title='Test', message='Msg', read=False,
        )

        communicator = WebsocketCommunicator(
            application,
            f'/ws/notifications/?token={token.key}'
        )
        await communicator.connect()
        await communicator.receive_json_from()  # connection_established
        await communicator.receive_json_from()  # unread_count

        await communicator.send_json_to({
            'action': 'mark_read',
            'notification_id': notif.id,
        })

        await database_sync_to_async(notif.refresh_from_db)()
        assert notif.read is True
        await communicator.disconnect()

    async def test_get_notifications_returns_list(self, db):
        """action='get_notifications' devuelve mensaje tipo notifications_list."""
        from config.asgi import application

        user = await database_sync_to_async(UserFactory)()
        token, _ = await database_sync_to_async(
            Token.objects.get_or_create
        )(user=user)

        communicator = WebsocketCommunicator(
            application,
            f'/ws/notifications/?token={token.key}'
        )
        await communicator.connect()
        await communicator.receive_json_from()
        await communicator.receive_json_from()

        await communicator.send_json_to({'action': 'get_notifications'})

        response = await communicator.receive_json_from()
        assert response['type'] == 'notifications_list'
        assert 'notifications' in response
        assert isinstance(response['notifications'], list)
        await communicator.disconnect()
```

---

## Paso 6 — Frontend: Setup Vitest + `tenant.test.ts` (paralelo a Pasos 3-4)

### 6.1 Dependencias — `package.json`

Agregar bajo `devDependencies`:

```json
"vitest": "^1.6.0",
"@vitest/coverage-v8": "^1.6.0",
"@testing-library/react": "^14.3.1",
"@testing-library/jest-dom": "^6.4.2",
"@testing-library/user-event": "^14.5.2",
"jsdom": "^24.0.0",
"msw": "^2.3.1"
```

Agregar scripts:

```json
"scripts": {
  "test": "vitest run",
  "test:watch": "vitest",
  "test:coverage": "vitest run --coverage"
}
```

Instalar:

```bash
cd front-end-taller-pro
npm install --save-dev vitest @vitest/coverage-v8 @testing-library/react @testing-library/jest-dom @testing-library/user-event jsdom msw
```

### 6.2 Crear `vitest.config.ts`

**Archivo:** `front-end-taller-pro/vitest.config.ts`

```typescript
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/lib/**/*.ts'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
```

### 6.3 Crear `src/test/setup.ts`

**Archivo:** `front-end-taller-pro/src/test/setup.ts`

```typescript
import '@testing-library/jest-dom';

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
  };
})();
Object.defineProperty(window, 'localStorage', { value: localStorageMock });

// Mock window.location
Object.defineProperty(window, 'location', {
  value: { hostname: 'localhost', search: '', href: 'http://localhost:8081' },
  writable: true,
});

// Limpiar localStorage entre tests
beforeEach(() => {
  localStorage.clear();
});
```

### 6.4 Crear `src/lib/__tests__/tenant.test.ts`

**Archivo:** `front-end-taller-pro/src/lib/__tests__/tenant.test.ts`

**Cubre:** `getTenantFromURL`, `setCurrentTenant`, `getCurrentTenant`, `clearTenant`,
`getCachedTenantConfig`, `isMultiTenant`, `fetchTenantConfig`, `initTenant`
con `discoverSingleTenant` — Spec-02 Paso 2.

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/config', () => ({
  API_URL: 'http://localhost:8000/api',
}));

import {
  getTenantFromURL,
  getCurrentTenant,
  setCurrentTenant,
  clearTenant,
  getCachedTenantConfig,
  fetchTenantConfig,
  initTenant,
  isMultiTenant,
} from '../tenant';

function setHostname(hostname: string, search = '') {
  Object.defineProperty(window, 'location', {
    value: { hostname, search, href: `http://${hostname}` },
    writable: true,
  });
}

describe('getTenantFromURL', () => {
  beforeEach(() => { setHostname('localhost'); localStorage.clear(); });

  it('devuelve default cuando hostname es localhost sin query params', () => {
    expect(getTenantFromURL()).toBe('default');
  });

  it('detecta tenant desde query param ?tenant=mi-taller', () => {
    Object.defineProperty(window, 'location', {
      value: { hostname: 'localhost', search: '?tenant=mi-taller', href: 'http://localhost' },
      writable: true,
    });
    expect(getTenantFromURL()).toBe('mi-taller');
  });

  it('detecta tenant desde subdominio (messi.tallerpro.com)', () => {
    setHostname('messi.tallerpro.com');
    expect(getTenantFromURL()).toBe('messi');
  });

  it('ignora subdominios excluidos: www', () => {
    setHostname('www.tallerpro.com');
    expect(getTenantFromURL()).toBe('default');
  });

  it('ignora subdominios excluidos: app', () => {
    setHostname('app.autotronia.com');
    expect(getTenantFromURL()).toBe('default');
  });

  it('devuelve tenant guardado en localStorage si no hay URL ni subdominio', () => {
    localStorage.setItem('taller_tenant_slug', 'taller-guardado');
    expect(getTenantFromURL()).toBe('taller-guardado');
  });

  it('no usa localStorage si el valor guardado es "default"', () => {
    localStorage.setItem('taller_tenant_slug', 'default');
    expect(getTenantFromURL()).toBe('default');
  });
});

describe('setCurrentTenant / getCurrentTenant', () => {
  beforeEach(() => localStorage.clear());

  it('setCurrentTenant guarda el slug en localStorage', () => {
    setCurrentTenant('mi-taller');
    expect(localStorage.getItem('taller_tenant_slug')).toBe('mi-taller');
  });

  it('getCurrentTenant lee desde localStorage', () => {
    localStorage.setItem('taller_tenant_slug', 'taller-test');
    expect(getCurrentTenant()).toBe('taller-test');
  });

  it('getCurrentTenant devuelve "default" si localStorage vacío', () => {
    expect(getCurrentTenant()).toBe('default');
  });
});

describe('clearTenant', () => {
  it('elimina slug y config del localStorage', () => {
    localStorage.setItem('taller_tenant_slug', 'algo');
    localStorage.setItem('taller_tenant_config', '{"id":1}');
    clearTenant();
    expect(localStorage.getItem('taller_tenant_slug')).toBeNull();
    expect(localStorage.getItem('taller_tenant_config')).toBeNull();
  });
});

describe('getCachedTenantConfig', () => {
  it('devuelve null cuando no hay cache', () => {
    expect(getCachedTenantConfig()).toBeNull();
  });

  it('devuelve el objeto parseado desde localStorage', () => {
    const config = { id: 1, name: 'Test', slug: 'test', primary_color: '#000', secondary_color: '#fff', logo: null };
    localStorage.setItem('taller_tenant_config', JSON.stringify(config));
    expect(getCachedTenantConfig()).toEqual(config);
  });

  it('devuelve null si el JSON está corrupto', () => {
    localStorage.setItem('taller_tenant_config', 'json-invalido{{{');
    expect(getCachedTenantConfig()).toBeNull();
  });
});

describe('isMultiTenant', () => {
  beforeEach(() => localStorage.clear());

  it('devuelve false cuando tenant es "default"', () => {
    expect(isMultiTenant()).toBe(false);
  });

  it('devuelve true cuando hay un slug real', () => {
    localStorage.setItem('taller_tenant_slug', 'mi-taller');
    expect(isMultiTenant()).toBe(true);
  });
});

describe('fetchTenantConfig', () => {
  it('devuelve null cuando el fetch falla (404)', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 } as Response);
    expect(await fetchTenantConfig('tenant-inexistente')).toBeNull();
  });

  it('devuelve el config y lo guarda en localStorage cuando el fetch es exitoso', async () => {
    const mockConfig = { id: 1, name: 'Test', slug: 'test', primary_color: '#000', secondary_color: '#fff', logo: null };
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => mockConfig } as Response);

    const result = await fetchTenantConfig('test');
    expect(result).toEqual(mockConfig);
    expect(localStorage.getItem('taller_tenant_config')).toBe(JSON.stringify(mockConfig));
  });

  it('devuelve null cuando fetch lanza excepción de red', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));
    expect(await fetchTenantConfig('test')).toBeNull();
  });
});

describe('initTenant con discoverSingleTenant', () => {
  beforeEach(() => { localStorage.clear(); setHostname('localhost'); });

  it('llama al endpoint active-single cuando slug es default y lo guarda', async () => {
    const mockFetch = vi.fn();
    global.fetch = mockFetch;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ slug: 'taller-real', name: 'Taller Real', id: 1 }),
    } as Response);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 1, name: 'Taller Real', slug: 'taller-real', primary_color: '#000', secondary_color: '#fff', logo: null }),
    } as Response);

    const result = await initTenant();

    const firstCall = mockFetch.mock.calls[0][0] as string;
    expect(firstCall).toContain('active-single');
    expect(localStorage.getItem('taller_tenant_slug')).toBe('taller-real');
    expect(result?.slug).toBe('taller-real');
  });

  it('devuelve cache cuando active-single devuelve 404', async () => {
    const cached = { id: 2, name: 'Cached', slug: 'cached', primary_color: '#000', secondary_color: '#fff', logo: null };
    localStorage.setItem('taller_tenant_config', JSON.stringify(cached));

    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 } as Response);

    const result = await initTenant();
    expect(result).toEqual(cached);
  });

  it('no llama active-single cuando slug viene de localStorage', async () => {
    localStorage.setItem('taller_tenant_slug', 'taller-guardado');

    const mockFetch = vi.fn();
    global.fetch = mockFetch;
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 1, name: 'Test', slug: 'taller-guardado', primary_color: '#000', secondary_color: '#fff', logo: null }),
    } as Response);

    await initTenant();

    const calls = mockFetch.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(calls.some((url) => url.includes('active-single'))).toBe(false);
  });
});
```

---

## Orden de Implementación

```
PASO 0  ← PRIMERO (bloquea Paso 5)
  pytest-asyncio + asyncio_mode + InMemoryChannelLayer

PASO 1  ← Sin dependencias, endpoint simple
  tenants/test_api.py → TestActiveSingleEndpoint

PASO 2  ← Depende de fixtures del Paso 1
  appointments/test_api.py → TestPerformCreateTenantResolution

PASO 3  ← Mayor impacto, puede hacerse en paralelo con Paso 1
  appointments/test_signals.py → nuevo archivo completo

PASO 4  ← Depende de entender cómo se llama NotificationService (Paso 3)
  notifications/test_services.py → nuevo archivo

PASO 5  ← Depende de Paso 0 + Paso 4
  notifications/test_consumer.py → async WebSocket tests

PASO 6  ← Totalmente independiente del backend (paralelo a Pasos 3-4)
  Frontend: vitest setup + tenant.test.ts
```

---

## Tabla de Impacto en Coverage

| Paso | Archivo | Líneas cubiertas | Delta |
|------|---------|-----------------|-------|
| 1 | `apps/tenants/views.py` (+active_single) | ~25 | +0.3% |
| 2 | `apps/appointments/views.py` (+perform_create) | ~30 | +0.5% |
| **3** | **`apps/appointments/signals.py` (completo)** | **~120** | **+2.5%** |
| 4 | `apps/notifications/services.py` | ~60 | +0.8% |
| 5 | `apps/notifications/consumers.py` (completo) | ~90 | +1.2% |
| **Total backend** | | **~325** | **+5.3%** |
| 6 | `src/lib/tenant.ts` | ~120 líneas TS | nueva base |

`apps/notifications/` pasa de **0% a ~80%** de cobertura con los Pasos 4 y 5.

---

## Archivos a Crear o Modificar

### Backend

| Acción | Ruta |
|--------|------|
| MODIFICAR | `backend-taller-pro/requirements.txt` |
| MODIFICAR | `backend-taller-pro/pytest.ini` |
| MODIFICAR | `backend-taller-pro/config/settings/testing.py` |
| MODIFICAR | `backend-taller-pro/apps/tenants/tests/test_api.py` |
| MODIFICAR | `backend-taller-pro/apps/appointments/tests/test_api.py` |
| CREAR | `backend-taller-pro/apps/appointments/tests/test_signals.py` |
| CREAR | `backend-taller-pro/apps/notifications/tests/__init__.py` |
| CREAR | `backend-taller-pro/apps/notifications/tests/test_services.py` |
| CREAR | `backend-taller-pro/apps/notifications/tests/test_consumer.py` |

### Frontend

| Acción | Ruta |
|--------|------|
| MODIFICAR | `front-end-taller-pro/package.json` |
| CREAR | `front-end-taller-pro/vitest.config.ts` |
| CREAR | `front-end-taller-pro/src/test/setup.ts` |
| CREAR | `front-end-taller-pro/src/lib/__tests__/tenant.test.ts` |
