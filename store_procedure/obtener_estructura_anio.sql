-- Devuelve la estructura académica de un año lectivo como árbol JSON:
-- niveles -> grados -> secciones.
--
-- p_solo_activos = true  -> solo niveles/grados/secciones con estado = true
-- p_solo_activos = false -> todos (default)
--
-- Un nivel sin grados devuelve "grados": [] (y un grado sin secciones,
-- "secciones": []). Si el año no existe devuelve NULL.
--
-- Ejemplo de resultado:
-- {
--   "id_anio_lectivo": 1, "anio": 2026, "nombre": "Año Escolar 2026", "estado": true,
--   "niveles": [
--     { "id_nivel": 1, "nombre": "Primaria", "estado": true,
--       "grados": [
--         { "id_grado": 1, "nombre": "1ro", "estado": true,
--           "secciones": [ { "id_seccion": 1, "nombre": "A", "estado": true,
--             "docente_responsable": { "id_docente": 3, "id_usuario": 7, "nombre_completo": "Ana Pérez Ruiz" },
--             "cursos": [ { "id_curso": 2, "curso": "Matemática", "id_docente": 5, "id_usuario": 9, "docente": "Luis Gómez Soto" } ] } ] }
--       ] }
--   ]
-- }
CREATE OR REPLACE FUNCTION public.obtener_estructura_anio(
  p_id_anio bigint,
  p_solo_activos boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'id_anio_lectivo', al.id_anio_lectivo,
    'anio', al.anio,
    'nombre', al.nombre,
    'estado', al.estado,
    'niveles', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id_nivel', n.id_nivel,
          'nombre', n.nombre,
          'estado', n.estado,
          'grados', COALESCE((
            SELECT jsonb_agg(
              jsonb_build_object(
                'id_grado', g.id_grado,
                'nombre', g.nombre,
                'estado', g.estado,
                'secciones', COALESCE((
                  SELECT jsonb_agg(
                    jsonb_build_object(
                      'id_seccion', s.id_seccion,
                      'nombre', s.nombre,
                      'estado', s.estado,
                      -- Tutor de la sección (NULL si no tiene programación)
                      'docente_responsable', (
                        SELECT jsonb_build_object(
                          'id_docente', d.id_docente,
                          'id_usuario', d.id_usuario,
                          'nombre_completo', concat_ws(' ', d.nombres, d.apellido_paterno, d.apellido_materno)
                        )
                        FROM public.mg_programacion_seccion ps
                        JOIN public.mg_docente d ON d.id_docente = ps.id_docente_responsable
                        WHERE ps.id_seccion = s.id_seccion
                      ),
                      -- Docente que dicta cada curso programado en la sección
                      'cursos', COALESCE((
                        SELECT jsonb_agg(
                          jsonb_build_object(
                            'id_curso', c.id_curso,
                            'curso', c.nombre,
                            'id_docente', d.id_docente,
                            'id_usuario', d.id_usuario,
                            'docente', concat_ws(' ', d.nombres, d.apellido_paterno, d.apellido_materno)
                          ) ORDER BY c.nombre, c.id_curso
                        )
                        FROM public.mg_programacion_seccion ps
                        JOIN public.mg_programacion_curso pc
                          ON pc.id_programacion_seccion = ps.id_programacion_seccion
                         AND pc.estado
                        JOIN public.mg_curso c ON c.id_curso = pc.id_curso
                        JOIN public.mg_docente d ON d.id_docente = pc.id_docente
                        WHERE ps.id_seccion = s.id_seccion
                      ), '[]'::jsonb)
                    ) ORDER BY s.nombre, s.id_seccion
                  )
                  FROM public.mg_seccion s
                  WHERE s.id_grado = g.id_grado
                    AND (NOT p_solo_activos OR s.estado)
                ), '[]'::jsonb)
              ) ORDER BY g.nombre, g.id_grado
            )
            FROM public.mg_grado g
            WHERE g.id_nivel = n.id_nivel
              AND (NOT p_solo_activos OR g.estado)
          ), '[]'::jsonb)
        ) ORDER BY n.id_nivel
      )
      FROM public.mg_nivel n
      WHERE n.id_anio_lectivo = al.id_anio_lectivo
        AND (NOT p_solo_activos OR n.estado)
    ), '[]'::jsonb)
  )
  FROM public.mg_anio_lectivo al
  WHERE al.id_anio_lectivo = p_id_anio;
$$;
