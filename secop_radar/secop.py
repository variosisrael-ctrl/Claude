"""Radar SECOP II: consultas a datos abiertos, puntuación de oportunidades e inteligencia de mercado.

Solo usa la biblioteca estándar. Cada función pública recibe los parámetros de la URL
como diccionario de texto y devuelve datos listos para convertir en JSON.
"""

from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta

# Datasets abiertos de SECOP II publicados en datos.gov.co.
URL_PROCESOS = "https://www.datos.gov.co/resource/p6dx-8zbt.json"
URL_CONTRATOS = "https://www.datos.gov.co/resource/jbjy-vk9h.json"

# Valores de contrato por encima de este monto (COP) son errores de digitación en la fuente,
# por ejemplo 104249364104249364. Se excluyen del análisis de mercado.
VALOR_MAXIMO_PLAUSIBLE = 100_000_000_000_000

FILAS_A_PUNTUAR = 500
MAXIMO_OPORTUNIDADES = 50
MAXIMO_FILAS_MERCADO = 10
SEGUNDOS_CACHE = 600
SEGUNDOS_TIMEOUT = 30
SEGUNDOS_TIMEOUT_MERCADO = 90  # las agregaciones de contratos son lentas en datos.gov.co
MAXIMO_ENTRADAS_CACHE = 256

# Modalidades en las que la entidad ya eligió a quién contratar, o que no son compras a proveedores.
# Las variantes "(con ofertas)" sí reciben ofertas y por eso no se excluyen.
MODALIDADES_NO_COMPETITIVAS = (
    "Contratación directa",
    "Contratación régimen especial",
    "Solicitud de información a los Proveedores",
    "Subasta de prueba",
    "Enajenación de bienes con subasta",
    "Enajenación de bienes con sobre cerrado",
)

PATRON_CODIGO = re.compile(r"\d{4,8}")
PATRON_TEXTO = re.compile(r"[A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9 \-]{2,60}")

_cache: dict = {}


class ErrorDeValidacion(ValueError):
    """La petición del usuario no es válida."""


class ErrorDeOrigen(RuntimeError):
    """datos.gov.co no respondió como se esperaba."""


# --- Validación de parámetros -------------------------------------------------


def _texto_validado(texto: str | None) -> str:
    """Quita espacios sobrantes, pasa a mayúsculas y rechaza caracteres que alteren la consulta SoQL."""
    limpio = " ".join((texto or "").split()).upper()
    if limpio and not PATRON_TEXTO.fullmatch(limpio):
        raise ErrorDeValidacion(
            f"'{limpio}' no es válido. Usa entre 2 y 60 letras, números, espacios o guiones."
        )
    return limpio


def normalizar_codigos(texto: str | None) -> list[str]:
    """Acepta códigos completos (80111600), prefijos (8011) o con el prefijo V1. que usa SECOP."""
    codigos = []
    for parte in re.split(r"[,;\s]+", texto or ""):
        if not parte:
            continue
        digitos = re.sub(r"^V1\.", "", parte, flags=re.IGNORECASE)
        if not PATRON_CODIGO.fullmatch(digitos):
            raise ErrorDeValidacion(f"'{parte}' no es un código UNSPSC válido. Usa entre 4 y 8 dígitos.")
        codigos.append(digitos)
    return codigos[:10]


def normalizar_palabras(texto: str | None) -> list[str]:
    palabras = [_texto_validado(parte) for parte in (texto or "").split(",")]
    return [palabra for palabra in palabras if palabra][:10]


def _entero(valor, nombre: str, minimo: int, maximo: int, defecto: int | None = None) -> int | None:
    if valor in (None, ""):
        return defecto
    try:
        numero = int(valor)
    except ValueError:
        raise ErrorDeValidacion(f"{nombre} debe ser un número entero.") from None
    if not minimo <= numero <= maximo:
        raise ErrorDeValidacion(f"{nombre} debe estar entre {minimo} y {maximo}.")
    return numero


