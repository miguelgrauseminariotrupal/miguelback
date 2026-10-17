// CRUD API for mg_programacion_curso. No hay endpoint DELETE.
//
// GET  /programacion-cursos?id_programacion_seccion=1&id_curso=2&id_docente=3&estado=true
// GET  /programacion-cursos/:id
// POST /programacion-cursos   { id_programacion_seccion, id_curso, id_docente, estado? }
// PUT  /programacion-cursos/:id   { id_programacion_seccion?, id_curso?, id_docente?, estado? }

import { getServiceClient } from "../_shared/client.ts";
import { corsHeaders } from "../_shared/cors.ts";
import {
  dbErrorStatus,
  errorResponse,
  jsonResponse,
  parseId,
  splitPath,
} from "../_shared/http.ts";

const FUNCTION_NAME = "programacion-cursos";
const TABLE = "mg_programacion_curso";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const [idSegment] = splitPath(url, FUNCTION_NAME);
  const supabase = getServiceClient();

  try {
    if (req.method === "GET" && !idSegment) {
      let query = supabase.from(TABLE).select("*").order(
        "id_programacion_curso",
      );

      const filtros: [string, string][] = [
        ["id_programacion_seccion", "id_programacion_seccion"],
        ["id_curso", "id_curso"],
        ["id_docente", "id_docente"],
      ];
      for (const [param, columna] of filtros) {
        const valor = url.searchParams.get(param);
        if (valor !== null) {
          const parsed = parseId(valor);
          if (parsed === null) {
            return errorResponse(`'${param}' inválido`, 400);
          }
          query = query.eq(columna, parsed);
        }
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
        .eq("id_programacion_curso", id)
        .maybeSingle();
      if (error) return errorResponse(error.message, 500);
      if (!data) return errorResponse("Programación de curso no encontrada", 404);
      return jsonResponse(data);
    }

    if (req.method === "POST" && !idSegment) {
      const body = await req.json().catch(() => null);
      if (
        !body ||
        typeof body.id_programacion_seccion !== "number" ||
        !Number.isInteger(body.id_programacion_seccion) ||
        typeof body.id_curso !== "number" ||
        !Number.isInteger(body.id_curso) ||
        typeof body.id_docente !== "number" ||
        !Number.isInteger(body.id_docente)
      ) {
        return errorResponse(
          "'id_programacion_seccion', 'id_curso' e 'id_docente' (enteros) son requeridos",
          400,
        );
      }
      const insert: Record<string, unknown> = {
        id_programacion_seccion: body.id_programacion_seccion,
        id_curso: body.id_curso,
        id_docente: body.id_docente,
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
          ? "Ese curso ya está programado para esa sección."
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
      const camposEnteros: [string, string][] = [
        ["id_programacion_seccion", "id_programacion_seccion"],
        ["id_curso", "id_curso"],
        ["id_docente", "id_docente"],
      ];
      for (const [campo, columna] of camposEnteros) {
        if (body[campo] !== undefined) {
          if (typeof body[campo] !== "number" || !Number.isInteger(body[campo])) {
            return errorResponse(`'${campo}' debe ser un entero`, 400);
          }
          update[columna] = body[campo];
        }
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
        .eq("id_programacion_curso", id)
        .select("*")
        .maybeSingle();
      if (error) {
        const status = dbErrorStatus(error);
        const message = status === 409
          ? "Ese curso ya está programado para esa sección."
          : error.message;
        return errorResponse(message, status);
      }
      if (!data) return errorResponse("Programación de curso no encontrada", 404);
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
