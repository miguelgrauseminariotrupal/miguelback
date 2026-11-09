// Exporta a Excel (.xlsx) el reporte EVOLUTIVO de un nivel: cómo evolucionan
// los resultados (C/B/A/AD, en %) a lo largo de los bimestres. Una pestaña por
// grado ("INDICADORES DE 1ro DE PRIMARIA"); dentro, un bloque por área (curso)
// con una tabla de porcentajes (una fila por bimestre) y, debajo, un gráfico
// de líneas nativo de Excel por competencia (una línea por valor).
//
// GET /exportar-evolucion-bimestre?id_anio_lectivo=1&id_nivel=2
//   Usa el stored procedure obtener_resumen_bimestre. Ambos parámetros son
//   obligatorios. Los bimestres sin notas quedan vacíos (la línea se corta).
//   Guarda el .xlsx en el bucket privado 'exportaciones' y responde JSON:
//   { "path": "evolucion-bimestres/Primaria_2026_<timestamp>.xlsx",
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
const CARPETA = "evolucion-bimestres";
const EXPIRA_POR_DEFECTO = 3600;
const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// Colores de cabecera por área (curso): [cabecera, subcabecera].
const PALETA = [
  ["FFC9F5EE", "FFE3FBF7"],
  ["FFEBC4E8", "FFF6E1F4"],
  ["FFFFE699", "FFFFF2CC"],
  ["FFBDD7EE", "FFDDEBF7"],
  ["FFF8CBAD", "FFFCE4D6"],
  ["FFC6E0B4", "FFE2EFDA"],
];
const BORDE: Partial<ExcelJS.Borders> = {
  top: { style: "thin" },
  left: { style: "thin" },
  bottom: { style: "thin" },
  right: { style: "thin" },
};

interface Valor {
  valor: string;
  cantidad: number;
}
interface Competencia {
  id_competencia: number;
  descripcion: string;
  valores: Valor[];
}
interface Curso {
  id_curso: number;
  curso: string;
  competencias: Competencia[];
}
interface Grado {
  id_grado: number;
  grado: string;
  cursos: Curso[];
}
interface Bimestre {
  numero: number;
  nombre: string;
  grados: Grado[];
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
const COLOR_VALOR: Record<string, string> = {
  C: "E15759",
  B: "F28E2B",
  A: "4E79A7",
  AD: "59A14F",
};
const COLORES_RESPALDO = ["4E79A7", "F28E2B", "59A14F", "E15759", "B07AA1"];

function esc(t: string): string {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface SerieLinea {
  nombre: string;
  rangoNombre: string; // ej. 'HOJA'!$C$7
  rangoValores: string; // ej. 'HOJA'!$C$8:$C$11
  valores: (number | null)[]; // null = sin dato
}
interface GraficoLinea {
  titulo: string;
  colInicio: number; // 1-based
  ancho: number;
  filaInicio: number; // 1-based
  alto: number;
  rangoCategorias: string; // ej. 'HOJA'!$A$8:$A$11
  categorias: string[];
  series: SerieLinea[];
}
interface HojaConGraficos {
  idHoja: number;
  graficos: GraficoLinea[];
}

function xmlGrafico(g: GraficoLinea): string {
  const n = g.categorias.length;
  const cacheCat = `<c:strCache><c:ptCount val="${n}"/>${
    g.categorias.map((c, i) => `<c:pt idx="${i}"><c:v>${esc(c)}</c:v></c:pt>`)
      .join("")
  }</c:strCache>`;

  const series = g.series.map((s, i) => {
    const color = COLOR_VALOR[s.nombre] ??
      COLORES_RESPALDO[i % COLORES_RESPALDO.length];
    const relleno = `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>`;
    // Oculta la etiqueta de los puntos en 0 (como en el reporte de pastel).
    const sinEtiqueta = s.valores.map((v, k) =>
      v === 0 ? `<c:dLbl><c:idx val="${k}"/><c:delete val="1"/></c:dLbl>` : ""
    ).join("");
    const cacheVal = `<c:numCache><c:formatCode>0.0</c:formatCode><c:ptCount val="${n}"/>${
      s.valores.map((v, k) =>
        v === null ? "" : `<c:pt idx="${k}"><c:v>${v}</c:v></c:pt>`
      ).join("")
    }</c:numCache>`;
    return `<c:ser><c:idx val="${i}"/><c:order val="${i}"/><c:tx><c:strRef><c:f>${
      esc(s.rangoNombre)
    }</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${
      esc(s.nombre)
    }</c:v></c:pt></c:strCache></c:strRef></c:tx><c:spPr><a:ln w="28575" cap="rnd">${relleno}<a:round/></a:ln></c:spPr><c:marker><c:symbol val="circle"/><c:size val="6"/><c:spPr>${relleno}<a:ln w="9525">${relleno}</a:ln></c:spPr></c:marker><c:dLbls>${sinEtiqueta}<c:numFmt formatCode="0.0" sourceLinked="0"/><c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr><c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="800"/></a:pPr><a:endParaRPr lang="es-PE"/></a:p></c:txPr><c:dLblPos val="t"/><c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbls><c:cat><c:strRef><c:f>${
      esc(g.rangoCategorias)
    }</c:f>${cacheCat}</c:strRef></c:cat><c:val><c:numRef><c:f>${
      esc(s.rangoValores)
    }</c:f>${cacheVal}</c:numRef></c:val><c:smooth val="0"/></c:ser>`;
  }).join("");

  const titulo =
    `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="900" b="1"/></a:pPr><a:r><a:rPr lang="es-PE" sz="900" b="1"/><a:t>${
      esc(g.titulo)
    }</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>`;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="${NS_C}" xmlns:a="${NS_A}" xmlns:r="${NS_R}"><c:roundedCorners val="0"/><c:chart>${titulo}<c:autoTitleDeleted val="0"/><c:plotArea><c:layout/><c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${series}<c:marker val="1"/><c:axId val="111111111"/><c:axId val="222222222"/></c:lineChart><c:catAx><c:axId val="111111111"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:numFmt formatCode="General" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="222222222"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx><c:valAx><c:axId val="222222222"/><c:scaling><c:orientation val="minMax"/><c:max val="100"/><c:min val="0"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines><c:spPr><a:ln w="6350"><a:solidFill><a:srgbClr val="D9D9D9"/></a:solidFill></a:ln></c:spPr></c:majorGridlines><c:numFmt formatCode="0" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="111111111"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx></c:plotArea><c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`;
}

function xmlDibujo(graficos: GraficoLinea[]): string {
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

// Orden de los valores en la plantilla (de menor a mayor logro). Si los
// códigos de la base son otros, se respeta el orden de la base.
const ORDEN_PLANTILLA = ["C", "B", "A", "AD"];
const ALTO_GRAFICO = 16; // filas
const ANCHO_COL_DATO = 11;

function nombreHoja(grado: string, usados: Set<string>): string {
  const base = grado.replace(/[\\/?*[\]:]/g, " ").trim().slice(0, 28) || "Grado";
  let nombre = base;
  for (let i = 2; usados.has(nombre.toLowerCase()); i++) {
    nombre = `${base} (${i})`;
  }
  usados.add(nombre.toLowerCase());
  return nombre;
}

function construirHoja(
  wb: ExcelJS.Workbook,
  bimestres: Bimestre[],
  idGrado: number,
  nivel: string,
  anio: number,
  usados: Set<string>,
): HojaConGraficos {
  // estructura del grado (la misma en todos los bimestres)
  const estructura = bimestres[0].grados.find((g) => g.id_grado === idGrado)!;
  const ws = wb.addWorksheet(nombreHoja(estructura.grado, usados), {
    views: [{ showGridLines: false }],
  });
  const refHoja = `'${ws.name.replace(/'/g, "''")}'`;

