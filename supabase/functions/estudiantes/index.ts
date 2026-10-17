// CRUD API for mg_estudiante (estudiantes).
//
// GET    /estudiantes?estado=true&q=perez   list (optional filters)
//   'q' busca (ILIKE parcial) en nombres/apellido_paterno/apellido_materno/dni
// GET    /estudiantes/:id           get one
// POST   /estudiantes               create { nombres, apellido_paterno?, apellido_materno?, dni?, fecha_nacimiento?, estado? }
//   solo 'nombres' es obligatorio
// PUT    /estudiantes/:id           update (same fields, all optional)

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

const FUNCTION_NAME = "estudiantes";
const TABLE = "mg_estudiante";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const OPTIONAL_STRING_FIELDS = [
  "apellido_paterno",
  "apellido_materno",
  "dni",
] as const;

const COLUMNAS_BUSQUEDA = [
  "nombres",
  "apellido_paterno",
  "apellido_materno",
  "dni",
] as const;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const [idSegment] = splitPath(url, FUNCTION_NAME);
  const supabase = getServiceClient();

  try {
    if (req.method === "GET" && !idSegment) {
      let query = supabase.from(TABLE).select("*").order("id_estudiante");
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
        .eq("id_estudiante", id)
        .maybeSingle();
      if (error) return errorResponse(error.message, 500);
      if (!data) return errorResponse("Estudiante no encontrado", 404);
      return jsonResponse(data);
    }

    if (req.method === "POST" && !idSegment) {
      const body = await req.json().catch(() => null);
      if (
        !body ||
        typeof body.nombres !== "string" || body.nombres.trim() === ""
      ) {
        return errorResponse("'nombres' es requerido y debe ser texto", 400);
      }
      if (
        body.fecha_nacimiento !== undefined && body.fecha_nacimiento !== null
      ) {
        if (
          typeof body.fecha_nacimiento !== "string" ||
          !DATE_RE.test(body.fecha_nacimiento)
        ) {
          return errorResponse(
            "'fecha_nacimiento' debe tener formato YYYY-MM-DD",
            400,
          );
        }
      }

      const insert: Record<string, unknown> = { nombres: body.nombres };
      if (body.fecha_nacimiento !== undefined) {
        insert.fecha_nacimiento = body.fecha_nacimiento;
      }
      for (const key of OPTIONAL_STRING_FIELDS) {
        if (body[key] !== undefined) insert[key] = body[key];
      }
      if (typeof body.estado === "boolean") insert.estado = body.estado;

      const { data, error } = await supabase
        .from(TABLE)
        .insert(insert)
        .select("*")
        .single();
      if (error) {
        const status = dbErrorStatus(error);
        const message = status === 409
          ? "Ya existe un estudiante con ese DNI."
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
      if (body.nombres !== undefined) {
        if (typeof body.nombres !== "string" || body.nombres.trim() === "") {
          return errorResponse("'nombres' debe ser texto no vacío", 400);
        }
        update.nombres = body.nombres;
      }
      if (body.fecha_nacimiento !== undefined) {
        if (
          body.fecha_nacimiento !== null &&
          (typeof body.fecha_nacimiento !== "string" ||
            !DATE_RE.test(body.fecha_nacimiento))
        ) {
          return errorResponse(
            "'fecha_nacimiento' debe tener formato YYYY-MM-DD",
            400,
          );
        }
        update.fecha_nacimiento = body.fecha_nacimiento;
      }
      for (const key of OPTIONAL_STRING_FIELDS) {
        if (body[key] !== undefined) update[key] = body[key];
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
        .eq("id_estudiante", id)
        .select("*")
        .maybeSingle();
      if (error) return errorResponse(error.message, dbErrorStatus(error));
      if (!data) return errorResponse("Estudiante no encontrado", 404);
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
