// CRUD API for mg_seccion (secciones), scoped to un grado.
//
// GET    /secciones?id_grado=1&estado=true   list (id_grado optional filter)
// GET    /secciones/:id                      get one
// POST   /secciones                          create { id_grado, nombre, estado? } (id_grado y nombre obligatorios)
// PUT    /secciones/:id                      update { id_grado?, nombre?, estado? }

import { getServiceClient } from "../_shared/client.ts";
import { corsHeaders } from "../_shared/cors.ts";
import {
  dbErrorStatus,
  errorResponse,
  jsonResponse,
  parseId,
  splitPath,
} from "../_shared/http.ts";

const FUNCTION_NAME = "secciones";
const TABLE = "mg_seccion";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const [idSegment] = splitPath(url, FUNCTION_NAME);
  const supabase = getServiceClient();

  try {
    if (req.method === "GET" && !idSegment) {
      let query = supabase.from(TABLE).select("*").order("id_seccion");

      const idGrado = url.searchParams.get("id_grado");
      if (idGrado !== null) {
        const parsed = parseId(idGrado);
        if (parsed === null) return errorResponse("'id_grado' inválido", 400);
        query = query.eq("id_grado", parsed);
      }

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
        .eq("id_seccion", id)
        .maybeSingle();
      if (error) return errorResponse(error.message, 500);
      if (!data) return errorResponse("Sección no encontrada", 404);
      return jsonResponse(data);
    }

    if (req.method === "POST" && !idSegment) {
      const body = await req.json().catch(() => null);
      if (
        !body ||
        typeof body.id_grado !== "number" ||
        !Number.isInteger(body.id_grado) ||
        typeof body.nombre !== "string" ||
        body.nombre.trim() === ""
      ) {
        return errorResponse(
          "'id_grado' (entero) y 'nombre' (texto no vacío) son requeridos",
          400,
        );
      }
      const insert: Record<string, unknown> = {
        id_grado: body.id_grado,
        nombre: body.nombre,
      };
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
          msgError = "Ya existe la sección."
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
      if (body.id_grado !== undefined) {
        if (
          typeof body.id_grado !== "number" ||
          !Number.isInteger(body.id_grado)
        ) {
          return errorResponse("'id_grado' debe ser un entero", 400);
        }
        update.id_grado = body.id_grado;
      }
      if (body.nombre !== undefined) {
        if (typeof body.nombre !== "string" || body.nombre.trim() === "") {
          return errorResponse("'nombre' debe ser texto no vacío", 400);
        }
        update.nombre = body.nombre;
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
        .eq("id_seccion", id)
        .select("*")
        .maybeSingle();
      if (error) return errorResponse(error.message, dbErrorStatus(error));
      if (!data) return errorResponse("Sección no encontrada", 404);
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
