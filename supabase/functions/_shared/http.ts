import { corsHeaders } from "./cors.ts";

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

export function noContentResponse(): Response {
  return new Response(null, { status: 204, headers: corsHeaders });
}

/** Parses a positive integer id from a URL path segment, or returns null. */
export function parseId(raw: string | undefined): number | null {
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) return null;
  return Number(raw);
}

/** Mensaje legible de un Error de JS o de un error de Postgrest (objeto plano). */
export function mensajeDeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return "Error inesperado";
}

/** Maps common Postgres error codes to an appropriate HTTP status. */
export function dbErrorStatus(error: { code?: string } | null): number {
  if (!error) return 500;
  if (error.code === "23505") return 409; // unique_violation
  if (error.code === "23503") return 400; // foreign_key_violation
  return 500;
}

/**
 * Limpia un término de búsqueda libre (un solo campo de texto en el
 * frontend) para usarlo dentro de un filtro `.or(...)` de PostgREST: quita
 * caracteres con significado especial en esa sintaxis (coma, paréntesis,
 * comillas, backslash) y escapa los comodines de ILIKE (%, _) para que se
 * busquen como texto literal, no como wildcard.
 */
export function sanitizarBusqueda(valor: string): string {
  return valor
    .trim()
    .replace(/[,()"\\]/g, "")
    .replace(/[%_]/g, "\\$&");
}

/**
 * Arma la parte derecha de un `.or(...)` de PostgREST: ILIKE parcial de
 * `termino` (ya sanitizado con sanitizarBusqueda) contra cada columna dada.
 */
export function busquedaIlikeOr(
  termino: string,
  columnas: readonly string[],
): string {
  return columnas.map((columna) => `${columna}.ilike.%${termino}%`).join(",");
}

/**
 * Splits the request path into [basePath, idSegment] relative to the
 * function's own name, e.g. for a request to
 * `/functions/v1/anios-lectivos/5` with functionName "anios-lectivos",
 * returns ["anios-lectivos", "5"].
 */
export function splitPath(url: URL, functionName: string): string[] {
  const parts = url.pathname.split("/").filter(Boolean);
  const idx = parts.indexOf(functionName);
  return idx === -1 ? parts : parts.slice(idx + 1);
}
