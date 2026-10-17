// CRUD API for mg_usuario (usuarios).
//
// GET    /usuarios          list (optional ?estado=true|false)
// GET    /usuarios/:id      get one
// POST   /usuarios          create { usuario, correo, password, estado?, nombres?, apaterno?, amaterno? }
// PUT    /usuarios/:id      update { usuario?, correo?, password?, estado?, nombres?, apaterno?, amaterno? }
//
// Las credenciales viven en Supabase Auth (auth.users): POST/PUT reciben
// `password` en texto plano y la envían a Auth; mg_usuario solo guarda el
// enlace (auth_id). Nada de password_hash se acepta ni se devuelve (las
// respuestas se limitan a PUBLIC_COLUMNS).

import { getServiceClient } from "../_shared/client.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { crearUsuarioAuth, eliminarUsuarioAuth } from "../_shared/auth.ts";
import {
  dbErrorStatus,
  errorResponse,
  jsonResponse,
  parseId,
  splitPath,
} from "../_shared/http.ts";

const FUNCTION_NAME = "usuarios";
const TABLE = "mg_usuario";
const PUBLIC_COLUMNS =
  "id_usuario, usuario, correo, estado, fecha_creacion, nombres, apaterno, amaterno";

const CAMPOS_NOMBRE = ["nombres", "apaterno", "amaterno"] as const;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const [idSegment] = splitPath(url, FUNCTION_NAME);
  const supabase = getServiceClient();

  try {
    if (req.method === "GET" && !idSegment) {
      let query = supabase.from(TABLE).select(PUBLIC_COLUMNS).order(
        "id_usuario",
      );
      const estado = url.searchParams.get("estado");
      if (estado === "true" || estado === "false") {
        query = query.eq("estado", estado === "true");
      }
      const { data, error } = await query;
      if (error) return errorResponse(error.message, 500);
      return jsonResponse(data);
    }

    if (req.method === "GET" && idSegment) {
      const id = parseId(idSegment);
      if (id === null) return errorResponse("id inválido", 400);
      const { data, error } = await supabase
        .from(TABLE)
        .select(PUBLIC_COLUMNS)
        .eq("id_usuario", id)
        .maybeSingle();
      if (error) return errorResponse(error.message, 500);
      if (!data) return errorResponse("Usuario no encontrado", 404);
      return jsonResponse(data);
    }

    if (req.method === "POST" && !idSegment) {
      const body = await req.json().catch(() => null);
      if (
        !body ||
        typeof body.usuario !== "string" || body.usuario.trim() === "" ||
        typeof body.correo !== "string" || !EMAIL_RE.test(body.correo) ||
        typeof body.password !== "string" || body.password.length < 6
      ) {
        return errorResponse(
          "'usuario' (texto), 'correo' (email válido) y 'password' (mínimo 6 caracteres) son requeridos",
          400,
        );
      }
      // Las credenciales viven en Supabase Auth; mg_usuario guarda el enlace.
      const creado = await crearUsuarioAuth(
        supabase,
        body.correo,
        body.password,
      );
      if ("error" in creado) return errorResponse(creado.error, creado.status);

      const insert: Record<string, unknown> = {
        usuario: body.usuario,
        correo: body.correo,
        auth_id: creado.authId,
      };
      if (typeof body.estado === "boolean") insert.estado = body.estado;
      for (const campo of CAMPOS_NOMBRE) {
        const v = body[campo];
        if (v === undefined || v === null) continue;
        if (typeof v !== "string") {
          await eliminarUsuarioAuth(supabase, creado.authId);
          return errorResponse(`'${campo}' debe ser texto`, 400);
        }
        insert[campo] = v.trim() || null;
      }

      const { data, error } = await supabase
        .from(TABLE)
        .insert(insert)
        .select(PUBLIC_COLUMNS)
        .single();
      if (error) {
        await eliminarUsuarioAuth(supabase, creado.authId);
        return errorResponse(error.message, dbErrorStatus(error));
      }
      return jsonResponse(data, 201);
    }

    if ((req.method === "PUT" || req.method === "PATCH") && idSegment) {
      const id = parseId(idSegment);
      if (id === null) return errorResponse("id inválido", 400);
      const body = await req.json().catch(() => null);
      if (!body || typeof body !== "object") {
        return errorResponse("Cuerpo de la solicitud inválido", 400);
      }

      const update: Record<string, unknown> = {};
      if (body.usuario !== undefined) {
        if (typeof body.usuario !== "string" || body.usuario.trim() === "") {
          return errorResponse("'usuario' debe ser texto no vacío", 400);
        }
        update.usuario = body.usuario;
      }
      if (body.correo !== undefined) {
        if (typeof body.correo !== "string" || !EMAIL_RE.test(body.correo)) {
          return errorResponse("'correo' debe ser un email válido", 400);
        }
        update.correo = body.correo;
      }
      if (body.password !== undefined) {
        if (typeof body.password !== "string" || body.password.length < 6) {
          return errorResponse(
            "'password' debe tener al menos 6 caracteres",
            400,
          );
        }
      }
      if (body.estado !== undefined) {
        if (typeof body.estado !== "boolean") {
          return errorResponse("'estado' debe ser booleano", 400);
        }
        update.estado = body.estado;
      }
      for (const campo of CAMPOS_NOMBRE) {
        const v = body[campo];
        if (v === undefined) continue;
        if (v !== null && typeof v !== "string") {
          return errorResponse(`'${campo}' debe ser texto o null`, 400);
        }
        update[campo] = typeof v === "string" ? v.trim() || null : null;
      }
      const nuevaPassword: string | undefined = body.password;
      if (Object.keys(update).length === 0 && nuevaPassword === undefined) {
        return errorResponse("No hay campos para actualizar", 400);
      }

      const { data: actual, error: errorActual } = await supabase
        .from(TABLE)
        .select("correo, auth_id")
        .eq("id_usuario", id)
        .maybeSingle();
      if (errorActual) return errorResponse(errorActual.message, 500);
      if (!actual) return errorResponse("Usuario no encontrado", 404);

      // Cuenta legada sin Auth: si llega una contraseña, se crea ahora su
      // usuario en Auth (con el correo nuevo, si también cambia).
      let authIdNuevo: string | null = null;
      if (!actual.auth_id && nuevaPassword !== undefined) {
        const creado = await crearUsuarioAuth(
          supabase,
          (update.correo as string | undefined) ?? actual.correo,
          nuevaPassword,
        );
        if ("error" in creado) {
          return errorResponse(creado.error, creado.status);
        }
        authIdNuevo = creado.authId;
        update.auth_id = authIdNuevo;
        update.password_hash = null;
      }

      if (Object.keys(update).length > 0) {
        const { error } = await supabase
          .from(TABLE)
          .update(update)
          .eq("id_usuario", id);
        if (error) {
          if (authIdNuevo) await eliminarUsuarioAuth(supabase, authIdNuevo);
          return errorResponse(error.message, dbErrorStatus(error));
        }
      }

      // Cuenta ya enlazada: propaga correo/contraseña a Auth. Si falla se
      // revierte el correo en mg_usuario para no dejar ambos desalineados.
      if (actual.auth_id && (nuevaPassword !== undefined || update.correo)) {
        const cambios: Record<string, unknown> = {};
        if (update.correo) {
          cambios.email = update.correo;
          cambios.email_confirm = true;
        }
        if (nuevaPassword !== undefined) cambios.password = nuevaPassword;
        const { error: errorAuth } = await supabase.auth.admin.updateUserById(
          actual.auth_id,
          cambios,
        );
        if (errorAuth) {
          if (update.correo) {
            await supabase.from(TABLE).update({ correo: actual.correo }).eq(
              "id_usuario",
              id,
            );
          }
          return errorResponse(
            errorAuth.message,
            errorAuth.code === "email_exists" ? 409 : 500,
          );
        }
      }

      const { data, error } = await supabase
        .from(TABLE)
        .select(PUBLIC_COLUMNS)
        .eq("id_usuario", id)
        .maybeSingle();
      if (error) return errorResponse(error.message, 500);
      return jsonResponse(data);
    }

    return errorResponse("Ruta o método no soportado", 404);
  } catch (err) {
    return errorResponse(
      err instanceof Error ? err.message : "Error inesperado",
      500,
    );
  }
});
