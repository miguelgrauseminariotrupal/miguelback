// GET /docente-responsable?id_seccion=1&id_curso=2
//
// Devuelve el docente responsable de dictar un curso puntual en una sección
// puntual (mg_programacion_curso.id_docente, resuelto vía
// mg_programacion_seccion.id_seccion). No confundir con
// mg_programacion_seccion.id_docente_responsable, que es el tutor general
// de la sección, no necesariamente quien dicta cada curso.

import { getServiceClient } from "../_shared/client.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { errorResponse, jsonResponse, parseId } from "../_shared/http.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "GET") {
    return errorResponse("Ruta o método no soportado", 404);
  }

  try {
    const url = new URL(req.url);
    const idSeccion = parseId(url.searchParams.get("id_seccion") ?? undefined);
    const idCurso = parseId(url.searchParams.get("id_curso") ?? undefined);
    if (idSeccion === null || idCurso === null) {
      return errorResponse(
        "'id_seccion' e 'id_curso' (enteros) son requeridos",
        400,
      );
    }

    const supabase = getServiceClient();

    const { data: programacionSeccion, error: errorPS } = await supabase
      .from("mg_programacion_seccion")
      .select("id_programacion_seccion")
      .eq("id_seccion", idSeccion)
      .maybeSingle();
    if (errorPS) return errorResponse(errorPS.message, 500);
    if (!programacionSeccion) {
      return errorResponse("No existe una programación para esa sección.", 404);
    }

    const { data: programacionCurso, error: errorPC } = await supabase
      .from("mg_programacion_curso")
      .select(
        "id_programacion_curso, estado, mg_docente(id_docente, nombres, apellido_paterno, apellido_materno, dni, telefono, correo, estado)",
      )
      .eq("id_programacion_seccion", programacionSeccion.id_programacion_seccion)
      .eq("id_curso", idCurso)
      .maybeSingle();
    if (errorPC) return errorResponse(errorPC.message, 500);
    if (!programacionCurso) {
      return errorResponse("Ese curso no está programado para esa sección.", 404);
    }

    return jsonResponse({
      id_seccion: idSeccion,
      id_curso: idCurso,
      id_programacion_curso: programacionCurso.id_programacion_curso,
      estado: programacionCurso.estado,
      docente: programacionCurso.mg_docente,
    });
  } catch (err) {
    return errorResponse(
      err instanceof Error ? err.message : "Error inesperado",
      500,
    );
  }
});
