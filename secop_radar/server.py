"""Servidor local del Radar SECOP II.

Sirve la interfaz de static/ y expone:
  GET /api/oportunidades  procesos abiertos que coinciden con tu perfil
  GET /api/mercado        entidades, proveedores y modalidades de contratos similares

Uso: python3 server.py   (abre http://127.0.0.1:8000, o el puerto de la variable PORT)
"""

import json
import os
import pathlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import secop

CARPETA_INTERFAZ = pathlib.Path(__file__).resolve().parent / "static"

RUTAS_API = {
    "/api/oportunidades": secop.buscar_oportunidades,
    "/api/mercado": secop.inteligencia_mercado,
}


class Manejador(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(CARPETA_INTERFAZ), **kwargs)

    def do_GET(self):
        ruta = urlparse(self.path)
        if not ruta.path.startswith("/api/"):
            return super().do_GET()

        funcion = RUTAS_API.get(ruta.path)
        if funcion is None:
            return self._enviar_json(404, {"error": "Ruta no encontrada."})
        parametros = {clave: valores[0] for clave, valores in parse_qs(ruta.query).items()}
        try:
            return self._enviar_json(200, funcion(parametros))
        except secop.ErrorDeValidacion as error:
            return self._enviar_json(400, {"error": str(error)})
        except secop.ErrorDeOrigen as error:
            return self._enviar_json(502, {"error": str(error)})

    def _enviar_json(self, estado, cuerpo):
        datos = json.dumps(cuerpo, ensure_ascii=False).encode("utf-8")
        self.send_response(estado)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(datos)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(datos)


def main():
    puerto = int(os.environ.get("PORT", "8000"))
    servidor = ThreadingHTTPServer(("127.0.0.1", puerto), Manejador)
    print(f"Radar SECOP en http://127.0.0.1:{puerto}  (Ctrl+C para detener)")
    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        servidor.server_close()


if __name__ == "__main__":
    main()
