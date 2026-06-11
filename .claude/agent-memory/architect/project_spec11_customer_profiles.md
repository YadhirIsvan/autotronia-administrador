---
name: spec_11 customer_profiles ForeignKey migration impact
description: Bug regresivo post-migración Customer.user OneToOneField->ForeignKey; accessor cambia de customer_profile a customer_profiles; ya corregido en código activo, pendiente tests
type: project
---

Customer.user migrado de OneToOneField (related_name='customer_profile') a ForeignKey (related_name='customer_profiles') para soportar un usuario siendo cliente en N tenants.

**Why:** Multi-tenant requiere que el mismo usuario pueda tener Customer en distintos talleres. UniqueConstraint en ('user', 'tenant') garantiza unicidad por taller.

**Estado al 2026-03-20:**
- shared/permissions.py: DONE — IsCustomer y CanManageVehicles ya usan customer_profiles
- apps/core/views.py: DONE — usa customer_profiles.filter(tenant=...).first()
- apps/workshop/views.py, apps/customers/views.py, apps/appointments/views.py: DONE
- No quedan referencias activas a customer_profile (singular) como accessor de FK
- Migracion 0002 aplicada correctamente
- Pendiente: tests en apps/customers/tests/test_customer_permissions.py (spec_11)
- Pendiente: fixtures customer_with_user y customer_api_client en conftest.py

**How to apply:** Si aparece un 403 inesperado en el panel de clientes, buscar primero customer_profile (singular) en el archivo sospechoso.
