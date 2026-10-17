// CRUD API for mg_asistencia. No hay endpoint DELETE ni campo 'estado'
// (la tabla de referencia no lo tiene): para corregir un registro se usa PUT.
//
// GET  /asistencias?id_matricula=1&id_tipo_asistencia=2&fecha=2026-04-10
//                   &fecha_desde=2026-04-01&fecha_hasta=2026-04-30
// GET  /asistencias/:id
// POST /asistencias   { id_matricula, id_tipo_asistencia, fecha }
//   (los 3 son obligatorios; se rechaza con 409 si ya existe un registro
//   para esa matrícula en esa fecha)
// PUT  /asistencias/:id   { id_matricula?, id_tipo_asistencia?, fecha? }

import { getServiceClient } from "../_shared/client.ts";
import { corsHeaders } from "../_shared/cors.ts";
import {
  dbErrorStatus,
  errorResponse,
  jsonResponse,
  parseId,
  splitPath,
} from "../_shared/http.ts";

const FUNCTION_NAME = "asistencias";
const TABLE = "mg_asistencia";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const [idSegment] = splitPath(url, FUNCTION_NAME);
  const supabase = getServiceClient();

  try {
    if (req.method === "GET" && !idSegment) {
      let query = supabase.from(TABLE).select("*").order("fecha", {
        ascending: false,
      });

      const idMatricula = url.searchParams.get("id_matricula");
      if (idMatricula !== null) {
        const parsed = parseId(idMatricula);
        if (parsed === null) return errorResponse("'id_matricula' inválido", 400);
        query = query.eq("id_matricula", parsed);
      }

      const idTipoAsistencia = url.searchParams.get("id_tipo_asistencia");
      if (idTipoAsistencia !== null) {
        const parsed = parseId(idTipoAsistencia);
        if (parsed === null) {
          return errorResponse("'id_tipo_asistencia' inválido", 400);
        }
        query = query.eq("id_tipo_asistencia", parsed);
      }

      const fecha = url.searchParams.get("fecha");
      if (fecha !== null) {
        if (!DATE_RE.test(fecha)) {
          return errorResponse("'fecha' debe tener formato YYYY-MM-DD", 400);
        }
        query = query.eq("fecha", fecha);
      }

      const fechaDesde = url.searchParams.get("fecha_desde");
      if (fechaDesde !== null) {
        if (!DATE_RE.test(fechaDesde)) {
          return errorResponse(
            "'fecha_desde' debe tener formato YYYY-MM-DD",
            400,
          );
        }
        query = query.gte("fecha", fechaDesde);
      }

      const fechaHasta = url.searchParams.get("fecha_hasta");
      if (fechaHasta !== null) {
        if (!DATE_RE.test(fechaHasta)) {
          return errorResponse(
            "'fecha_hasta' debe tener formato YYYY-MM-DD",
            400,
          );
        }
        query = query.lte("fecha", fechaHasta);
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
        .eq("id_asistencia", id)
        .maybeSingle();
      if (error) return errorResponse(error.message, 500);
      if (!data) return errorResponse("Asistencia no encontrada", 404);
      return jsonResponse(data);
    }

    if (req.method === "POST" && !idSegment) {
      const body = await req.json().catch(() => null);
      if (
        !body ||
        typeof body.id_matricula !== "number" ||
        !Number.isInteger(body.id_matricula) ||
        typeof body.id_tipo_asistencia !== "number" ||
        !Number.isInteger(body.id_tipo_asistencia) ||
        typeof body.fecha !== "string" ||
        !DATE_RE.test(body.fecha)
      ) {
        return errorResponse(
          "'id_matricula', 'id_tipo_asistencia' (enteros) y 'fecha' (YYYY-MM-DD) son requeridos",
          400,
        );
      }

      // La tabla no tiene UNIQUE(id_matricula, fecha) a nivel de BD, así que
      // este pre-chequeo es la única protección contra duplicados (queda una
      // ventana de condición de carrera ante altas simultáneas).
      const { data: existente, error: errorExistente } = await supabase
        .from(TABLE)
        .select("id_asistencia")
        .eq("id_matricula", body.id_matricula)
        .eq("fecha", body.fecha)
        .maybeSingle();
      if (errorExistente) return errorResponse(errorExistente.message, 500);
      if (existente) {
        return errorResponse(
          "Ya existe un registro de asistencia para esa matrícula en esa fecha.",
          409,
        );
      }

      const { data, error } = await supabase
        .from(TABLE)
        .insert({
          id_matricula: body.id_matricula,
          id_tipo_asistencia: body.id_tipo_asistencia,
          fecha: body.fecha,
        })
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
      if (body.id_matricula !== undefined) {
        if (
          typeof body.id_matricula !== "number" ||
          !Number.isInteger(body.id_matricula)
        ) {
          return errorResponse("'id_matricula' debe ser un entero", 400);
        }
        update.id_matricula = body.id_matricula;
      }
      if (body.id_tipo_asistencia !== undefined) {
        if (
          typeof body.id_tipo_asistencia !== "number" ||
          !Number.isInteger(body.id_tipo_asistencia)
        ) {
          return errorResponse("'id_tipo_asistencia' debe ser un entero", 400);
        }
        update.id_tipo_asistencia = body.id_tipo_asistencia;
      }
      if (body.fecha !== undefined) {
        if (typeof body.fecha !== "string" || !DATE_RE.test(body.fecha)) {
          return errorResponse("'fecha' debe tener formato YYYY-MM-DD", 400);
        }
        update.fecha = body.fecha;
      }
      if (Object.keys(update).length === 0) {
        return errorResponse("No hay campos para actualizar", 400);
      }

      const { data, error } = await supabase
        .from(TABLE)
        .update(update)
        .eq("id_asistencia", id)
        .select("*")
        .maybeSingle();
      if (error) return errorResponse(error.message, dbErrorStatus(error));
      if (!data) return errorResponse("Asistencia no encontrada", 404);
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
