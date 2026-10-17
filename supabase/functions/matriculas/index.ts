// CRUD API for mg_matricula. No hay endpoint DELETE.
// Relación directa con mg_seccion vía 'id_seccion' (ya no con
// mg_programacion_seccion).
//
// GET  /matriculas?id_seccion=1&id_estudiante=2&estado=true
//                  &id_anio_lectivo=1&id_nivel=2&id_grado=3&q=perez
//   (id_anio_lectivo/id_nivel/id_grado filtran subiendo mg_seccion ->
//   mg_grado -> mg_nivel; 'q' busca -ILIKE parcial- en nombres/apellidos/dni
//   del alumno matriculado. Todos se pueden combinar entre sí. Cada
//   matrícula devuelve embebidos los datos del alumno en 'mg_estudiante')
// GET  /matriculas/:id
// POST /matriculas   { id_seccion, id_estudiante, fecha_matricula?, estado? }
//   (id_seccion e id_estudiante obligatorios)
// PUT  /matriculas/:id   { id_seccion?, id_estudiante?, fecha_matricula?, estado? }

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

const FUNCTION_NAME = "matriculas";
const TABLE = "mg_matricula";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const COLUMNAS_BUSQUEDA_ALUMNO = [
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
      // id_anio_lectivo/id_nivel/id_grado filtran subiendo la cadena
      // mg_seccion -> mg_grado -> mg_nivel. Solo se embebe esa cadena (con
      // !inner) cuando alguno de esos filtros se usa, para no inflar la
      // respuesta en el caso normal. id_seccion es columna directa, no
      // necesita embed.
      const idAnioLectivo = url.searchParams.get("id_anio_lectivo");
      const idNivel = url.searchParams.get("id_nivel");
      const idGrado = url.searchParams.get("id_grado");
      const idSeccion = url.searchParams.get("id_seccion");
      const usaFiltroJerarquico = idAnioLectivo !== null || idNivel !== null ||
        idGrado !== null;

      const q = url.searchParams.get("q");
      const usaBusquedaAlumno = q !== null && q.trim() !== "";

      // mg_estudiante siempre se embebe (id_estudiante es NOT NULL + FK, así
      // que el !inner nunca descarta una matrícula) para devolver los datos
      // del alumno junto con cada matrícula, sin una segunda consulta a
      // /estudiantes.
      const embeds: string[] = [
        "mg_estudiante!inner(id_estudiante, nombres, apellido_paterno, apellido_materno, dni, fecha_nacimiento, estado)",
      ];
      if (usaFiltroJerarquico) {
        embeds.push(
          "mg_seccion!inner(id_grado, mg_grado!inner(id_nivel, mg_nivel!inner(id_anio_lectivo)))",
        );
      }

      let query = supabase
        .from(TABLE)
        .select(`*, ${embeds.join(", ")}`)
        .order("id_matricula");

      if (usaBusquedaAlumno) {
        query = query.or(
          busquedaIlikeOr(sanitizarBusqueda(q), COLUMNAS_BUSQUEDA_ALUMNO),
          { foreignTable: "mg_estudiante" },
        );
      }

      if (idSeccion !== null) {
        const parsed = parseId(idSeccion);
        if (parsed === null) return errorResponse("'id_seccion' inválido", 400);
        query = query.eq("id_seccion", parsed);
      }
      if (idGrado !== null) {
        const parsed = parseId(idGrado);
        if (parsed === null) return errorResponse("'id_grado' inválido", 400);
        query = query.eq("mg_seccion.id_grado", parsed);
      }
      if (idNivel !== null) {
        const parsed = parseId(idNivel);
        if (parsed === null) return errorResponse("'id_nivel' inválido", 400);
        query = query.eq("mg_seccion.mg_grado.id_nivel", parsed);
      }
      if (idAnioLectivo !== null) {
        const parsed = parseId(idAnioLectivo);
        if (parsed === null) {
          return errorResponse("'id_anio_lectivo' inválido", 400);
        }
        query = query.eq(
          "mg_seccion.mg_grado.mg_nivel.id_anio_lectivo",
          parsed,
        );
      }

      const idEstudiante = url.searchParams.get("id_estudiante");
      if (idEstudiante !== null) {
        const parsed = parseId(idEstudiante);
        if (parsed === null) return errorResponse("'id_estudiante' inválido", 400);
        query = query.eq("id_estudiante", parsed);
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
        .select(
          "*, mg_estudiante!inner(id_estudiante, nombres, apellido_paterno, apellido_materno, dni, fecha_nacimiento, estado)",
        )
        .eq("id_matricula", id)
        .maybeSingle();
      if (error) return errorResponse(error.message, 500);
      if (!data) return errorResponse("Matrícula no encontrada", 404);
      return jsonResponse(data);
    }

    if (req.method === "POST" && !idSegment) {
      const body = await req.json().catch(() => null);
      if (
        !body ||
        typeof body.id_seccion !== "number" ||
        !Number.isInteger(body.id_seccion) ||
        typeof body.id_estudiante !== "number" ||
        !Number.isInteger(body.id_estudiante)
      ) {
        return errorResponse(
          "'id_seccion' e 'id_estudiante' (enteros) son requeridos",
          400,
        );
      }
      if (body.fecha_matricula !== undefined && body.fecha_matricula !== null) {
        if (
          typeof body.fecha_matricula !== "string" ||
          !DATE_RE.test(body.fecha_matricula)
        ) {
          return errorResponse(
            "'fecha_matricula' debe tener formato YYYY-MM-DD",
            400,
          );
        }
      }

      const insert: Record<string, unknown> = {
        id_seccion: body.id_seccion,
        id_estudiante: body.id_estudiante,
      };
      if (body.fecha_matricula !== undefined) {
        insert.fecha_matricula = body.fecha_matricula;
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
          ? "El estudiante ya está matriculado en esa sección."
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
      if (body.id_estudiante !== undefined) {
        if (
          typeof body.id_estudiante !== "number" ||
          !Number.isInteger(body.id_estudiante)
        ) {
          return errorResponse("'id_estudiante' debe ser un entero", 400);
        }
        update.id_estudiante = body.id_estudiante;
      }
      if (body.fecha_matricula !== undefined) {
        if (
          body.fecha_matricula !== null &&
          (typeof body.fecha_matricula !== "string" ||
            !DATE_RE.test(body.fecha_matricula))
        ) {
          return errorResponse(
            "'fecha_matricula' debe tener formato YYYY-MM-DD",
            400,
          );
        }
        update.fecha_matricula = body.fecha_matricula;
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
        .eq("id_matricula", id)
        .select("*")
        .maybeSingle();
      if (error) {
        const status = dbErrorStatus(error);
        const message = status === 409
          ? "El estudiante ya está matriculado en esa sección."
          : error.message;
        return errorResponse(message, status);
      }
      if (!data) return errorResponse("Matrícula no encontrada", 404);
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
