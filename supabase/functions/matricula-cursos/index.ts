// CRUD API for mg_matricula_curso, + un batch que auto-genera los registros
// a partir de las matrículas de sección y los cursos programados. Sin DELETE.
//
// GET  /matricula-cursos?id_matricula=1&id_programacion_curso=2&estado=true
// GET  /matricula-cursos/:id
// POST /matricula-cursos   { id_matricula, id_programacion_curso, estado? }
//   (alta manual de un solo registro; id_matricula e id_programacion_curso
//   obligatorios)
// PUT  /matricula-cursos/:id   { id_matricula?, id_programacion_curso?, estado? }
//
// POST /matricula-cursos/generar   { id_matricula?: number }
//   Batch: por cada matrícula (activa) a procesar -- una sola si se manda
//   id_matricula, o todas las activas si se omite -- resuelve su
//   mg_programacion_seccion (por id_seccion), toma los mg_programacion_curso
//   activos de esa sección, y crea el mg_matricula_curso que falte para cada
//   combinación (matrícula, curso programado). No duplica: chequea qué pares
//   ya existen antes de insertar. No hay transacción real entre las
//   consultas y el insert masivo (limitación de usar la tabla vía REST en
//   vez de una función SQL), pero el insert final es una sola llamada.

import { getServiceClient } from "../_shared/client.ts";
import { corsHeaders } from "../_shared/cors.ts";
import {
  dbErrorStatus,
  errorResponse,
  jsonResponse,
  parseId,
  splitPath,
} from "../_shared/http.ts";

