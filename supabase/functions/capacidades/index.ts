// CRUD API for mg_capacidades. No hay endpoint DELETE.
//
// GET  /capacidades?id_competencia=1&estado=true&q=texto   list (optional filters)
//   'q' busca (ILIKE parcial) en descripcion
// GET  /capacidades/:id
// POST /capacidades   { descripcion, id_competencia?, estado? }
//   (descripcion obligatoria)
// PUT  /capacidades/:id   { descripcion?, id_competencia?, estado? }

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

const FUNCTION_NAME = "capacidades";
const TABLE = "mg_capacidades";

const COLUMNAS_BUSQUEDA = ["descripcion"] as const;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const [idSegment] = splitPath(url, FUNCTION_NAME);
  const supabase = getServiceClient();

  try {
    if (req.method === "GET" && !idSegment) {
      let query = supabase.from(TABLE).select("*").order("id_capacidad");

      const idCompetencia = url.searchParams.get("id_competencia");
      if (idCompetencia !== null) {
        const parsed = parseId(idCompetencia);
        if (parsed === null) {
          return errorResponse("'id_competencia' inválido", 400);
        }
        query = query.eq("id_competencia", parsed);
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
        .eq("id_capacidad", id)
        .maybeSingle();
      if (error) return errorResponse(error.message, 500);
      if (!data) return errorResponse("Capacidad no encontrada", 404);
      return jsonResponse(data);
    }

    if (req.method === "POST" && !idSegment) {
      const body = await req.json().catch(() => null);
      if (
        !body ||
        typeof body.descripcion !== "string" ||
        body.descripcion.trim() === ""
      ) {
        return errorResponse(
          "'descripcion' es requerida y debe ser texto",
          400,
        );
      }
      if (body.id_competencia !== undefined && body.id_competencia !== null) {
        if (
          typeof body.id_competencia !== "number" ||
          !Number.isInteger(body.id_competencia)
        ) {
          return errorResponse("'id_competencia' debe ser un entero", 400);
        }
      }

      const insert: Record<string, unknown> = {
        descripcion: body.descripcion,
      };
      if (body.id_competencia !== undefined) {
        insert.id_competencia = body.id_competencia;
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
      if (body.descripcion !== undefined) {
        if (
          typeof body.descripcion !== "string" ||
          body.descripcion.trim() === ""
        ) {
          return errorResponse("'descripcion' debe ser texto no vacío", 400);
        }
        update.descripcion = body.descripcion;
      }
      if (body.id_competencia !== undefined) {
        if (
          body.id_competencia !== null &&
          (typeof body.id_competencia !== "number" ||
            !Number.isInteger(body.id_competencia))
        ) {
          return errorResponse("'id_competencia' debe ser un entero", 400);
        }
        update.id_competencia = body.id_competencia;
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
        .eq("id_capacidad", id)
        .select("*")
        .maybeSingle();
      if (error) return errorResponse(error.message, dbErrorStatus(error));
      if (!data) return errorResponse("Capacidad no encontrada", 404);
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
