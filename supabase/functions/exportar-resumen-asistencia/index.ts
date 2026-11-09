// Exporta a Excel (.xlsx) el reporte estadístico de ASISTENCIA de un nivel:
// cantidad y porcentaje de cada tipo de asistencia (asistió, tardanza,
// justificado, falta... según el catálogo mg_tipo_asistencia) por bimestre.
//
// GET /exportar-resumen-asistencia?id_anio_lectivo=1&id_nivel=2
//   Pestañas: "RESUMEN" (el nivel, una fila por bimestre + total del año) y
//   una pestaña por bimestre ("BIMESTRE 1"...) con una fila por grado. Cada
//   pestaña lleva un gráfico de columnas nativo de Excel con los porcentajes.
//   Un registro cuenta en el bimestre cuyo rango fecha_inicio..fecha_fin
//   contiene su fecha (los bimestres sin fechas salen en 0).
//   Usa el stored procedure obtener_resumen_asistencia. Ambos parámetros son
//   obligatorios. Guarda el .xlsx en el bucket privado 'exportaciones' y
//   responde JSON:
//   { "path": "resumen-asistencia/Primaria_2026_<timestamp>.xlsx",
//     "bucket": "exportaciones", "url": "<URL firmada>", "expires_in": 3600 }
//   (Opcional) &expira=<segundos> cambia la duración de la URL (60..86400).

import ExcelJS from "npm:exceljs@4.4.0";
import JSZip from "npm:jszip@3.10.1";
import { getServiceClient } from "../_shared/client.ts";
import { corsHeaders } from "../_shared/cors.ts";
import {
  errorResponse,
  jsonResponse,
  mensajeDeError,
  parseId,
} from "../_shared/http.ts";

const BUCKET = "exportaciones";
const CARPETA = "resumen-asistencia";
const EXPIRA_POR_DEFECTO = 3600;
const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const AZUL = "FFBDD7EE";
const AZUL_SUAVE = "FFDDEBF7";
const GRIS = "FFD9D9D9";
const VERDE_TOTAL = "FFC6E0B4";
const BORDE: Partial<ExcelJS.Borders> = {
  top: { style: "thin" },
  left: { style: "thin" },
  bottom: { style: "thin" },
  right: { style: "thin" },
};

interface Tipo {
  codigo: string;
  descripcion: string;
}
interface PorTipo {
  codigo: string;
  cantidad: number;
}
interface GradoAsist {
  id_grado: number;
  grado: string;
  registros: number;
  por_tipo: PorTipo[];
}
interface BimestreAsist {
  numero: number;
  nombre: string;
  fecha_inicio: string | null;
  fecha_fin: string | null;
  registros: number;
  por_tipo: PorTipo[];
  grados: GradoAsist[];
}

function estilizar(
  cell: ExcelJS.Cell,
  opts: { bold?: boolean; fill?: string; size?: number; numFmt?: string } = {},
) {
  cell.border = BORDE;
  cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  if (opts.bold || opts.size) cell.font = { bold: opts.bold, size: opts.size };
  if (opts.fill) {
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: opts.fill },
    };
  }
  if (opts.numFmt) cell.numFmt = opts.numFmt;
}

// ---------------------------------------------------------------- gráficos

const NS_C = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_R =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_XDR =
  "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing";
// Colores por código de tipo de asistencia (A asistió, J justificado,
// F falta, T tarde); el resto usa colores de respaldo.
const COLOR_TIPO: Record<string, string> = {
  A: "59A14F",
  J: "4E79A7",
  F: "E15759",
  T: "F28E2B",
};
const COLORES_RESPALDO = ["4E79A7", "F28E2B", "59A14F", "E15759", "B07AA1"];

