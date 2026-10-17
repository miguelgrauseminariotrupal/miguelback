// GET /notas-matricula-curso?id_matricula=1&id_curso=2
//
// Todas las notas de un alumno en un curso, en una sola respuesta:
//   competencia -> nota_final
//               -> bimestres[] -> nota_bimestre (de la competencia)
//                              -> capacidades[] -> nota_bimestre
//
// Sale de mg_evaluacion_competencia y mg_evaluacion_capacidades, donde
// id_bimestre NULL = nota final y con valor = nota de ese bimestre. Una
// nota sin asignar viene con id_valor/valor en null. Las notas finales de
// capacidades (id_bimestre NULL) no se incluyen en esta respuesta.

import { getServiceClient } from "../_shared/client.ts";
import { corsHeaders } from "../_shared/cors.ts";
import {
  errorResponse,
  jsonResponse,
  mensajeDeError,
  parseId,
} from "../_shared/http.ts";
import { type Fila, resolverIdMatriculaCurso } from "../_shared/notas.ts";

interface GrupoBimestre {
  id_bimestre: number;
  numero: number | null;
  nombre: string | null;
  nota: Fila | null;
  capacidades: Fila[];
}

interface GrupoCompetencia {
  notaFinal: Fila | null;
  bimestres: Map<number, GrupoBimestre>;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "GET") {
    return errorResponse("Ruta o método no soportado", 404);
  }

  try {
    const url = new URL(req.url);
    const idMatricula = parseId(url.searchParams.get("id_matricula") ?? undefined);
    const idCurso = parseId(url.searchParams.get("id_curso") ?? undefined);
    if (idMatricula === null || idCurso === null) {
      return errorResponse(
        "'id_matricula' e 'id_curso' (enteros) son requeridos",
        400,
      );
    }

    const supabase = getServiceClient();
    const resuelto = await resolverIdMatriculaCurso(supabase, idMatricula, idCurso);
    if ("error" in resuelto) return resuelto.error;
    const idMatriculaCurso = resuelto.id;

    const [
      { data: evalCompetencias, error: errorComp },
      { data: evalCapacidades, error: errorCap },
    ] = await Promise.all([
      supabase
        .from("mg_evaluacion_competencia")
        .select(
          "id_evaluacion_competencia, id_competencia, id_bimestre, id_valor, observacion, mg_valor_evaluacion(codigo, descripcion), mg_bimestre(numero, nombre)",
        )
        .eq("id_matricula_curso", idMatriculaCurso),
      supabase
        .from("mg_evaluacion_capacidades")
        .select(
          "id_evaluacion_capacidad, id_capacidad, id_bimestre, id_valor, mg_valor_evaluacion(codigo, descripcion), mg_bimestre(numero, nombre), mg_capacidades(id_competencia, descripcion)",
        )
        .eq("id_matricula_curso", idMatriculaCurso),
    ]);
    if (errorComp) return errorResponse(errorComp.message, 500);
    if (errorCap) return errorResponse(errorCap.message, 500);

    const grupos = new Map<number, GrupoCompetencia>();
    const grupoDe = (idCompetencia: number): GrupoCompetencia => {
      let g = grupos.get(idCompetencia);
      if (!g) {
        g = { notaFinal: null, bimestres: new Map() };
        grupos.set(idCompetencia, g);
      }
      return g;
    };
    const bimestreDe = (
      g: GrupoCompetencia,
      idBimestre: number,
      info: Fila | null,
    ): GrupoBimestre => {
      let b = g.bimestres.get(idBimestre);
      if (!b) {
        b = {
          id_bimestre: idBimestre,
          numero: (info?.numero as number | undefined) ?? null,
          nombre: (info?.nombre as string | undefined) ?? null,
          nota: null,
          capacidades: [],
        };
        g.bimestres.set(idBimestre, b);
      }
      return b;
    };

    for (const f of (evalCompetencias ?? []) as unknown as Fila[]) {
      const nota = {
        id_evaluacion_competencia: f.id_evaluacion_competencia,
        id_valor: f.id_valor,
        valor: f.mg_valor_evaluacion ?? null,
        observacion: f.observacion,
      };
      const g = grupoDe(f.id_competencia as number);
      if (f.id_bimestre === null) {
        g.notaFinal = nota;
      } else {
        bimestreDe(g, f.id_bimestre as number, f.mg_bimestre as Fila | null).nota =
          nota;
      }
    }

    for (const f of (evalCapacidades ?? []) as unknown as Fila[]) {
      if (f.id_bimestre === null) continue;
      const capacidad = f.mg_capacidades as Fila | null;
      const idCompetencia = capacidad?.id_competencia as number | null | undefined;
      if (idCompetencia === undefined || idCompetencia === null) continue;
      bimestreDe(
        grupoDe(idCompetencia),
        f.id_bimestre as number,
        f.mg_bimestre as Fila | null,
      ).capacidades.push({
        id_capacidad: f.id_capacidad,
        descripcion: capacidad?.descripcion ?? null,
        nota_bimestre: {
          id_evaluacion_capacidad: f.id_evaluacion_capacidad,
          id_valor: f.id_valor,
          valor: f.mg_valor_evaluacion ?? null,
        },
      });
    }

    // Datos descriptivos de las competencias (también de las que solo
    // aparecen vía sus capacidades).
    const idsCompetencia = [...grupos.keys()];
    const infoCompetencia = new Map<number, Fila>();
    if (idsCompetencia.length > 0) {
      const { data, error } = await supabase
        .from("mg_competencia")
        .select("id_competencia, codigo, descripcion, tipo")
        .in("id_competencia", idsCompetencia);
      if (error) return errorResponse(error.message, 500);
      for (const f of (data ?? []) as unknown as Fila[]) {
        infoCompetencia.set(f.id_competencia as number, f);
      }
    }

    const competencias = idsCompetencia
      .sort((a, b) => a - b)
      .map((idCompetencia) => {
        const g = grupos.get(idCompetencia) as GrupoCompetencia;
        const info = infoCompetencia.get(idCompetencia);
        const bimestres = [...g.bimestres.values()]
          .sort((a, b) => (a.numero ?? a.id_bimestre) - (b.numero ?? b.id_bimestre))
          .map((b) => ({
            id_bimestre: b.id_bimestre,
            numero: b.numero,
            nombre: b.nombre,
            nota_bimestre: b.nota,
            capacidades: b.capacidades.sort((x, y) =>
              (x.id_capacidad as number) - (y.id_capacidad as number)
            ),
          }));
        return {
          id_competencia: idCompetencia,
          codigo: info?.codigo ?? null,
          descripcion: info?.descripcion ?? null,
          tipo: info?.tipo ?? null,
          nota_final: g.notaFinal,
          bimestres,
        };
      });

    return jsonResponse({
      id_matricula: idMatricula,
      id_curso: idCurso,
      id_matricula_curso: idMatriculaCurso,
      competencias,
    });
  } catch (err) {
    console.error("[notas-matricula-curso] fallo:", err);
    return errorResponse(mensajeDeError(err), 500);
  }
});
