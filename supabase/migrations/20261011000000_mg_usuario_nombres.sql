-- Datos personales en mg_usuario, para usuarios que no son docentes (p. ej.
-- ADMIN) y aun así necesitan nombre y apellidos (los devuelve /login).
-- Idempotente: si las columnas ya existen en la base no hace nada.
alter table public.mg_usuario
  add column if not exists nombres character varying,
  add column if not exists apaterno character varying,
  add column if not exists amaterno character varying;

-- Los usuarios que ya son docentes y no tienen nombre heredan el de mg_docente.
update public.mg_usuario u
set nombres = d.nombres,
    apaterno = d.apellido_paterno,
    amaterno = d.apellido_materno
from public.mg_docente d
where d.id_usuario = u.id_usuario
  and u.nombres is null;
