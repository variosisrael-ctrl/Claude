# Radar SECOP II

App web local para encontrar oportunidades de contratación pública en Colombia, conocer a tu competencia y hacer seguimiento a los procesos a los que quieres ofertar. Usa los datos abiertos de SECOP II publicados en [datos.gov.co](https://www.datos.gov.co); no necesita cuenta ni instalar dependencias (solo Python 3; probada con 3.13).

## Cómo ejecutarla

```bash
python3 secop_radar/server.py
```

Abre <http://127.0.0.1:8000> (o el puerto de la variable `PORT`).

Opcional: si tienes un [app token de Socrata](https://dev.socrata.com/docs/app-tokens.html), expórtalo como `SOCRATA_APP_TOKEN` para tener límites de consulta más holgados.

## Qué hace

1. **Oportunidades.** Con tu perfil (palabras clave, códigos UNSPSC, departamento, rango de presupuesto, días de publicación) busca procesos abiertos y los ordena por coincidencia. Cada resultado explica por qué coincide y enlaza al proceso oficial.
2. **Mercado y competencia.** Para tu sector muestra qué entidades contratan más, qué proveedores ganan más contratos (agrupados por NIT o cédula) y qué modalidades se usan.
3. **Mi seguimiento.** Guarda procesos con su estado (por revisar, preparando oferta, ofertada, ganada…), notas y una lista de requisitos típicos de una oferta. Todo se guarda en tu navegador.

### Solo procesos competitivos

Viene activado por defecto. En contratación directa y régimen especial la entidad ya eligió a quién contratar, así que no es algo que se pueda ganar ofertando; en los datos son la gran mayoría de los registros. El filtro los excluye de las oportunidades y de la lista de competidores. La tabla de modalidades siempre muestra el mercado completo para que veas esa proporción.

### Cómo se calcula el porcentaje de coincidencia

| Criterio | Puntos |
| --- | --- |
| La categoría UNSPSC coincide con alguno de tus códigos | 40 |
| Cada palabra clave en el nombre del proceso (máx. 2) | 20 |
| Cada palabra clave solo en la descripción (máx. 2) | 10 |
| El presupuesto está dentro de tu rango (si lo definiste) | 20 |

El máximo es 100. Es una medida de relevancia para tu perfil, no una probabilidad de ganar.

## Limitaciones que debes conocer

- **No hay fecha de cierre.** El dataset abierto no la incluye. Confirma siempre el cronograma, los requisitos habilitantes y las adendas en el proceso oficial antes de ofertar.
- **El estado "Abierto" no es confiable en procesos viejos** (hay procesos de años atrás que siguen marcados así). Por eso la búsqueda también filtra por fecha de publicación.
- **Se puntúan los 500 procesos más recientes** que cumplen tu filtro y se muestran los 50 mejores. Si tu búsqueda es muy amplia, estrecha el perfil.
- **Las palabras clave se comparan tal como las escribes**, sin distinguir mayúsculas pero sí tildes: escribe "capacitación", no "capacitacion".
- **Algunos procesos no traen código UNSPSC**; se encuentran solo por palabras clave.
- **Valores de contratos con errores de digitación** (por ejemplo `104249364104249364`) vienen en la fuente. Se excluyen los mayores a 100 billones de COP, y los contratos sin NIT/cédula no cuentan como competidores.
- **El análisis de mercado es lento la primera vez** (20 segundos o más) porque recorre millones de contratos. Las consultas repetidas se guardan en memoria 10 minutos.
- La lista de requisitos de la oferta es una **plantilla general**; cada proceso tiene los suyos en el pliego de condiciones.

Esta herramienta ayuda a encontrar y priorizar oportunidades; no presenta ofertas ni garantiza adjudicaciones.

## Pruebas

```bash
python3 -m unittest discover -s secop_radar -v
```

Las pruebas no usan la red: simulan las respuestas de datos.gov.co.

## Estructura

- `secop.py`: validación de entradas, construcción de consultas SoQL, puntuación e inteligencia de mercado.
- `server.py`: servidor local (solo escucha en 127.0.0.1) con `/api/oportunidades` y `/api/mercado`.
- `static/`: interfaz (HTML, CSS y JavaScript sin dependencias ni paso de compilación).
