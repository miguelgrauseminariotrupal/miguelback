-- Enlaza mg_usuario con Supabase Auth (auth.users).
-- Las credenciales pasan a vivir en auth.users; mg_usuario conserva los datos
-- de negocio (roles, docente, auditoría, conversaciones).

alter table public.mg_usuario
  add column if not exists auth_id uuid unique references auth.users(id) on delete cascade;

-- Los usuarios nuevos ya no tienen hash propio. La columna se conserva (ahora
-- opcional) solo para migrar al vuelo a los usuarios existentes en su primer
-- login; cuando todos tengan auth_id se puede eliminar.
alter table public.mg_usuario
  alter column password_hash drop not null;
