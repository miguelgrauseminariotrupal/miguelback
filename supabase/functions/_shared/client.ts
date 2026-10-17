import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * Service-role client for the academic management functions.
 *
 * NOTE: these functions do not validate a caller identity yet (no auth
 * layer), so every request runs with elevated database access. Revisit
 * this before exposing the functions outside of trusted admin tooling.
 */
export function getServiceClient() {
  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(url, serviceRoleKey);
}

/**
 * Cliente con la anon key y sin sesión persistente: se usa solo para los
 * flujos de Supabase Auth que actúan como el usuario final
 * (signInWithPassword, refreshSession). Nunca usar el service client para
 * esto: dejaría la sesión del usuario pegada al cliente del servidor.
 */
export function getAnonClient() {
  const url = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
