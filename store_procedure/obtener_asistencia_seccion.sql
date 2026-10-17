-- Resumen de asistencia de una sección en un rango de fechas, para cualquier
-- nivel (Inicial, Primaria, Secundaria). Reemplaza a fn_asistencia_por_seccion,
-- que identificaba la sección por (grado 1-5, letra) y solo servía a Secundaria.
--
-- Cuenta los registros de mg_asistencia de los alumnos matriculados en la
-- sección (mg_matricula.id_seccion) con fecha entre p_desde y p_hasta (ambas
-- inclusive), agrupados por tipo de asistencia (mg_tipo_asistencia). Los tipos
-- sin registros salen con cantidad 0. Si la sección no existe devuelve NULL.
--
-- Ejemplo de resultado:
-- {
--   "id_seccion": 1, "seccion": "Única", "grado": "1ro", "nivel": "Primaria",
--   "desde": "2026-01-01", "hasta": "2026-10-11",
--   "alumnos_matriculados": 25, "dias_con_registro": 120, "total_registros": 2950,
--   "por_tipo": [
--     { "codigo": "A", "descripcion": "Asistió", "cantidad": 2800, "porcentaje": 94.92 },
--     { "codigo": "F", "descripcion": "Faltó",   "cantidad": 150,  "porcentaje": 5.08 }
--   ]
-- }
CREATE OR REPLACE FUNCTION public.obtener_asistencia_seccion(
  p_id_seccion bigint,
  p_desde date,
  p_hasta date
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH sec AS (
    SELECT s.id_seccion, s.nombre AS seccion, g.nombre AS grado, n.nombre AS nivel
    FROM public.mg_seccion s
    JOIN public.mg_grado g ON g.id_grado = s.id_grado
    JOIN public.mg_nivel n ON n.id_nivel = g.id_nivel
    WHERE s.id_seccion = p_id_seccion
  ),
  reg AS (
    SELECT a.id_tipo_asistencia, a.fecha
    FROM public.mg_asistencia a
    JOIN public.mg_matricula m ON m.id_matricula = a.id_matricula
    WHERE m.id_seccion = p_id_seccion
      AND a.fecha BETWEEN p_desde AND p_hasta
  ),
  total AS (SELECT count(*) AS n FROM reg),
  tipos AS (
    SELECT ta.id_tipo_asistencia, ta.codigo, ta.descripcion,
           count(r.id_tipo_asistencia) AS cantidad
    FROM public.mg_tipo_asistencia ta
    LEFT JOIN reg r ON r.id_tipo_asistencia = ta.id_tipo_asistencia
    WHERE ta.estado
    GROUP BY ta.id_tipo_asistencia, ta.codigo, ta.descripcion
  )
  SELECT jsonb_build_object(
    'id_seccion', sec.id_seccion,
    'seccion', sec.seccion,
    'grado', sec.grado,
    'nivel', sec.nivel,
    'desde', p_desde,
    'hasta', p_hasta,
    'alumnos_matriculados', (
      SELECT count(*) FROM public.mg_matricula m
      WHERE m.id_seccion = p_id_seccion AND m.estado
    ),
    'dias_con_registro', (SELECT count(DISTINCT fecha) FROM reg),
    'total_registros', (SELECT n FROM total),
    'por_tipo', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'codigo', t.codigo,
          'descripcion', t.descripcion,
          'cantidad', t.cantidad,
          'porcentaje', CASE WHEN (SELECT n FROM total) = 0 THEN 0
            ELSE round(t.cantidad * 100.0 / (SELECT n FROM total), 2) END
        ) ORDER BY t.id_tipo_asistencia
      ) FROM tipos t
    ), '[]'::jsonb)
  )
  FROM sec;
$$;
