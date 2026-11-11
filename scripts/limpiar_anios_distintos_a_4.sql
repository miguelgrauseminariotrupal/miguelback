-- =====================================================================
-- Borra TODA la información académica de los años lectivos distintos a
-- id_anio_lectivo = 4 (incluye el año como tal, sus niveles, grados,
-- secciones, cursos, bimestres, programaciones, matrículas, asistencias,
-- competencias, capacidades y evaluaciones).
--
-- NO toca: mg_estudiante, mg_docente, mg_usuario, roles/permisos,
-- catálogos (mg_tipo_asistencia, mg_valor_evaluacion), ni las tablas del
-- chat (conversaciones, mensajes, metricas_consulta, mg_*_agente,
-- mg_auditoria_accion).
--
-- IRREVERSIBLE. Haz un respaldo antes. El script termina en ROLLBACK:
-- primero ejecútalo así y revisa los conteos; para aplicar de verdad,
-- cambia el ROLLBACK final por COMMIT.
-- =====================================================================
BEGIN;

-- Año que se CONSERVA
CREATE TEMP TABLE _conf ON COMMIT DROP AS SELECT 4::bigint AS id_anio_lectivo;

-- ---- Conjuntos a borrar (ids) ----------------------------------------
CREATE TEMP TABLE d_anio ON COMMIT DROP AS
  SELECT id_anio_lectivo FROM mg_anio_lectivo
  WHERE id_anio_lectivo <> (SELECT id_anio_lectivo FROM _conf);

CREATE TEMP TABLE d_nivel ON COMMIT DROP AS
  SELECT id_nivel FROM mg_nivel WHERE id_anio_lectivo IN (SELECT id_anio_lectivo FROM d_anio);

CREATE TEMP TABLE d_grado ON COMMIT DROP AS
  SELECT id_grado FROM mg_grado WHERE id_nivel IN (SELECT id_nivel FROM d_nivel);

CREATE TEMP TABLE d_seccion ON COMMIT DROP AS
  SELECT id_seccion FROM mg_seccion WHERE id_grado IN (SELECT id_grado FROM d_grado);

CREATE TEMP TABLE d_curso ON COMMIT DROP AS
  SELECT id_curso FROM mg_curso WHERE id_anio_lectivo IN (SELECT id_anio_lectivo FROM d_anio);

CREATE TEMP TABLE d_bimestre ON COMMIT DROP AS
  SELECT id_bimestre FROM mg_bimestre WHERE id_anio_lectivo IN (SELECT id_anio_lectivo FROM d_anio);

-- Aprendizajes con año distinto (los de año NULL son globales y se conservan)
CREATE TEMP TABLE d_aprendizaje ON COMMIT DROP AS
  SELECT id_aprendizaje FROM mg_aprendizaje
  WHERE id_anio_lectivo IN (SELECT id_anio_lectivo FROM d_anio);

CREATE TEMP TABLE d_matricula ON COMMIT DROP AS
  SELECT id_matricula FROM mg_matricula WHERE id_seccion IN (SELECT id_seccion FROM d_seccion);

CREATE TEMP TABLE d_prog_seccion ON COMMIT DROP AS
  SELECT id_programacion_seccion FROM mg_programacion_seccion
  WHERE id_seccion IN (SELECT id_seccion FROM d_seccion);

CREATE TEMP TABLE d_prog_curso ON COMMIT DROP AS
  SELECT id_programacion_curso FROM mg_programacion_curso
  WHERE id_programacion_seccion IN (SELECT id_programacion_seccion FROM d_prog_seccion)
     OR id_curso IN (SELECT id_curso FROM d_curso);

CREATE TEMP TABLE d_matricula_curso ON COMMIT DROP AS
  SELECT id_matricula_curso FROM mg_matricula_curso
  WHERE id_programacion_curso IN (SELECT id_programacion_curso FROM d_prog_curso)
     OR id_matricula IN (SELECT id_matricula FROM d_matricula);

CREATE TEMP TABLE d_competencia ON COMMIT DROP AS
  SELECT id_competencia FROM mg_competencia WHERE id_curso IN (SELECT id_curso FROM d_curso);

CREATE TEMP TABLE d_capacidad ON COMMIT DROP AS
  SELECT id_capacidad FROM mg_capacidades
  WHERE id_competencia IN (SELECT id_competencia FROM d_competencia);