def parsear_perfil(params: dict) -> dict:
    """Valida los filtros del usuario. Lanza ErrorDeValidacion si algo no sirve."""
    perfil = {
        "palabras": normalizar_palabras(params.get("palabras")),
        "codigos": normalizar_codigos(params.get("codigos")),
        "departamento": _texto_validado(params.get("departamento")),
        "min": _entero(params.get("min"), "El presupuesto mínimo", 0, 10**15),
        "max": _entero(params.get("max"), "El presupuesto máximo", 0, 10**15),
        "dias": _entero(params.get("dias"), "Los días", 1, 365, defecto=30),
        "competitivos": params.get("competitivos") != "0",
    }
    if not perfil["palabras"] and not perfil["codigos"]:
        raise ErrorDeValidacion("Indica al menos una palabra clave o un código UNSPSC.")
    if perfil["min"] is not None and perfil["max"] is not None and perfil["min"] > perfil["max"]:
        raise ErrorDeValidacion("El presupuesto mínimo no puede ser mayor que el máximo.")
    return perfil


# --- Construcción de consultas SoQL -------------------------------------------


def _literal(texto: str) -> str:
    """Escribe un texto como literal SoQL entre comillas simples."""
    return "'" + texto.replace("'", "''") + "'"


def _condicion_codigos(codigos: list[str], columna: str) -> str:
    return " OR ".join(f"{columna} like {_literal('V1.' + codigo + '%')}" for codigo in codigos)


def _condicion_competitiva() -> str:
    excluidas = ",".join(_literal(modalidad) for modalidad in MODALIDADES_NO_COMPETITIVAS)
    return f"modalidad_de_contratacion not in ({excluidas})"


def clausula_oportunidades(perfil: dict, desde: datetime) -> str:
    condiciones = [
        "estado_de_apertura_del_proceso = 'Abierto'",
        # 'Abierto' no se actualiza en procesos viejos, por eso también filtramos por fecha de publicación.
        f"fecha_de_publicacion_del >= {_literal(desde.strftime('%Y-%m-%dT00:00:00'))}",
    ]
    alcance = []
    if perfil["codigos"]:
        alcance.append(_condicion_codigos(perfil["codigos"], "codigo_principal_de_categoria"))
    for palabra in perfil["palabras"]:
        patron = _literal(f"%{palabra}%")
        alcance.append(
            f"upper(nombre_del_procedimiento) like {patron} "
            f"OR upper(descripci_n_del_procedimiento) like {patron}"
        )
    condiciones.append("(" + " OR ".join(f"({parte})" for parte in alcance) + ")")

    if perfil["competitivos"]:
        condiciones.append(_condicion_competitiva())
    if perfil["min"] is not None:
        condiciones.append(f"precio_base >= {perfil['min']}")
    if perfil["max"] is not None:
        condiciones.append(f"precio_base <= {perfil['max']}")
    if perfil["departamento"]:
        patron_depto = _literal("%" + perfil["departamento"] + "%")
        condiciones.append(f"upper(departamento_entidad) like {patron_depto}")
    return " AND ".join(condiciones)


def clausula_mercado(perfil: dict, desde_anio: int, solo_competitivas: bool) -> str:
    condiciones = [
        f"valor_del_contrato < {VALOR_MAXIMO_PLAUSIBLE}",
        f"fecha_de_firma >= {_literal(str(desde_anio) + '-01-01T00:00:00')}",
    ]
    if solo_competitivas:
        condiciones.append(_condicion_competitiva())
    alcance = []
    if perfil["codigos"]:
        alcance.append(_condicion_codigos(perfil["codigos"], "codigo_de_categoria_principal"))
    for palabra in perfil["palabras"]:
        alcance.append(f"upper(descripcion_del_proceso) like {_literal('%' + palabra + '%')}")
    condiciones.append("(" + " OR ".join(f"({parte})" for parte in alcance) + ")")
    return " AND ".join(condiciones)


# --- Acceso a datos.gov.co ----------------------------------------------------


def _cabeceras() -> dict:
    cabeceras = {"Accept": "application/json", "User-Agent": "RadarSECOP/1.0"}
    token = os.environ.get("SOCRATA_APP_TOKEN")
    if token:
        cabeceras["X-App-Token"] = token
    return cabeceras


