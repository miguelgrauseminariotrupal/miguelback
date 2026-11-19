// Reporte de asistencia de una sección en un rango de fechas (.xlsx).
//
// GET /exportar-reporte-asistencia?id_seccion=1&fecha_inicio=2026-03-01&fecha_fin=2026-03-31
//   Requiere `Authorization: Bearer <access_token>`. Un profesor solo puede
//   pedir las secciones en las que es docente responsable; ADMIN, todas.
//   Responde el archivo .xlsx como descarga (Content-Disposition) con:
//     - Datos generales: año lectivo, nivel, grado, sección, docente
//       responsable, fecha de inicio y fecha de fin.
//     - Tabla FECHA | ALUMNO | ASISTENCIA (una fila por registro de
//       asistencia, ordenado por fecha y luego por alumno).
//   Máximo 366 días por reporte.

import ExcelJS from "npm:exceljs@4.4.0";
import {
  alcanceSecciones,
  puedeVerSeccion,
  requireAuth,
} from "../_shared/auth.ts";
import { getServiceClient } from "../_shared/client.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { errorResponse, mensajeDeError, parseId } from "../_shared/http.ts";

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const MAX_DIAS = 366;
const PAGINA = 1000;
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

const BORDE: Partial<ExcelJS.Borders> = {
  top: { style: "thin" },
  left: { style: "thin" },
  bottom: { style: "thin" },
  right: { style: "thin" },
};