  // (bimestre, competencia) -> cantidades
  const cantidades = (b: Bimestre, idComp: number): Valor[] | undefined => {
    const g = b.grados.find((x) => x.id_grado === idGrado);
    for (const cu of g?.cursos ?? []) {
      const co = cu.competencias.find((c) => c.id_competencia === idComp);
      if (co) return co.valores;
    }
    return undefined;
  };

  let codigos: string[] = [];
  for (const cu of estructura.cursos) {
    for (const co of cu.competencias) {
      if (codigos.length === 0) codigos = co.valores.map((v) => v.valor);
    }
  }
  let orden = codigos.map((_, i) => i);
  if (
    codigos.length === ORDEN_PLANTILLA.length &&
    ORDEN_PLANTILLA.every((c) => codigos.includes(c))
  ) {
    orden = ORDEN_PLANTILLA.map((c) => codigos.indexOf(c));
  }
  const nv = Math.max(codigos.length, 1);
  const nb = bimestres.length;

  // A = etiqueta de bimestre; datos desde B.
  const PRIMERA = 2;
  ws.getColumn(1).width = 12;
  const maxComp = Math.max(1, ...estructura.cursos.map((c) => c.competencias.length));
  const ultima = PRIMERA + maxComp * nv - 1;
  for (let c = PRIMERA; c <= ultima; c++) ws.getColumn(c).width = ANCHO_COL_DATO;

  ws.mergeCells(1, 2, 1, Math.max(ultima, PRIMERA + 3));
  const titulo = ws.getCell(1, 2);
  titulo.value = `INDICADORES DE ${estructura.grado.toUpperCase()} DE ${nivel.replace(/^nivel\s+/i, "").toUpperCase()} ${anio}`;
  titulo.font = { bold: true, size: 16 };
  titulo.alignment = { horizontal: "left", vertical: "middle" };
  ws.getRow(1).height = 32;

  const graficos: GraficoLinea[] = [];
  const categorias = bimestres.map((b) => `${b.numero} BIM`);
  let fila = 3;
  let i = 0;

