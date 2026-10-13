/* Radar SECOP II: guarda y lee la configuración de alertas en un gist secreto de GitHub.
 *
 * Se usa desde el navegador (con el token de la persona, que solo necesita el permiso «gist») y desde el flujo de
 * alertas (que solo lee, con el token del propio flujo o sin token, porque un gist secreto lo puede leer quien tenga su
 * dirección). Un gist secreto no está cifrado: no aparece en buscadores ni en el perfil, pero lo ve quien tenga el enlace.
 *
 * Funciona en el navegador (define `Gist` global) y en Node. `fetchFn` y `base` se reemplazan en las pruebas.
 */
(function (raiz, fabrica) {
  if (typeof module === "object" && module.exports) module.exports = fabrica();
  else raiz.Gist = fabrica();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const BASE = "https://api.github.com";
  const ARCHIVO = "radar-alertas.json";
  const DESCRIPCION = "Radar SECOP II: configuración de alertas (no borrar)";
  const MS_TIMEOUT = 20_000;

  class ErrorDeGist extends Error {
    constructor(mensaje, estado = null) {
      super(mensaje);
      this.name = "ErrorDeGist";
      this.estado = estado;
    }
  }

  /** Explica en español lo que respondió GitHub, sin repetir el token ni el contenido enviado. */
  function mensajeDeEstado(estado, cuerpo, conToken) {
    if (estado === 401) return "GitHub no reconoce el token. Revisa que lo copiaste completo y que no haya vencido.";
    if (estado === 403 && /rate limit/i.test(cuerpo?.message || "")) {
      return "GitHub limitó las consultas por un momento. Espera unos minutos e inténtalo de nuevo.";
    }
    if (estado === 403) {
      return conToken
        ? "El token no tiene permiso para los gists. Al crearlo hay que marcar la casilla «gist»."
        : "GitHub no permitió leer el gist.";
    }
    if (estado === 404) return "No se encontró el gist. Puede que se haya borrado o que el token sea de otra cuenta.";
    if (estado === 422) return "GitHub rechazó el contenido de la configuración.";
    if (estado >= 500) return "GitHub tuvo un problema por su lado. Inténtalo de nuevo en unos minutos.";
    return `GitHub respondió con el error ${estado}.`;
  }

  /** Avisa si el token es de un tipo que no sirve (los «fine-grained» no pueden usar gists). */
  function problemaDelToken(token) {
    const limpio = String(token ?? "").trim();
    if (!limpio) return "Pega el token de GitHub.";
    if (/\s/.test(limpio)) return "El token no debe tener espacios ni saltos de línea.";
    if (limpio.startsWith("github_pat_")) {
      return "Este token es de tipo «fine-grained», que no puede usar gists. Crea uno «classic» con el permiso «gist».";
    }
    return null;
  }

  function crearClienteGist({ token = null, fetchFn = (...a) => globalThis.fetch(...a), base = BASE } = {}) {
    const limpio = token ? String(token).trim() : null;

    async function pedir(ruta, { metodo = "GET", cuerpo, sinToken = false } = {}) {
      const usaToken = Boolean(limpio) && !sinToken;
      const cabeceras = { accept: "application/vnd.github+json" };
      if (usaToken) cabeceras.authorization = `Bearer ${limpio}`;
      if (cuerpo !== undefined) cabeceras["content-type"] = "application/json";

      const controlador = new AbortController();
      const temporizador = setTimeout(() => controlador.abort(), MS_TIMEOUT);
      let respuesta;
      try {
        respuesta = await fetchFn(`${base}${ruta}`, {
          method: metodo, headers: cabeceras, signal: controlador.signal,
          ...(cuerpo !== undefined ? { body: JSON.stringify(cuerpo) } : {}),
        });
      } catch {
        throw new ErrorDeGist("No se pudo conectar con GitHub. Revisa tu conexión e inténtalo de nuevo.");
      } finally {
        clearTimeout(temporizador);
      }
      const datos = await respuesta.json().catch(() => ({}));
      if (!respuesta.ok) throw new ErrorDeGist(mensajeDeEstado(respuesta.status, datos, usaToken), respuesta.status);
      return { datos, respuesta };
    }

    return {
      /** Comprueba el token y devuelve el usuario. Si GitHub informa los permisos y falta «gist», lo dice. */
      async verificar() {
        const { datos, respuesta } = await pedir("/user");
        const permisos = respuesta.headers?.get?.("x-oauth-scopes");
        if (permisos && !permisos.split(",").map((p) => p.trim()).includes("gist")) {
          throw new ErrorDeGist("El token no tiene el permiso «gist». Créalo de nuevo marcando esa casilla.", 403);
        }
        return { usuario: datos.login ?? null };
      },

      /** Crea el gist secreto con la configuración y devuelve su identificador. */
      async crear(contenido) {
        const { datos } = await pedir("/gists", {
          metodo: "POST",
          cuerpo: { description: DESCRIPCION, public: false, files: { [ARCHIVO]: { content: contenido } } },
        });
        if (!datos.id) throw new ErrorDeGist("GitHub no devolvió el identificador del gist.");
        return { id: datos.id };
      },

      /** Lee el contenido del archivo de alertas. Con token, si GitHub lo rechaza se reintenta sin token. */
      async leer(id) {
        if (!/^[a-f0-9]{8,64}$/i.test(String(id ?? ""))) throw new ErrorDeGist("El identificador del gist no es válido.");
        let resultado;
        try {
          resultado = await pedir(`/gists/${id}`);
        } catch (error) {
          if (limpio && (error.estado === 401 || error.estado === 403)) resultado = await pedir(`/gists/${id}`, { sinToken: true });
          else throw error;
        }
        const archivo = resultado.datos.files?.[ARCHIVO];
        if (!archivo) throw new ErrorDeGist("El gist no tiene el archivo de alertas.");
        if (archivo.truncated) throw new ErrorDeGist("La configuración de alertas es demasiado grande.");
        return archivo.content ?? "";
      },

      /** Reemplaza el contenido del archivo de alertas. */
      async guardar(id, contenido) {
        if (!/^[a-f0-9]{8,64}$/i.test(String(id ?? ""))) throw new ErrorDeGist("El identificador del gist no es válido.");
        await pedir(`/gists/${id}`, { metodo: "PATCH", cuerpo: { files: { [ARCHIVO]: { content: contenido } } } });
      },
    };
  }

  return { BASE, ARCHIVO, ErrorDeGist, crearClienteGist, problemaDelToken, mensajeDeEstado };
});
