// CRUD API for mg_competencia. No hay endpoint DELETE.
//
// GET  /competencias?id_curso=1&id_aprendizaje=2&estado=true&q=texto
//   'q' busca (ILIKE parcial) en codigo/descripcion
// GET  /competencias/:id
// POST /competencias   { id_curso, descripcion, codigo?, id_aprendizaje?, tipo?, estado? }
//   (id_curso y descripcion obligatorios)
// PUT  /competencias/:id   { id_curso?, descripcion?, codigo?, id_aprendizaje?, tipo?, estado? }

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

const FUNCTION_NAME = "competencias";
const TABLE = "mg_competencia";

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
      let query = supabase.from(TABLE).select("*").order("id_competencia");

      const idCurso = url.searchParams.get("id_curso");
      if (idCurso !== null) {
        const parsed = parseId(idCurso);
        if (parsed === null) return errorResponse("'id_curso' inválido", 400);
        query = query.eq("id_curso", parsed);
      }

      const idAprendizaje = url.searchParams.get("id_aprendizaje");
      if (idAprendizaje !== null) {
        const parsed = parseId(idAprendizaje);
        if (parsed === null) {
          return errorResponse("'id_aprendizaje' inválido", 400);
        }
        query = query.eq("id_aprendizaje", parsed);
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
        .eq("id_competencia", id)
        .maybeSingle();
      if (error) return errorResponse(error.message, 500);
      if (!data) return errorResponse("Competencia no encontrada", 404);
      return jsonResponse(data);
    }

    if (req.method === "POST" && !idSegment) {
      const body = await req.json().catch(() => null);
      if (
        !body ||
        typeof body.id_curso !== "number" ||
        !Number.isInteger(body.id_curso) ||
        typeof body.descripcion !== "string" ||
        body.descripcion.trim() === ""
      ) {
        return errorResponse(
          "'id_curso' (entero) y 'descripcion' (texto no vacío) son requeridos",
          400,
        );
      }
      if (body.id_aprendizaje !== undefined && body.id_aprendizaje !== null) {
        if (
          typeof body.id_aprendizaje !== "number" ||
          !Number.isInteger(body.id_aprendizaje)
        ) {
          return errorResponse("'id_aprendizaje' debe ser un entero", 400);
        }
      }
      if (body.codigo !== undefined && body.codigo !== null) {
        if (typeof body.codigo !== "string") {
          return errorResponse("'codigo' debe ser texto", 400);
        }
      }
      if (body.tipo !== undefined && body.tipo !== null) {
        if (typeof body.tipo !== "string") {
          return errorResponse("'tipo' debe ser texto", 400);
        }
      }

      const insert: Record<string, unknown> = {
        id_curso: body.id_curso,
        descripcion: body.descripcion,
      };
      if (body.codigo !== undefined) insert.codigo = body.codigo;
      if (body.id_aprendizaje !== undefined) {
        insert.id_aprendizaje = body.id_aprendizaje;
      }
      if (body.tipo !== undefined) insert.tipo = body.tipo;
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
      if (body.id_curso !== undefined) {
        if (
          typeof body.id_curso !== "number" || !Number.isInteger(body.id_curso)
        ) {
          return errorResponse("'id_curso' debe ser un entero", 400);
        }
        update.id_curso = body.id_curso;
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
      if (body.codigo !== undefined) {
        if (body.codigo !== null && typeof body.codigo !== "string") {
          return errorResponse("'codigo' debe ser texto", 400);
        }
        update.codigo = body.codigo;
      }
      if (body.id_aprendizaje !== undefined) {
        if (
          body.id_aprendizaje !== null &&
          (typeof body.id_aprendizaje !== "number" ||
            !Number.isInteger(body.id_aprendizaje))
        ) {
          return errorResponse("'id_aprendizaje' debe ser un entero", 400);
        }
        update.id_aprendizaje = body.id_aprendizaje;
      }
      if (body.tipo !== undefined) {
        if (body.tipo !== null && typeof body.tipo !== "string") {
          return errorResponse("'tipo' debe ser texto", 400);
        }
        update.tipo = body.tipo;
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
        .eq("id_competencia", id)
        .select("*")
        .maybeSingle();
      if (error) return errorResponse(error.message, dbErrorStatus(error));
      if (!data) return errorResponse("Competencia no encontrada", 404);
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
