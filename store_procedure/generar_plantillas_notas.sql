CREATE OR REPLACE FUNCTION public.generar_plantillas_notas(p_id_anio bigint)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_competencias integer;
  v_capacidades integer;
  v_competencias_bimestre integer;
  v_capacidades_bimestre integer;
BEGIN
  INSERT INTO mg_evaluacion_competencia (id_competencia, id_valor, id_matricula_curso, codigo, observacion)
  SELECT c.id_competencia, NULL, mc.id_matricula_curso, NULL, NULL
  FROM mg_aprendizaje a
  INNER JOIN mg_competencia c ON a.id_aprendizaje = c.id_aprendizaje
  INNER JOIN mg_programacion_curso pc ON c.id_curso = pc.id_curso
  INNER JOIN mg_matricula_curso mc ON mc.id_programacion_curso = pc.id_programacion_curso
  WHERE a.id_anio_lectivo = p_id_anio
    AND NOT EXISTS (
      SELECT 1 FROM mg_evaluacion_competencia ec
      WHERE ec.id_matricula_curso = mc.id_matricula_curso AND ec.id_competencia = c.id_competencia
    );
  GET DIAGNOSTICS v_competencias = ROW_COUNT;

  INSERT INTO mg_evaluacion_capacidades (id_capacidad, id_valor, id_matricula_curso, codigo)
  SELECT ca.id_capacidad, NULL, mc.id_matricula_curso, NULL
  FROM mg_aprendizaje a
  INNER JOIN mg_competencia c ON a.id_aprendizaje = c.id_aprendizaje
  INNER JOIN mg_capacidades ca ON c.id_competencia = ca.id_competencia
  INNER JOIN mg_programacion_curso pc ON c.id_curso = pc.id_curso
  INNER JOIN mg_matricula_curso mc ON mc.id_programacion_curso = pc.id_programacion_curso
  WHERE a.id_anio_lectivo = p_id_anio
    AND NOT EXISTS (
      SELECT 1 FROM mg_evaluacion_capacidades ec
      WHERE ec.id_matricula_curso = mc.id_matricula_curso AND ec.id_capacidad = ca.id_capacidad
    );
  GET DIAGNOSTICS v_capacidades = ROW_COUNT;

  INSERT INTO mg_evaluacion_competencia_bimestre (id_evaluacion_competencia, id_bimestre, id_valor)
  SELECT ec.id_evaluacion_competencia, b.id_bimestre, NULL
  FROM mg_evaluacion_competencia ec
  INNER JOIN mg_competencia c ON c.id_competencia = ec.id_competencia
  INNER JOIN mg_aprendizaje a ON a.id_aprendizaje = c.id_aprendizaje
  INNER JOIN mg_bimestre b ON b.id_anio_lectivo = a.id_anio_lectivo
  WHERE a.id_anio_lectivo = p_id_anio
    AND NOT EXISTS (
      SELECT 1 FROM mg_evaluacion_competencia_bimestre ecb
      WHERE ecb.id_evaluacion_competencia = ec.id_evaluacion_competencia AND ecb.id_bimestre = b.id_bimestre
    );
  GET DIAGNOSTICS v_competencias_bimestre = ROW_COUNT;

  INSERT INTO mg_evaluacion_capacidades_bimestre (id_evaluacion_capacidad, id_bimestre, id_valor)
  SELECT ec.id_evaluacion_capacidad, b.id_bimestre, NULL
  FROM mg_evaluacion_capacidades ec
  INNER JOIN mg_capacidades ca ON ec.id_capacidad = ca.id_capacidad
  INNER JOIN mg_competencia c ON c.id_competencia = ca.id_competencia
  INNER JOIN mg_aprendizaje a ON a.id_aprendizaje = c.id_aprendizaje
  INNER JOIN mg_bimestre b ON b.id_anio_lectivo = a.id_anio_lectivo
  WHERE a.id_anio_lectivo = p_id_anio
    AND NOT EXISTS (
      SELECT 1 FROM mg_evaluacion_capacidades_bimestre ecb
      WHERE ecb.id_evaluacion_capacidad = ec.id_evaluacion_capacidad AND ecb.id_bimestre = b.id_bimestre
    );
  GET DIAGNOSTICS v_capacidades_bimestre = ROW_COUNT;

  RETURN jsonb_build_object(
    'id_anio', p_id_anio,
    'competencias_creadas', v_competencias,
    'capacidades_creadas', v_capacidades,
    'competencias_bimestre_creadas', v_competencias_bimestre,
    'capacidades_bimestre_creadas', v_capacidades_bimestre
  );
END;
$$;