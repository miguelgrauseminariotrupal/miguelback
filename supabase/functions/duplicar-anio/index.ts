// POST /duplicar-anio — duplica configuración de un año lectivo a otro, por
// bloques independientes (cada uno se activa con su propio flag booleano).
//
// Body:
//   {
//     id_anio_origen: number,        // requerido
//     id_anio_destino: number,       // requerido, debe existir y ser distinto del origen
//     incluir_estructura?: boolean,          // niveles + grados + secciones
//     incluir_cursos?: boolean,              // cursos
//     incluir_curriculo?: boolean,           // aprendizajes + competencias + capacidades
//     incluir_programacion_secciones?: boolean,  // tutor responsable por sección
//     incluir_programacion_cursos?: boolean,     // curso+docente por sección
//   }
// Al menos un 'incluir_*' debe venir en true.
//
// Reglas generales:
// - Idempotente: si ya existe un registro equivalente en el año destino (por
//   nombre, o por la combinación que corresponda), no se duplica de nuevo.
// - Los bloques con dependencias (grados necesita niveles, competencias
//   necesita cursos y aprendizajes, programación_cursos necesita
//   programación_secciones y cursos) resuelven el mapeo viejo->nuevo
//   buscando también lo que ya exista en el destino, no solo lo creado en
//   esta misma llamada — así se puede correr en pasos separados o combinar
//   con estructura ya armada a mano.
// - Si un registro no se puede mapear (su padre no existe ni se creó), se
//   omite y se reporta en 'omitidos' en vez de fallar toda la operación.
// - mg_programacion_seccion.estado_completado NO se copia: las filas nuevas
//   quedan en false (la programación del año nuevo todavía no está
//   terminada, aunque se haya prellenado con el mismo docente).

import { getServiceClient } from "../_shared/client.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { errorResponse, jsonResponse } from "../_shared/http.ts";

type Supabase = ReturnType<typeof getServiceClient>;

/** Extrae un mensaje legible tanto de un Error de JS como de un error de
 * Postgrest/Postgres (objeto plano { message, code, details, hint }). */
function mensajeDeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return "Error inesperado";
}

/** Loguea el error completo (visible en `supabase functions logs
 * duplicar-anio`) con una etiqueta que dice en qué paso pasó, y lo relanza. */
function logYLanzar(etiqueta: string, error: unknown): never {
  console.error(`[duplicar-anio] ${etiqueta}:`, error);
  throw error;
}

interface ResultadoBloque {
  creados: number;
  ya_existian: number;
  omitidos: number[];
}

/**
 * Mapea (y opcionalmente crea) filas de una tabla jerárquica simple
 * (nivel/grado/sección/curso/aprendizaje: id + un campo de nombre + estado +
 * una columna de "padre" que ya viene resuelta al valor destino por fila).
 * 'columnaNombre' es configurable porque mg_aprendizaje usa
 * 'nombre_aprendizaje' en vez de 'nombre'.
 */
