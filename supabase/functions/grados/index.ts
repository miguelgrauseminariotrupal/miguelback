// CRUD API for mg_grado (grados), scoped to un nivel.
//
// GET    /grados?id_nivel=1&estado=true   list (id_nivel optional filter)
// GET    /grados/:id                      get one
// POST   /grados                          create { id_nivel, nombre, estado? } (id_nivel y nombre obligatorios)
// PUT    /grados/:id                      update { id_nivel?, nombre?, estado? }

import { getServiceClient } from "../_shared/client.ts";
import { corsHeaders } from "../_shared/cors.ts";
import {
  dbErrorStatus,
  errorResponse,
  jsonResponse,
  parseId,
  splitPath,
} from "../_shared/http.ts";

const FUNCTION_NAME = "grados";
const TABLE = "mg_grado";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const [idSegment] = splitPath(url, FUNCTION_NAME);
  const supabase = getServiceClient();

  try {
    if (req.method === "GET" && !idSegment) {
      let query = supabase.from(TABLE).select("*").order("id_grado");

      const idNivel = url.searchParams.get("id_nivel");
      if (idNivel !== null) {
        const parsed = parseId(idNivel);
        if (parsed === null) return errorResponse("'id_nivel' inválido", 400);
        query = query.eq("id_nivel", parsed);
      }

      const estado = url.searchParams.get("estado");
      if (estado === "true" || estado === "false") {
        query = query.eq("estado", estado === "true");
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
        .eq("id_grado", id)
        .maybeSingle();
      if (error) return errorResponse(error.message, 500);
      if (!data) return errorResponse("Grado no encontrado", 404);
      return jsonResponse(data);
    }

    if (req.method === "POST" && !idSegment) {
      const body = await req.json().catch(() => null);
      if (
        !body ||
        typeof body.id_nivel !== "number" ||
        !Number.isInteger(body.id_nivel) ||
        typeof body.nombre !== "string" ||
        body.nombre.trim() === ""
      ) {
        return errorResponse(
          "'id_nivel' (entero) y 'nombre' (texto no vacío) son requeridos",
          400,
        );
      }
      const insert: Record<string, unknown> = {
        id_nivel: body.id_nivel,
        nombre: body.nombre,
      };
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
          msgError = "Ya existe el grado."
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
      if (body.id_nivel !== undefined) {
        if (
          typeof body.id_nivel !== "number" ||
          !Number.isInteger(body.id_nivel)
        ) {
          return errorResponse("'id_nivel' debe ser un entero", 400);
        }
        update.id_nivel = body.id_nivel;
      }
      if (body.nombre !== undefined) {
        if (typeof body.nombre !== "string" || body.nombre.trim() === "") {
          return errorResponse("'nombre' debe ser texto no vacío", 400);
        }
        update.nombre = body.nombre;
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
        .eq("id_grado", id)
        .select("*")
        .maybeSingle();
      if (error) return errorResponse(error.message, dbErrorStatus(error));
      if (!data) return errorResponse("Grado no encontrado", 404);
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
