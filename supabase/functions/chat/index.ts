// supabase/functions/chat/index.ts
// Edge Function del agente.
// Tablas: conversaciones, mensajes, metricas_consulta
//
// Seguridad: todas las rutas exigen `Authorization: Bearer <access_token>`
// (el de POST /login, Supabase Auth). Cada usuario solo ve y escribe en sus
// propias conversaciones: conversaciones.usuario_id = auth.users.id del token.
// La validación se hace en el código (requireAuth), por eso se despliega con
// verify_jwt = false (ver config.toml).
//
//   supabase secrets set OPENAI_API_KEY=...
//   supabase functions deploy chat --no-verify-jwt
//
// Opcional: COLEGIO_API_URL y COLEGIO_API_TOKEN para la API externa del colegio.
// SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY ya vienen por defecto.

import {
  streamText,
  convertToModelMessages,
  tool,
  stepCountIs,
  type UIMessage,
} from "npm:ai@5";
import { createOpenAI } from "npm:@ai-sdk/openai@2";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { z } from "npm:zod@3";
import {
  type AlcanceSecciones,
  alcanceSecciones,
  type ContextoAuth,
  puedeVerSeccion,
  requireAuth,
} from "../_shared/auth.ts";

// ---------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------
const MAX_MENSAJES_CONTEXTO = 20;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Se puede cambiar sin redesplegar con el secret OPENAI_MODEL.
const MODELO = Deno.env.get("OPENAI_MODEL") ?? "gpt-4.1-mini";

const openai = createOpenAI({ apiKey: Deno.env.get("OPENAI_API_KEY") });

// Cliente con service_role: se salta RLS, así que TODA consulta sobre datos
// del usuario debe filtrar por usuario_id (id de Auth del token validado).
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// ---------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Logs del agente: todo con prefijo [chat] para filtrarlos en el dashboard
// (Edge Functions > chat > Logs) o con `supabase functions logs chat`.
function log(msg: string, extra?: unknown) {
  if (extra === undefined) console.log(`[chat] ${msg}`);
  else console.log(`[chat] ${msg}`, JSON.stringify(extra));
}

