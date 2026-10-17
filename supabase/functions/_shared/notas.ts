// Lógica compartida por los endpoints de notas.

import { getServiceClient } from "./client.ts";
import { errorResponse } from "./http.ts";

export type Supabase = ReturnType<typeof getServiceClient>;
export type Fila = Record<string, unknown>;

export function esEntero(valor: unknown): valor is number {
  return typeof valor === "number" && Number.isInteger(valor);
}

/** Resuelve mg_matricula_curso a partir de (id_matricula, id_curso). */
export async function resolverIdMatriculaCurso(
  supabase: Supabase,
  idMatricula: number,
  idCurso: number,
): Promise<{ id: number } | { error: Response }> {
  const { data, error } = await supabase
    .from("mg_matricula_curso")
    .select("id_matricula_curso, mg_programacion_curso!inner(id_curso)")
    .eq("id_matricula", idMatricula)
    .eq("mg_programacion_curso.id_curso", idCurso)
    .maybeSingle();
  if (error) return { error: errorResponse(error.message, 500) };
  if (!data) {
    return {
      error: errorResponse(
        "No existe una matrícula de ese alumno en ese curso.",
        404,
      ),
    };
  }
  return { id: (data as Fila).id_matricula_curso as number };
}

/** Devuelve una Response de error si el valor de evaluación no existe o está inactivo. */
export async function validarValor(
  supabase: Supabase,
  idValor: number,
): Promise<Response | null> {
  const { data, error } = await supabase
    .from("mg_valor_evaluacion")
    .select("id_valor")
    .eq("id_valor", idValor)
    .eq("estado", true)
    .maybeSingle();
  if (error) return errorResponse(error.message, 500);
  if (!data) {
    return errorResponse(
      `El valor de evaluación ${idValor} no existe o está inactivo.`,
      400,
    );
  }
  return null;
}

/**
 * Devuelve una Response de error si el bimestre no existe o no es del mismo
 * año lectivo que el curso de la matrícula-curso (cadena
 * mg_matricula_curso -> mg_programacion_curso -> mg_curso).
 */
export async function validarBimestreDeMatriculaCurso(
  supabase: Supabase,
  idMatriculaCurso: number,
  idBimestre: number,
): Promise<Response | null> {
  const [
    { data: bimestre, error: errorBimestre },
    { data: matriculaCurso, error: errorMc },
  ] = await Promise.all([
    supabase
      .from("mg_bimestre")
      .select("id_anio_lectivo")
      .eq("id_bimestre", idBimestre)
      .maybeSingle(),
    supabase
      .from("mg_matricula_curso")
      .select("mg_programacion_curso!inner(mg_curso!inner(id_anio_lectivo))")
      .eq("id_matricula_curso", idMatriculaCurso)
      .maybeSingle(),
  ]);
  if (errorBimestre) return errorResponse(errorBimestre.message, 500);
  if (errorMc) return errorResponse(errorMc.message, 500);
  if (!bimestre) return errorResponse("Bimestre no encontrado", 404);

  const programacion = (matriculaCurso as unknown as Fila | null)
    ?.mg_programacion_curso as Fila | undefined;
  const curso = programacion?.mg_curso as Fila | undefined;
  if (curso?.id_anio_lectivo !== (bimestre as Fila).id_anio_lectivo) {
    return errorResponse(
      "El bimestre no pertenece al año lectivo del curso.",
      400,
    );
  }
  return null;
}
