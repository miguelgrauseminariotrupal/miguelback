// CRUD API for mg_docente (docentes).
//
// GET    /docentes?estado=true&id_usuario=1&q=perez   list (optional filters)
//   'q' busca (ILIKE parcial) en nombres/apellido_paterno/apellido_materno/dni
// GET    /docentes/:id                        get one
// POST   /docentes                            create { id_usuario?, nombres, apellido_paterno?, apellido_materno?, dni?, telefono?, correo?, estado?, indUsuario? }
//   solo 'nombres' es obligatorio (salvo que indUsuario=true, ver abajo)
// PUT    /docentes/:id                        update (same fields, all optional)
//
// Si POST trae `indUsuario: true`, además del docente se crea su cuenta con
// tres altas secuenciales (se valida todo antes; si un paso falla se revierten
// los anteriores): usuario en Supabase Auth -> mg_usuario (auth_id) -> docente.
//   - 'correo' y 'dni' (8 dígitos) pasan a ser requeridos.
//   - mg_usuario.usuario = el mismo 'correo' (ya es único en mg_usuario, no
//     hace falta generar/deduplicar un usuario aparte).
//   - la contraseña inicial en Auth es el 'dni' tal cual (el docente deberá
//     cambiarla luego).

import { getServiceClient } from "../_shared/client.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { crearUsuarioAuth, eliminarUsuarioAuth } from "../_shared/auth.ts";
import {
  busquedaIlikeOr,
  dbErrorStatus,
  errorResponse,
  jsonResponse,
  parseId,
  sanitizarBusqueda,
  splitPath,
} from "../_shared/http.ts";

const FUNCTION_NAME = "docentes";
const TABLE = "mg_docente";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DNI_RE = /^\d{8}$/;

const OPTIONAL_STRING_FIELDS = [
  "apellido_paterno",
  "apellido_materno",
  "dni",
  "telefono",
] as const;

const COLUMNAS_BUSQUEDA = [
  "nombres",
  "apellido_paterno",
  "apellido_materno",
  "dni",
] as const;

/** Devuelve un mensaje de error si alguno de los campos, cuando viene
 * presente, no es texto; o null si todos son válidos. */