// Los errores de PostgREST son objetos planos (no `Error`): String(e) daría
// "[object Object]", así que se serializan completos.
function descr(e: unknown): string {
  if (e instanceof Error) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

function textoDe(message: UIMessage): string {
  return message.parts
    .filter((p) => p.type === "text")
    .map((p) => (p as { text: string }).text)
    .join(" ")
    .trim();
}

function clasificarIndicador(herramientas: string[]) {
  const notas = herramientas.some((h) =>
    h === "obtener_notas_seccion" || h === "obtener_notas"
  );
  const asistencia = herramientas.some((h) =>
    h === "obtener_asistencia" || h === "listar_asistencias"
  );
  if (notas && asistencia) return "integrado";
  if (notas) return "notas";
  if (asistencia) return "asistencia";
  return "otro";
}

// ---------------------------------------------------------------------
// Listados de la estructura académica
// ---------------------------------------------------------------------
const LIMITE_LISTADO = 200;

const estadoSchema = z.boolean().optional().describe(
  "true = solo activos, false = solo inactivos. Omitir para traer todos",
);

async function listar(
  tabla: string,
  columnas: string,
  orden: { columna: string; ascendente: boolean },
  filtros: Record<string, number | boolean | undefined>,
) {
  let query = supabase
    .from(tabla)
    .select(columnas)
    .order(orden.columna, { ascending: orden.ascendente })
    .limit(LIMITE_LISTADO);
  for (const [columna, valor] of Object.entries(filtros)) {
    if (valor !== undefined) query = query.eq(columna, valor);
  }
  const { data, error } = await query;
  if (error) {
    log(`tool -> ${tabla} falló`, error);
    return { error: error.message };
  }
  log(`tool -> ${tabla} ${JSON.stringify(filtros)} = ${data?.length ?? 0} filas`);
  return data;
}

// Llama a las otras edge functions del proyecto (mismo contrato que openapi.yaml).
// Reenvía el Authorization del usuario para que esas funciones lo validen.
async function academico(
  ruta: string,
  query: Record<string, string | number | boolean | undefined>,
  authorization: string,
) {
  const url = new URL(`${Deno.env.get("SUPABASE_URL")}/functions/v1/${ruta}`);
  for (const [clave, valor] of Object.entries(query)) {
    if (valor !== undefined) url.searchParams.set(clave, String(valor));
  }
  try {
    const res = await fetch(url, { headers: { Authorization: authorization } });
    const cuerpo = await res.json().catch(() => null);
    log(`tool -> GET ${url.pathname}${url.search} = ${res.status}`);
    if (!res.ok) {
      return { error: cuerpo?.error ?? `La API respondió ${res.status}` };
    }
    return cuerpo;
  } catch (e) {
    return { error: e instanceof Error ? e.message : "No se pudo llamar a la API" };
  }
}

// ---------------------------------------------------------------------
// Herramientas del agente
// ---------------------------------------------------------------------
const SIN_ACCESO_SECCION = {
  error: "No tienes acceso a esa sección. Solo puedes consultar las secciones " +
    "en las que eres docente responsable.",
};


// --- Verificación de coincidencia sección pedida vs. sección consultada ----
// El modelo resuelve "Primero de primaria, Única" a un id_seccion. Para que no
// pueda sustituir una sección por otra (y rotular mal los datos), cada tool de
// datos recibe también el texto que dijo el usuario y se compara con la
// sección real del id.
const ORDINALES: Record<string, number> = {
  primero: 1, primer: 1, "1ro": 1, "1ero": 1, "1er": 1, "1": 1,
  segundo: 2, "2do": 2, "2": 2,
  tercero: 3, tercer: 3, "3ro": 3, "3ero": 3, "3er": 3, "3": 3,
  cuarto: 4, "4to": 4, "4": 4,
  quinto: 5, "5to": 5, "5": 5,
  sexto: 6, "6to": 6, "6": 6,
};
const NIVELES = ["inicial", "primaria", "secundaria"];

const tokens = (t: string) =>
  t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .split(/[^a-z0-9]+/).filter(Boolean);

const ordinalDe = (t: string): number | null => {
  for (const tok of tokens(t)) if (tok in ORDINALES) return ORDINALES[tok];
  return null;
};

async function verificarSeccion(idSeccion: number, solicitud: string) {
  const { data, error } = await supabase
    .from("mg_seccion")
    .select("nombre, mg_grado(nombre, mg_nivel(nombre))")
    .eq("id_seccion", idSeccion)
    .maybeSingle();
  if (error || !data) return { error: `No existe la sección ${idSeccion}` };
  const uno = <T>(v: T | T[] | null | undefined): T | null =>
    Array.isArray(v) ? v[0] ?? null : v ?? null;
  const g = uno(data.mg_grado as unknown as
    | { nombre: string; mg_nivel: unknown } | null);
  const n = uno(g?.mg_nivel as { nombre: string } | { nombre: string }[] | null);
  const real = `${g?.nombre ?? "?"} de ${n?.nombre ?? "?"}, sección ${data.nombre}`;

  const pedido = tokens(solicitud);
  const ordPedido = ordinalDe(solicitud);
  const ordReal = ordinalDe(g?.nombre ?? "");
  const nivelReal = tokens(n?.nombre ?? "");
  const nivelPedido = NIVELES.filter((x) => pedido.includes(x));
  const seccionReal = tokens(data.nombre);

  const gradoOk = ordPedido === null || ordReal === null || ordPedido === ordReal;
  const nivelOk = nivelPedido.length === 0 ||
    nivelPedido.some((x) => nivelReal.includes(x));
  const seccionOk = seccionReal.every((x) => pedido.includes(x)) ||
    // la sección no se mencionó: no se puede contradecir
    !pedido.some((x) => /^[a-z]$/.test(x) || x === "unica");

  if (gradoOk && nivelOk && seccionOk) return null;
  return {
    error: `El id_seccion ${idSeccion} corresponde a ${real}, que no coincide ` +
      `con lo pedido ("${solicitud}"). No lo sustituyas: dile al usuario que ` +
      "esa sección no existe o no está disponible para él.",
  };
}

const solicitudSchema = z.string().describe(
  "Texto exacto del usuario que identifica la sección, p. ej. " +
    "'Primero de primaria, sección Única'. Se usa para comprobar que el " +
    "id_seccion es el que pidió.",
);

type Fila = Record<string, unknown>;

// Deja en el árbol de obtener_estructura_anio solo las secciones permitidas
// (y los grados/niveles que queden con alguna).
function podarEstructura(estructura: Fila, permitidas: number[]): Fila {
  const niveles = ((estructura.niveles as Fila[] | undefined) ?? [])
    .map((n) => {
      const grados = ((n.grados as Fila[] | undefined) ?? [])
        .map((g) => ({
          ...g,
          secciones: ((g.secciones as Fila[] | undefined) ?? []).filter((s) =>
            permitidas.includes(s.id_seccion as number)
          ),
        }))
        .filter((g) => g.secciones.length > 0);
      return { ...n, grados };
    })
    .filter((n) => n.grados.length > 0);
  return { ...estructura, niveles };
}

function crearTools(
  authorization: string,
  alcance: AlcanceSecciones,
  ctx: ContextoAuth,
) {
  const api = (
    ruta: string,
    query: Record<string, string | number | boolean | undefined>,
  ) => academico(ruta, query, authorization);

  return {
  mi_perfil: tool({
    description:
      "Datos del usuario que está chateando: usuario, correo, roles, si es " +
      "docente, y las secciones en las que es docente responsable (tutor). " +
      "Usar cuando pregunte quién es, qué rol tiene, qué secciones tiene a su " +
      "cargo o en qué puedes ayudarle. Nunca le pidas su rol o nombre: ya los sabes.",
    inputSchema: z.object({}),
    execute: async () => {
      const { data: docente } = await supabase
        .from("mg_docente")
        .select("id_docente, nombres, apellido_paterno, apellido_materno")
        .eq("id_usuario", ctx.usuario.id_usuario)
        .maybeSingle();

      let secciones: unknown[] = [];
      if (docente) {
        const { data } = await supabase
          .from("mg_programacion_seccion")
          .select(
            "id_seccion, mg_seccion(nombre, mg_grado(nombre, mg_nivel(nombre, mg_anio_lectivo(anio))))",
          )
          .eq("id_docente_responsable", docente.id_docente);
        secciones = (data ?? []).map((f) => {
          const s = (Array.isArray(f.mg_seccion) ? f.mg_seccion[0] : f.mg_seccion) as
            | { nombre: string; mg_grado: unknown }
            | null;
          const g = (Array.isArray(s?.mg_grado) ? s?.mg_grado[0] : s?.mg_grado) as
            | { nombre: string; mg_nivel: unknown }
            | null;
          const n = (Array.isArray(g?.mg_nivel) ? g?.mg_nivel[0] : g?.mg_nivel) as
            | { nombre: string; mg_anio_lectivo: unknown }
            | null;
          const a = (Array.isArray(n?.mg_anio_lectivo)
            ? n?.mg_anio_lectivo[0]
            : n?.mg_anio_lectivo) as { anio: number } | null;
          return {
            id_seccion: f.id_seccion,
            seccion: s?.nombre ?? null,
            grado: g?.nombre ?? null,
            nivel: n?.nombre ?? null,
            anio: a?.anio ?? null,
          };
        });
      }
      return {
        usuario: ctx.usuario.usuario,
        correo: ctx.usuario.correo,
        roles: ctx.roles,
        docente: docente
          ? [docente.nombres, docente.apellido_paterno, docente.apellido_materno]
            .filter(Boolean).join(" ")
          : null,
        acceso_todas_las_secciones: alcance.todas,
        secciones_a_cargo: secciones,
      };
    },
  }),

  obtener_notas_seccion: tool({
    description:
      "Resumen de notas de una sección (cualquier nivel) en un bimestre: por " +
      "curso y competencia, cuántos alumnos obtuvieron cada calificación " +
      "(cantidad y porcentaje). Las notas son calificaciones por valor (por " +
      "ejemplo AD, A, B, C), no números: no hay promedio numérico. Necesita " +
      "id_seccion, que se obtiene con obtener_estructura_anio. Usar para " +
      "preguntas sobre rendimiento académico o notas de una sección.",
    inputSchema: z.object({
      id_seccion: z.number().int(),
      solicitud: solicitudSchema,
      bimestre: z.number().int().min(1).max(4),
    }),
    execute: async ({ id_seccion, solicitud, bimestre }) => {
      if (!puedeVerSeccion(alcance, id_seccion)) return SIN_ACCESO_SECCION;
      const noCoincide = await verificarSeccion(id_seccion, solicitud);
      if (noCoincide) return noCoincide;
      const { data, error } = await supabase.rpc("obtener_notas_seccion", {
        p_id_seccion: id_seccion,
        p_bimestre: bimestre,
      });
      if (error) {
        log("tool -> obtener_notas_seccion falló", error);
        return { error: error.message };
      }
      if (!data) return { error: `No existe la sección ${id_seccion}` };
      return data;
    },
  }),

  obtener_asistencia: tool({
    description:
      "Resumen de asistencia de una sección (cualquier nivel: Inicial, Primaria " +
      "o Secundaria) en un rango de fechas: cantidad y porcentaje por tipo de " +
      "asistencia (asistió, faltó, tardanza, etc.). Necesita id_seccion, que se " +
      "obtiene con obtener_estructura_anio. Para 'el año actual' usar del 1 de " +
      "enero del año de hoy hasta hoy.",
    inputSchema: z.object({
      id_seccion: z.number().int(),
      solicitud: solicitudSchema,
      desde: z.string().describe("Fecha inicial YYYY-MM-DD"),
      hasta: z.string().describe("Fecha final YYYY-MM-DD"),
    }),
    execute: async ({ id_seccion, solicitud, desde, hasta }) => {
      if (!puedeVerSeccion(alcance, id_seccion)) return SIN_ACCESO_SECCION;
      const noCoincide = await verificarSeccion(id_seccion, solicitud);
      if (noCoincide) return noCoincide;
      const { data, error } = await supabase.rpc("obtener_asistencia_seccion", {
        p_id_seccion: id_seccion,
        p_desde: desde,
        p_hasta: hasta,
      });
      if (error) {
        log("tool -> obtener_asistencia_seccion falló", error);
        return { error: error.message };
      }
      if (!data) return { error: `No existe la sección ${id_seccion}` };
      return data;
    },
  }),

  // Estructura académica. Mismos filtros que los GET del OpenAPI
  // (/anios-lectivos, /niveles, /grados, /secciones). Jerarquía:
  // año lectivo -> nivel -> grado -> sección.
  listar_anios_lectivos: tool({
    description:
      "Lista los años lectivos (id_anio_lectivo, anio, nombre, estado), del más " +
      "reciente al más antiguo. Es el primer paso para ubicar niveles, grados " +
      "y secciones: sin el año no se sabe a qué estructura corresponden.",
    inputSchema: z.object({ estado: estadoSchema }),
    execute: ({ estado }) =>
      listar(
        "mg_anio_lectivo",
        "id_anio_lectivo, anio, nombre, estado",
        { columna: "anio", ascendente: false },
        { estado },
      ),
  }),

  obtener_estructura_anio: tool({
    description:
      "Devuelve de una sola vez la estructura académica de un año lectivo: " +
      "niveles (Inicial, Primaria, Secundaria), y dentro de cada uno sus grados " +
      "y las secciones de cada grado, con sus ids (id_nivel, id_grado, " +
      "id_seccion). Cada sección incluye su docente_responsable (tutor) y los " +
      "cursos programados con el docente que dicta cada uno. Si no se indica el año, usa el año lectivo activo más " +
      "reciente. Reemplaza a listar niveles, grados y secciones por separado.",
    inputSchema: z.object({
      id_anio_lectivo: z.number().int().optional()
        .describe("Id del año lectivo (de listar_anios_lectivos). Omitir para el activo más reciente"),
      solo_activos: z.boolean().optional()
        .describe("true = solo niveles, grados y secciones activos. Por defecto trae todos"),
    }),
    execute: async ({ id_anio_lectivo, solo_activos }) => {
      let idAnio = id_anio_lectivo;
      if (idAnio === undefined) {
        const { data: anio, error: errAnio } = await supabase
          .from("mg_anio_lectivo")
          .select("id_anio_lectivo")
          .eq("estado", true)
          .order("anio", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (errAnio) return { error: errAnio.message };
        if (!anio) return { error: "No hay un año lectivo activo" };
        idAnio = anio.id_anio_lectivo;
      }
      const { data, error } = await supabase.rpc("obtener_estructura_anio", {
        p_id_anio: idAnio,
        p_solo_activos: solo_activos ?? false,
      });
      if (error) {
        log("tool -> obtener_estructura_anio falló", error);
        return { error: error.message };
      }
      if (!data) return { error: `No existe el año lectivo ${idAnio}` };
      log(`tool -> obtener_estructura_anio(${idAnio}) ok`);
      if (alcance.todas) return data;
      return {
        ...podarEstructura(data, alcance.secciones),
        aviso: "Estructura limitada a las secciones del usuario como docente " +
          "responsable. Las demás secciones del año existen pero no son " +
          "accesibles: no las sustituyas por estas.",
      };
    },
  }),

  listar_cursos: tool({
    description: "Lista los cursos de un año lectivo.",
    inputSchema: z.object({
      id_anio_lectivo: z.number().int().optional(),
      estado: estadoSchema,
    }),
    execute: (input) => api("cursos", input),
  }),

  listar_matriculas: tool({
    description:
      "Lista los alumnos matriculados. Se puede filtrar por año, nivel, grado " +
      "y sección, y buscar por nombre, apellidos o DNI con 'q'.",
    inputSchema: z.object({
      id_anio_lectivo: z.number().int().optional(),
      id_nivel: z.number().int().optional(),
      id_grado: z.number().int().optional(),
      id_seccion: z.number().int(),
      solicitud: solicitudSchema,
      q: z.string().optional().describe("Nombre, apellidos o DNI del alumno"),
      estado: estadoSchema,
    }),
    execute: async ({ solicitud, ...input }) => {
      if (!puedeVerSeccion(alcance, input.id_seccion)) return SIN_ACCESO_SECCION;
      const noCoincide = await verificarSeccion(input.id_seccion, solicitud);
      return noCoincide ?? api("matriculas", input);
    },
  }),

  obtener_docente_responsable: tool({
    description: "Docente que dicta un curso en una sección.",
    inputSchema: z.object({
      id_seccion: z.number().int(),
      id_curso: z.number().int(),
    }),
    execute: (input) =>
      puedeVerSeccion(alcance, input.id_seccion)
        ? api("docente-responsable", input)
        : SIN_ACCESO_SECCION,
  }),

  mostrar_grafico: tool({
    description:
      "Muestra un gráfico en el chat. Usar SOLO con datos obtenidos de otras " +
      "herramientas, nunca con datos inventados.",
    inputSchema: z.object({
      tipo: z.enum(["barras", "lineas", "torta"]),
      titulo: z.string(),
      etiquetas: z.array(z.string()).describe("Eje X o categorías"),
      series: z.array(z.object({ nombre: z.string(), valores: z.array(z.number()) })),
    }),
    // El front renderiza el gráfico con estos mismos datos
    execute: (input) => input,
  }),
  };
}

// GET /chat            -> conversaciones del usuario (más recientes primero)
// GET /chat?id=<uuid>  -> mensajes de esa conversación (en orden)
async function handleGet(req: Request, usuarioId: string) {
  const id = new URL(req.url).searchParams.get("id");
  try {
    if (!id) {
      const { data, error } = await supabase
        .from("conversaciones")
        .select("id, titulo, actualizado_en")
        .eq("usuario_id", usuarioId)
        .eq("archivada", false)
        .order("actualizado_en", { ascending: false })
        .limit(30);
      if (error) throw error;
      return json(data ?? []);
    }
    if (!UUID_RE.test(id)) return json({ error: "'id' debe ser un uuid" }, 400);

    // Solo se leen mensajes de conversaciones propias. Se responde 404 (no 403)
    // para no revelar que el id existe y es de otro usuario.
    const { data: propia, error: errPropia } = await supabase
      .from("conversaciones")
      .select("id")
      .eq("id", id)
      .eq("usuario_id", usuarioId)
      .maybeSingle();
    if (errPropia) throw errPropia;
    if (!propia) return json({ error: "Conversación no encontrada" }, 404);

    const { data, error } = await supabase
      .from("mensajes")
      .select("id, rol, partes")
      .eq("conversacion_id", id)
      .order("secuencia", { ascending: true })
      .limit(200);
    if (error) throw error;
    const mensajes: UIMessage[] = (data ?? []).map((f) => ({
      id: f.id,
      role: f.rol,
      parts: f.partes,
    }));
    return json(mensajes);
  } catch (e) {
    console.error(e);
    return json({ error: "Error interno", detalle: JSON.stringify(e) }, 500);
  }
}

// ---------------------------------------------------------------------
// Handler principal
// ---------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET" && req.method !== "POST") {
    return json({ error: "Método no permitido" }, 405);
  }

  const ctx = await requireAuth(req, supabase);
  if (ctx instanceof Response) return ctx;
  const usuarioId = ctx.authId;
  const authorization = req.headers.get("Authorization")!;

  if (req.method === "GET") return await handleGet(req, usuarioId);

  // ADMIN ve todas las secciones; el resto solo aquellas donde es docente
  // responsable (mg_programacion_seccion.id_docente_responsable).
  const alcance = await alcanceSecciones(supabase, ctx);
  log(
    alcance.todas
      ? "alcance: todas las secciones"
      : `alcance: secciones ${JSON.stringify(alcance.secciones)}`,
  );

  const inicio = performance.now();
  const ms = () => `${Math.round(performance.now() - inicio)}ms`;

  try {
    // 1. Cuerpo: { id: uuid de la conversación, message: UIMessage }
    const cuerpo = await req.json().catch((e) => {
      log("body no es JSON válido", descr(e));
      return null;
    });
    const { id: conversacionId, message } = (cuerpo ?? {}) as {
      id?: string;
      message?: UIMessage;
    };
    log("POST recibido", {
      id: conversacionId,
      mensaje_id: message?.id,
      rol: message?.role,
      texto: message ? textoDe(message).slice(0, 200) : null,
      modelo: MODELO,
      openai_key: Deno.env.get("OPENAI_API_KEY") ? "ok" : "FALTA",
    });
    if (!conversacionId || !message) {
      log("400: faltan id o message");
      return json({ error: "Faltan id o message" }, 400);
    }

    // 2. Crear la conversación si no existe
    const { error: convError } = await supabase
      .from("conversaciones")
      .upsert(
        {
          id: conversacionId,
          usuario_id: usuarioId,
          titulo: textoDe(message).slice(0, 80) || "Nueva conversación",
          modelo: MODELO,
        },
        { onConflict: "id", ignoreDuplicates: true },
      );
    if (convError) {
      log("falló upsert de conversaciones", convError);
      throw convError;
    }

    // El upsert ignora duplicados: si el id ya existía puede ser de OTRO
    // usuario. Se exige que la conversación sea del usuario autenticado.
    const { data: propia, error: errPropia } = await supabase
      .from("conversaciones")
      .select("id")
      .eq("id", conversacionId)
      .eq("usuario_id", usuarioId)
      .maybeSingle();
    if (errPropia) throw errPropia;
    if (!propia) {
      log("404: la conversación no es del usuario");
      return json({ error: "Conversación no encontrada" }, 404);
    }
    log(`conversación lista (${ms()})`);

    // 3. Guardar el mensaje del usuario. Antes se descarta que el id de
    // mensaje ya pertenezca a otra conversación: el upsert lo sobrescribiría.
    const { data: existente, error: errExistente } = await supabase
      .from("mensajes")
      .select("conversacion_id")
      .eq("id", message.id)
      .maybeSingle();
    if (errExistente) throw errExistente;
    if (existente && existente.conversacion_id !== conversacionId) {
      log("400: message.id pertenece a otra conversación");
      return json({ error: "message.id inválido" }, 400);
    }
    const { error: msgError } = await supabase.from("mensajes").upsert({
      id: message.id,
      conversacion_id: conversacionId,
      rol: "user",
      partes: message.parts,
    });
    if (msgError) {
      log("falló upsert de mensajes", msgError);
      throw msgError;
    }
    log(`mensaje del usuario guardado (${ms()})`);

    // 4. Cargar el contexto (últimos N mensajes, incluido el recién guardado)
    const { data: filas, error: histError } = await supabase
      .from("mensajes")
      .select("id, rol, partes")
      .eq("conversacion_id", conversacionId)
      .order("secuencia", { ascending: false })
      .limit(MAX_MENSAJES_CONTEXTO);
    if (histError) {
      log("falló la carga del historial", histError);
      throw histError;
    }

    const historial: UIMessage[] = (filas ?? [])
      .reverse()
      .map((f) => ({ id: f.id, role: f.rol, parts: f.partes }));

    log(`historial cargado: ${historial.length} mensajes (${ms()})`);

    // 5. Llamar al modelo
    const hoy = new Date().toISOString().slice(0, 10);
    const result = streamText({
      model: openai(MODELO),
      system:
        `Eres el asistente académico del colegio. Fecha: ${hoy}. ` +
        "Respondes en español, de forma breve y clara. Para cualquier dato de notas " +
        "o asistencia usa SIEMPRE las herramientas; nunca inventes cifras. Las notas " +
        "son calificaciones por valor (por ejemplo AD, A, B, C), no números: " +
        "nunca calcules promedios numéricos ni uses escala vigesimal. Si el usuario pide comparar o ver una " +
        "evolución, después de obtener los datos llama a mostrar_grafico. Si falta " +
        "el grado, la sección o el periodo, pregúntalo. " +
        "Estructura académica: año lectivo -> nivel -> grado -> sección. Para " +
        "listar niveles, grados o secciones, o para resolver ids a partir de " +
        "nombres (por ejemplo '1ero de secundaria'), llama a " +
        "obtener_estructura_anio (una sola llamada trae todo el árbol) y busca " +
        "por nombre en el resultado. Si el usuario nombra un año concreto, " +
        "obtén su id con listar_anios_lectivos. Nunca pidas ids al usuario. Si " +
        "no indica el año, usa el año lectivo activo más reciente. Presenta " +
        "los listados de forma clara y breve. " +
        "Coincidencia exacta: el grado y la sección pedidos deben existir " +
        "con ese nombre en el resultado de obtener_estructura_anio. Si no existen " +
        "(porque no hay tal sección o porque el usuario no tiene acceso a ella), " +
        "dilo y no sustituyas por otra sección aunque sea la única disponible. " +
        "Al responder, nombra el grado, nivel y sección tal como los devuelve la " +
        "herramienta, nunca los que dijo el usuario." +
        ` Usuario autenticado: ${ctx.usuario.usuario}, roles: ` +
        `${ctx.roles.join(", ") || "ninguno"}. Ya conoces su identidad y rol: ` +
        "nunca se los pidas; si pregunta quién es, qué secciones tiene a cargo o " +
        "en qué puedes ayudarle, usa mi_perfil. Puedes ayudar a consultar: " +
        "promedios de notas y asistencia por sección, alumnos matriculados, " +
        "estructura académica (niveles, grados, secciones), docentes responsables " +
        "y cursos, y mostrar gráficos. Solo consultas; no modificas datos." +
        (alcance.todas
          ? " El usuario es administrador: puede consultar todas las secciones."
          : " El usuario solo puede consultar las secciones en las que es " +
            "docente responsable. Si una herramienta responde que no tiene " +
            "acceso, explícaselo y no intentes otra vía."),
      messages: convertToModelMessages(historial),
      tools: crearTools(authorization, alcance, ctx),
      stopWhen: stepCountIs(8),
      onStepFinish: (step) => {
        log(`paso terminado (${ms()})`, {
          finishReason: step.finishReason,
          tools: step.toolCalls.map((tc) => ({
            nombre: tc.toolName,
            input: tc.input,
          })),
          resultados: step.toolResults.map((tr) => ({
            nombre: tr.toolName,
            salida: JSON.stringify(tr.output).slice(0, 300),
          })),
          texto: step.text.slice(0, 200),
        });
      },
      onError: ({ error }) => log("error del modelo/stream", descr(error)),
    });

    // 6. Devolver en streaming y guardar al terminar
    return result.toUIMessageStreamResponse({
      headers: corsHeaders,
      originalMessages: historial,
      generateMessageId: () => crypto.randomUUID(),
      onError: (e) => {
        log("error enviado al cliente", descr(e));
        // PoC: se devuelve el detalle para depurar desde el front.
        return `Error al procesar la consulta: ${descr(e)}`;
      },
      onFinish: async ({ responseMessage }) => {
        try {
          const { error: errRespuesta } = await supabase
            .from("mensajes")
            .insert({
              id: responseMessage.id,
              conversacion_id: conversacionId,
              rol: "assistant",
              partes: responseMessage.parts,
            });
          if (errRespuesta) log("falló guardar la respuesta", errRespuesta);
          else log(`respuesta guardada (${ms()})`);

          const steps = await result.steps;
          const usage = await result.totalUsage;
          const herramientas = [
            ...new Set(steps.flatMap((s) => s.toolCalls.map((tc) => tc.toolName))),
          ];

          const { error: errMetricas } = await supabase
            .from("metricas_consulta")
            .insert({
            conversacion_id: conversacionId,
            mensaje_id: responseMessage.id,
            usuario_id: usuarioId,
            tipo_indicador: clasificarIndicador(herramientas),
            herramientas,
            tokens_entrada: usage.inputTokens ?? null,
            tokens_salida: usage.outputTokens ?? null,
            latencia_ms: Math.round(performance.now() - inicio),
          });
          if (errMetricas) log("falló guardar métricas", errMetricas);
          else log(`métricas guardadas, tools=[${herramientas}] (${ms()})`);
        } catch (e) {
          log("excepción guardando respuesta/métricas", descr(e));
        }
      },
    });
  } catch (e) {
    log(`500 (${ms()})`, descr(e));
    return json({ error: "Error interno", detalle: descr(e) }, 500);
  }
});