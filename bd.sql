-- WARNING: This schema is for context only and is not meant to be run.
-- Table order and constraints may not be valid for execution.

CREATE TABLE public.mg_anio_lectivo (
  id_anio_lectivo bigint NOT NULL DEFAULT nextval('mg_anio_lectivo_id_anio_lectivo_seq'::regclass),
  anio integer NOT NULL UNIQUE,
  estado boolean NOT NULL DEFAULT true,
  nombre character varying NOT NULL,
  CONSTRAINT mg_anio_lectivo_pkey PRIMARY KEY (id_anio_lectivo)
);
CREATE TABLE public.mg_nivel (
  id_nivel bigint NOT NULL DEFAULT nextval('mg_nivel_id_nivel_seq'::regclass),
  id_anio_lectivo bigint NOT NULL,
  nombre character varying NOT NULL,
  estado boolean NOT NULL DEFAULT true,
  CONSTRAINT mg_nivel_pkey PRIMARY KEY (id_nivel),
  CONSTRAINT fk_mg_nivel_anio_lectivo FOREIGN KEY (id_anio_lectivo) REFERENCES public.mg_anio_lectivo(id_anio_lectivo)
);
CREATE TABLE public.mg_grado (
  id_grado bigint NOT NULL DEFAULT nextval('mg_grado_id_grado_seq'::regclass),
  id_nivel bigint NOT NULL,
  nombre character varying NOT NULL,
  estado boolean NOT NULL DEFAULT true,
  CONSTRAINT mg_grado_pkey PRIMARY KEY (id_grado),
  CONSTRAINT fk_mg_grado_nivel FOREIGN KEY (id_nivel) REFERENCES public.mg_nivel(id_nivel)
);
CREATE TABLE public.mg_seccion (
  id_seccion bigint NOT NULL DEFAULT nextval('mg_seccion_id_seccion_seq'::regclass),
  id_grado bigint NOT NULL,
  nombre character varying NOT NULL,
  estado boolean NOT NULL DEFAULT true,
  CONSTRAINT mg_seccion_pkey PRIMARY KEY (id_seccion),
  CONSTRAINT fk_mg_seccion_grado FOREIGN KEY (id_grado) REFERENCES public.mg_grado(id_grado)
);
CREATE TABLE public.mg_usuario (
  id_usuario bigint NOT NULL DEFAULT nextval('mg_usuario_id_usuario_seq'::regclass),
  usuario character varying NOT NULL UNIQUE,
  correo character varying NOT NULL UNIQUE,
  password_hash text,
  estado boolean NOT NULL DEFAULT true,
  fecha_creacion timestamp with time zone NOT NULL DEFAULT now(),
  auth_id uuid UNIQUE,
  nombres character varying,
  apaterno character varying,
  amaterno character varying,
  CONSTRAINT mg_usuario_pkey PRIMARY KEY (id_usuario),
  CONSTRAINT mg_usuario_auth_id_fkey FOREIGN KEY (auth_id) REFERENCES auth.users(id)
);
CREATE TABLE public.mg_docente (
  id_docente bigint NOT NULL DEFAULT nextval('mg_docente_id_docente_seq'::regclass),
  id_usuario bigint UNIQUE,
  nombres character varying NOT NULL,
  apellido_paterno character varying,
  apellido_materno character varying,
  dni character varying UNIQUE,
  telefono character varying,
  correo character varying UNIQUE,
  estado boolean NOT NULL DEFAULT true,
  CONSTRAINT mg_docente_pkey PRIMARY KEY (id_docente),
  CONSTRAINT fk_mg_docente_usuario FOREIGN KEY (id_usuario) REFERENCES public.mg_usuario(id_usuario)
);
CREATE TABLE public.mg_estudiante (
  id_estudiante bigint NOT NULL DEFAULT nextval('mg_estudiante_id_estudiante_seq'::regclass),
  nombres character varying NOT NULL,
  apellido_paterno character varying,
  apellido_materno character varying,
  dni character varying UNIQUE,
  fecha_nacimiento date,
  estado boolean NOT NULL DEFAULT true,
  CONSTRAINT mg_estudiante_pkey PRIMARY KEY (id_estudiante)
);
CREATE TABLE public.mg_curso (
  id_curso bigint NOT NULL DEFAULT nextval('mg_curso_id_curso_seq'::regclass),
  nombre character varying NOT NULL,
  estado boolean NOT NULL DEFAULT true,
  id_anio_lectivo bigint NOT NULL,
  CONSTRAINT mg_curso_pkey PRIMARY KEY (id_curso),
  CONSTRAINT mg_curso_id_anio_lectivo_fkey FOREIGN KEY (id_anio_lectivo) REFERENCES public.mg_anio_lectivo(id_anio_lectivo)
);
CREATE TABLE public.mg_programacion_seccion (
  id_programacion_seccion bigint NOT NULL DEFAULT nextval('mg_programacion_seccion_id_programacion_seccion_seq'::regclass),
  id_seccion bigint NOT NULL UNIQUE,
  id_docente_responsable bigint NOT NULL,
  estado_completado boolean NOT NULL DEFAULT true,
  CONSTRAINT mg_programacion_seccion_pkey PRIMARY KEY (id_programacion_seccion),
  CONSTRAINT fk_mg_prog_seccion_seccion FOREIGN KEY (id_seccion) REFERENCES public.mg_seccion(id_seccion),
  CONSTRAINT fk_mg_prog_seccion_docente FOREIGN KEY (id_docente_responsable) REFERENCES public.mg_docente(id_docente)
);
CREATE TABLE public.mg_programacion_curso (
  id_programacion_curso bigint NOT NULL DEFAULT nextval('mg_programacion_curso_id_programacion_curso_seq'::regclass),
  id_programacion_seccion bigint NOT NULL,
  id_curso bigint NOT NULL,
  id_docente bigint NOT NULL,
  estado boolean NOT NULL DEFAULT true,
  CONSTRAINT mg_programacion_curso_pkey PRIMARY KEY (id_programacion_curso),
  CONSTRAINT fk_mg_prog_curso_seccion FOREIGN KEY (id_programacion_seccion) REFERENCES public.mg_programacion_seccion(id_programacion_seccion),
  CONSTRAINT fk_mg_prog_curso_curso FOREIGN KEY (id_curso) REFERENCES public.mg_curso(id_curso),
  CONSTRAINT fk_mg_prog_curso_docente FOREIGN KEY (id_docente) REFERENCES public.mg_docente(id_docente)
);
CREATE TABLE public.mg_matricula (
  id_matricula bigint NOT NULL DEFAULT nextval('mg_matricula_id_matricula_seq'::regclass),
  id_seccion bigint NOT NULL,
  id_estudiante bigint NOT NULL,
  fecha_matricula date NOT NULL DEFAULT CURRENT_DATE,
  estado boolean NOT NULL DEFAULT true,
  CONSTRAINT mg_matricula_pkey PRIMARY KEY (id_matricula),
  CONSTRAINT fk_mg_matricula_estudiante FOREIGN KEY (id_estudiante) REFERENCES public.mg_estudiante(id_estudiante),
  CONSTRAINT mg_matricula_id_seccion_fkey FOREIGN KEY (id_seccion) REFERENCES public.mg_seccion(id_seccion)
);
CREATE TABLE public.mg_tipo_asistencia (
  id_tipo_asistencia bigint NOT NULL DEFAULT nextval('mg_tipo_asistencia_id_tipo_asistencia_seq'::regclass),
  codigo character varying NOT NULL UNIQUE,
  descripcion character varying NOT NULL,
  estado boolean NOT NULL DEFAULT true,
  CONSTRAINT mg_tipo_asistencia_pkey PRIMARY KEY (id_tipo_asistencia)
);
CREATE TABLE public.mg_asistencia (
  id_asistencia bigint NOT NULL DEFAULT nextval('mg_asistencia_id_asistencia_seq'::regclass),
  id_matricula bigint NOT NULL,
  id_tipo_asistencia bigint NOT NULL,
  fecha date NOT NULL,
  CONSTRAINT mg_asistencia_pkey PRIMARY KEY (id_asistencia),
  CONSTRAINT fk_mg_asistencia_matricula FOREIGN KEY (id_matricula) REFERENCES public.mg_matricula(id_matricula),
  CONSTRAINT fk_mg_asistencia_tipo FOREIGN KEY (id_tipo_asistencia) REFERENCES public.mg_tipo_asistencia(id_tipo_asistencia)
);
CREATE TABLE public.mg_competencia (
  id_competencia bigint NOT NULL DEFAULT nextval('mg_competencia_id_competencia_seq'::regclass),
  id_curso bigint NOT NULL,
  codigo character varying,
  descripcion text NOT NULL,
  estado boolean NOT NULL DEFAULT true,
  id_aprendizaje bigint,
  tipo text,
  CONSTRAINT mg_competencia_pkey PRIMARY KEY (id_competencia),
  CONSTRAINT fk_mg_competencia_curso FOREIGN KEY (id_curso) REFERENCES public.mg_curso(id_curso),
  CONSTRAINT mg_competencia_id_aprendizaje_fkey FOREIGN KEY (id_aprendizaje) REFERENCES public.mg_aprendizaje(id_aprendizaje)
);
CREATE TABLE public.mg_capacidades (
  id_capacidad bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  descripcion text NOT NULL,
  estado boolean NOT NULL DEFAULT true,
  id_competencia bigint,
  CONSTRAINT mg_capacidades_pkey PRIMARY KEY (id_capacidad),
  CONSTRAINT mg_capacidades_Id_competencia_fkey FOREIGN KEY (id_competencia) REFERENCES public.mg_competencia(id_competencia)
);
CREATE TABLE public.mg_matricula_curso (
  id_matricula_curso bigint NOT NULL DEFAULT nextval('mg_matricula_curso_id_matricula_curso_seq'::regclass),
  id_programacion_curso bigint NOT NULL,
  id_matricula bigint NOT NULL,
  estado boolean NOT NULL DEFAULT true,
  CONSTRAINT mg_matricula_curso_pkey PRIMARY KEY (id_matricula_curso),
  CONSTRAINT fk_mg_matricula_curso_programacion FOREIGN KEY (id_programacion_curso) REFERENCES public.mg_programacion_curso(id_programacion_curso),
  CONSTRAINT fk_mg_matricula_curso_matricula FOREIGN KEY (id_matricula) REFERENCES public.mg_matricula(id_matricula)
);
CREATE TABLE public.mg_valor_evaluacion (
  id_valor bigint NOT NULL DEFAULT nextval('mg_valor_evaluacion_id_valor_seq'::regclass),
  codigo character varying NOT NULL UNIQUE,
  descripcion character varying NOT NULL,
  estado boolean NOT NULL DEFAULT true,
  orden bigint NOT NULL,
  CONSTRAINT mg_valor_evaluacion_pkey PRIMARY KEY (id_valor)
);
CREATE TABLE public.mg_rol (
  id_rol bigint NOT NULL DEFAULT nextval('mg_rol_id_rol_seq'::regclass),
  codigo character varying NOT NULL UNIQUE,
  nombre character varying NOT NULL,
  descripcion character varying,
  estado boolean NOT NULL DEFAULT true,
  CONSTRAINT mg_rol_pkey PRIMARY KEY (id_rol)
);
CREATE TABLE public.mg_permiso (
  id_permiso bigint NOT NULL DEFAULT nextval('mg_permiso_id_permiso_seq'::regclass),
  codigo character varying NOT NULL UNIQUE,
  nombre character varying NOT NULL,
  modulo character varying NOT NULL,
  descripcion character varying,
  estado boolean NOT NULL DEFAULT true,
  CONSTRAINT mg_permiso_pkey PRIMARY KEY (id_permiso)
);
CREATE TABLE public.mg_usuario_rol (
  id_usuario_rol bigint NOT NULL DEFAULT nextval('mg_usuario_rol_id_usuario_rol_seq'::regclass),
  id_usuario bigint NOT NULL,
  id_rol bigint NOT NULL,
  estado boolean NOT NULL DEFAULT true,
  CONSTRAINT mg_usuario_rol_pkey PRIMARY KEY (id_usuario_rol),
  CONSTRAINT fk_mg_usuario_rol_usuario FOREIGN KEY (id_usuario) REFERENCES public.mg_usuario(id_usuario),
  CONSTRAINT fk_mg_usuario_rol_rol FOREIGN KEY (id_rol) REFERENCES public.mg_rol(id_rol)
);
CREATE TABLE public.mg_rol_permiso (
  id_rol_permiso bigint NOT NULL DEFAULT nextval('mg_rol_permiso_id_rol_permiso_seq'::regclass),
  id_rol bigint NOT NULL,
  id_permiso bigint NOT NULL,
  estado boolean NOT NULL DEFAULT true,
  CONSTRAINT mg_rol_permiso_pkey PRIMARY KEY (id_rol_permiso),
  CONSTRAINT fk_mg_rol_permiso_rol FOREIGN KEY (id_rol) REFERENCES public.mg_rol(id_rol),
  CONSTRAINT fk_mg_rol_permiso_permiso FOREIGN KEY (id_permiso) REFERENCES public.mg_permiso(id_permiso)
);
CREATE TABLE public.mg_conversacion_agente (
  id_conversacion bigint NOT NULL DEFAULT nextval('mg_conversacion_agente_id_conversacion_seq'::regclass),
  id_usuario bigint NOT NULL,
  titulo character varying,
  fecha_creacion timestamp with time zone NOT NULL DEFAULT now(),
  fecha_actualizacion timestamp with time zone NOT NULL DEFAULT now(),
  estado boolean NOT NULL DEFAULT true,
  CONSTRAINT mg_conversacion_agente_pkey PRIMARY KEY (id_conversacion),
  CONSTRAINT fk_mg_conversacion_usuario FOREIGN KEY (id_usuario) REFERENCES public.mg_usuario(id_usuario)
);
CREATE TABLE public.mg_mensaje_agente (
  id_mensaje bigint NOT NULL DEFAULT nextval('mg_mensaje_agente_id_mensaje_seq'::regclass),
  id_conversacion bigint NOT NULL,
  rol_mensaje character varying NOT NULL CHECK (rol_mensaje::text = ANY (ARRAY['USER'::character varying, 'ASSISTANT'::character varying, 'TOOL'::character varying]::text[])),
  contenido text NOT NULL,
  fecha_creacion timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT mg_mensaje_agente_pkey PRIMARY KEY (id_mensaje),
  CONSTRAINT fk_mg_mensaje_conversacion FOREIGN KEY (id_conversacion) REFERENCES public.mg_conversacion_agente(id_conversacion)
);
CREATE TABLE public.mg_auditoria_accion (
  id_auditoria bigint NOT NULL DEFAULT nextval('mg_auditoria_accion_id_auditoria_seq'::regclass),
  id_usuario bigint NOT NULL,
  modulo character varying NOT NULL,
  accion character varying NOT NULL,
  entidad character varying,
  id_entidad bigint,
  origen character varying NOT NULL DEFAULT 'WEB'::character varying CHECK (origen::text = ANY (ARRAY['WEB'::character varying, 'AGENTE'::character varying, 'EXCEL'::character varying, 'API'::character varying]::text[])),
  detalle jsonb,
  fecha_creacion timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT mg_auditoria_accion_pkey PRIMARY KEY (id_auditoria),
  CONSTRAINT fk_mg_auditoria_usuario FOREIGN KEY (id_usuario) REFERENCES public.mg_usuario(id_usuario)
);
CREATE TABLE public.mg_aprendizaje (
  id_aprendizaje bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  estado boolean,
  nombre_aprendizaje character varying,
  id_anio_lectivo bigint,
  CONSTRAINT mg_aprendizaje_pkey PRIMARY KEY (id_aprendizaje),
  CONSTRAINT mg_aprendizaje_id_AnioLectivo_fkey FOREIGN KEY (id_anio_lectivo) REFERENCES public.mg_anio_lectivo(id_anio_lectivo)
);
CREATE TABLE public.mg_bimestre (
  id_bimestre bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  id_anio_lectivo bigint NOT NULL,
  numero integer NOT NULL,
  nombre character varying NOT NULL,
  fecha_inicio date,
  fecha_fin date,
  estado boolean NOT NULL DEFAULT true,
  CONSTRAINT mg_bimestre_pkey PRIMARY KEY (id_bimestre),
  CONSTRAINT fk_mg_bimestre_anio FOREIGN KEY (id_anio_lectivo) REFERENCES public.mg_anio_lectivo(id_anio_lectivo)
);
CREATE TABLE public.mg_evaluacion_capacidades (
  id_evaluacion_capacidad bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  id_capacidad bigint NOT NULL,
  id_valor bigint,
  id_matricula_curso bigint NOT NULL,
  id_bimestre bigint,
  codigo character varying,
  estado boolean NOT NULL DEFAULT true,
  CONSTRAINT mg_evaluacion_capacidades_pkey PRIMARY KEY (id_evaluacion_capacidad),
  CONSTRAINT fk_mg_eval_criterio_criterio FOREIGN KEY (id_capacidad) REFERENCES public.mg_capacidades(id_capacidad),
  CONSTRAINT fk_mg_eval_criterio_valor FOREIGN KEY (id_valor) REFERENCES public.mg_valor_evaluacion(id_valor),
  CONSTRAINT fk_mg_eval_criterio_matricula_curso FOREIGN KEY (id_matricula_curso) REFERENCES public.mg_matricula_curso(id_matricula_curso),
  CONSTRAINT fk_mg_eval_criterio_bimestre FOREIGN KEY (id_bimestre) REFERENCES public.mg_bimestre(id_bimestre)
);
CREATE TABLE public.mg_evaluacion_competencia (
  id_evaluacion_competencia bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  id_competencia bigint NOT NULL,
  id_valor bigint,
  id_matricula_curso bigint NOT NULL,
  id_bimestre bigint,
  codigo character varying,
  observacion text,
  estado boolean NOT NULL DEFAULT true,
  CONSTRAINT mg_evaluacion_competencia_pkey PRIMARY KEY (id_evaluacion_competencia),
  CONSTRAINT fk_mg_eval_competencia_competencia FOREIGN KEY (id_competencia) REFERENCES public.mg_competencia(id_competencia),
  CONSTRAINT fk_mg_eval_competencia_valor FOREIGN KEY (id_valor) REFERENCES public.mg_valor_evaluacion(id_valor),
  CONSTRAINT fk_mg_eval_competencia_matricula_curso FOREIGN KEY (id_matricula_curso) REFERENCES public.mg_matricula_curso(id_matricula_curso),
  CONSTRAINT fk_mg_eval_competencia_bimestre FOREIGN KEY (id_bimestre) REFERENCES public.mg_bimestre(id_bimestre)
);
CREATE TABLE public.conversaciones (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  usuario_id uuid NOT NULL DEFAULT auth.uid(),
  titulo text,
  modelo text,
  archivada boolean NOT NULL DEFAULT false,
  creado_en timestamp with time zone NOT NULL DEFAULT now(),
  actualizado_en timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT conversaciones_pkey PRIMARY KEY (id),
  CONSTRAINT conversaciones_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES auth.users(id)
);
CREATE TABLE public.mensajes (
  id text NOT NULL,
  conversacion_id uuid NOT NULL,
  rol text NOT NULL CHECK (rol = ANY (ARRAY['system'::text, 'user'::text, 'assistant'::text])),
  partes jsonb NOT NULL,
  metadata jsonb,
  secuencia bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  creado_en timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT mensajes_pkey PRIMARY KEY (id),
  CONSTRAINT mensajes_conversacion_id_fkey FOREIGN KEY (conversacion_id) REFERENCES public.conversaciones(id)
);
CREATE TABLE public.metricas_consulta (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  conversacion_id uuid NOT NULL,
  mensaje_id text,
  usuario_id uuid NOT NULL,
  tipo_indicador text CHECK (tipo_indicador = ANY (ARRAY['notas'::text, 'asistencia'::text, 'integrado'::text, 'otro'::text])),
  herramientas ARRAY,
  tokens_entrada integer,
  tokens_salida integer,
  latencia_ms integer,
  error text,
  creado_en timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT metricas_consulta_pkey PRIMARY KEY (id),
  CONSTRAINT metricas_consulta_conversacion_id_fkey FOREIGN KEY (conversacion_id) REFERENCES public.conversaciones(id),
  CONSTRAINT metricas_consulta_mensaje_id_fkey FOREIGN KEY (mensaje_id) REFERENCES public.mensajes(id),
  CONSTRAINT metricas_consulta_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES auth.users(id)
);