function validarCamposTexto(
  body: Record<string, unknown>,
  campos: readonly string[],
): string | null {
  for (const campo of campos) {
    const valor = body[campo];
    if (valor !== undefined && valor !== null && typeof valor !== "string") {
      return `'${campo}' debe ser texto`;
    }
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const [idSegment] = splitPath(url, FUNCTION_NAME);
  const supabase = getServiceClient();

  try {
    if (req.method === "GET" && !idSegment) {
      let query = supabase.from(TABLE).select("*").order("id_docente");

      const estado = url.searchParams.get("estado");
      if (estado === "true" || estado === "false") {
        query = query.eq("estado", estado === "true");
      }
      const idUsuario = url.searchParams.get("id_usuario");
      if (idUsuario !== null) {
        const parsed = parseId(idUsuario);
        if (parsed === null) {
          return errorResponse("'id_usuario' inválido", 400);
        }
        query = query.eq("id_usuario", parsed);
      }

      const q = url.searchParams.get("q");
      if (q !== null && q.trim() !== "") {
        query = query.or(
          busquedaIlikeOr(sanitizarBusqueda(q), COLUMNAS_BUSQUEDA),
        );
      }

      const { data, error } = await query;
      if (error) return errorResponse(error.message, 500);
      return jsonResponse(data);
    }

    if (req.method === "GET" && idSegment) {
      const id = parseId(idSegment);
      if (id === null) return errorResponse("id inválido", 400);
      const { data, error } = await supabase
        .from(TABLE)
        .select("*")
        .eq("id_docente", id)
        .maybeSingle();
      if (error) return errorResponse(error.message, 500);
      if (!data) return errorResponse("Docente no encontrado", 404);
      return jsonResponse(data);
    }

    if (req.method === "POST" && !idSegment) {
      const body = await req.json().catch(() => null);
      if (
        !body ||
        typeof body.nombres !== "string" || body.nombres.trim() === ""
      ) {
        return errorResponse("'nombres' es requerido y debe ser texto", 400);
      }
      if (body.correo !== undefined && body.correo !== null) {
        if (typeof body.correo !== "string" || !EMAIL_RE.test(body.correo)) {
          return errorResponse("'correo' debe ser un email válido", 400);
        }
      }
      if (body.id_usuario !== undefined && body.id_usuario !== null) {
        if (
          typeof body.id_usuario !== "number" ||
          !Number.isInteger(body.id_usuario)
        ) {
          return errorResponse("'id_usuario' debe ser un entero", 400);
        }
      }
      if (body.indUsuario !== undefined && typeof body.indUsuario !== "boolean") {
        return errorResponse("'indUsuario' debe ser booleano", 400);
      }

      if (body.indUsuario === true) {
        if (typeof body.correo !== "string" || !EMAIL_RE.test(body.correo)) {
          return errorResponse(
            "'correo' es requerido y debe ser un email válido cuando 'indUsuario' es true",
            400,
          );
        }
        if (typeof body.dni !== "string" || !DNI_RE.test(body.dni)) {
          return errorResponse(
            "'dni' es requerido y debe tener 8 dígitos cuando 'indUsuario' es true",
            400,
          );
        }
        const errorCampos = validarCamposTexto(body, [
          "apellido_paterno",
          "apellido_materno",
          "telefono",
        ]);
        if (errorCampos) return errorResponse(errorCampos, 400);

        const estadoNuevo = typeof body.estado === "boolean"
          ? body.estado
          : true;

        // Pre-chequeo de duplicados: da un mensaje claro y evita dejar un
        // usuario a medio crear por una violación que ya sabíamos que iba a
        // ocurrir. La restricción UNIQUE en la BD sigue siendo la garantía
        // real ante condiciones de carrera (dos altas simultáneas).
        const [usuarioExistente, docentePorDni, docentePorCorreo] =
          await Promise.all([
            supabase.from("mg_usuario").select("id_usuario").eq(
              "correo",
              body.correo,
            ).maybeSingle(),
            supabase.from(TABLE).select("id_docente").eq("dni", body.dni)
              .maybeSingle(),
            supabase.from(TABLE).select("id_docente").eq(
              "correo",
              body.correo,
            ).maybeSingle(),
          ]);
        if (usuarioExistente.error) {
          return errorResponse(usuarioExistente.error.message, 500);
        }
        if (usuarioExistente.data) {
          return errorResponse("Ya existe un usuario con ese correo.", 409);
        }
        if (docentePorDni.error) {
          return errorResponse(docentePorDni.error.message, 500);
        }
        if (docentePorDni.data) {
          return errorResponse("Ya existe un docente con ese DNI.", 409);
        }
        if (docentePorCorreo.error) {
          return errorResponse(docentePorCorreo.error.message, 500);
        }
        if (docentePorCorreo.data) {
          return errorResponse("Ya existe un docente con ese correo.", 409);
        }

        // 1) Credenciales en Supabase Auth (contraseña inicial = DNI).
        const creadoAuth = await crearUsuarioAuth(
          supabase,
          body.correo,
          body.dni,
        );
        if ("error" in creadoAuth) {
          return errorResponse(creadoAuth.error, creadoAuth.status);
        }

        // 2) mg_usuario enlazado a auth.users por auth_id.
        const { data: nuevoUsuario, error: errorUsuario } = await supabase
          .from("mg_usuario")
          .insert({
            usuario: body.correo,
            correo: body.correo,
            auth_id: creadoAuth.authId,
            estado: estadoNuevo,
          })
          .select("id_usuario, usuario, correo, estado, fecha_creacion")
          .single();

        if (errorUsuario) {
          await eliminarUsuarioAuth(supabase, creadoAuth.authId);
          const status = dbErrorStatus(errorUsuario);
          const message = status === 409
            ? "Ya existe un usuario con ese correo."
            : errorUsuario.message;
          return errorResponse(message, status);
        }

        const { data: nuevoDocente, error: errorDocente } = await supabase
          .from(TABLE)
          .insert({
            id_usuario: nuevoUsuario.id_usuario,
            nombres: body.nombres,
            apellido_paterno: body.apellido_paterno ?? null,
            apellido_materno: body.apellido_materno ?? null,
            dni: body.dni,
            telefono: body.telefono ?? null,
            correo: body.correo,
            estado: estadoNuevo,
          })
          .select("*")
          .single();

        if (errorDocente) {
          // Compensa los inserts previos (mg_usuario y auth.users) para no dejar
          // usuarios huérfanos (no hay transacción real entre ellos).
          const { error: errorBorrarUsuario } = await supabase
            .from("mg_usuario")
            .delete()
            .eq("id_usuario", nuevoUsuario.id_usuario);
          const authBorrado = await eliminarUsuarioAuth(
            supabase,
            creadoAuth.authId,
          );
          const errorCompensacion = errorBorrarUsuario || !authBorrado;

          const status = dbErrorStatus(errorDocente);
          let message = status === 409
            ? "Ya existe el docente (DNI o correo duplicado)."
            : errorDocente.message;
          if (errorCompensacion) {
            message +=
              ` Además, no se pudo revertir el usuario huérfano id_usuario=${nuevoUsuario.id_usuario}; requiere limpieza manual.`;
          }
          return errorResponse(message, status);
        }

        return jsonResponse({ usuario: nuevoUsuario, docente: nuevoDocente }, 201);
      }

      const errorCamposGeneral = validarCamposTexto(
        body,
        OPTIONAL_STRING_FIELDS,
      );
      if (errorCamposGeneral) return errorResponse(errorCamposGeneral, 400);

      const insert: Record<string, unknown> = { nombres: body.nombres };
      if (body.id_usuario !== undefined) insert.id_usuario = body.id_usuario;
      if (body.correo !== undefined) insert.correo = body.correo;
      for (const key of OPTIONAL_STRING_FIELDS) {
        if (body[key] !== undefined) insert[key] = body[key];
      }
      if (typeof body.estado === "boolean") insert.estado = body.estado;

      const { data, error } = await supabase
        .from(TABLE)
        .insert(insert)
        .select("*")
        .single();
      if (error){
        const codeError = dbErrorStatus(error);
        let msgError = "Error interno del servidor";
        if (codeError === 409) {
          msgError = "Ya existe el docente."
        }
        return errorResponse(msgError, codeError);
      }
      return jsonResponse(data, 201);
    }

    if ((req.method === "PUT" || req.method === "PATCH") && idSegment) {
      const id = parseId(idSegment);
      if (id === null) return errorResponse("id inválido", 400);
      const body = await req.json().catch(() => null);
      if (!body || typeof body !== "object") {
        return errorResponse("Cuerpo de la solicitud inválido", 400);
      }

      const update: Record<string, unknown> = {};
      if (body.nombres !== undefined) {
        if (typeof body.nombres !== "string" || body.nombres.trim() === "") {
          return errorResponse("'nombres' debe ser texto no vacío", 400);
        }
        update.nombres = body.nombres;
      }
      if (body.correo !== undefined) {
        if (
          body.correo !== null &&
          (typeof body.correo !== "string" || !EMAIL_RE.test(body.correo))
        ) {
          return errorResponse("'correo' debe ser un email válido", 400);
        }
        update.correo = body.correo;
      }
      if (body.id_usuario !== undefined) {
        if (
          body.id_usuario !== null &&
          (typeof body.id_usuario !== "number" ||
            !Number.isInteger(body.id_usuario))
        ) {
          return errorResponse("'id_usuario' debe ser un entero", 400);
        }
        update.id_usuario = body.id_usuario;
      }
      const errorCamposUpdate = validarCamposTexto(
        body,
        OPTIONAL_STRING_FIELDS,
      );
      if (errorCamposUpdate) return errorResponse(errorCamposUpdate, 400);
      for (const key of OPTIONAL_STRING_FIELDS) {
        if (body[key] !== undefined) update[key] = body[key];
      }
      if (body.estado !== undefined) {
        if (typeof body.estado !== "boolean") {
          return errorResponse("'estado' debe ser booleano", 400);
        }
        update.estado = body.estado;
      }
      if (Object.keys(update).length === 0) {
        return errorResponse("No hay campos para actualizar", 400);
      }

      const { data, error } = await supabase
        .from(TABLE)
        .update(update)
        .eq("id_docente", id)
        .select("*")
        .maybeSingle();
      if (error) return errorResponse(error.message, dbErrorStatus(error));
      if (!data) return errorResponse("Docente no encontrado", 404);
      return jsonResponse(data);
    }

    return errorResponse("Ruta o método no soportado", 404);
  } catch (err) {
    return errorResponse(
      err instanceof Error ? err.message : "Error inesperado",
      500,
    );
  }
});
