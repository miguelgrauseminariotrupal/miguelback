// CRUD API for mg_nivel (niveles), scoped to un año lectivo.
//
// GET    /niveles?id_anio_lectivo=1&estado=true   list (id_anio_lectivo optional filter)
// GET    /niveles/:id                             get one
// POST   /niveles                                 create { id_anio_lectivo, nombre, estado? } (id_anio_lectivo y nombre obligatorios)
// PUT    /niveles/:id                             update { id_anio_lectivo?, nombre?, estado? }

import { getServiceClient } from "../_shared/client.ts";
import { corsHeaders } from "../_shared/cors.ts";
import {
  dbErrorStatus,
  errorResponse,
  jsonResponse,
  parseId,
  splitPath,
} from "../_shared/http.ts";

const FUNCTION_NAME = "niveles";
const TABLE = "mg_nivel";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const [idSegment] = splitPath(url, FUNCTION_NAME);
  const supabase = getServiceClient();

  try {
    if (req.method === "GET" && !idSegment) {
      let query = supabase.from(TABLE).select("*").order("id_nivel");

      const idAnioLectivo = url.searchParams.get("id_anio_lectivo");
      if (idAnioLectivo !== null) {
        const parsed = parseId(idAnioLectivo);
        if (parsed === null) {
          return errorResponse("'id_anio_lectivo' inválido", 400);
        }
        query = query.eq("id_anio_lectivo", parsed);
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
        .eq("id_nivel", id)
        .maybeSingle();
      if (error) return errorResponse(error.message, 500);
      if (!data) return errorResponse("Nivel no encontrado", 404);
      return jsonResponse(data);
    }

    if (req.method === "POST" && !idSegment) {
      const body = await req.json().catch(() => null);
      if (
        !body ||
        typeof body.id_anio_lectivo !== "number" ||
        !Number.isInteger(body.id_anio_lectivo) ||
        typeof body.nombre !== "string" ||
        body.nombre.trim() === ""
      ) {
        return errorResponse(
          "'id_anio_lectivo' (entero) y 'nombre' (texto no vacío) son requeridos",
          400,
        );
      }
      const insert: Record<string, unknown> = {
        id_anio_lectivo: body.id_anio_lectivo,
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
          msgError = "Ya existe el nivel."
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
      if (body.id_anio_lectivo !== undefined) {
        if (
          typeof body.id_anio_lectivo !== "number" ||
          !Number.isInteger(body.id_anio_lectivo)
        ) {
          return errorResponse("'id_anio_lectivo' debe ser un entero", 400);
        }
        update.id_anio_lectivo = body.id_anio_lectivo;
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
        .eq("id_nivel", id)
        .select("*")
        .maybeSingle();
      if (error) return errorResponse(error.message, dbErrorStatus(error));
      if (!data) return errorResponse("Nivel no encontrado", 404);
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
