CREATE OR REPLACE FUNCTION public.obtener_resumen_bimestre(p_id_anio_lectivo bigint, p_id_nivel bigint)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
  WITH bim AS (
    SELECT id_bimestre, numero, nombre
    FROM public.mg_bimestre
    WHERE id_anio_lectivo = p_id_anio_lectivo
  ),
  grados AS (
    SELECT g.id_grado, g.nombre AS grado
    FROM public.mg_nivel n
    JOIN public.mg_grado g ON g.id_nivel = n.id_nivel AND g.estado
    WHERE n.id_nivel = p_id_nivel AND n.id_anio_lectivo = p_id_anio_lectivo
  ),
  alumnos AS (
    SELECT s.id_grado, count(DISTINCT m.id_estudiante) AS total
    FROM public.mg_matricula m
    JOIN public.mg_seccion s ON s.id_seccion = m.id_seccion
    WHERE m.estado AND s.id_grado IN (SELECT id_grado FROM grados)
    GROUP BY s.id_grado
  ),
  valores AS (
    SELECT id_valor, codigo, orden
    FROM public.mg_valor_evaluacion
    WHERE estado
  ),
  -- cursos programados por grado
  gc AS (
    SELECT DISTINCT s.id_grado, pc.id_curso
    FROM public.mg_programacion_curso pc
    JOIN public.mg_programacion_seccion ps
      ON ps.id_programacion_seccion = pc.id_programacion_seccion
    JOIN public.mg_seccion s ON s.id_seccion = ps.id_seccion
    WHERE pc.estado AND s.id_grado IN (SELECT id_grado FROM grados)
  ),
  -- todas las competencias de esos cursos
  comp_base AS (
    SELECT gc.id_grado, cu.id_curso, cu.nombre AS curso,
           co.id_competencia, co.codigo AS cod_comp, co.descripcion AS desc_comp
    FROM gc
    JOIN public.mg_curso cu ON cu.id_curso = gc.id_curso
    JOIN public.mg_competencia co ON co.id_curso = cu.id_curso AND co.estado
  ),
  -- conteo por bimestre / grado / competencia / valor
  cnt AS (
    SELECT e.id_bimestre, s.id_grado, e.id_competencia, e.id_valor,
           count(*) AS cantidad
    FROM public.mg_evaluacion_competencia e
    JOIN public.mg_matricula_curso mc
      ON mc.id_matricula_curso = e.id_matricula_curso AND mc.estado
    JOIN public.mg_matricula m
      ON m.id_matricula = mc.id_matricula AND m.estado
    JOIN public.mg_seccion s ON s.id_seccion = m.id_seccion
    WHERE e.estado AND e.id_valor IS NOT NULL
      AND e.id_bimestre IN (SELECT id_bimestre FROM bim)
      AND s.id_grado IN (SELECT id_grado FROM grados)
    GROUP BY e.id_bimestre, s.id_grado, e.id_competencia, e.id_valor
  ),
  comp_json AS (
    SELECT b.id_bimestre, cb.id_grado, cb.id_curso, cb.curso,
           cb.id_competencia, cb.cod_comp, cb.desc_comp,
           jsonb_agg(
             jsonb_build_object(
               'valor', v.codigo,
               'cantidad', COALESCE(c.cantidad, 0)
             ) ORDER BY v.orden
           ) AS valores
    FROM comp_base cb
    CROSS JOIN bim b
    CROSS JOIN valores v
    LEFT JOIN cnt c
      ON c.id_bimestre = b.id_bimestre AND c.id_grado = cb.id_grado
     AND c.id_competencia = cb.id_competencia AND c.id_valor = v.id_valor
    GROUP BY b.id_bimestre, cb.id_grado, cb.id_curso, cb.curso,
             cb.id_competencia, cb.cod_comp, cb.desc_comp
  ),
  curso_json AS (
    SELECT id_bimestre, id_grado, id_curso, curso,
           jsonb_agg(
             jsonb_build_object(
               'id_competencia', id_competencia,
               'codigo', cod_comp,
               'descripcion', desc_comp,
               'valores', valores
             ) ORDER BY id_competencia
           ) AS competencias
    FROM comp_json
    GROUP BY id_bimestre, id_grado, id_curso, curso
  )
  SELECT jsonb_build_object(
    'bimestres', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id_bimestre', b.id_bimestre,
          'numero', b.numero,
          'nombre', b.nombre,
          'grados', COALESCE((
            SELECT jsonb_agg(
              jsonb_build_object(
                'id_grado', g.id_grado,
                'grado', g.grado,
                'alumnos', COALESCE(a.total, 0),
                'cursos', COALESCE((
                  SELECT jsonb_agg(
                    jsonb_build_object(
                      'id_curso', cj.id_curso,
                      'curso', cj.curso,
                      'competencias', cj.competencias
                    ) ORDER BY cj.curso
                  )
                  FROM curso_json cj
                  WHERE cj.id_bimestre = b.id_bimestre
                    AND cj.id_grado = g.id_grado
                ), '[]'::jsonb)
              ) ORDER BY g.id_grado
            )
            FROM grados g LEFT JOIN alumnos a ON a.id_grado = g.id_grado
          ), '[]'::jsonb)
        ) ORDER BY b.numero
      )
      FROM bim b
    ), '[]'::jsonb)
  );
$function$