function esFechaValida(v: string | null): v is string {
  if (!v || !FECHA_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

// 2026-03-05 -> 05/03/2026
const fmt = (v: string) => v.split("-").reverse().join("/");

interface Registro {
  fecha: string;
  alumno: string;
  asistencia: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "GET") {
    return errorResponse("Ruta o método no soportado", 404);
  }

  const url = new URL(req.url);
  const idSeccion = parseId(url.searchParams.get("id_seccion") ?? undefined);
  if (idSeccion === null) return errorResponse("id_seccion inválido", 400);
  const inicio = url.searchParams.get("fecha_inicio");
  const fin = url.searchParams.get("fecha_fin");
  if (!esFechaValida(inicio) || !esFechaValida(fin)) {
    return errorResponse(
      "fecha_inicio y fecha_fin son obligatorias (formato AAAA-MM-DD)",
      400,
    );
  }
  if (inicio > fin) {
    return errorResponse(
      "La fecha de inicio no puede ser mayor que la fecha fin",
      400,
    );
  }
  const dias = (Date.parse(`${fin}T00:00:00Z`) -
    Date.parse(`${inicio}T00:00:00Z`)) / 86400000 + 1;
  if (dias > MAX_DIAS) {
    return errorResponse(`El rango máximo es de ${MAX_DIAS} días`, 400);
  }

  try {
    const supabase = getServiceClient();

    const ctx = await requireAuth(req, supabase);
    if (ctx instanceof Response) return ctx;
    const alcance = await alcanceSecciones(supabase, ctx);
    if (!puedeVerSeccion(alcance, idSeccion)) {
      return errorResponse(
        "No tienes acceso a esa sección. Solo puedes consultar las secciones " +
          "en las que eres docente responsable.",
        403,
      );
    }

    const { data: seccion, error: errSeccion } = await supabase
      .from("mg_seccion")
      .select(
        "nombre, mg_grado!inner(nombre, mg_nivel!inner(nombre, mg_anio_lectivo!inner(anio)))",
      )
      .eq("id_seccion", idSeccion)
      .maybeSingle();
    if (errSeccion) return errorResponse(errSeccion.message, 500);
    if (!seccion) return errorResponse("Sección no encontrada", 404);

    // deno-lint-ignore no-explicit-any
    const grado = seccion.mg_grado as any;
    const nivel = grado.mg_nivel;
    const anio = nivel.mg_anio_lectivo.anio;

    // Docente responsable (opcional: puede no estar asignado).
    let docente = "Sin docente asignado";
    const { data: prog } = await supabase
      .from("mg_programacion_seccion")
      .select(
        "mg_docente!inner(nombres, apellido_paterno, apellido_materno)",
      )
      .eq("id_seccion", idSeccion)
      .limit(1)
      .maybeSingle();
    if (prog) {
      // deno-lint-ignore no-explicit-any
      const d = (prog as any).mg_docente;
      docente = [d.nombres, d.apellido_paterno, d.apellido_materno]
        .filter(Boolean).join(" ");
    }

    // Registros de asistencia del rango (paginado: PostgREST limita a 1000).
    const registros: Registro[] = [];
    for (let desde = 0;; desde += PAGINA) {
      const { data, error } = await supabase
        .from("mg_asistencia")
        .select(
          "fecha, mg_tipo_asistencia!inner(codigo, descripcion), " +
            "mg_matricula!inner(id_seccion, mg_estudiante!inner(nombres, apellido_paterno, apellido_materno))",
        )
        .eq("mg_matricula.id_seccion", idSeccion)
        .gte("fecha", inicio)
        .lte("fecha", fin)
        .order("fecha", { ascending: true })
        .order("id_asistencia", { ascending: true })
        .range(desde, desde + PAGINA - 1);
      if (error) return errorResponse(error.message, 500);
      // deno-lint-ignore no-explicit-any
      for (const r of (data ?? []) as any[]) {
        const e = r.mg_matricula.mg_estudiante;
        registros.push({
          fecha: r.fecha,
          alumno: [e.apellido_paterno, e.apellido_materno, e.nombres]
            .filter(Boolean).join(" "),
          asistencia: r.mg_tipo_asistencia.descripcion,
        });
      }
      if (!data || data.length < PAGINA) break;
    }
    registros.sort((a, b) =>
      a.fecha.localeCompare(b.fecha) ||
      a.alumno.localeCompare(b.alumno, "es", { sensitivity: "base" })
    );

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Reporte de asistencia");
    ws.columns = [{ width: 16 }, { width: 46 }, { width: 22 }];

    ws.mergeCells("A1:C1");
    const titulo = ws.getCell("A1");
    titulo.value = "REPORTE DE ASISTENCIA";
    titulo.font = { bold: true, size: 14 };
    titulo.alignment = { horizontal: "center" };

    const generales: Array<[string, string | number]> = [
      ["Año lectivo", anio],
      ["Nivel", nivel.nombre],
      ["Grado", grado.nombre],
      ["Sección", seccion.nombre],
      ["Docente responsable", docente],
      ["Fecha de inicio", fmt(inicio)],
      ["Fecha de fin", fmt(fin)],
    ];
    generales.forEach(([k, v], i) => {
      const fila = 3 + i;
      const c1 = ws.getCell(`A${fila}`);
      c1.value = k;
      c1.font = { bold: true };
      c1.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFD9E2F3" },
      };
      c1.border = BORDE;
      ws.mergeCells(`B${fila}:C${fila}`);
      const c2 = ws.getCell(`B${fila}`);
      c2.value = v;
      c2.alignment = { horizontal: "left" };
      c2.border = BORDE;
      ws.getCell(`C${fila}`).border = BORDE;
    });

    const filaCab = 3 + generales.length + 1;
    ["FECHA", "ALUMNO", "ASISTENCIA"].forEach((t, i) => {
      const c = ws.getCell(filaCab, i + 1);
      c.value = t;
      c.font = { bold: true, color: { argb: "FFFFFFFF" } };
      c.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF174E83" },
      };
      c.alignment = { horizontal: "center", vertical: "middle" };
      c.border = BORDE;
    });

    registros.forEach((r, i) => {
      const fila = filaCab + 1 + i;
      const vals = [fmt(r.fecha), r.alumno, r.asistencia];
      vals.forEach((v, j) => {
        const c = ws.getCell(fila, j + 1);
        c.value = v;
        c.border = BORDE;
        c.alignment = { horizontal: j === 1 ? "left" : "center" };
      });
    });
    if (registros.length === 0) {
      ws.mergeCells(filaCab + 1, 1, filaCab + 1, 3);
      const c = ws.getCell(filaCab + 1, 1);
      c.value = "No hay registros de asistencia en el rango indicado";
      c.alignment = { horizontal: "center" };
      c.font = { italic: true };
    } else {
      ws.autoFilter = {
        from: { row: filaCab, column: 1 },
        to: { row: filaCab, column: 3 },
      };
    }
    ws.views = [{ state: "frozen", ySplit: filaCab }];

    const buffer = await wb.xlsx.writeBuffer();
    const nombre = `Asistencia_${grado.nombre}_${seccion.nombre}_${inicio}_${fin}.xlsx`
      .replace(/[^\w.-]+/g, "_");
    return new Response(buffer, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": XLSX_MIME,
        "Content-Disposition": `attachment; filename="${nombre}"`,
      },
    });
  } catch (err) {
    return errorResponse(mensajeDeError(err), 500);
  }
});