def _consultar(url: str, parametros: dict, timeout: int = SEGUNDOS_TIMEOUT) -> list[dict]:
    clave = (url, tuple(sorted(parametros.items())))
    ahora = time.monotonic()
    if clave in _cache and ahora - _cache[clave][0] < SEGUNDOS_CACHE:
        return _cache[clave][1]

    peticion = urllib.request.Request(
        f"{url}?{urllib.parse.urlencode(parametros)}", headers=_cabeceras()
    )
    try:
        with urllib.request.urlopen(peticion, timeout=timeout) as respuesta:
            datos = json.loads(respuesta.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raise ErrorDeOrigen(
            f"datos.gov.co respondió con error {error.code}. Inténtalo de nuevo más tarde."
        ) from error
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
        raise ErrorDeOrigen(
            "No fue posible consultar datos.gov.co. Verifica tu conexión e inténtalo de nuevo."
        ) from error

    if len(_cache) >= MAXIMO_ENTRADAS_CACHE:
        _cache.clear()
    _cache[clave] = (ahora, datos)
    return datos


# --- Normalización ------------------------------------------------------------


def _numero(valor) -> float | None:
    try:
        return float(valor)
    except (TypeError, ValueError):
        return None


def _conteo(valor) -> int:
    return int(_numero(valor) or 0)


def _url_proceso(valor) -> str | None:
    # La fuente entrega 'urlproceso' como objeto {"url": ...}. Solo aceptamos enlaces https.
    url = valor.get("url") if isinstance(valor, dict) else valor
    return url if isinstance(url, str) and url.startswith("https://") else None


def normalizar_proceso(fila: dict) -> dict:
    return {
        "id": fila.get("id_del_proceso"),
        "referencia": fila.get("referencia_del_proceso"),
        "nombre": fila.get("nombre_del_procedimiento") or "",
        "descripcion": fila.get("descripci_n_del_procedimiento") or "",
        "entidad": fila.get("entidad"),
        "ciudad": fila.get("ciudad_entidad"),
        "departamento": fila.get("departamento_entidad"),
        "publicado": (fila.get("fecha_de_publicacion_del") or "")[:10] or None,
        "presupuesto": _numero(fila.get("precio_base")),
        "modalidad": fila.get("modalidad_de_contratacion"),
        "categoria": fila.get("codigo_principal_de_categoria"),
        "url": _url_proceso(fila.get("urlproceso")),
    }


# --- Puntuación ---------------------------------------------------------------


def puntuar(oportunidad: dict, perfil: dict) -> tuple[int, list[str]]:
    """Devuelve un puntaje de 0 a 100 y las razones legibles que lo explican."""
    puntos = 0
    razones = []
    nombre = oportunidad["nombre"].upper()
    descripcion = oportunidad["descripcion"].upper()
    categoria = oportunidad["categoria"] or ""

    if any(categoria.startswith("V1." + codigo) for codigo in perfil["codigos"]):
        puntos += 40
        razones.append(f"Categoría {categoria} coincide con tus códigos UNSPSC")

    en_nombre = [palabra for palabra in perfil["palabras"] if palabra in nombre]
    en_descripcion = [
        palabra for palabra in perfil["palabras"] if palabra not in en_nombre and palabra in descripcion
    ]
    if en_nombre:
        puntos += min(40, 20 * len(en_nombre))
        razones.append("El nombre menciona: " + ", ".join(en_nombre).lower())
    if en_descripcion:
        puntos += min(20, 10 * len(en_descripcion))
        razones.append("La descripción menciona: " + ", ".join(en_descripcion).lower())

    presupuesto = oportunidad["presupuesto"]
    tiene_rango = perfil["min"] is not None or perfil["max"] is not None
    if tiene_rango and presupuesto is not None:
        dentro = (perfil["min"] is None or presupuesto >= perfil["min"]) and (
            perfil["max"] is None or presupuesto <= perfil["max"]
        )
        if dentro:
            puntos += 20
            razones.append("El presupuesto está dentro de tu rango")

    return min(puntos, 100), razones


# --- Casos de uso -------------------------------------------------------------


def buscar_oportunidades(params: dict) -> dict:
    perfil = parsear_perfil(params)
    desde = datetime.now() - timedelta(days=perfil["dias"])
    filas = _consultar(
        URL_PROCESOS,
        {
            "$where": clausula_oportunidades(perfil, desde),
            "$order": "fecha_de_publicacion_del DESC",
            "$limit": FILAS_A_PUNTUAR,
        },
    )

    vistos = set()
    resultados = []
    for fila in filas:
        oportunidad = normalizar_proceso(fila)
        if not oportunidad["id"] or oportunidad["id"] in vistos:
            continue
        vistos.add(oportunidad["id"])
        oportunidad["puntaje"], oportunidad["razones"] = puntuar(oportunidad, perfil)
        resultados.append(oportunidad)

    resultados.sort(key=lambda op: (op["puntaje"], op["publicado"] or ""), reverse=True)
    return {
        "filas_revisadas": len(filas),
        "desde": desde.date().isoformat(),
        "resultados": resultados[:MAXIMO_OPORTUNIDADES],
    }


def inteligencia_mercado(params: dict) -> dict:
    """Quién compra y quién gana contratos en las mismas categorías o palabras clave."""
    perfil = parsear_perfil(params)
    anio_actual = datetime.now().year
    desde_anio = _entero(params.get("desde"), "El año inicial", 2015, anio_actual, defecto=anio_actual - 3)
    base = {"$order": "contratos DESC", "$limit": MAXIMO_FILAS_MERCADO}
    donde_competitivo = clausula_mercado(perfil, desde_anio, solo_competitivas=perfil["competitivos"])
    # La mezcla de modalidades siempre se muestra completa para ver cuánto del mercado no es disputable.
    donde_completo = clausula_mercado(perfil, desde_anio, solo_competitivas=False)

    consultas = {
        "entidades": {
            **base, "$where": donde_competitivo,
            "$select": "nombre_entidad,count(*) as contratos,sum(valor_del_contrato) as valor",
            "$group": "nombre_entidad",
        },
        # Los contratos sin documento ('No Definido') agrupan proveedores distintos: no son un competidor real.
        "proveedores": {
            **base, "$where": f"{donde_competitivo} AND documento_proveedor != 'No Definido'",
            "$select": "documento_proveedor,max(proveedor_adjudicado) as nombre,"
                       "count(*) as contratos,sum(valor_del_contrato) as valor",
            "$group": "documento_proveedor",
        },
        "modalidades": {
            **base, "$where": donde_completo,
            "$select": "modalidad_de_contratacion,count(*) as contratos",
            "$group": "modalidad_de_contratacion",
        },
    }
    # Estas agregaciones recorren millones de contratos y tardan: en paralelo el tiempo es el de la más lenta.
    with ThreadPoolExecutor(max_workers=len(consultas)) as pool:
        futuros = {
            nombre: pool.submit(_consultar, URL_CONTRATOS, parametros, SEGUNDOS_TIMEOUT_MERCADO)
            for nombre, parametros in consultas.items()
        }
        entidades, proveedores, modalidades = (
            futuros[nombre].result() for nombre in ("entidades", "proveedores", "modalidades")
        )

    return {
        "desde": desde_anio,
        "competitivos": perfil["competitivos"],
        "entidades": [
            {"nombre": f.get("nombre_entidad"), "contratos": _conteo(f.get("contratos")),
             "valor": _numero(f.get("valor")) or 0}
            for f in entidades
        ],
        "proveedores": [
            {"nombre": f.get("nombre"), "documento": f.get("documento_proveedor"),
             "contratos": _conteo(f.get("contratos")), "valor": _numero(f.get("valor")) or 0}
            for f in proveedores
        ],
        "modalidades": [
            {"nombre": f.get("modalidad_de_contratacion"), "contratos": _conteo(f.get("contratos"))}
            for f in modalidades
        ],
    }
