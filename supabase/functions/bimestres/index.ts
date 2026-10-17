// CRUD API for mg_bimestre. No hay endpoint DELETE.
//
// GET  /bimestres?id_anio_lectivo=1&estado=true&q=bimestre   list (optional filters)
//   'q' busca (ILIKE parcial) en nombre
// GET  /bimestres/:id                                        get one
// POST /bimestres   { id_anio_lectivo, numero, nombre, fecha_inicio?, fecha_fin?, estado? }
//   (id_anio_lectivo, numero y nombre obligatorios)
// PUT  /bimestres/:id   { id_anio_lectivo?, numero?, nombre?, fecha_inicio?, fecha_fin?, estado? }

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

const FUNCTION_NAME = "bimestres";
const TABLE = "mg_bimestre";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const COLUMNAS_BUSQUEDA = ["nombre"] as const;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const [idSegment] = splitPath(url, FUNCTION_NAME);
  const supabase = getServiceClient();

  try {
    if (req.method === "GET" && !idSegment) {
      let query = supabase.from(TABLE).select("*").order("id_anio_lectivo").order(
        "numero",
      );

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
        .eq("id_bimestre", id)
        .maybeSingle();
      if (error) return errorResponse(error.message, 500);
      if (!data) return errorResponse("Bimestre no encontrado", 404);
      return jsonResponse(data);
    }

    if (req.method === "POST" && !idSegment) {
      const body = await req.json().catch(() => null);
      if (
        !body ||
        typeof body.id_anio_lectivo !== "number" ||
        !Number.isInteger(body.id_anio_lectivo) ||
        typeof body.numero !== "number" ||
        !Number.isInteger(body.numero) ||
        typeof body.nombre !== "string" ||
        body.nombre.trim() === ""
      ) {
        return errorResponse(
          "'id_anio_lectivo' (entero), 'numero' (entero) y 'nombre' (texto no vacío) son requeridos",
          400,
        );
      }
      for (const campo of ["fecha_inicio", "fecha_fin"] as const) {
        if (body[campo] !== undefined && body[campo] !== null) {
          if (typeof body[campo] !== "string" || !DATE_RE.test(body[campo])) {
            return errorResponse(`'${campo}' debe tener formato YYYY-MM-DD`, 400);
          }
        }
      }

      const insert: Record<string, unknown> = {
        id_anio_lectivo: body.id_anio_lectivo,
        numero: body.numero,
        nombre: body.nombre,
      };
      if (body.fecha_inicio !== undefined) insert.fecha_inicio = body.fecha_inicio;
      if (body.fecha_fin !== undefined) insert.fecha_fin = body.fecha_fin;
      if (typeof body.estado === "boolean") insert.estado = body.estado;

      const { data, error } = await supabase
        .from(TABLE)
        .insert(insert)
        .select("*")
        .single();
      if (error) {
        const status = dbErrorStatus(error);
        const message = status === 409
          ? "Ya existe ese número de bimestre para ese año lectivo."
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
      if (body.id_anio_lectivo !== undefined) {
        if (
          typeof body.id_anio_lectivo !== "number" ||
          !Number.isInteger(body.id_anio_lectivo)
        ) {
          return errorResponse("'id_anio_lectivo' debe ser un entero", 400);
        }
        update.id_anio_lectivo = body.id_anio_lectivo;
      }
      if (body.numero !== undefined) {
        if (typeof body.numero !== "number" || !Number.isInteger(body.numero)) {
          return errorResponse("'numero' debe ser un entero", 400);
        }
        update.numero = body.numero;
      }
      if (body.nombre !== undefined) {
        if (typeof body.nombre !== "string" || body.nombre.trim() === "") {
          return errorResponse("'nombre' debe ser texto no vacío", 400);
        }
        update.nombre = body.nombre;
      }
      for (const campo of ["fecha_inicio", "fecha_fin"] as const) {
        if (body[campo] !== undefined) {
          if (
            body[campo] !== null &&
            (typeof body[campo] !== "string" || !DATE_RE.test(body[campo]))
          ) {
            return errorResponse(`'${campo}' debe tener formato YYYY-MM-DD`, 400);
          }
          update[campo] = body[campo];
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
        .eq("id_bimestre", id)
        .select("*")
        .maybeSingle();
      if (error) {
        const status = dbErrorStatus(error);
        const message = status === 409
          ? "Ya existe ese número de bimestre para ese año lectivo."
          : error.message;
        return errorResponse(message, status);
      }
      if (!data) return errorResponse("Bimestre no encontrado", 404);
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
