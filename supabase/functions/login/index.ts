// Login contra Supabase Auth (auth.users), enlazado a mg_usuario por auth_id.
//
// POST /login            { usuario, password }  -> sesión + correo, nombres, apaterno,
//                                                  amaterno + usuario + docente + roles
//   'usuario' acepta el nombre de usuario o el correo.
// POST /login/refresh    { refresh_token }       -> sesión renovada
// GET  /login/me         (Authorization: Bearer <access_token>) -> usuario + docente + roles
//
// El access_token devuelto es un JWT de Supabase Auth: el frontend lo envía
// en `Authorization: Bearer ...` y se valida con requireAuth (_shared/auth.ts).
//
// Migración al vuelo: si el mg_usuario aún no tiene auth_id pero conserva su
// password_hash legado y la contraseña es correcta, se crea su usuario en Auth
// y se enlaza (el hash legado se borra). Así no hace falta resetear a nadie.

import { getAnonClient, getServiceClient } from "../_shared/client.ts";
import { corsHeaders } from "../_shared/cors.ts";
import {
  cargarRoles,
  crearUsuarioAuth,
  eliminarUsuarioAuth,
  requireAuth,
} from "../_shared/auth.ts";
import { verifyPassword } from "../_shared/password.ts";
import { errorResponse, jsonResponse, splitPath } from "../_shared/http.ts";

const FUNCTION_NAME = "login";
const CREDENCIALES_INVALIDAS = "Credenciales inválidas";

type Cliente = ReturnType<typeof getServiceClient>;

interface SesionAuth {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expires_at?: number;
  token_type: string;
}

function sesionPublica(s: SesionAuth) {
  return {
    access_token: s.access_token,
    refresh_token: s.refresh_token,
    expires_in: s.expires_in,
    expires_at: s.expires_at,
    token_type: s.token_type,
  };
}

async function buscarUsuario(supabase: Cliente, login: string) {
  const columnas =
    "id_usuario, usuario, correo, estado, auth_id, password_hash, nombres, apaterno, amaterno";
  for (const campo of ["usuario", "correo"]) {
    const { data, error } = await supabase
      .from("mg_usuario")
      .select(columnas)
      .eq(campo, login)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (data) return data;
  }
  return null;
}

/** Docente enlazado a un mg_usuario (o null si el usuario no es docente). */
async function buscarDocente(supabase: Cliente, idUsuario: number) {
  const { data } = await supabase
    .from("mg_docente")
    .select("id_docente, nombres, apellido_paterno, apellido_materno, dni, telefono, correo")
    .eq("id_usuario", idUsuario)
    .maybeSingle();
  return data ?? null;
}

/** Nombre y apellidos guardados en mg_usuario. */
async function buscarNombres(supabase: Cliente, idUsuario: number) {
  const { data } = await supabase
    .from("mg_usuario")
    .select("nombres, apaterno, amaterno")
    .eq("id_usuario", idUsuario)
    .maybeSingle();
  return data ?? null;
}

interface Nombres {
  nombres?: string | null;
  apaterno?: string | null;
  amaterno?: string | null;
}

/**
 * Columnas planas de identidad para el frontend. El nombre sale de
 * mg_usuario; si ahí está vacío (cuenta anterior a esas columnas) se usa el del
 * docente enlazado.
 */
function datosPersonales(
  correo: string,
  persona: Nombres | null,
  docente: Awaited<ReturnType<typeof buscarDocente>>,
) {
  return {
    correo,
    nombres: persona?.nombres ?? docente?.nombres ?? null,
    apaterno: persona?.apaterno ?? docente?.apellido_paterno ?? null,
    amaterno: persona?.amaterno ?? docente?.apellido_materno ?? null,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const [accion] = splitPath(url, FUNCTION_NAME);
  const supabase = getServiceClient();

  try {
    if (req.method === "POST" && !accion) {
      const body = await req.json().catch(() => null);
      if (
        !body ||
        typeof body.usuario !== "string" || body.usuario.trim() === "" ||
        typeof body.password !== "string" || body.password === ""
      ) {
        return errorResponse("'usuario' y 'password' son requeridos", 400);
      }
      const login = body.usuario.trim();

      const usuario = await buscarUsuario(supabase, login);
      // Mismo mensaje para "no existe", "inactivo" y "contraseña errónea":
      // no se revela cuál de los tres ocurrió.
      if (!usuario || !usuario.estado) {
        return errorResponse(CREDENCIALES_INVALIDAS, 401);
      }

      if (!usuario.auth_id) {
        if (
          !usuario.password_hash ||
          !(await verifyPassword(body.password, usuario.password_hash))
        ) {
          return errorResponse(CREDENCIALES_INVALIDAS, 401);
        }
        const creado = await crearUsuarioAuth(
          supabase,
          usuario.correo,
          body.password,
        );
        if ("error" in creado) {
          return errorResponse(
            `No se pudo migrar la cuenta a Auth: ${creado.error}`,
            creado.status,
          );
        }
        const { error: errorEnlace } = await supabase
          .from("mg_usuario")
          .update({ auth_id: creado.authId, password_hash: null })
          .eq("id_usuario", usuario.id_usuario);
        if (errorEnlace) {
          await eliminarUsuarioAuth(supabase, creado.authId);
          return errorResponse(errorEnlace.message, 500);
        }
      }

      const { data, error } = await getAnonClient().auth.signInWithPassword({
        email: usuario.correo,
        password: body.password,
      });
      if (error || !data.session) {
        return errorResponse(
          CREDENCIALES_INVALIDAS,
          error?.status === 429 ? 429 : 401,
        );
      }

      const docente = await buscarDocente(supabase, usuario.id_usuario);
      return jsonResponse({
        ...sesionPublica(data.session),
        ...datosPersonales(usuario.correo, usuario, docente),
        usuario: {
          id_usuario: usuario.id_usuario,
          usuario: usuario.usuario,
          correo: usuario.correo,
        },
        docente,
        roles: await cargarRoles(supabase, usuario.id_usuario),
      });
    }

    if (req.method === "POST" && accion === "refresh") {
      const body = await req.json().catch(() => null);
      if (!body || typeof body.refresh_token !== "string" || !body.refresh_token) {
        return errorResponse("'refresh_token' es requerido", 400);
      }
      const { data, error } = await getAnonClient().auth.refreshSession({
        refresh_token: body.refresh_token,
      });
      if (error || !data.session) {
        return errorResponse("Refresh token inválido o vencido", 401);
      }
      return jsonResponse(sesionPublica(data.session));
    }

    if (req.method === "GET" && accion === "me") {
      const ctx = await requireAuth(req, supabase);
      if (ctx instanceof Response) return ctx;
      const docente = await buscarDocente(supabase, ctx.usuario.id_usuario);
      const persona = await buscarNombres(supabase, ctx.usuario.id_usuario);
      return jsonResponse({
        ...datosPersonales(ctx.usuario.correo, persona, docente),
        usuario: ctx.usuario,
        docente,
        roles: ctx.roles,
      });
    }

    return errorResponse("Ruta o método no soportado", 404);
  } catch (err) {
    return errorResponse(
      err instanceof Error ? err.message : "Error inesperado",
      500,
    );
  }
});
