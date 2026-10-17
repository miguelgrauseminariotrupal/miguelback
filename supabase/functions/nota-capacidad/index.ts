// PUT /nota-capacidad — actualiza UNA fila de mg_evaluacion_capacidades.
//
// {
//   id_evaluacion_capacidad,     // obligatorio
//   id_valor,                    // obligatorio: entero (activo) o null (limpia la nota)
//   observacion?,                // texto o null; si se omite no se modifica
//   id_bimestre?                 // entero o null (= nota final); si se omite no se modifica
// }
//
// 'id_bimestre' mueve la fila a otro bimestre (o a nota final con null):
// debe ser del año lectivo del curso y no chocar con otra fila existente.
//
// OJO: mg_evaluacion_capacidades necesita una columna 'observacion' para que
// ese campo funcione; si la tabla no la tiene, mandar 'observacion' da error
// de base de datos (omitirla funciona normal).

import { getServiceClient } from "../_shared/client.ts";
import { corsHeaders } from "../_shared/cors.ts";
import {
  dbErrorStatus,
  errorResponse,
  jsonResponse,
  mensajeDeError,
} from "../_shared/http.ts";
import {
  esEntero,
  type Fila,
  validarBimestreDeMatriculaCurso,
  validarValor,
} from "../_shared/notas.ts";

const TABLE = "mg_evaluacion_capacidades";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "PUT" && req.method !== "PATCH") {
    return errorResponse("Ruta o método no soportado", 404);
  }

  try {
    const body = await req.json().catch(() => null);
    if (!body || !esEntero(body.id_evaluacion_capacidad)) {
      return errorResponse(
        "'id_evaluacion_capacidad' (entero) es requerido",
        400,
      );
    }
    if (!("id_valor" in body) || !(body.id_valor === null || esEntero(body.id_valor))) {
      return errorResponse("'id_valor' es requerido (entero o null)", 400);
    }
    if (
      body.observacion !== undefined && body.observacion !== null &&
      typeof body.observacion !== "string"
    ) {
      return errorResponse("'observacion' debe ser texto o null", 400);
    }
    if (
      body.id_bimestre !== undefined && body.id_bimestre !== null &&
      !esEntero(body.id_bimestre)
    ) {
      return errorResponse("'id_bimestre' debe ser un entero o null", 400);
    }

    const supabase = getServiceClient();

    const { data: actual, error: errorActual } = await supabase
      .from(TABLE)
      .select("id_evaluacion_capacidad, id_matricula_curso")
      .eq("id_evaluacion_capacidad", body.id_evaluacion_capacidad)
      .maybeSingle();
    if (errorActual) return errorResponse(errorActual.message, 500);
    if (!actual) return errorResponse("Nota de capacidad no encontrada", 404);

    if (body.id_valor !== null) {
      const errorValor = await validarValor(supabase, body.id_valor);
      if (errorValor) return errorValor;
    }
    if (body.id_bimestre !== undefined && body.id_bimestre !== null) {
      const errorBimestre = await validarBimestreDeMatriculaCurso(
        supabase,
        (actual as Fila).id_matricula_curso as number,
        body.id_bimestre,
      );
      if (errorBimestre) return errorBimestre;
    }

    const update: Record<string, unknown> = { id_valor: body.id_valor };
    if (body.observacion !== undefined) update.observacion = body.observacion;
    if (body.id_bimestre !== undefined) update.id_bimestre = body.id_bimestre;

    const { data, error } = await supabase
      .from(TABLE)
      .update(update)
      .eq("id_evaluacion_capacidad", body.id_evaluacion_capacidad)
      .select("*")
      .maybeSingle();
    if (error) {
      const status = dbErrorStatus(error);
      const message = status === 409
        ? "Ya existe una nota de esa capacidad para ese bimestre."
        : error.message;
      return errorResponse(message, status);
    }
    if (!data) return errorResponse("Nota de capacidad no encontrada", 404);
    return jsonResponse(data);
  } catch (err) {
    console.error("[nota-capacidad] fallo:", err);
    return errorResponse(mensajeDeError(err), 500);
  }
});