  for (const cu of estructura.cursos) {
    if (cu.competencias.length === 0) continue;
    const [fuerte, suave] = PALETA[i++ % PALETA.length];
    const F_AREA = fila, F_COMP = fila + 1, F_VAL = fila + 2;
    const F_DATOS = fila + 3; // primera fila de bimestre
    const c1 = PRIMERA + cu.competencias.length * nv - 1;

    ws.mergeCells(F_AREA, PRIMERA, F_AREA, c1);
    ws.getCell(F_AREA, PRIMERA).value = cu.curso.toUpperCase();
    for (let c = PRIMERA; c <= c1; c++) estilizar(ws.getCell(F_AREA, c), { fill: fuerte });
    ws.getCell(F_AREA, PRIMERA).font = { bold: true, size: 13 };
    ws.getRow(F_COMP).height = 45;

    cu.competencias.forEach((co, k) => {
      const k0 = PRIMERA + k * nv;
      ws.mergeCells(F_COMP, k0, F_COMP, k0 + nv - 1);
      ws.getCell(F_COMP, k0).value = co.descripcion;
      for (let c = k0; c < k0 + nv; c++) {
        estilizar(ws.getCell(F_COMP, c), { fill: suave });
        estilizar(ws.getCell(F_VAL, c), { bold: true, fill: suave });
        ws.getCell(F_VAL, c).value = codigos[orden[c - k0]];
      }
      ws.getCell(F_COMP, k0).font = { bold: true, size: 9 };

      // % por bimestre; vacío si ese bimestre no tiene notas para la competencia
      const porValor: (number | null)[][] = Array.from({ length: nv }, () =>
        new Array<number | null>(nb).fill(null)
      );
      bimestres.forEach((b, bi) => {
        const vals = cantidades(b, co.id_competencia);
        const suma = vals ? vals.reduce((a, v) => a + v.cantidad, 0) : 0;
        if (!vals || suma === 0) return;
        for (let v = 0; v < nv; v++) {
          porValor[v][bi] = Math.round(((vals[orden[v]]?.cantidad ?? 0) / suma) * 1000) /
            10;
        }
      });
      for (let bi = 0; bi < nb; bi++) {
        for (let v = 0; v < nv; v++) {
          const cell = ws.getCell(F_DATOS + bi, k0 + v);
          estilizar(cell, { numFmt: "0.0" });
          const dato = porValor[v][bi];
          if (dato !== null) cell.value = dato;
        }
      }

      // gráfico solo si la competencia tiene alguna nota
      if (porValor.some((s) => s.some((x) => x !== null))) {
        const letraCat = ws.getColumn(1).letter;
        graficos.push({
          titulo: co.descripcion,
          colInicio: k0,
          ancho: nv,
          filaInicio: F_DATOS + nb + 1,
          alto: ALTO_GRAFICO,
          rangoCategorias:
            `${refHoja}!$${letraCat}$${F_DATOS}:$${letraCat}$${F_DATOS + nb - 1}`,
          categorias,
          series: porValor.map((valores, v) => {
            const l = ws.getColumn(k0 + v).letter;
            return {
              nombre: codigos[orden[v]],
              rangoNombre: `${refHoja}!$${l}$${F_VAL}`,
              rangoValores: `${refHoja}!$${l}$${F_DATOS}:$${l}$${F_DATOS + nb - 1}`,
              valores,
            };
          }),
        });
      }
    });

    categorias.forEach((cat, bi) => {
      const cell = ws.getCell(F_DATOS + bi, 1);
      cell.value = cat;
      cell.font = { bold: true };
      cell.alignment = { horizontal: "left", vertical: "middle" };
    });

    // siguiente área: tabla + espacio del gráfico + separación
    fila = F_DATOS + nb + 1 + ALTO_GRAFICO + 1;
  }

  // Alturas explícitas en TODAS las filas: sin ellas, algunos visores (Numbers,
  // Vista previa) autoajustan filas con fuente grande o texto envuelto y los
  // gráficos (anclados por fila) quedan desfasados sobre las tablas.
  for (let r = 2; r <= fila; r++) {
    const row = ws.getRow(r);
    if (!row.height) row.height = 18;
  }

  return { idHoja: ws.id, graficos };
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

    const { data, error } = await supabase.rpc("obtener_resumen_bimestre", {
      p_id_anio_lectivo: idAnio,
      p_id_nivel: idNivel,
    });
    if (error) return errorResponse(error.message, 500);

    const bimestres = (data?.bimestres ?? []) as Bimestre[];
    if (bimestres.length === 0) {
      return errorResponse("El año lectivo no tiene bimestres", 404);
    }
    const grados = idsGrado
      ? bimestres[0].grados.filter((g) => idsGrado.includes(g.id_grado))
      : bimestres[0].grados;
    if (grados.length === 0) {
      return errorResponse("El nivel no tiene grados", 404);
    }

    const wb = new ExcelJS.Workbook();
    const usados = new Set<string>();
    const hojas = grados.map((g) =>
      construirHoja(wb, bimestres, g.id_grado, nivel.nombre, anio, usados)
    );

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
