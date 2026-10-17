// CRUD API for mg_aprendizaje. No hay endpoint DELETE.
//
// GET  /aprendizajes?id_anio_lectivo=1&estado=true&q=texto   list (optional filters)
//   'q' busca (ILIKE parcial) en nombre_aprendizaje
// GET  /aprendizajes/:id                                     get one
// POST /aprendizajes   { nombre_aprendizaje, id_anio_lectivo?, estado? }
//   (nombre_aprendizaje obligatorio)
// PUT  /aprendizajes/:id   { nombre_aprendizaje?, id_anio_lectivo?, estado? }

import { getServiceClient } from "../_shared/client.ts";
import { corsHeaders } from "../_shared/cors.ts";
import {
  busquedaIlikeOr,
  dbErrorStatus,
  errorResponse,
  jsonResponse,
  parseId,
  sanitizarBusqueda,
  splitPath,
} from "../_shared/http.ts";

const FUNCTION_NAME = "aprendizajes";
const TABLE = "mg_aprendizaje";

const COLUMNAS_BUSQUEDA = ["nombre_aprendizaje"] as const;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const [idSegment] = splitPath(url, FUNCTION_NAME);
  const supabase = getServiceClient();

  try {
    if (req.method === "GET" && !idSegment) {
      let query = supabase.from(TABLE).select("*").order("id_aprendizaje");

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

      const q = url.searchParams.get("q");
      if (q !== null && q.trim() !== "") {
        query = query.or(
          busquedaIlikeOr(sanitizarBusqueda(q), COLUMNAS_BUSQUEDA),
        );
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
        .eq("id_aprendizaje", id)
        .maybeSingle();
      if (error) return errorResponse(error.message, 500);
      if (!data) return errorResponse("Aprendizaje no encontrado", 404);
      return jsonResponse(data);
    }

    if (req.method === "POST" && !idSegment) {
      const body = await req.json().catch(() => null);
      if (
        !body ||
        typeof body.nombre_aprendizaje !== "string" ||
        body.nombre_aprendizaje.trim() === ""
      ) {
        return errorResponse(
          "'nombre_aprendizaje' es requerido y debe ser texto",
          400,
        );
      }
      if (body.id_anio_lectivo !== undefined && body.id_anio_lectivo !== null) {
        if (
          typeof body.id_anio_lectivo !== "number" ||
          !Number.isInteger(body.id_anio_lectivo)
        ) {
          return errorResponse("'id_anio_lectivo' debe ser un entero", 400);
        }
      }

      const insert: Record<string, unknown> = {
        nombre_aprendizaje: body.nombre_aprendizaje,
      };
      if (body.id_anio_lectivo !== undefined) {
        insert.id_anio_lectivo = body.id_anio_lectivo;
      }
      if (typeof body.estado === "boolean") insert.estado = body.estado;

      const { data, error } = await supabase
        .from(TABLE)
        .insert(insert)
        .select("*")
        .single();
      if (error) return errorResponse(error.message, dbErrorStatus(error));
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
      if (body.nombre_aprendizaje !== undefined) {
        if (
          typeof body.nombre_aprendizaje !== "string" ||
          body.nombre_aprendizaje.trim() === ""
        ) {
          return errorResponse(
            "'nombre_aprendizaje' debe ser texto no vacío",
            400,
          );
        }
        update.nombre_aprendizaje = body.nombre_aprendizaje;
      }
      if (body.id_anio_lectivo !== undefined) {
        if (
          body.id_anio_lectivo !== null &&
          (typeof body.id_anio_lectivo !== "number" ||
            !Number.isInteger(body.id_anio_lectivo))
        ) {
          return errorResponse("'id_anio_lectivo' debe ser un entero", 400);
        }
        update.id_anio_lectivo = body.id_anio_lectivo;
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
        .eq("id_aprendizaje", id)
        .select("*")
        .maybeSingle();
      if (error) return errorResponse(error.message, dbErrorStatus(error));
      if (!data) return errorResponse("Aprendizaje no encontrado", 404);
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