function esc(t: string): string {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface SerieBarra {
  codigo: string;
  nombre: string;
  rangoNombre: string;
  rangoValores: string;
  valores: number[];
}
interface GraficoBarras {
  titulo: string;
  colInicio: number; // 1-based
  ancho: number;
  filaInicio: number; // 1-based
  alto: number;
  rangoCategorias: string;
  categorias: string[];
  series: SerieBarra[];
}
interface HojaConGraficos {
  idHoja: number;
  graficos: GraficoBarras[];
}

function xmlGrafico(g: GraficoBarras): string {
  const n = g.categorias.length;
  const cacheCat = `<c:strCache><c:ptCount val="${n}"/>${
    g.categorias.map((c, i) => `<c:pt idx="${i}"><c:v>${esc(c)}</c:v></c:pt>`)
      .join("")
  }</c:strCache>`;

  const series = g.series.map((s, i) => {
    const color = COLOR_TIPO[s.codigo] ??
      COLORES_RESPALDO[i % COLORES_RESPALDO.length];
    // Sin etiqueta en los valores 0 (la serie sigue en la leyenda).
    const sinEtiqueta = s.valores.map((v, k) =>
      v === 0 ? `<c:dLbl><c:idx val="${k}"/><c:delete val="1"/></c:dLbl>` : ""
    ).join("");
    const cacheVal = `<c:numCache><c:formatCode>0.0</c:formatCode><c:ptCount val="${n}"/>${
      s.valores.map((v, k) => `<c:pt idx="${k}"><c:v>${v}</c:v></c:pt>`).join("")
    }</c:numCache>`;
    return `<c:ser><c:idx val="${i}"/><c:order val="${i}"/><c:tx><c:strRef><c:f>${
      esc(s.rangoNombre)
    }</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${
      esc(s.nombre)
    }</c:v></c:pt></c:strCache></c:strRef></c:tx><c:spPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></c:spPr><c:invertIfNegative val="0"/><c:dLbls>${sinEtiqueta}<c:numFmt formatCode="0.0" sourceLinked="0"/><c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr><c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="800"/></a:pPr><a:endParaRPr lang="es-PE"/></a:p></c:txPr><c:dLblPos val="outEnd"/><c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbls><c:cat><c:strRef><c:f>${
      esc(g.rangoCategorias)
    }</c:f>${cacheCat}</c:strRef></c:cat><c:val><c:numRef><c:f>${
      esc(s.rangoValores)
    }</c:f>${cacheVal}</c:numRef></c:val></c:ser>`;
  }).join("");

  const titulo =
    `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1000" b="1"/></a:pPr><a:r><a:rPr lang="es-PE" sz="1000" b="1"/><a:t>${
      esc(g.titulo)
    }</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>`;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="${NS_C}" xmlns:a="${NS_A}" xmlns:r="${NS_R}"><c:roundedCorners val="0"/><c:chart>${titulo}<c:autoTitleDeleted val="0"/><c:plotArea><c:layout/><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>${series}<c:gapWidth val="80"/><c:axId val="333333333"/><c:axId val="444444444"/></c:barChart><c:catAx><c:axId val="333333333"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:numFmt formatCode="General" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="444444444"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx><c:valAx><c:axId val="444444444"/><c:scaling><c:orientation val="minMax"/><c:max val="100"/><c:min val="0"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines><c:spPr><a:ln w="6350"><a:solidFill><a:srgbClr val="D9D9D9"/></a:solidFill></a:ln></c:spPr></c:majorGridlines><c:numFmt formatCode="0&quot;%&quot;" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="333333333"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx></c:plotArea><c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`;
}

function xmlDibujo(graficos: GraficoBarras[]): string {
  const anclas = graficos.map((g, i) =>
    `<xdr:twoCellAnchor><xdr:from><xdr:col>${g.colInicio - 1}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${
      g.filaInicio - 1
    }</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>${
      g.colInicio - 1 + g.ancho
    }</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${
      g.filaInicio - 1 + g.alto
    }</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${
      i + 2
    }" name="Grafico ${
      i + 1
    }"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="${NS_C}"><c:chart xmlns:c="${NS_C}" r:id="rId${
      i + 1
    }"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`
  ).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="${NS_XDR}" xmlns:a="${NS_A}" xmlns:r="${NS_R}">${anclas}</xdr:wsDr>`;
}

/**
 * ExcelJS no soporta gráficos: se inyectan en el .xlsx ya generado
 * (drawing + charts + relaciones + content types).
 */
async function agregarGraficos(
  buffer: ArrayBuffer | Uint8Array,
  hojas: HojaConGraficos[],
): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(buffer);
  let contentTypes = await zip.file("[Content_Types].xml")!.async("string");
  let nChart = 0;
  let nDibujo = 0;
  const overrides: string[] = [];

  for (const h of hojas) {
    if (h.graficos.length === 0) continue;
    nDibujo++;
    const relsDibujo: string[] = [];
    h.graficos.forEach((g, i) => {
      nChart++;
      zip.file(`xl/charts/chart${nChart}.xml`, xmlGrafico(g));
      overrides.push(
        `<Override PartName="/xl/charts/chart${nChart}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`,
      );
      relsDibujo.push(
        `<Relationship Id="rId${
          i + 1
        }" Type="${NS_R}/chart" Target="../charts/chart${nChart}.xml"/>`,
      );
    });
    zip.file(`xl/drawings/drawing${nDibujo}.xml`, xmlDibujo(h.graficos));
    zip.file(
      `xl/drawings/_rels/drawing${nDibujo}.xml.rels`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
        relsDibujo.join("")
      }</Relationships>`,
    );
    overrides.push(
      `<Override PartName="/xl/drawings/drawing${nDibujo}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`,
    );

    // relación hoja -> dibujo
    const relsPath = `xl/worksheets/_rels/sheet${h.idHoja}.xml.rels`;
    const relDibujo = `<Relationship Id="rIdDibujo1" Type="${NS_R}/drawing" Target="../drawings/drawing${nDibujo}.xml"/>`;
    const relsExistente = zip.file(relsPath);
    if (relsExistente) {
      const xml = await relsExistente.async("string");
      zip.file(relsPath, xml.replace("</Relationships>", relDibujo + "</Relationships>"));
    } else {
      zip.file(
        relsPath,
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relDibujo}</Relationships>`,
      );
    }

    // <drawing> dentro de la hoja, antes de legacyDrawing/tableParts/extLst
    const hojaPath = `xl/worksheets/sheet${h.idHoja}.xml`;
    let xml = await zip.file(hojaPath)!.async("string");
    const tag = `<drawing xmlns:r="${NS_R}" r:id="rIdDibujo1"/>`;
    const despues = /<(legacyDrawing|legacyDrawingHF|picture|oleObjects|controls|webPublishItems|tableParts|extLst)[\s>\/]/
      .exec(xml);
    xml = despues
      ? xml.slice(0, despues.index) + tag + xml.slice(despues.index)
      : xml.replace("</worksheet>", tag + "</worksheet>");
    zip.file(hojaPath, xml);
  }

  contentTypes = contentTypes.replace("</Types>", overrides.join("") + "</Types>");
  zip.file("[Content_Types].xml", contentTypes);
  return await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

// ------------------------------------------------------------------- hojas

interface Fila {
  etiqueta: string;
  cantidades: number[]; // en el orden de 'tipos'
}

const pct = (cant: number, total: number) =>
  total ? Math.round((cant / total) * 10000) / 100 : 0;

/**
 * Tabla: A = etiqueta, B = total de registros, luego un bloque de CANTIDADES
 * (una columna por tipo) y otro de PORCENTAJES. Gráfico de columnas con los
 * porcentajes de las filas (sin la fila TOTAL) debajo de la tabla.
 */
function construirHoja(
  wb: ExcelJS.Workbook,
  nombreHoja: string,
  titulo: string,
  etiquetaCol: string,
  filas: Fila[],
  total: Fila,
  tipos: Tipo[],
): HojaConGraficos {
  const ws = wb.addWorksheet(nombreHoja, { views: [{ showGridLines: false }] });
  const nt = tipos.length;
  const C_TOTAL = 2, C_CANT = 3, C_PCT = C_CANT + nt;
  const ultima = C_PCT + nt - 1;

  ws.getColumn(1).width = 22;
  ws.getColumn(C_TOTAL).width = 14;
  for (let c = C_CANT; c <= ultima; c++) ws.getColumn(c).width = 13;

  ws.mergeCells(1, 1, 1, Math.max(ultima, 6));
  const t = ws.getCell(1, 1);
  t.value = titulo;
  t.font = { bold: true, size: 14 };
  t.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  ws.getRow(1).height = 30;

  // Cabeceras: fila 3 = bloques, fila 4 = tipos
  const F_BLOQUE = 3, F_TIPO = 4, F_DATOS = 5;
  ws.mergeCells(F_BLOQUE, 1, F_TIPO, 1);
  estilizar(ws.getCell(F_BLOQUE, 1), { bold: true, fill: AZUL });
  ws.getCell(F_BLOQUE, 1).value = etiquetaCol;
  ws.mergeCells(F_BLOQUE, C_TOTAL, F_TIPO, C_TOTAL);
  estilizar(ws.getCell(F_BLOQUE, C_TOTAL), { bold: true, fill: AZUL });
  ws.getCell(F_BLOQUE, C_TOTAL).value = "TOTAL DE REGISTROS";
  for (const [c0, nombre] of [[C_CANT, "CANTIDADES"], [C_PCT, "PORCENTAJES (%)"]] as const) {
    ws.mergeCells(F_BLOQUE, c0, F_BLOQUE, c0 + nt - 1);
    ws.getCell(F_BLOQUE, c0).value = nombre;
    for (let c = c0; c < c0 + nt; c++) {
      estilizar(ws.getCell(F_BLOQUE, c), { bold: true, fill: AZUL });
      estilizar(ws.getCell(F_TIPO, c), { bold: true, fill: AZUL_SUAVE });
      ws.getCell(F_TIPO, c).value = tipos[c - c0].descripcion;
    }
  }
  ws.getRow(F_TIPO).height = 30;

  const todas = [...filas, total];
  todas.forEach((f, i) => {
    const r = F_DATOS + i;
    const esTotal = i === filas.length;
    const fill = esTotal ? VERDE_TOTAL : undefined;
    const suma = f.cantidades.reduce((a, b) => a + b, 0);

    estilizar(ws.getCell(r, 1), { bold: true, fill: esTotal ? VERDE_TOTAL : GRIS });
    ws.getCell(r, 1).value = f.etiqueta;

    const cT = ws.getCell(r, C_TOTAL);
    estilizar(cT, { bold: true, fill, numFmt: "0" });
    cT.value = {
      formula: `SUM(${ws.getColumn(C_CANT).letter}${r}:${ws.getColumn(C_CANT + nt - 1).letter}${r})`,
      result: suma,
    };

    f.cantidades.forEach((cant, k) => {
      const cc = ws.getCell(r, C_CANT + k);
      estilizar(cc, { bold: esTotal, fill, numFmt: "0" });
      cc.value = cant;
      const cp = ws.getCell(r, C_PCT + k);
      estilizar(cp, { bold: esTotal, fill, numFmt: "0.0" });
      cp.value = {
        formula: `IF($${ws.getColumn(C_TOTAL).letter}${r}=0,0,${
          ws.getColumn(C_CANT + k).letter
        }${r}/$${ws.getColumn(C_TOTAL).letter}${r}*100)`,
        result: pct(cant, suma),
      };
    });
  });

  const graficos: GraficoBarras[] = [];
  const hayDatos = filas.some((f) => f.cantidades.some((c) => c > 0));
  if (filas.length > 0 && hayDatos) {
    const ref = `'${ws.name.replace(/'/g, "''")}'`;
    const ultFila = F_DATOS + filas.length - 1;
    graficos.push({
      titulo: `${titulo} - % por tipo de asistencia`,
      colInicio: 1,
      ancho: Math.max(ultima, 8),
      filaInicio: F_DATOS + filas.length + 3,
      alto: 20,
      rangoCategorias: `${ref}!$A$${F_DATOS}:$A$${ultFila}`,
      categorias: filas.map((f) => f.etiqueta),
      series: tipos.map((tp, k) => {
        const l = ws.getColumn(C_PCT + k).letter;
        return {
          codigo: tp.codigo,
          nombre: tp.descripcion,
          rangoNombre: `${ref}!$${l}$${F_TIPO}`,
          rangoValores: `${ref}!$${l}$${F_DATOS}:$${l}$${ultFila}`,
          valores: filas.map((f) =>
            pct(f.cantidades[k], f.cantidades.reduce((a, b) => a + b, 0))
          ),
        };
      }),
    });
  }
  return { idHoja: ws.id, graficos };
}