-- ---- Vista previa: filas que se borrarán -----------------------------
SELECT 'mg_anio_lectivo' tabla, count(*) FROM d_anio
UNION ALL SELECT 'mg_nivel', count(*) FROM d_nivel
UNION ALL SELECT 'mg_grado', count(*) FROM d_grado
UNION ALL SELECT 'mg_seccion', count(*) FROM d_seccion
UNION ALL SELECT 'mg_curso', count(*) FROM d_curso
UNION ALL SELECT 'mg_bimestre', count(*) FROM d_bimestre
UNION ALL SELECT 'mg_aprendizaje', count(*) FROM d_aprendizaje
UNION ALL SELECT 'mg_matricula', count(*) FROM d_matricula
UNION ALL SELECT 'mg_programacion_seccion', count(*) FROM d_prog_seccion
UNION ALL SELECT 'mg_programacion_curso', count(*) FROM d_prog_curso
UNION ALL SELECT 'mg_matricula_curso', count(*) FROM d_matricula_curso
UNION ALL SELECT 'mg_competencia', count(*) FROM d_competencia
UNION ALL SELECT 'mg_capacidades', count(*) FROM d_capacidad;

-- ---- Borrado (hijos primero) ------------------------------------------
DELETE FROM mg_evaluacion_capacidades
 WHERE id_matricula_curso IN (SELECT id_matricula_curso FROM d_matricula_curso)
    OR id_bimestre IN (SELECT id_bimestre FROM d_bimestre)
    OR id_capacidad IN (SELECT id_capacidad FROM d_capacidad);

DELETE FROM mg_evaluacion_competencia
 WHERE id_matricula_curso IN (SELECT id_matricula_curso FROM d_matricula_curso)
    OR id_bimestre IN (SELECT id_bimestre FROM d_bimestre)
    OR id_competencia IN (SELECT id_competencia FROM d_competencia);

DELETE FROM mg_capacidades WHERE id_capacidad IN (SELECT id_capacidad FROM d_capacidad);

-- Competencias que se conservan pero apuntan a un aprendizaje que se borra
UPDATE mg_competencia SET id_aprendizaje = NULL
 WHERE id_aprendizaje IN (SELECT id_aprendizaje FROM d_aprendizaje)
   AND id_competencia NOT IN (SELECT id_competencia FROM d_competencia);

DELETE FROM mg_competencia WHERE id_competencia IN (SELECT id_competencia FROM d_competencia);

DELETE FROM mg_matricula_curso WHERE id_matricula_curso IN (SELECT id_matricula_curso FROM d_matricula_curso);
DELETE FROM mg_asistencia WHERE id_matricula IN (SELECT id_matricula FROM d_matricula);
DELETE FROM mg_matricula WHERE id_matricula IN (SELECT id_matricula FROM d_matricula);
DELETE FROM mg_programacion_curso WHERE id_programacion_curso IN (SELECT id_programacion_curso FROM d_prog_curso);
DELETE FROM mg_programacion_seccion WHERE id_programacion_seccion IN (SELECT id_programacion_seccion FROM d_prog_seccion);
DELETE FROM mg_seccion WHERE id_seccion IN (SELECT id_seccion FROM d_seccion);
DELETE FROM mg_grado WHERE id_grado IN (SELECT id_grado FROM d_grado);
DELETE FROM mg_nivel WHERE id_nivel IN (SELECT id_nivel FROM d_nivel);
DELETE FROM mg_curso WHERE id_curso IN (SELECT id_curso FROM d_curso);
DELETE FROM mg_bimestre WHERE id_bimestre IN (SELECT id_bimestre FROM d_bimestre);
DELETE FROM mg_aprendizaje WHERE id_aprendizaje IN (SELECT id_aprendizaje FROM d_aprendizaje);
DELETE FROM mg_anio_lectivo WHERE id_anio_lectivo IN (SELECT id_anio_lectivo FROM d_anio);

-- ---- Verificación: debe quedar solo el año 4 --------------------------
SELECT id_anio_lectivo, anio FROM mg_anio_lectivo;

-- Por seguridad NO confirma. Para aplicar los cambios, reemplaza por COMMIT;
ROLLBACK;
