// Exporta a Excel (.xlsx) la lista de alumnos matriculados en una sección.
//
// GET /exportar-lista-seccion/:id_seccion?estado=true
//   (estado=true|false filtra por estado de la matrícula; por defecto solo
//   matrículas activas. Usar estado=all para incluir todas.)
//   Responde el archivo .xlsx como descarga (Content-Disposition).

import ExcelJS from "npm:exceljs@4.4.0";
import { getServiceClient } from "../_shared/client.ts";
import { corsHeaders } from "../_shared/cors.ts";
import {
  errorResponse,
  mensajeDeError,
  parseId,
  splitPath,
} from "../_shared/http.ts";

const FUNCTION_NAME = "exportar-lista-seccion";
const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "GET") {
    return errorResponse("Ruta o método no soportado", 404);
  }

  const url = new URL(req.url);
  const [idSegment] = splitPath(url, FUNCTION_NAME);
  const idSeccion = parseId(idSegment);
  if (idSeccion === null) return errorResponse("id_seccion inválido", 400);

  try {
    const supabase = getServiceClient();

    const { data: seccion, error: errSeccion } = await supabase
      .from("mg_seccion")
      .select(
        "nombre, mg_grado!inner(nombre, mg_nivel!inner(nombre, mg_anio_lectivo!inner(anio)))",
      )
      .eq("id_seccion", idSeccion)
      .maybeSingle();
    if (errSeccion) return errorResponse(errSeccion.message, 500);
    if (!seccion) return errorResponse("Sección no encontrada", 404);

    let query = supabase
      .from("mg_matricula")
      .select(
        "fecha_matricula, estado, mg_estudiante!inner(nombres, apellido_paterno, apellido_materno, dni, fecha_nacimiento)",
      )
      .eq("id_seccion", idSeccion);

    const estado = url.searchParams.get("estado");
    if (estado === "all") {
      // sin filtro
    } else if (estado === "false") {
      query = query.eq("estado", false);
    } else {
      query = query.eq("estado", true);
    }

    const { data: matriculas, error } = await query;
    if (error) return errorResponse(error.message, 500);

    // deno-lint-ignore no-explicit-any
    const grado = seccion.mg_grado as any;
    const nivel = grado.mg_nivel;
    const anio = nivel.mg_anio_lectivo.anio;

    // Orden alfabético por apellidos y nombres (en JS: más simple que
    // ordenar por una tabla embebida).
    // deno-lint-ignore no-explicit-any
    const alumnos = (matriculas ?? []).map((m: any) => ({
      ...m.mg_estudiante,
      fecha_matricula: m.fecha_matricula,
      estado: m.estado,
    })).sort((a, b) =>
      `${a.apellido_paterno ?? ""} ${a.apellido_materno ?? ""} ${a.nombres}`
        .localeCompare(
          `${b.apellido_paterno ?? ""} ${b.apellido_materno ?? ""} ${b.nombres}`,
          "es",
        )
    );

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Lista de alumnos");

    ws.mergeCells("A1:G1");
    ws.getCell("A1").value =
      `${nivel.nombre} - ${grado.nombre} "${seccion.nombre}" - Año ${anio}`;
    ws.getCell("A1").font = { bold: true, size: 14 };

    ws.columns = [
      { key: "n", width: 6 },
      { key: "apellido_paterno", width: 20 },
      { key: "apellido_materno", width: 20 },
      { key: "nombres", width: 24 },
      { key: "dni", width: 12 },
      { key: "fecha_nacimiento", width: 16 },
      { key: "fecha_matricula", width: 16 },
    ];
    const header = ws.getRow(3);
    header.values = [
      "N°",
      "Apellido paterno",
      "Apellido materno",
      "Nombres",
      "DNI",
      "Fecha de nacimiento",
      "Fecha de matrícula",
    ];
    header.font = { bold: true, color: { argb: "FFFFFFFF" } };
    header.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF1F4E78" },
    };

    alumnos.forEach((a, i) => {
      ws.addRow([
        i + 1,
        a.apellido_paterno,
        a.apellido_materno,
        a.nombres,
        a.dni,
        a.fecha_nacimiento,
        a.fecha_matricula,
      ]);
    });
    ws.views = [{ state: "frozen", ySplit: 3 }];

    const buffer = await wb.xlsx.writeBuffer();
    const nombreArchivo =
      `lista_${grado.nombre}_${seccion.nombre}_${anio}.xlsx`
        .replace(/[^\w.-]+/g, "_");

    return new Response(buffer, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": XLSX_MIME,
        "Content-Disposition": `attachment; filename="${nombreArchivo}"`,
        "Access-Control-Expose-Headers": "Content-Disposition",
      },
    });
  } catch (err) {
    return errorResponse(mensajeDeError(err), 500);
  }
});
