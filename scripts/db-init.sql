-- A non-superuser, non-BYPASSRLS application role: superusers would silently skip row-level security.
create role app login password 'app' nosuperuser nobypassrls;
create database sim owner app;
create database sim_test owner app;
