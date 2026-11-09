// Exporta a Excel (.xlsx) la sistematización de resultados de evaluación de
// un nivel: una pestaña por bimestre, con cantidades y porcentajes por grado
// y competencia (columnas = valores de evaluación, ej. C/B/A/AD).
//
// GET /exportar-resumen-bimestre?id_anio_lectivo=1&id_nivel=2
//   Cada pestaña incluye un gráfico de pastel (nativo de Excel) por
//   competencia, con las cantidades de la fila TOTAL.
//   Usa el stored procedure obtener_resumen_bimestre. Ambos parámetros son
//   obligatorios. Genera el .xlsx, lo guarda en el bucket privado
//   'exportaciones' de Storage y responde JSON:
//   { "path": "resumen-bimestres/Primaria_2026_<timestamp>.xlsx",
//     "bucket": "exportaciones", "url": "<URL firmada>", "expires_in": 3600 }
//   La URL firmada caduca; 'path' sirve para generar otra con Storage.
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
const CARPETA = "resumen-bimestres";
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
const VERDE_TOTAL = "FFC6E0B4";
const GRIS = "FFD9D9D9";

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
  alumnos: number;
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
  if (opts.bold) cell.font = { bold: true, size: opts.size };
  if (opts.fill) {
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: opts.fill },
    };
  }
  if (opts.numFmt) cell.numFmt = opts.numFmt;
}

interface GraficoPastel {
  titulo: string;
  hoja: string;
  colInicio: number; // 1-based, primera columna de la competencia
  ancho: number; // columnas que ocupa
  filaInicio: number; // 1-based, primera fila del gráfico
  alto: number; // filas que ocupa
  rangoEtiquetas: string; // ej. 'BIMESTRE 1'!$E$5:$H$5
  rangoValores: string;
  etiquetas: string[];
  valores: number[];
}
interface HojaConGraficos {
  idHoja: number;
  graficos: GraficoPastel[];
}

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

function xmlGrafico(g: GraficoPastel): string {
  const n = g.etiquetas.length;
  const puntos = g.etiquetas.map((e, i) =>
    `<c:dPt><c:idx val="${i}"/><c:bubble3D val="0"/><c:spPr><a:solidFill><a:srgbClr val="${
      COLOR_VALOR[e] ?? COLORES_RESPALDO[i % COLORES_RESPALDO.length]
    }"/></a:solidFill></c:spPr></c:dPt>`
  ).join("");
  // Oculta la etiqueta de valor en los puntos con 0 (siguen en la leyenda).
  const etiquetasCero = g.valores.map((v, i) =>
    Number(v) === 0 ? `<c:dLbl><c:idx val="${i}"/><c:delete val="1"/></c:dLbl>` : ""
  ).join("");
  const cacheCat = `<c:strCache><c:ptCount val="${n}"/>${
    g.etiquetas.map((e, i) => `<c:pt idx="${i}"><c:v>${esc(e)}</c:v></c:pt>`)
      .join("")
  }</c:strCache>`;
  const cacheVal = `<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${n}"/>${
    g.valores.map((v, i) => `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`).join("")
  }</c:numCache>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="${NS_C}" xmlns:a="${NS_A}" xmlns:r="${NS_R}"><c:roundedCorners val="0"/><c:chart><c:autoTitleDeleted val="1"/><c:plotArea><c:layout/><c:pieChart><c:varyColors val="1"/><c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:v>Cantidad</c:v></c:tx>${puntos}<c:dLbls>${etiquetasCero}<c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/><c:showLeaderLines val="1"/></c:dLbls><c:cat><c:strRef><c:f>${
    esc(g.rangoEtiquetas)
  }</c:f>${cacheCat}</c:strRef></c:cat><c:val><c:numRef><c:f>${
    esc(g.rangoValores)
  }</c:f>${cacheVal}</c:numRef></c:val></c:ser><c:firstSliceAng val="0"/></c:pieChart></c:plotArea><c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`;
}

