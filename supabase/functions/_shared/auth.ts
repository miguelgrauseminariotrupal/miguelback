// Integración con Supabase Auth (auth.users). Las credenciales viven en Auth;
// mg_usuario guarda los datos de negocio y se enlaza por mg_usuario.auth_id.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { errorResponse } from "./http.ts";

export type ResultadoAuth =
  | { authId: string }
  | { error: string; status: number };

/** Crea el usuario en auth.users (correo ya confirmado). */
export async function crearUsuarioAuth(
  supabase: SupabaseClient,
  email: string,
  password: string,
): Promise<ResultadoAuth> {
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data?.user) {
    if (error?.code === "email_exists") {
      return { error: "Ya existe un usuario con ese correo.", status: 409 };
    }
    if (error?.code === "weak_password") {
      return { error: error.message, status: 400 };
    }
    return { error: error?.message ?? "No se pudo crear el usuario", status: 500 };
  }
  return { authId: data.user.id };
}

/** Compensación: elimina un usuario de Auth creado en una operación fallida. */
export async function eliminarUsuarioAuth(
  supabase: SupabaseClient,
  authId: string,
): Promise<boolean> {
  const { error } = await supabase.auth.admin.deleteUser(authId);
  return !error;
}

/** Códigos de los roles activos de un mg_usuario. */
export async function cargarRoles(
  supabase: SupabaseClient,
  idUsuario: number,
): Promise<string[]> {
  const { data } = await supabase
    .from("mg_usuario_rol")
    .select("mg_rol(codigo, estado)")
    .eq("id_usuario", idUsuario)
    .eq("estado", true);
  const roles: string[] = [];
  for (const fila of (data ?? []) as unknown as Array<{ mg_rol: unknown }>) {
    const rol = Array.isArray(fila.mg_rol) ? fila.mg_rol[0] : fila.mg_rol;
    const r = rol as { codigo?: string; estado?: boolean } | null;
    if (r?.codigo && r.estado !== false) roles.push(r.codigo);
  }
  return roles;
}

/**
 * Autorización por rol: devuelve una Response 403 si el usuario no tiene
 * ninguno de los roles dados, o null si puede continuar.
 *
 *   const sinPermiso = exigirRol(ctx, ["ADMIN"]);
 *   if (sinPermiso) return sinPermiso;
 */
export function exigirRol(
  ctx: ContextoAuth,
  rolesPermitidos: readonly string[],
): Response | null {
  if (ctx.roles.some((r) => rolesPermitidos.includes(r))) return null;
  return errorResponse("No tienes permiso para esta operación", 403);
}

/** Roles con acceso a todas las secciones. El resto solo ve las suyas. */
export const ROLES_ACCESO_TOTAL = ["ADMIN"] as const;

export type AlcanceSecciones =
  | { todas: true }
  | { todas: false; secciones: number[] };

/**
 * Secciones de las que el usuario es docente responsable (tutor):
 * mg_docente.id_usuario -> mg_programacion_seccion.id_docente_responsable.
 */
export async function seccionesDelResponsable(
  supabase: SupabaseClient,
  idUsuario: number,
): Promise<number[]> {
  const { data: docente } = await supabase
    .from("mg_docente")
    .select("id_docente")
    .eq("id_usuario", idUsuario)
    .eq("estado", true)
    .maybeSingle();
  if (!docente) return [];

  const { data } = await supabase
    .from("mg_programacion_seccion")
    .select("id_seccion")
    .eq("id_docente_responsable", docente.id_docente);
  return ((data ?? []) as Array<{ id_seccion: number }>).map((f) => f.id_seccion);
}

/**
 * Qué secciones puede consultar el usuario: todas si tiene un rol de
 * ROLES_ACCESO_TOTAL; si no, solo aquellas donde es docente responsable.
 */
export async function alcanceSecciones(
  supabase: SupabaseClient,
  ctx: ContextoAuth,
): Promise<AlcanceSecciones> {
  if (ctx.roles.some((r) => (ROLES_ACCESO_TOTAL as readonly string[]).includes(r))) {
    return { todas: true };
  }
  return {
    todas: false,
    secciones: await seccionesDelResponsable(supabase, ctx.usuario.id_usuario),
  };
}

export function puedeVerSeccion(
  alcance: AlcanceSecciones,
  idSeccion: number,
): boolean {
  return alcance.todas || alcance.secciones.includes(idSeccion);
}

export interface ContextoAuth {
  authId: string;
  usuario: {
    id_usuario: number;
    usuario: string;
    correo: string;
    estado: boolean;
  };
  roles: string[];
}

/**
 * Valida el `Authorization: Bearer <access_token>` de Supabase Auth y lo
 * resuelve a su mg_usuario (activo) y roles. Devuelve el contexto, o una
 * Response 401 lista para retornar.
 *
 * Uso:
 *   const ctx = await requireAuth(req, supabase);
 *   if (ctx instanceof Response) return ctx;
 *   if (!ctx.roles.includes("ADMIN")) return errorResponse("Prohibido", 403);
 */
export async function requireAuth(
  req: Request,
  supabase: SupabaseClient,
): Promise<ContextoAuth | Response> {
  const header = req.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return errorResponse("No autenticado", 401);

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return errorResponse("Token inválido o vencido", 401);

  const { data: usuario, error: errorUsuario } = await supabase
    .from("mg_usuario")
    .select("id_usuario, usuario, correo, estado")
    .eq("auth_id", data.user.id)
    .maybeSingle();
  if (errorUsuario) return errorResponse(errorUsuario.message, 500);
  if (!usuario || !usuario.estado) {
    return errorResponse("Usuario inactivo o no registrado", 401);
  }

  return {
    authId: data.user.id,
    usuario,
    roles: await cargarRoles(supabase, usuario.id_usuario),
  };
}
