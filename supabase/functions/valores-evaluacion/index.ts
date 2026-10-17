// CRUD API for mg_valor_evaluacion (catálogo de valores de evaluación,
// ej. A, B, C). No hay endpoint DELETE.
//
// GET  /valores-evaluacion?estado=true&q=A   list (optional filters)
//   'q' busca (ILIKE parcial) en codigo/descripcion
// GET  /valores-evaluacion/:id                get one
// POST /valores-evaluacion                    create { codigo, descripcion, estado? }
//   (codigo y descripcion obligatorios)
// PUT  /valores-evaluacion/:id                update { codigo?, descripcion?, estado? }

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

const FUNCTION_NAME = "valores-evaluacion";
const TABLE = "mg_valor_evaluacion";

const COLUMNAS_BUSQUEDA = ["codigo", "descripcion"] as const;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const [idSegment] = splitPath(url, FUNCTION_NAME);
  const supabase = getServiceClient();

  try {
    if (req.method === "GET" && !idSegment) {
      let query = supabase.from(TABLE).select("*").order("id_valor");

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
        .eq("id_valor", id)
        .maybeSingle();
      if (error) return errorResponse(error.message, 500);
      if (!data) return errorResponse("Valor de evaluación no encontrado", 404);
      return jsonResponse(data);
    }

    if (req.method === "POST" && !idSegment) {
      const body = await req.json().catch(() => null);
      if (
        !body ||
        typeof body.codigo !== "string" || body.codigo.trim() === "" ||
        typeof body.descripcion !== "string" || body.descripcion.trim() === ""
      ) {
        return errorResponse(
          "'codigo' y 'descripcion' (texto no vacío) son requeridos",
          400,
        );
      }
      const insert: Record<string, unknown> = {
        codigo: body.codigo,
        descripcion: body.descripcion,
      };
      if (typeof body.estado === "boolean") insert.estado = body.estado;

      const { data, error } = await supabase
        .from(TABLE)
        .insert(insert)
        .select("*")
        .single();
      if (error) {
        const status = dbErrorStatus(error);
        const message = status === 409
          ? "Ya existe un valor de evaluación con ese código."
          : error.message;
        return errorResponse(message, status);
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
      if (body.codigo !== undefined) {
        if (typeof body.codigo !== "string" || body.codigo.trim() === "") {
          return errorResponse("'codigo' debe ser texto no vacío", 400);
        }
        update.codigo = body.codigo;
      }
      if (body.descripcion !== undefined) {
        if (
          typeof body.descripcion !== "string" ||
          body.descripcion.trim() === ""
        ) {
          return errorResponse("'descripcion' debe ser texto no vacío", 400);
        }
        update.descripcion = body.descripcion;
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
        .eq("id_valor", id)
        .select("*")
        .maybeSingle();
      if (error) {
        const status = dbErrorStatus(error);
        const message = status === 409
          ? "Ya existe un valor de evaluación con ese código."
          : error.message;
        return errorResponse(message, status);
      }
      if (!data) return errorResponse("Valor de evaluación no encontrado", 404);
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