const FUNCTION_NAME = "matricula-cursos";
const TABLE = "mg_matricula_curso";

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
        "id_matricula_curso",
      );

      const idMatricula = url.searchParams.get("id_matricula");
      if (idMatricula !== null) {
        const parsed = parseId(idMatricula);
        if (parsed === null) return errorResponse("'id_matricula' inválido", 400);
        query = query.eq("id_matricula", parsed);
      }

      const idProgramacionCurso = url.searchParams.get(
        "id_programacion_curso",
      );
      if (idProgramacionCurso !== null) {
        const parsed = parseId(idProgramacionCurso);
        if (parsed === null) {
          return errorResponse("'id_programacion_curso' inválido", 400);
        }
        query = query.eq("id_programacion_curso", parsed);
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
        .eq("id_matricula_curso", id)
        .maybeSingle();
      if (error) return errorResponse(error.message, 500);
      if (!data) return errorResponse("Matrícula de curso no encontrada", 404);
      return jsonResponse(data);
    }

    if (req.method === "POST" && idSegment === "generar") {
      const body = await req.json().catch(() => ({}));
      if (
        body?.id_matricula !== undefined &&
        (typeof body.id_matricula !== "number" ||
          !Number.isInteger(body.id_matricula))
      ) {
        return errorResponse("'id_matricula' debe ser un entero", 400);
      }

      // 1. Matrículas a procesar.
      let matriculaQuery = supabase
        .from("mg_matricula")
        .select("id_matricula, id_seccion")
        .eq("estado", true);
      matriculaQuery = body?.id_matricula !== undefined
        ? matriculaQuery.eq("id_matricula", body.id_matricula)
        : matriculaQuery;
      const { data: matriculas, error: errorMatriculas } =
        await matriculaQuery;
      if (errorMatriculas) return errorResponse(errorMatriculas.message, 500);
      if (!matriculas || matriculas.length === 0) {
        return jsonResponse({
          matriculas_procesadas: 0,
          secciones_sin_programacion: [],
          registros_creados: 0,
          registros_ya_existian: 0,
        });
      }

      // 2. mg_programacion_seccion de esas secciones.
      const idsSeccion = [...new Set(matriculas.map((m) => m.id_seccion))];
      const { data: programacionesSeccion, error: errorProgSeccion } =
        await supabase
          .from("mg_programacion_seccion")
          .select("id_programacion_seccion, id_seccion")
          .in("id_seccion", idsSeccion);
      if (errorProgSeccion) {
        return errorResponse(errorProgSeccion.message, 500);
      }
      const programacionPorSeccion = new Map<number, number>();
      for (const p of programacionesSeccion ?? []) {
        programacionPorSeccion.set(p.id_seccion, p.id_programacion_seccion);
      }

      // 3. mg_programacion_curso activos de esas programaciones de sección.
      const idsProgramacionSeccion = [...programacionPorSeccion.values()];
      const { data: programacionesCurso, error: errorProgCurso } =
        idsProgramacionSeccion.length > 0
          ? await supabase
            .from("mg_programacion_curso")
            .select("id_programacion_curso, id_programacion_seccion")
            .in("id_programacion_seccion", idsProgramacionSeccion)
            .eq("estado", true)
          : { data: [], error: null };
      if (errorProgCurso) return errorResponse(errorProgCurso.message, 500);
      const cursosPorProgramacionSeccion = new Map<number, number[]>();
      for (const pc of programacionesCurso ?? []) {
        const lista = cursosPorProgramacionSeccion.get(
          pc.id_programacion_seccion,
        ) ?? [];
        lista.push(pc.id_programacion_curso);
        cursosPorProgramacionSeccion.set(pc.id_programacion_seccion, lista);
      }

      // 4. Pares deseados (id_matricula, id_programacion_curso).
      const seccionesSinProgramacion = new Set<number>();
      const paresDeseados: { id_matricula: number; id_programacion_curso: number }[] = [];
      for (const m of matriculas) {
        const idProgSeccion = programacionPorSeccion.get(m.id_seccion);
        if (idProgSeccion === undefined) {
          seccionesSinProgramacion.add(m.id_seccion);
          continue;
        }
        const cursos = cursosPorProgramacionSeccion.get(idProgSeccion) ?? [];
        for (const idProgCurso of cursos) {
          paresDeseados.push({
            id_matricula: m.id_matricula,
            id_programacion_curso: idProgCurso,
          });
        }
      }

      if (paresDeseados.length === 0) {
        return jsonResponse({
          matriculas_procesadas: matriculas.length,
          secciones_sin_programacion: [...seccionesSinProgramacion],
          registros_creados: 0,
          registros_ya_existian: 0,
        });
      }

      // 5. Pares que ya existen, para no duplicar.
      const idsMatriculaAfectadas = [
        ...new Set(paresDeseados.map((p) => p.id_matricula)),
      ];
      const { data: existentes, error: errorExistentes } = await supabase
        .from(TABLE)
        .select("id_matricula, id_programacion_curso")
        .in("id_matricula", idsMatriculaAfectadas);
      if (errorExistentes) return errorResponse(errorExistentes.message, 500);
      const clavesExistentes = new Set(
        (existentes ?? []).map((e) =>
          `${e.id_matricula}:${e.id_programacion_curso}`
        ),
      );

      const aInsertar = paresDeseados.filter((p) =>
        !clavesExistentes.has(`${p.id_matricula}:${p.id_programacion_curso}`)
      );

      if (aInsertar.length === 0) {
        return jsonResponse({
          matriculas_procesadas: matriculas.length,
          secciones_sin_programacion: [...seccionesSinProgramacion],
          registros_creados: 0,
          registros_ya_existian: paresDeseados.length,
        });
      }

      const { error: errorInsert } = await supabase
        .from(TABLE)
        .insert(aInsertar);
      if (errorInsert) {
        return errorResponse(errorInsert.message, dbErrorStatus(errorInsert));
      }

      return jsonResponse({
        matriculas_procesadas: matriculas.length,
        secciones_sin_programacion: [...seccionesSinProgramacion],
        registros_creados: aInsertar.length,
        registros_ya_existian: paresDeseados.length - aInsertar.length,
      }, 201);
    }

    if (req.method === "POST" && !idSegment) {
      const body = await req.json().catch(() => null);
      if (
        !body ||
        typeof body.id_matricula !== "number" ||
        !Number.isInteger(body.id_matricula) ||
        typeof body.id_programacion_curso !== "number" ||
        !Number.isInteger(body.id_programacion_curso)
      ) {
        return errorResponse(
          "'id_matricula' e 'id_programacion_curso' (enteros) son requeridos",
          400,
        );
      }
      const insert: Record<string, unknown> = {
        id_matricula: body.id_matricula,
        id_programacion_curso: body.id_programacion_curso,
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
          ? "Ese alumno ya está matriculado en ese curso programado."
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
      if (body.id_matricula !== undefined) {
        if (
          typeof body.id_matricula !== "number" ||
          !Number.isInteger(body.id_matricula)
        ) {
          return errorResponse("'id_matricula' debe ser un entero", 400);
        }
        update.id_matricula = body.id_matricula;
      }
      if (body.id_programacion_curso !== undefined) {
        if (
          typeof body.id_programacion_curso !== "number" ||
          !Number.isInteger(body.id_programacion_curso)
        ) {
          return errorResponse(
            "'id_programacion_curso' debe ser un entero",
            400,
          );
        }
        update.id_programacion_curso = body.id_programacion_curso;
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
        .eq("id_matricula_curso", id)
        .select("*")
        .maybeSingle();
      if (error) {
        const status = dbErrorStatus(error);
        const message = status === 409
          ? "Ese alumno ya está matriculado en ese curso programado."
          : error.message;
        return errorResponse(message, status);
      }
      if (!data) return errorResponse("Matrícula de curso no encontrada", 404);
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
