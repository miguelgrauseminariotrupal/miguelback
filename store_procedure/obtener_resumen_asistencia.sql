CREATE OR REPLACE FUNCTION public.obtener_resumen_asistencia(p_id_anio_lectivo bigint, p_id_nivel bigint)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
  WITH bim AS (
    SELECT id_bimestre, numero, nombre, fecha_inicio, fecha_fin
    FROM public.mg_bimestre
    WHERE id_anio_lectivo = p_id_anio_lectivo
  ),
  grados AS (
    SELECT g.id_grado, g.nombre AS grado
    FROM public.mg_nivel n
    JOIN public.mg_grado g ON g.id_nivel = n.id_nivel AND g.estado
    WHERE n.id_nivel = p_id_nivel AND n.id_anio_lectivo = p_id_anio_lectivo
  ),
  tipos AS (
    SELECT id_tipo_asistencia, codigo, descripcion
    FROM public.mg_tipo_asistencia
    WHERE estado
  ),
  cnt AS (
    SELECT b.id_bimestre, s.id_grado, a.id_tipo_asistencia, count(*) AS cantidad
    FROM public.mg_asistencia a
    JOIN public.mg_matricula m ON m.id_matricula = a.id_matricula
    JOIN public.mg_seccion s ON s.id_seccion = m.id_seccion
    JOIN bim b ON a.fecha BETWEEN b.fecha_inicio AND b.fecha_fin
    WHERE s.id_grado IN (SELECT id_grado FROM grados)
    GROUP BY b.id_bimestre, s.id_grado, a.id_tipo_asistencia
  ),
  -- bimestre x grado x tipo (con ceros)
  bgt AS (
    SELECT b.id_bimestre, g.id_grado, t.id_tipo_asistencia, t.codigo,
           COALESCE(c.cantidad, 0) AS cantidad
    FROM bim b
    CROSS JOIN grados g
    CROSS JOIN tipos t
    LEFT JOIN cnt c
      ON c.id_bimestre = b.id_bimestre AND c.id_grado = g.id_grado
     AND c.id_tipo_asistencia = t.id_tipo_asistencia
  )
  SELECT jsonb_build_object(
    'tipos', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object('codigo', t.codigo, 'descripcion', t.descripcion)
        ORDER BY t.id_tipo_asistencia)
      FROM tipos t
    ), '[]'::jsonb),
    'bimestres', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'numero', b.numero,
          'nombre', b.nombre,
          'fecha_inicio', b.fecha_inicio,
          'fecha_fin', b.fecha_fin,
          'registros', COALESCE((
            SELECT sum(x.cantidad) FROM bgt x WHERE x.id_bimestre = b.id_bimestre
          ), 0),
          'por_tipo', COALESCE((
            SELECT jsonb_agg(
              jsonb_build_object('codigo', t.codigo, 'cantidad', COALESCE((
                SELECT sum(x.cantidad) FROM bgt x
                WHERE x.id_bimestre = b.id_bimestre
                  AND x.id_tipo_asistencia = t.id_tipo_asistencia
              ), 0)) ORDER BY t.id_tipo_asistencia)
            FROM tipos t
          ), '[]'::jsonb),
          'grados', COALESCE((
            SELECT jsonb_agg(
              jsonb_build_object(
                'id_grado', g.id_grado,
                'grado', g.grado,
                'registros', COALESCE((
                  SELECT sum(x.cantidad) FROM bgt x
                  WHERE x.id_bimestre = b.id_bimestre AND x.id_grado = g.id_grado
                ), 0),
                'por_tipo', COALESCE((
                  SELECT jsonb_agg(
                    jsonb_build_object('codigo', x.codigo, 'cantidad', x.cantidad)
                    ORDER BY x.id_tipo_asistencia)
                  FROM bgt x
                  WHERE x.id_bimestre = b.id_bimestre AND x.id_grado = g.id_grado
                ), '[]'::jsonb)
              ) ORDER BY g.id_grado)
            FROM grados g
          ), '[]'::jsonb)
        ) ORDER BY b.numero)
      FROM bim b
    ), '[]'::jsonb)
  );
$function$
