import { getServiceClient } from "../_shared/client.ts";
import { corsHeaders } from "../_shared/cors.ts";
import {
  dbErrorStatus,
  errorResponse,
  jsonResponse,
  parseId,
  splitPath,
} from "../_shared/http.ts";

const FUNCTION_NAME = "programacion-secciones";
const TABLE = "mg_programacion_seccion";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const [idSegment] = splitPath(url, FUNCTION_NAME);
  const supabase = getServiceClient();

  try {
    if (req.method === "GET" && !idSegment) {
      // Solo programaciones cuyo año lectivo está activo (estado = true).
      // Una sola consulta trae la jerarquía completa: sección -> grado ->
      // nivel -> año lectivo, para que el cliente no pida cada uno aparte.
      let query = supabase
        .from(TABLE)
        .select(
          "*, mg_seccion!inner(id_seccion, nombre, estado, id_grado, " +
            "mg_grado!inner(id_grado, nombre, estado, id_nivel, " +
            "mg_nivel!inner(id_nivel, nombre, estado, id_anio_lectivo, " +
            "mg_anio_lectivo!inner(id_anio_lectivo, anio, nombre, estado))))",
        )
        .eq("mg_seccion.mg_grado.mg_nivel.mg_anio_lectivo.estado", true)
        .order("id_programacion_seccion");

      const idSeccion = url.searchParams.get("id_seccion");
      if (idSeccion !== null) {
        const parsed = parseId(idSeccion);
        if (parsed === null) return errorResponse("'id_seccion' inválido", 400);
        query = query.eq("id_seccion", parsed);
      }

      const idDocente = url.searchParams.get("id_docente_responsable");
      if (idDocente !== null) {
        const parsed = parseId(idDocente);
        if (parsed === null) {
          return errorResponse("'id_docente_responsable' inválido", 400);
        }
        query = query.eq("id_docente_responsable", parsed);
      }

      const estadoCompletado = url.searchParams.get("estado_completado");
      if (estadoCompletado === "true" || estadoCompletado === "false") {
        query = query.eq("estado_completado", estadoCompletado === "true");
      }

      const { data, error } = await query;
      if (error) return errorResponse(error.message, 500);
      // Se aplana la jerarquía anidada: se conservan las columnas originales y
      // se agregan `seccion`, `grado`, `nivel` y `anio_lectivo`.
      // deno-lint-ignore no-explicit-any
      const filas = (data ?? []).map(({ mg_seccion, ...fila }: any) => {
        const { mg_grado, ...seccion } = mg_seccion;
        const { mg_nivel, ...grado } = mg_grado;
        const { mg_anio_lectivo, ...nivel } = mg_nivel;
        return { ...fila, seccion, grado, nivel, anio_lectivo: mg_anio_lectivo };
      });
      return jsonResponse(filas);
    }

    if (req.method === "GET" && idSegment) {
      const id = parseId(idSegment);
      if (id === null) return errorResponse("id inválido", 400);
      const { data, error } = await supabase
        .from(TABLE)
        .select("*")
        .eq("id_programacion_seccion", id)
        .maybeSingle();
      if (error) return errorResponse(error.message, 500);
      if (!data) return errorResponse("Programación de sección no encontrada", 404);
      return jsonResponse(data);
    }

    if (req.method === "POST" && !idSegment) {
      const body = await req.json().catch(() => null);
      if (
        !body ||
        typeof body.id_seccion !== "number" ||
        !Number.isInteger(body.id_seccion) ||
        typeof body.id_docente_responsable !== "number" ||
        !Number.isInteger(body.id_docente_responsable)
      ) {
        return errorResponse(
          "'id_seccion' e 'id_docente_responsable' (enteros) son requeridos",
          400,
        );
      }
      const insert: Record<string, unknown> = {
        id_seccion: body.id_seccion,
        id_docente_responsable: body.id_docente_responsable,
      };
      if (typeof body.estado_completado === "boolean") {
        insert.estado_completado = body.estado_completado;
      }

      const { data, error } = await supabase
        .from(TABLE)
        .insert(insert)
        .select("*")
        .single();
      if (error) {
        const status = dbErrorStatus(error);
        const message = status === 409
          ? "Ya existe una programación para esta sección."
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
      if (body.id_seccion !== undefined) {
        if (
          typeof body.id_seccion !== "number" ||
          !Number.isInteger(body.id_seccion)
        ) {
          return errorResponse("'id_seccion' debe ser un entero", 400);
        }
        update.id_seccion = body.id_seccion;
      }
      if (body.id_docente_responsable !== undefined) {
        if (
          typeof body.id_docente_responsable !== "number" ||
          !Number.isInteger(body.id_docente_responsable)
        ) {
          return errorResponse(
            "'id_docente_responsable' debe ser un entero",
            400,
          );
        }
        update.id_docente_responsable = body.id_docente_responsable;
      }
      if (body.estado_completado !== undefined) {
        if (typeof body.estado_completado !== "boolean") {
          return errorResponse("'estado_completado' debe ser booleano", 400);
        }
        update.estado_completado = body.estado_completado;
      }
      if (Object.keys(update).length === 0) {
        return errorResponse("No hay campos para actualizar", 400);
      }

      const { data, error } = await supabase
        .from(TABLE)
        .update(update)
        .eq("id_programacion_seccion", id)
        .select("*")
        .maybeSingle();
      if (error) {
        const status = dbErrorStatus(error);
        const message = status === 409
          ? "Ya existe una programación para esta sección."
          : error.message;
        return errorResponse(message, status);
      }
      if (!data) return errorResponse("Programación de sección no encontrada", 404);
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
