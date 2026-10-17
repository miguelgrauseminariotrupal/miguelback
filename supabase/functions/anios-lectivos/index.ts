// CRUD API for mg_anio_lectivo (años lectivos).
//
// GET    /anios-lectivos          list (optional ?estado=true|false)
// GET    /anios-lectivos/:id      get one
// POST   /anios-lectivos          create { anio, nombre, estado? } (anio y nombre obligatorios)
// PUT    /anios-lectivos/:id      update { anio?: number, estado?: boolean }
//
// Seguridad: requiere `Authorization: Bearer <access_token>` (de POST /login).
//   - GET:       cualquier usuario autenticado y activo.
//   - POST/PUT:  solo roles en ROLES_ESCRITURA.

import { exigirRol, requireAuth } from "../_shared/auth.ts";
import { getServiceClient } from "../_shared/client.ts";
import { corsHeaders } from "../_shared/cors.ts";
import {
  dbErrorStatus,
  errorResponse,
  jsonResponse,
  parseId,
  splitPath,
} from "../_shared/http.ts";

const FUNCTION_NAME = "anios-lectivos";
const TABLE = "mg_anio_lectivo";
/** Códigos de mg_rol que pueden crear/modificar años lectivos. */
const ROLES_ESCRITURA = ["ADMIN"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const [idSegment] = splitPath(url, FUNCTION_NAME);
  const supabase = getServiceClient();

  try {
    const ctx = await requireAuth(req, supabase);
    if (ctx instanceof Response) return ctx;

    if (req.method !== "GET") {
      const sinPermiso = exigirRol(ctx, ROLES_ESCRITURA);
      if (sinPermiso) return sinPermiso;
    }

    if (req.method === "GET" && !idSegment) {
      let query = supabase.from(TABLE).select("*").order("anio", {
        ascending: false,
      });
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
        .select("*")
        .eq("id_anio_lectivo", id)
        .maybeSingle();
      if (error) return errorResponse(error.message, 500);
      if (!data) return errorResponse("Año lectivo no encontrado", 404);
      return jsonResponse(data);
    }

    if (req.method === "POST" && !idSegment) {
      const body = await req.json().catch(() => null);
      const { anio,nombre } = body || {};
      if (!anio || !Number.isInteger(anio)) {
        return errorResponse("El campo 'anio' es requerido y debe ser un entero", 400);
      }
      if (!nombre) {
        return errorResponse("El campo 'nombre' es requerido", 400);
      }
      const insert: Record<string, unknown> = { anio, nombre };
      if (typeof body.estado === "boolean") insert.estado = body.estado;

      const { data, error } = await supabase
        .from(TABLE)
        .insert(insert)
        .select("*")
        .single();
        
      if (error){
        const codeError = dbErrorStatus(error);
        let msgError = "Error interno del servidor";
        if (codeError === 409) {
          msgError = "Ya existe el año lectivo."
        }
        return errorResponse(msgError, codeError);
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
      if (body.anio !== undefined) {
        if (typeof body.anio !== "number" || !Number.isInteger(body.anio)) {
          return errorResponse("'anio' debe ser un entero", 400);
        }
        update.anio = body.anio;
      }
      if (body.estado !== undefined) {
        if (typeof body.estado !== "boolean") {
          return errorResponse("'estado' debe ser booleano", 400);
        }
        update.estado = body.estado;
      }
      if (Object.keys(update).length === 0) {
        return errorResponse("No hay campos para actualizar", 400);
      }

      const { data, error } = await supabase
        .from(TABLE)
        .update(update)
        .eq("id_anio_lectivo", id)
        .select("*")
        .maybeSingle();
      if (error) return errorResponse(error.message, dbErrorStatus(error));
      if (!data) return errorResponse("Año lectivo no encontrado", 404);
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
