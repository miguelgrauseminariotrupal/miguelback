-- Resumen de notas de una sección en un bimestre, para cualquier nivel.
-- Reemplaza a fn_promedio_por_seccion (que no existe en la base y asumía
-- notas numéricas de Secundaria).
--
-- Las notas del esquema son valores cualitativos (mg_valor_evaluacion: codigo
-- + orden), no números, así que en vez de un promedio se devuelve la
-- distribución: por curso y competencia, cuántos alumnos obtuvieron cada valor.
--
-- Fuente: mg_evaluacion_competencia del bimestre pedido (p_bimestre = número
-- del bimestre, 1..4, dentro del año lectivo de la sección), solo alumnos con
-- matrícula y matrícula-curso activas y con valor asignado.
-- Si la sección no existe devuelve NULL. Si el bimestre no existe, "bimestre"
-- viene null y "cursos" vacío.
--
-- Ejemplo de resultado:
-- {
--   "id_seccion": 1, "seccion": "Única", "grado": "1ro", "nivel": "Primaria",
--   "bimestre": { "id_bimestre": 1, "numero": 1, "nombre": "I Bimestre" },
--   "cursos": [
--     { "id_curso": 2, "curso": "Matemática",
--       "competencias": [
--         { "id_competencia": 5, "codigo": "C1", "descripcion": "Resuelve problemas...",
--           "alumnos_evaluados": 25,
--           "distribucion": [
--             { "valor": "AD", "cantidad": 5,  "porcentaje": 20.00 },
--             { "valor": "A",  "cantidad": 15, "porcentaje": 60.00 },
--             { "valor": "B",  "cantidad": 5,  "porcentaje": 20.00 } ] } ] } ]
-- }
CREATE OR REPLACE FUNCTION public.obtener_notas_seccion(
  p_id_seccion bigint,
  p_bimestre integer
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH sec AS (
    SELECT s.id_seccion, s.nombre AS seccion, g.nombre AS grado,
           n.nombre AS nivel, n.id_anio_lectivo
    FROM public.mg_seccion s
    JOIN public.mg_grado g ON g.id_grado = s.id_grado
    JOIN public.mg_nivel n ON n.id_nivel = g.id_nivel
    WHERE s.id_seccion = p_id_seccion
  ),
  bim AS (
    SELECT b.id_bimestre, b.numero, b.nombre
    FROM sec
    JOIN public.mg_bimestre b
      ON b.id_anio_lectivo = sec.id_anio_lectivo AND b.numero = p_bimestre
  ),
  ev AS (
    SELECT co.id_curso, c.nombre AS curso, co.id_competencia,
           co.codigo AS cod_comp, co.descripcion AS desc_comp,
           v.codigo AS valor, v.orden
    FROM bim
    JOIN public.mg_evaluacion_competencia e
      ON e.id_bimestre = bim.id_bimestre AND e.estado AND e.id_valor IS NOT NULL
    JOIN public.mg_matricula_curso mc
      ON mc.id_matricula_curso = e.id_matricula_curso AND mc.estado
    JOIN public.mg_matricula m
      ON m.id_matricula = mc.id_matricula
     AND m.id_seccion = p_id_seccion AND m.estado
    JOIN public.mg_competencia co ON co.id_competencia = e.id_competencia
    JOIN public.mg_curso c ON c.id_curso = co.id_curso
    JOIN public.mg_valor_evaluacion v ON v.id_valor = e.id_valor
  ),
  dist AS (
    SELECT id_curso, curso, id_competencia, cod_comp, desc_comp, valor, orden,
           count(*) AS cant,
           sum(count(*)) OVER (PARTITION BY id_competencia) AS tot
    FROM ev
    GROUP BY id_curso, curso, id_competencia, cod_comp, desc_comp, valor, orden
  ),
  comp AS (
    SELECT id_curso, curso, id_competencia, cod_comp, desc_comp,
           max(tot) AS evaluados,
           jsonb_agg(
             jsonb_build_object(
               'valor', valor,
               'cantidad', cant,
               'porcentaje', round(cant * 100.0 / tot, 2)
             ) ORDER BY orden
           ) AS distribucion
    FROM dist
    GROUP BY id_curso, curso, id_competencia, cod_comp, desc_comp
  )
  SELECT jsonb_build_object(
    'id_seccion', sec.id_seccion,
    'seccion', sec.seccion,
    'grado', sec.grado,
    'nivel', sec.nivel,
    'bimestre', (SELECT to_jsonb(bim) FROM bim),
    'cursos', COALESCE((
      SELECT jsonb_agg(x.curso_json ORDER BY x.curso)
      FROM (
        SELECT curso,
               jsonb_build_object(
                 'id_curso', id_curso,
                 'curso', curso,
                 'competencias', jsonb_agg(
                   jsonb_build_object(
                     'id_competencia', id_competencia,
                     'codigo', cod_comp,
                     'descripcion', desc_comp,
                     'alumnos_evaluados', evaluados,
                     'distribucion', distribucion
                   ) ORDER BY id_competencia
                 )
               ) AS curso_json
        FROM comp
        GROUP BY id_curso, curso
      ) x
    ), '[]'::jsonb)
  )
  FROM sec;
$$;