async function mapearPorNombre(
  supabase: Supabase,
  tabla: string,
  columnaId: string,
  columnaNombre: string,
  columnaPadre: string,
  filasOrigen: { id: number; nombre: string; estado: boolean; padreDestino: number | undefined }[],
  crear: boolean,
): Promise<{ mapa: Map<number, number>; resultado: ResultadoBloque }> {
  const mapa = new Map<number, number>();
  const omitidos: number[] = [];
  let yaExistian = 0;

  const padresDestino = [
    ...new Set(
      filasOrigen
        .map((f) => f.padreDestino)
        .filter((v): v is number => v !== undefined),
    ),
  ];

  const existentes = padresDestino.length > 0
    ? await supabase.from(tabla).select(`${columnaId}, ${columnaNombre}, ${columnaPadre}`).in(
      columnaPadre,
      padresDestino,
    )
    : { data: [] as Record<string, unknown>[], error: null };
  if (existentes.error) {
    logYLanzar(`mapearPorNombre(${tabla}): consulta de existentes`, existentes.error);
  }

  const clave = (padre: number, nombre: string) => `${padre}:${nombre}`;
  const existentesPorClave = new Map(
    ((existentes.data ?? []) as Record<string, unknown>[]).map((r) => [
      clave(r[columnaPadre] as number, r[columnaNombre] as string),
      r[columnaId] as number,
    ]),
  );

  const aCrear: { nombre: string; estado: boolean; padreDestino: number; idOrigen: number }[] = [];
  for (const f of filasOrigen) {
    if (f.padreDestino === undefined) {
      omitidos.push(f.id);
      continue;
    }
    const idExistente = existentesPorClave.get(clave(f.padreDestino, f.nombre));
    if (idExistente !== undefined) {
      mapa.set(f.id, idExistente);
      yaExistian++;
    } else if (crear) {
      aCrear.push({
        nombre: f.nombre,
        estado: f.estado,
        padreDestino: f.padreDestino,
        idOrigen: f.id,
      });
    } else {
      omitidos.push(f.id);
    }
  }

  let creados = 0;
  if (aCrear.length > 0) {
    const { data: insertados, error } = await supabase
      .from(tabla)
      .insert(
        aCrear.map((r) => ({
          [columnaNombre]: r.nombre,
          estado: r.estado,
          [columnaPadre]: r.padreDestino,
        })),
      )
      .select(`${columnaId}, ${columnaNombre}, ${columnaPadre}`);
    if (error) logYLanzar(`mapearPorNombre(${tabla}): insert`, error);
    const nuevoPorClave = new Map(
      ((insertados ?? []) as unknown as Record<string, unknown>[]).map((r) => [
        clave(r[columnaPadre] as number, r[columnaNombre] as string),
        r[columnaId] as number,
      ]),
    );
    for (const r of aCrear) {
      const nuevoId = nuevoPorClave.get(clave(r.padreDestino, r.nombre));
      if (nuevoId !== undefined) mapa.set(r.idOrigen, nuevoId);
    }
    creados = insertados?.length ?? 0;
  }

  return { mapa, resultado: { creados, ya_existian: yaExistian, omitidos } };
}

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
      !body ||
      typeof body.id_anio_origen !== "number" || !Number.isInteger(body.id_anio_origen) ||
      typeof body.id_anio_destino !== "number" || !Number.isInteger(body.id_anio_destino)
    ) {
      return errorResponse(
        "'id_anio_origen' e 'id_anio_destino' (enteros) son requeridos",
        400,
      );
    }
    if (body.id_anio_origen === body.id_anio_destino) {
      return errorResponse(
        "'id_anio_origen' e 'id_anio_destino' deben ser distintos",
        400,
      );
    }

    const flags = {
      incluir_estructura: body.incluir_estructura === true,
      incluir_cursos: body.incluir_cursos === true,
      incluir_curriculo: body.incluir_curriculo === true,
      incluir_programacion_secciones: body.incluir_programacion_secciones === true,
      incluir_programacion_cursos: body.incluir_programacion_cursos === true,
    };
    if (!Object.values(flags).some(Boolean)) {
      return errorResponse(
        "Debe activarse al menos un 'incluir_*' (estructura, cursos, curriculo, programacion_secciones, programacion_cursos)",
        400,
      );
    }

    console.log("[duplicar-anio] body:", JSON.stringify({ ...body, flags }));

    const supabase = getServiceClient();
    const idOrigen = body.id_anio_origen;
    const idDestino = body.id_anio_destino;

    const [{ data: anioOrigen }, { data: anioDestino }] = await Promise.all([
      supabase.from("mg_anio_lectivo").select("id_anio_lectivo").eq(
        "id_anio_lectivo",
        idOrigen,
      ).maybeSingle(),
      supabase.from("mg_anio_lectivo").select("id_anio_lectivo").eq(
        "id_anio_lectivo",
        idDestino,
      ).maybeSingle(),
    ]);
    if (!anioOrigen) return errorResponse("'id_anio_origen' no existe", 400);
    if (!anioDestino) return errorResponse("'id_anio_destino' no existe", 400);
    console.log(`[duplicar-anio] años validados: origen=${idOrigen} destino=${idDestino}`);

    const respuesta: Record<string, unknown> = {
      id_anio_origen: idOrigen,
      id_anio_destino: idDestino,
    };

    // --- Estructura: niveles -> grados -> secciones ---
    // Los niveles se mapean siempre (de solo lectura si el flag viene en
    // false) porque cursos/curriculo no los necesitan, pero programación de
    // secciones sí necesita el mapeo de secciones más abajo.
    const necesitaEstructura = flags.incluir_estructura ||
      flags.incluir_programacion_secciones || flags.incluir_programacion_cursos;

    let mapaSecciones = new Map<number, number>();
    if (necesitaEstructura) {
      console.log("[duplicar-anio] bloque estructura: inicio");
      const { data: nivelesOrigen, error: eNiv } = await supabase
        .from("mg_nivel")
        .select("id_nivel, nombre, estado")
        .eq("id_anio_lectivo", idOrigen);
      if (eNiv) logYLanzar("estructura: select mg_nivel origen", eNiv);
      console.log(`[duplicar-anio] niveles origen: ${nivelesOrigen?.length ?? 0}`);

      const { mapa: mapaNiveles, resultado: resNiveles } = await mapearPorNombre(
        supabase,
        "mg_nivel",
        "id_nivel",
        "nombre",
        "id_anio_lectivo",
        (nivelesOrigen ?? []).map((n) => ({
          id: n.id_nivel,
          nombre: n.nombre,
          estado: n.estado,
          padreDestino: idDestino,
        })),
        flags.incluir_estructura,
      );

      const { data: gradosOrigen, error: eGra } = await supabase
        .from("mg_grado")
        .select("id_grado, id_nivel, nombre, estado")
        .in("id_nivel", (nivelesOrigen ?? []).map((n) => n.id_nivel));
      if (eGra) logYLanzar("estructura: select mg_grado origen", eGra);
      console.log(`[duplicar-anio] grados origen: ${gradosOrigen?.length ?? 0}`);

      const { mapa: mapaGrados, resultado: resGrados } = await mapearPorNombre(
        supabase,
        "mg_grado",
        "id_grado",
        "nombre",
        "id_nivel",
        (gradosOrigen ?? []).map((g) => ({
          id: g.id_grado,
          nombre: g.nombre,
          estado: g.estado,
          padreDestino: mapaNiveles.get(g.id_nivel),
        })),
        flags.incluir_estructura,
      );

      const { data: seccionesOrigen, error: eSec } = await supabase
        .from("mg_seccion")
        .select("id_seccion, id_grado, nombre, estado")
        .in("id_grado", (gradosOrigen ?? []).map((g) => g.id_grado));
      if (eSec) logYLanzar("estructura: select mg_seccion origen", eSec);
      console.log(`[duplicar-anio] secciones origen: ${seccionesOrigen?.length ?? 0}`);

      const { mapa, resultado: resSecciones } = await mapearPorNombre(
        supabase,
        "mg_seccion",
        "id_seccion",
        "nombre",
        "id_grado",
        (seccionesOrigen ?? []).map((s) => ({
          id: s.id_seccion,
          nombre: s.nombre,
          estado: s.estado,
          padreDestino: mapaGrados.get(s.id_grado),
        })),
        flags.incluir_estructura,
      );
      mapaSecciones = mapa;
      console.log("[duplicar-anio] bloque estructura: fin", {
        niveles: resNiveles,
        grados: resGrados,
        secciones: resSecciones,
      });

      if (flags.incluir_estructura) {
        respuesta.estructura = {
          niveles: resNiveles,
          grados: resGrados,
          secciones: resSecciones,
        };
      }
    }

    // --- Cursos (independiente, pero mapeo necesario para curriculo y
    // programación de cursos incluso si este flag viene en false) ---
    const necesitaCursos = flags.incluir_cursos || flags.incluir_curriculo ||
      flags.incluir_programacion_cursos;

    let mapaCursos = new Map<number, number>();
    if (necesitaCursos) {
      console.log("[duplicar-anio] bloque cursos: inicio");
      const { data: cursosOrigen, error: eCur } = await supabase
        .from("mg_curso")
        .select("id_curso, nombre, estado")
        .eq("id_anio_lectivo", idOrigen);
      if (eCur) logYLanzar("cursos: select mg_curso origen", eCur);
      console.log(`[duplicar-anio] cursos origen: ${cursosOrigen?.length ?? 0}`);

      const { mapa, resultado } = await mapearPorNombre(
        supabase,
        "mg_curso",
        "id_curso",
        "nombre",
        "id_anio_lectivo",
        (cursosOrigen ?? []).map((c) => ({
          id: c.id_curso,
          nombre: c.nombre,
          estado: c.estado,
          padreDestino: idDestino,
        })),
        flags.incluir_cursos,
      );
      mapaCursos = mapa;
      console.log("[duplicar-anio] bloque cursos: fin", resultado);
      if (flags.incluir_cursos) respuesta.cursos = resultado;
    }

    // --- Currículo: aprendizajes -> competencias -> capacidades ---
    if (flags.incluir_curriculo) {
      console.log("[duplicar-anio] bloque curriculo: inicio");
      const { data: aprendizajesOrigen, error: eApr } = await supabase
        .from("mg_aprendizaje")
        .select("id_aprendizaje, nombre_aprendizaje, estado")
        .eq("id_anio_lectivo", idOrigen);
      if (eApr) logYLanzar("curriculo: select mg_aprendizaje origen", eApr);
      console.log(`[duplicar-anio] aprendizajes origen: ${aprendizajesOrigen?.length ?? 0}`);

      const { mapa: mapaAprendizajes, resultado: resAprendizajes } = await mapearPorNombre(
        supabase,
        "mg_aprendizaje",
        "id_aprendizaje",
        "nombre_aprendizaje",
        "id_anio_lectivo",
        (aprendizajesOrigen ?? []).map((a) => ({
          id: a.id_aprendizaje,
          nombre: a.nombre_aprendizaje ?? "",
          estado: a.estado ?? true,
          padreDestino: idDestino,
        })),
        true,
      );

      const { data: competenciasOrigen, error: eComp } = await supabase
        .from("mg_competencia")
        .select("id_competencia, id_curso, codigo, descripcion, estado, id_aprendizaje, tipo")
        .in("id_curso", (
          await supabase.from("mg_curso").select("id_curso").eq(
            "id_anio_lectivo",
            idOrigen,
          )
        ).data?.map((c) => c.id_curso) ?? []);
      if (eComp) logYLanzar("curriculo: select mg_competencia origen", eComp);
      console.log(`[duplicar-anio] competencias origen: ${competenciasOrigen?.length ?? 0}`);

      const cursoDestinoIds = [
        ...new Set(
          (competenciasOrigen ?? [])
            .map((c) => mapaCursos.get(c.id_curso))
            .filter((v): v is number => v !== undefined),
        ),
      ];
      const { data: competenciasExistentes, error: eCompEx } = cursoDestinoIds.length > 0
        ? await supabase.from("mg_competencia").select(
          "id_competencia, id_curso, descripcion",
        ).in("id_curso", cursoDestinoIds)
        : { data: [], error: null };
      if (eCompEx) logYLanzar("curriculo: select mg_competencia existentes destino", eCompEx);
      const claveComp = (idCurso: number, descripcion: string) => `${idCurso}:${descripcion}`;
      const compExistentesPorClave = new Map(
        (competenciasExistentes ?? []).map((
          c,
        ) => [claveComp(c.id_curso, c.descripcion), c.id_competencia]),
      );

      const mapaCompetencias = new Map<number, number>();
      const omitidosCompetencias: number[] = [];
      let yaExistianCompetencias = 0;
      const competenciasACrear: {
        idOrigen: number;
        id_curso: number;
        codigo: string | null;
        descripcion: string;
        estado: boolean;
        id_aprendizaje: number | null;
        tipo: string | null;
      }[] = [];

      for (const c of competenciasOrigen ?? []) {
        const idCursoDestino = mapaCursos.get(c.id_curso);
        if (idCursoDestino === undefined) {
          omitidosCompetencias.push(c.id_competencia);
          continue;
        }
        let idAprendizajeDestino: number | null = null;
        if (c.id_aprendizaje !== null) {
          const resuelto = mapaAprendizajes.get(c.id_aprendizaje);
          if (resuelto === undefined) {
            omitidosCompetencias.push(c.id_competencia);
            continue;
          }
          idAprendizajeDestino = resuelto;
        }
        const idExistente = compExistentesPorClave.get(
          claveComp(idCursoDestino, c.descripcion),
        );
        if (idExistente !== undefined) {
          mapaCompetencias.set(c.id_competencia, idExistente);
          yaExistianCompetencias++;
        } else {
          competenciasACrear.push({
            idOrigen: c.id_competencia,
            id_curso: idCursoDestino,
            codigo: c.codigo,
            descripcion: c.descripcion,
            estado: c.estado,
            id_aprendizaje: idAprendizajeDestino,
            tipo: c.tipo,
          });
        }
      }
      let competenciasCreadas = 0;
      if (competenciasACrear.length > 0) {
        const { data: insertadas, error } = await supabase
          .from("mg_competencia")
          .insert(competenciasACrear.map((c) => ({
            id_curso: c.id_curso,
            codigo: c.codigo,
            descripcion: c.descripcion,
            estado: c.estado,
            id_aprendizaje: c.id_aprendizaje,
            tipo: c.tipo,
          })))
          .select("id_competencia, id_curso, descripcion");
        if (error) logYLanzar("curriculo: insert mg_competencia", error);
        const nuevoPorClave = new Map(
          (insertadas ?? []).map((
            r,
          ) => [claveComp(r.id_curso, r.descripcion), r.id_competencia]),
        );
        for (const c of competenciasACrear) {
          const nuevoId = nuevoPorClave.get(claveComp(c.id_curso, c.descripcion));
          if (nuevoId !== undefined) mapaCompetencias.set(c.idOrigen, nuevoId);
        }
        competenciasCreadas = insertadas?.length ?? 0;
      }
      console.log("[duplicar-anio] competencias:", {
        creados: competenciasCreadas,
        ya_existian: yaExistianCompetencias,
        omitidos: omitidosCompetencias,
      });

      const { data: capacidadesOrigen, error: eCap } = await supabase
        .from("mg_capacidades")
        .select("id_capacidad, id_competencia, descripcion, estado")
        .in("id_competencia", (competenciasOrigen ?? []).map((c) => c.id_competencia));
      if (eCap) logYLanzar("curriculo: select mg_capacidades origen", eCap);
      console.log(`[duplicar-anio] capacidades origen: ${capacidadesOrigen?.length ?? 0}`);

      const competenciaDestinoIds = [
        ...new Set(
          (capacidadesOrigen ?? [])
            .map((c) => c.id_competencia !== null ? mapaCompetencias.get(c.id_competencia) : undefined)
            .filter((v): v is number => v !== undefined),
        ),
      ];
      const { data: capacidadesExistentes, error: eCapEx } = competenciaDestinoIds.length > 0
        ? await supabase.from("mg_capacidades").select(
          "id_capacidad, id_competencia, descripcion",
        ).in("id_competencia", competenciaDestinoIds)
        : { data: [], error: null };
      if (eCapEx) logYLanzar("curriculo: select mg_capacidades existentes destino", eCapEx);
      const claveCap = (idComp: number, descripcion: string) => `${idComp}:${descripcion}`;
      const capExistentesPorClave = new Map(
        (capacidadesExistentes ?? []).map((
          c,
        ) => [claveCap(c.id_competencia, c.descripcion), c.id_capacidad]),
      );

      const omitidosCapacidades: number[] = [];
      let yaExistianCapacidades = 0;
      const capacidadesACrear: {
        id_competencia: number;
        descripcion: string;
        estado: boolean;
      }[] = [];
      for (const c of capacidadesOrigen ?? []) {
        const idCompetenciaDestino = c.id_competencia !== null
          ? mapaCompetencias.get(c.id_competencia)
          : undefined;
        if (idCompetenciaDestino === undefined) {
          omitidosCapacidades.push(c.id_capacidad);
          continue;
        }
        const idExistente = capExistentesPorClave.get(
          claveCap(idCompetenciaDestino, c.descripcion),
        );
        if (idExistente !== undefined) {
          yaExistianCapacidades++;
        } else {
          capacidadesACrear.push({
            id_competencia: idCompetenciaDestino,
            descripcion: c.descripcion,
            estado: c.estado,
          });
        }
      }
      let capacidadesCreadas = 0;
      if (capacidadesACrear.length > 0) {
        const { error } = await supabase.from("mg_capacidades").insert(capacidadesACrear);
        if (error) logYLanzar("curriculo: insert mg_capacidades", error);
        capacidadesCreadas = capacidadesACrear.length;
      }
      console.log("[duplicar-anio] bloque curriculo: fin", {
        capacidades: {
          creados: capacidadesCreadas,
          ya_existian: yaExistianCapacidades,
          omitidos: omitidosCapacidades,
        },
      });

      respuesta.curriculo = {
        aprendizajes: resAprendizajes,
        competencias: {
          creados: competenciasCreadas,
          ya_existian: yaExistianCompetencias,
          omitidos: omitidosCompetencias,
        },
        capacidades: {
          creados: capacidadesCreadas,
          ya_existian: yaExistianCapacidades,
          omitidos: omitidosCapacidades,
        },
      };
    }

    // --- Programación de secciones (tutor responsable) ---
    const mapaProgramacionSeccion = new Map<number, number>();
    if (flags.incluir_programacion_secciones || flags.incluir_programacion_cursos) {
      console.log("[duplicar-anio] bloque programacion_secciones: inicio");
      const seccionesOrigenIds = [...mapaSecciones.keys()];
      const { data: progSeccionOrigen, error: ePS } = await supabase
        .from("mg_programacion_seccion")
        .select("id_programacion_seccion, id_seccion, id_docente_responsable")
        .in("id_seccion", seccionesOrigenIds);
      if (ePS) logYLanzar("programacion_secciones: select origen", ePS);
      console.log(
        `[duplicar-anio] programacion_seccion origen: ${progSeccionOrigen?.length ?? 0}`,
      );

      const seccionesDestinoIds = [
        ...new Set(
          (progSeccionOrigen ?? [])
            .map((p) => mapaSecciones.get(p.id_seccion))
            .filter((v): v is number => v !== undefined),
        ),
      ];
      const { data: progSeccionExistente, error: ePSEx } = seccionesDestinoIds.length > 0
        ? await supabase.from("mg_programacion_seccion").select(
          "id_programacion_seccion, id_seccion",
        ).in("id_seccion", seccionesDestinoIds)
        : { data: [], error: null };
      if (ePSEx) logYLanzar("programacion_secciones: select existentes destino", ePSEx);
      const psExistentePorSeccion = new Map(
        (progSeccionExistente ?? []).map((p) => [p.id_seccion, p.id_programacion_seccion]),
      );

      const omitidos: number[] = [];
      let yaExistian = 0;
      const aCrear: { idOrigen: number; id_seccion: number; id_docente_responsable: number }[] = [];
      for (const p of progSeccionOrigen ?? []) {
        const idSeccionDestino = mapaSecciones.get(p.id_seccion);
        if (idSeccionDestino === undefined) {
          omitidos.push(p.id_programacion_seccion);
          continue;
        }
        const idExistente = psExistentePorSeccion.get(idSeccionDestino);
        if (idExistente !== undefined) {
          mapaProgramacionSeccion.set(p.id_programacion_seccion, idExistente);
          yaExistian++;
        } else if (flags.incluir_programacion_secciones) {
          aCrear.push({
            idOrigen: p.id_programacion_seccion,
            id_seccion: idSeccionDestino,
            id_docente_responsable: p.id_docente_responsable,
          });
        } else {
          omitidos.push(p.id_programacion_seccion);
        }
      }
      let creados = 0;
      if (aCrear.length > 0) {
        const { data: insertados, error } = await supabase
          .from("mg_programacion_seccion")
          .insert(aCrear.map((r) => ({
            id_seccion: r.id_seccion,
            id_docente_responsable: r.id_docente_responsable,
            estado_completado: false,
          })))
          .select("id_programacion_seccion, id_seccion");
        if (error) logYLanzar("programacion_secciones: insert", error);
        const nuevoPorSeccion = new Map(
          (insertados ?? []).map((r) => [r.id_seccion, r.id_programacion_seccion]),
        );
        for (const r of aCrear) {
          const nuevoId = nuevoPorSeccion.get(r.id_seccion);
          if (nuevoId !== undefined) mapaProgramacionSeccion.set(r.idOrigen, nuevoId);
        }
        creados = insertados?.length ?? 0;
      }

      console.log("[duplicar-anio] bloque programacion_secciones: fin", {
        creados,
        ya_existian: yaExistian,
        omitidos,
      });
      if (flags.incluir_programacion_secciones) {
        respuesta.programacion_secciones = { creados, ya_existian: yaExistian, omitidos };
      }
    }

    // --- Programación de cursos (curso + docente por sección) ---
    if (flags.incluir_programacion_cursos) {
      console.log("[duplicar-anio] bloque programacion_cursos: inicio");
      const progSeccionOrigenIds = [...mapaProgramacionSeccion.keys()];
      const { data: progCursoOrigen, error: ePC } = await supabase
        .from("mg_programacion_curso")
        .select("id_programacion_curso, id_programacion_seccion, id_curso, id_docente, estado")
        .in("id_programacion_seccion", progSeccionOrigenIds);
      if (ePC) logYLanzar("programacion_cursos: select origen", ePC);
      console.log(`[duplicar-anio] programacion_curso origen: ${progCursoOrigen?.length ?? 0}`);

      const progSeccionDestinoIds = [
        ...new Set(
          (progCursoOrigen ?? [])
            .map((p) => mapaProgramacionSeccion.get(p.id_programacion_seccion))
            .filter((v): v is number => v !== undefined),
        ),
      ];
      const { data: progCursoExistente, error: ePCEx } = progSeccionDestinoIds.length > 0
        ? await supabase.from("mg_programacion_curso").select(
          "id_programacion_seccion, id_curso",
        ).in("id_programacion_seccion", progSeccionDestinoIds)
        : { data: [], error: null };
      if (ePCEx) logYLanzar("programacion_cursos: select existentes destino", ePCEx);
      const claveExistente = (idProgSeccion: number, idCurso: number) =>
        `${idProgSeccion}:${idCurso}`;
      const existentesSet = new Set(
        (progCursoExistente ?? []).map((p) =>
          claveExistente(p.id_programacion_seccion, p.id_curso)
        ),
      );

      const omitidos: number[] = [];
      let yaExistian = 0;
      const aCrear: {
        id_programacion_seccion: number;
        id_curso: number;
        id_docente: number;
        estado: boolean;
      }[] = [];
      for (const p of progCursoOrigen ?? []) {
        const idProgSeccionDestino = mapaProgramacionSeccion.get(p.id_programacion_seccion);
        const idCursoDestino = mapaCursos.get(p.id_curso);
        if (idProgSeccionDestino === undefined || idCursoDestino === undefined) {
          omitidos.push(p.id_programacion_curso);
          continue;
        }
        if (existentesSet.has(claveExistente(idProgSeccionDestino, idCursoDestino))) {
          yaExistian++;
        } else {
          aCrear.push({
            id_programacion_seccion: idProgSeccionDestino,
            id_curso: idCursoDestino,
            id_docente: p.id_docente,
            estado: p.estado,
          });
        }
      }
      let creados = 0;
      if (aCrear.length > 0) {
        const { error } = await supabase.from("mg_programacion_curso").insert(aCrear);
        if (error) logYLanzar("programacion_cursos: insert", error);
        creados = aCrear.length;
      }

      console.log("[duplicar-anio] bloque programacion_cursos: fin", {
        creados,
        ya_existian: yaExistian,
        omitidos,
      });
      respuesta.programacion_cursos = { creados, ya_existian: yaExistian, omitidos };
    }

    console.log("[duplicar-anio] respuesta final:", JSON.stringify(respuesta));
    return jsonResponse(respuesta, 201);
  } catch (err) {
    console.error("[duplicar-anio] fallo:", err);
    return errorResponse(mensajeDeError(err), 500);
  }
});
