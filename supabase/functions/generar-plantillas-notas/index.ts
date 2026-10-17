// POST /generar-plantillas-notas { id_anio: number }
//
// Llama al stored procedure `generar_plantillas_notas(p_id_anio)` (creado
// directo en Supabase), que genera las "plantillas" de evaluación (filas
// con id_valor=NULL, para que el docente las vaya completando) para todas
// las matrículas de curso del año indicado: mg_evaluacion_competencia,
// mg_evaluacion_capacidades, mg_evaluacion_competencia_bimestre,
// mg_evaluacion_capacidades_bimestre.
//
// Es idempotente: el NOT EXISTS de cada paso del stored procedure evita
// duplicar lo que ya se generó en una corrida anterior.

import { getServiceClient } from "../_shared/client.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { errorResponse, jsonResponse } from "../_shared/http.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return errorResponse("Ruta o método no soportado", 404);
  }

  try {
    const body = await req.json().catch(() => null);
    if (
      !body || typeof body.id_anio !== "number" || !Number.isInteger(body.id_anio)
    ) {
      return errorResponse("'id_anio' (entero) es requerido", 400);
    }

    const supabase = getServiceClient();

    const { data: anio, error: errorAnio } = await supabase
      .from("mg_anio_lectivo")
      .select("id_anio_lectivo")
      .eq("id_anio_lectivo", body.id_anio)
      .maybeSingle();
    if (errorAnio) return errorResponse(errorAnio.message, 500);
    if (!anio) return errorResponse("'id_anio' no existe", 400);

    const { data, error } = await supabase.rpc("generar_plantillas_notas", {
      p_id_anio: body.id_anio,
    });
    if (error) {
      console.error("[generar-plantillas-notas] fallo:", error);
      return errorResponse(error.message, 500);
    }

    return jsonResponse(data, 201);
  } catch (err) {
    console.error("[generar-plantillas-notas] fallo:", err);
    return errorResponse(
      err instanceof Error ? err.message : "Error inesperado",
      500,
    );
  }
});