const cantidadesEn = (porTipo: PorTipo[], tipos: Tipo[]): number[] =>
  tipos.map((tp) => Number(porTipo.find((p) => p.codigo === tp.codigo)?.cantidad ?? 0));

function fechaCorta(f: string | null): string {
  if (!f) return "";
  const [y, m, d] = f.split("-");
  return `${d}/${m}/${y}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "GET") {
    return errorResponse("Ruta o método no soportado", 404);
  }

  const url = new URL(req.url);
  const idAnio = parseId(url.searchParams.get("id_anio_lectivo") ?? undefined);
  const idNivel = parseId(url.searchParams.get("id_nivel") ?? undefined);
  if (idAnio === null || idNivel === null) {
    return errorResponse(
      "'id_anio_lectivo' e 'id_nivel' son requeridos (enteros)",
      400,
    );
  }

  const expiraRaw = url.searchParams.get("expira");
  const expira = expiraRaw === null ? EXPIRA_POR_DEFECTO : Number(expiraRaw);
  if (!Number.isInteger(expira) || expira < 60 || expira > 86400) {
    return errorResponse("'expira' debe ser un entero entre 60 y 86400", 400);
  }

  // Opcional: limita el reporte a ciertos grados (ej. los del profesor).
  const idsGradoRaw = url.searchParams.get("ids_grado");
  const idsGrado = idsGradoRaw
    ? idsGradoRaw.split(",").map(Number).filter((n) => Number.isInteger(n))
    : null;

  try {
    const supabase = getServiceClient();

    const { data: nivel, error: errNivel } = await supabase
      .from("mg_nivel")
      .select("nombre, mg_anio_lectivo!inner(anio)")
      .eq("id_nivel", idNivel)
      .eq("id_anio_lectivo", idAnio)
      .maybeSingle();
    if (errNivel) return errorResponse(errNivel.message, 500);
    if (!nivel) {
      return errorResponse("Nivel no encontrado en ese año lectivo", 404);
    }
    // deno-lint-ignore no-explicit-any
    const anio = (nivel.mg_anio_lectivo as any).anio as number;

    const { data, error } = await supabase.rpc("obtener_resumen_asistencia", {
      p_id_anio_lectivo: idAnio,
      p_id_nivel: idNivel,
    });
    if (error) return errorResponse(error.message, 500);

    const tipos = (data?.tipos ?? []) as Tipo[];
    const bimestres = (data?.bimestres ?? []) as BimestreAsist[];
    if (idsGrado) {
      for (const b of bimestres) {
        b.grados = b.grados.filter((g) => idsGrado.includes(g.id_grado));
        // El total del bimestre pasa a ser la suma de los grados filtrados.
        b.por_tipo = (data?.tipos ?? []).map((t: Tipo) => ({
          codigo: t.codigo,
          cantidad: b.grados.reduce(
            (a, g) =>
              a + (g.por_tipo.find((x) => x.codigo === t.codigo)?.cantidad ?? 0),
            0,
          ),
        }));
        b.registros = b.grados.reduce((a, g) => a + g.registros, 0);
      }
      if (bimestres.every((b) => b.grados.length === 0)) {
        return errorResponse("No hay grados para esos filtros", 404);
      }
    }
    if (bimestres.length === 0) {
      return errorResponse("El año lectivo no tiene bimestres", 404);
    }
    if (tipos.length === 0) {
      return errorResponse("No hay tipos de asistencia activos", 404);
    }

    const nombreNivel = String(nivel.nombre).toUpperCase();
    // Título dinámico: nivel completo, o los grados del filtro (ej. profesor).
    const gradosTxt = [
      ...new Set(bimestres.flatMap((b) => b.grados.map((g) => g.grado))),
    ].join(", ").toUpperCase();
    const ambito = idsGrado && gradosTxt
      ? `${gradosTxt} DE ${nombreNivel.replace(/^NIVEL\s+/, "")}`
      : nombreNivel;
    const wb = new ExcelJS.Workbook();
    const hojas: HojaConGraficos[] = [];

    // Resumen del nivel: una fila por bimestre + total del año
    const filasResumen: Fila[] = bimestres.map((b) => ({
      etiqueta: b.nombre,
      cantidades: cantidadesEn(b.por_tipo, tipos),
    }));
    const totalAnio: Fila = {
      etiqueta: "TOTAL AÑO",
      cantidades: tipos.map((_, k) =>
        filasResumen.reduce((a, f) => a + f.cantidades[k], 0)
      ),
    };
    hojas.push(construirHoja(
      wb,
      "RESUMEN",
      `ASISTENCIA POR BIMESTRE - ${ambito} ${anio}`,
      "BIMESTRE",
      filasResumen,
      totalAnio,
      tipos,
    ));

    // Una pestaña por bimestre, con una fila por grado
    for (const b of bimestres) {
      const rango = b.fecha_inicio && b.fecha_fin
        ? ` (${fechaCorta(b.fecha_inicio)} - ${fechaCorta(b.fecha_fin)})`
        : " (sin fechas definidas)";
      hojas.push(construirHoja(
        wb,
        `BIMESTRE ${b.numero}`,
        `ASISTENCIA ${b.nombre.toUpperCase()}${rango} - ${ambito} ${anio}`,
        "GRADO",
        b.grados.map((g) => ({
          etiqueta: g.grado,
          cantidades: cantidadesEn(g.por_tipo, tipos),
        })),
        { etiqueta: idsGrado ? "TOTAL" : "TOTAL NIVEL", cantidades: cantidadesEn(b.por_tipo, tipos) },
        tipos,
      ));
    }

    const buffer = await agregarGraficos(await wb.xlsx.writeBuffer(), hojas);
    const marca = new Date().toISOString().replace(/[:.]/g, "-");
    const path = `${CARPETA}/${nivel.nombre}_${anio}_${marca}.xlsx`
      .replace(/[^\w./-]+/g, "_");

    const { error: errUp } = await supabase.storage
      .from(BUCKET)
      .upload(path, buffer, { contentType: XLSX_MIME, upsert: false });
    if (errUp) return errorResponse(errUp.message, 500);

    const { data: firmada, error: errFirma } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(path, expira);
    if (errFirma) return errorResponse(errFirma.message, 500);

    return jsonResponse({
      bucket: BUCKET,
      path,
      url: firmada.signedUrl,
      expires_in: expira,
    }, 201);
  } catch (err) {
    return errorResponse(mensajeDeError(err), 500);
  }
});