function xmlDibujo(graficos: GraficoPastel[]): string {
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

// Orden de los valores en la plantilla (de menor a mayor logro). Si los
// códigos de la base son otros, se respeta el orden de la base.
const ORDEN_PLANTILLA = ["C", "B", "A", "AD"];

function construirHoja(
  wb: ExcelJS.Workbook,
  bim: Bimestre,
  ambito: string,
  anio: number,
): HojaConGraficos {
  const ws = wb.addWorksheet(`BIMESTRE ${bim.numero}`);

  // Estructura de columnas: áreas (cursos) -> competencias, unión de todos los
  // grados (un grado sin esa competencia deja las celdas vacías).
  const cursos = new Map<number, {
    nombre: string;
    comps: Map<number, string>;
  }>();
  let codigos: string[] = [];
  for (const g of bim.grados) {
    for (const cu of g.cursos) {
      if (!cursos.has(cu.id_curso)) {
        cursos.set(cu.id_curso, { nombre: cu.curso, comps: new Map() });
      }
      for (const co of cu.competencias) {
        cursos.get(cu.id_curso)!.comps.set(co.id_competencia, co.descripcion);
        if (codigos.length === 0) codigos = co.valores.map((v) => v.valor);
      }
    }
  }
  // posición (en la lista de la base) de cada columna de la plantilla
  let orden = codigos.map((_, i) => i);
  if (
    codigos.length === ORDEN_PLANTILLA.length &&
    ORDEN_PLANTILLA.every((c) => codigos.includes(c))
  ) {
    orden = ORDEN_PLANTILLA.map((c) => codigos.indexOf(c));
  }
  const nv = Math.max(codigos.length, 1);

  // A = etiqueta general, B = CANTIDADES/PORCENTAJES, C = grado,
  // D = total de estudiantes, datos desde E.
  const COL_GRADO = 3, COL_TOTAL = 4, PRIMERA = 5;
  ws.getColumn(1).width = 24;
  ws.getColumn(2).width = 16;
  ws.getColumn(3).width = 8;
  ws.getColumn(4).width = 16;

  // índice de columna inicial por competencia
  const colComp = new Map<number, number>();
  let col = PRIMERA;
  for (const cu of cursos.values()) {
    for (const idComp of cu.comps.keys()) {
      colComp.set(idComp, col);
      col += nv;
    }
  }
  const ultima = Math.max(col - 1, PRIMERA);
  for (let c = PRIMERA; c <= ultima; c++) ws.getColumn(c).width = 6;

  // Título
  ws.mergeCells(1, 1, 1, Math.max(ultima, 8));
  const titulo = ws.getCell(1, 1);
  titulo.value =
    `SISTEMATIZACIÓN DE RESULTADOS DE EVALUACIÓN DE LOS APRENDIZAJES DEL ${bim.nombre.toUpperCase()} - ${ambito} ${anio}`;
  titulo.font = { bold: true, size: 14 };
  titulo.alignment = { horizontal: "center", vertical: "middle" };
  titulo.border = BORDE;
  ws.getRow(1).height = 28;

  // Cabeceras: fila 3 = áreas, 4 = competencias, 5 = valores
  const F_AREA = 3, F_COMP = 4, F_VAL = 5;
  for (let c = 1; c <= COL_TOTAL; c++) estilizar(ws.getCell(F_AREA, c), {});
  estilizar(ws.getCell(F_AREA, COL_TOTAL), { bold: true, size: 13 });
  ws.getCell(F_AREA, COL_TOTAL).value = "ÁREAS";
  for (let c = 1; c <= 2; c++) {
    ws.mergeCells(F_COMP, c, F_VAL, c);
    estilizar(ws.getCell(F_COMP, c), {});
  }
  ws.mergeCells(F_COMP, COL_GRADO, F_VAL, COL_GRADO);
  estilizar(ws.getCell(F_COMP, COL_GRADO), { bold: true });
  ws.getCell(F_COMP, COL_GRADO).value = "GRADOS";
  ws.mergeCells(F_COMP, COL_TOTAL, F_VAL, COL_TOTAL);
  estilizar(ws.getCell(F_COMP, COL_TOTAL), { bold: true });
  ws.getCell(F_COMP, COL_TOTAL).value = "TOTAL DE ESTUDIANTES EVALUADOS";

  let i = 0;
  for (const cu of cursos.values()) {
    const [fuerte, suave] = PALETA[i++ % PALETA.length];
    const c0 = colComp.get(cu.comps.keys().next().value as number)!;
    const c1 = c0 + cu.comps.size * nv - 1;
    ws.mergeCells(F_AREA, c0, F_AREA, c1);
    ws.getCell(F_AREA, c0).value = cu.nombre.toUpperCase();
    for (let c = c0; c <= c1; c++) estilizar(ws.getCell(F_AREA, c), { fill: fuerte });
    ws.getCell(F_AREA, c0).font = { bold: true, size: 13 };

    for (const [idComp, desc] of cu.comps) {
      const k0 = colComp.get(idComp)!;
      ws.mergeCells(F_COMP, k0, F_COMP, k0 + nv - 1);
      ws.getCell(F_COMP, k0).value = desc;
      for (let c = k0; c < k0 + nv; c++) {
        estilizar(ws.getCell(F_COMP, c), { fill: suave });
        estilizar(ws.getCell(F_VAL, c), { bold: true, fill: suave });
        ws.getCell(F_VAL, c).value = codigos[orden[c - k0]];
      }
      ws.getCell(F_COMP, k0).font = { bold: true, size: 9 };
    }
  }
  ws.getRow(F_COMP).height = 70;

  // Bloques de datos
  const nGrados = bim.grados.length;
  // cant[g][idComp] = number[] (en el orden de la plantilla)
  const cant = bim.grados.map((g) => {
    const m = new Map<number, number[]>();
    for (const cu of g.cursos) {
      for (const co of cu.competencias) {
        m.set(co.id_competencia, orden.map((o) => co.valores[o].cantidad));
      }
    }
    return m;
  });

  // Rango de una fila para las columnas de una competencia, ej. $E12:$H12
  const rangoFila = (fila: number, c0: number) =>
    `$${ws.getColumn(c0).letter}${fila}:$${ws.getColumn(c0 + nv - 1).letter}${fila}`;

  const bloque = (inicio: number, etiqueta: string, porcentaje: boolean) => {
    ws.mergeCells(inicio, 2, inicio + nGrados, 2);
    ws.getCell(inicio, 2).value = etiqueta;
    estilizar(ws.getCell(inicio, 2), { bold: true });

    const filaTotal = inicio + nGrados;
    const totales = new Map<number, number[]>();
    let totalAlumnos = 0;
    const relleno = porcentaje ? GRIS : undefined;

    bim.grados.forEach((g, gi) => {
      const f = inicio + gi;
      estilizar(ws.getCell(f, COL_GRADO), { bold: true, fill: GRIS });
      ws.getCell(f, COL_GRADO).value = g.grado;
      estilizar(ws.getCell(f, COL_TOTAL), {
        bold: true,
        fill: GRIS,
        numFmt: porcentaje ? "0.0" : "0",
      });
      // Total de evaluados del grado = suma de los valores de la primera
      // competencia en esa fila (en % da 100). Sin competencias: dato fijo.
      const primeraComp = colComp.keys().next().value as number | undefined;
      if (primeraComp === undefined) {
        ws.getCell(f, COL_TOTAL).value = porcentaje ? 100 : g.alumnos;
        totalAlumnos += g.alumnos;
      } else {
        const valsPrimera = cant[gi].get(primeraComp);
        const evaluados = valsPrimera
          ? valsPrimera.reduce((a, b) => a + b, 0)
          : 0;
        ws.getCell(f, COL_TOTAL).value = {
          formula: `SUM(${rangoFila(f, PRIMERA)})`,
          result: porcentaje ? (evaluados ? 100 : 0) : evaluados,
        };
        totalAlumnos += evaluados;
      }

      for (const [idComp, c0] of colComp) {
        const vals = cant[gi].get(idComp);
        const suma = vals ? vals.reduce((a, b) => a + b, 0) : 0;
        for (let k = 0; k < nv; k++) {
          const cell = ws.getCell(f, c0 + k);
          estilizar(cell, { fill: relleno, numFmt: porcentaje ? "0.0" : "0" });
          if (porcentaje) {
            // % = cantidad / suma de la fila de cantidades de ese grado y
            // competencia. 0 si no hay datos (también si el grado no tiene
            // la competencia, como en la plantilla).
            const fc = inicioCant + gi;
            const rango = rangoFila(fc, c0);
            const celda = `${ws.getColumn(c0 + k).letter}${fc}`;
            cell.value = {
              formula: `IF(SUM(${rango})=0,0,${celda}/SUM(${rango})*100)`,
              result: vals && suma ? (vals[k] / suma) * 100 : 0,
            };
          } else if (vals) {
            cell.value = vals[k];
          }
          if (!porcentaje && vals) {
            const t = totales.get(idComp) ?? new Array(nv).fill(0);
            t[k] += vals[k];
            totales.set(idComp, t);
          }
        }
      }
    });

    if (porcentaje) {
      ws.mergeCells(filaTotal, COL_GRADO, filaTotal, COL_TOTAL);
    } else {
      estilizar(ws.getCell(filaTotal, COL_TOTAL), {
        bold: true,
        fill: VERDE_TOTAL,
        numFmt: "0",
      });
      ws.getCell(filaTotal, COL_TOTAL).value = {
        formula: `SUM(${ws.getColumn(COL_TOTAL).letter}${inicio}:${
          ws.getColumn(COL_TOTAL).letter
        }${filaTotal - 1})`,
        result: totalAlumnos,
      };
    }
    estilizar(ws.getCell(filaTotal, COL_GRADO), {
      bold: true,
      fill: VERDE_TOTAL,
    });
    ws.getCell(filaTotal, COL_GRADO).value = "TOTAL";
    return { filaTotal, totales };
  };

  const inicioCant = F_VAL + 1;
  const { filaTotal: ftCant, totales } = bloque(inicioCant, "CANTIDADES", false);
  for (const [idComp, c0] of colComp) {
    const t = totales.get(idComp);
    for (let k = 0; k < nv; k++) {
      const cell = ws.getCell(ftCant, c0 + k);
      estilizar(cell, { bold: true, fill: VERDE_TOTAL, numFmt: "0" });
      const letra = ws.getColumn(c0 + k).letter;
      cell.value = {
        formula: `SUM(${letra}${inicioCant}:${letra}${ftCant - 1})`,
        result: t ? t[k] : 0,
      };
    }
  }

  // el bloque de porcentajes va pegado al de cantidades, como en la plantilla
  const inicioPct = ftCant + 1;
  const { filaTotal: ftPct } = bloque(inicioPct, "PORCENTAJES", true);
  for (const [idComp, c0] of colComp) {
    const t = totales.get(idComp);
    const suma = t ? t.reduce((a, b) => a + b, 0) : 0;
    for (let k = 0; k < nv; k++) {
      const cell = ws.getCell(ftPct, c0 + k);
      estilizar(cell, { bold: true, fill: VERDE_TOTAL, numFmt: "0.0" });
      const rango = rangoFila(ftCant, c0);
      const celda = `${ws.getColumn(c0 + k).letter}${ftCant}`;
      cell.value = {
        formula: `IF(SUM(${rango})=0,0,${celda}/SUM(${rango})*100)`,
        result: t && suma ? (t[k] / suma) * 100 : 0,
      };
    }
  }

  // etiqueta general que abarca ambos bloques
  ws.mergeCells(inicioCant, 1, ftPct, 1);
  ws.getCell(inicioCant, 1).value =
    "Cantidad de estudiantes ubicados en cada nivel en las evaluaciones de la I.E.";
  estilizar(ws.getCell(inicioCant, 1), { bold: true });

  // Un pastel por competencia con la fila TOTAL de cantidades, debajo del
  // bloque de porcentajes. Se omite si la competencia no tiene notas.
  const graficos: GraficoPastel[] = [];
  const nombreHoja = `'${ws.name}'`;
  const etiquetas = orden.map((o) => codigos[o]);
  for (const cu of cursos.values()) {
    for (const [idComp, desc] of cu.comps) {
      const t = totales.get(idComp);
      if (!t || t.reduce((a, b) => a + b, 0) === 0) continue;
      const c0 = colComp.get(idComp)!;
      const letraIni = ws.getColumn(c0).letter;
      const letraFin = ws.getColumn(c0 + nv - 1).letter;
      graficos.push({
        titulo: desc,
        hoja: ws.name,
        colInicio: c0,
        ancho: nv,
        filaInicio: ftPct + 2,
        alto: 12,
        rangoEtiquetas: `${nombreHoja}!$${letraIni}$${F_VAL}:$${letraFin}$${F_VAL}`,
        rangoValores: `${nombreHoja}!$${letraIni}$${ftCant}:$${letraFin}$${ftCant}`,
        etiquetas,
        valores: t,
      });
    }
  }

  ws.views = [{ state: "frozen", xSplit: COL_TOTAL, ySplit: F_VAL }];
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
    if (idsGrado) {
      for (const b of bimestres) {
        b.grados = b.grados.filter((g) => idsGrado.includes(g.id_grado));
      }
      if (bimestres.every((b) => b.grados.length === 0)) {
        return errorResponse("No hay grados para esos filtros", 404);
      }
    }

    const wb = new ExcelJS.Workbook();
    // Título dinámico: nivel completo, o los grados del filtro (ej. profesor).
    const nivelTxt = String(nivel.nombre).replace(/^nivel\s+/i, "").toUpperCase();
    const gradosTxt = [
      ...new Set(bimestres.flatMap((b) => b.grados.map((g) => g.grado))),
    ].join(", ").toUpperCase();
    const ambito = idsGrado && gradosTxt
      ? `${gradosTxt} DE ${nivelTxt}`
      : `NIVEL ${nivelTxt}`;
    const hojas = bimestres.map((b) =>
      construirHoja(wb, b, ambito, anio)
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
