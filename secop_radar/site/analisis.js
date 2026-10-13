/* Radar SECOP II: análisis puro (sin red ni DOM) de competencia, dificultad, privacidad y exportación.
 *
 * Funciona en el navegador (define `Analisis` global) y en Node (module.exports).
 * Los umbrales del índice de dificultad son heurísticos y están a la vista: no son una probabilidad de ganar.
 */
(function (raiz, fabrica) {
  if (typeof module === "object" && module.exports) module.exports = fabrica();
  else raiz.Analisis = fabrica();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /** Con menos procesos que esto, la estadística de una entidad no es confiable y se pasa al nivel nacional. */
  const MIN_PROCESOS = 5;
  const MAX_GANADORES = 8;

  // --- Estadística básica -----------------------------------------------------

  function mediana(valores) {
    if (!valores.length) return null;
    const orden = [...valores].sort((a, b) => a - b);
    const mitad = Math.floor(orden.length / 2);
    return orden.length % 2 ? orden[mitad] : (orden[mitad - 1] + orden[mitad]) / 2;
  }

  const promedio = (valores) => (valores.length ? valores.reduce((a, b) => a + b, 0) / valores.length : null);

  /** Fracción del presupuesto que se "ahorró" la entidad (0 a 1). Sin descuento si se adjudicó por encima. */
  function descuento(presupuesto, adjudicado) {
    if (!(presupuesto > 0) || !(adjudicado > 0)) return null;
    return Math.min(1, Math.max(0, 1 - adjudicado / presupuesto));
  }

  const porcentaje = (fraccion) => `${Math.round(fraccion * 100)} %`;

  const normalizarNombre = (nombre) => String(nombre || "").toUpperCase().replace(/[.,]/g, "").replace(/\s+/g, " ").trim();

  // --- Competencia histórica --------------------------------------------------

  /**
   * Resume quién compite y cómo se adjudica. `raw` es lo que devuelve Secop.competenciaHistorica:
   *   entidad.procesos: [{id, presupuesto, valor_adjudicado, nit_ganador, ganador}]
   *   entidad.proponentes: [{id, nit, nombre}]  (quiénes se presentaron a cada proceso)
   *   pais: null | {ganadores: [{nit, nombre, ganados, valor}], totales: {n, adjudicado, base}}
   */
  function resumirCompetencia(raw) {
    const procesos = raw.entidad.procesos;
    if (procesos.length >= MIN_PROCESOS || !raw.pais) return resumirEntidad(raw, procesos);
    return resumirPais(raw, procesos);
  }

  function resumirEntidad(raw, procesos) {
    const porProceso = new Map();
    const participaciones = new Map();
    for (const p of raw.entidad.proponentes) {
      const clave = p.nit || p.nombre;
      if (!clave) continue;
      if (!porProceso.has(p.id)) porProceso.set(p.id, new Set());
      porProceso.get(p.id).add(clave);
    }
    for (const proveedores of porProceso.values()) {
      for (const clave of proveedores) participaciones.set(clave, (participaciones.get(clave) || 0) + 1);
    }

    const conteos = procesos.map((p) => porProceso.get(p.id)?.size || 0).filter((n) => n > 0);
    const oferentes = conteos.length
      ? {
          con_datos: conteos.length,
          mediana: mediana(conteos),
          uno_solo: conteos.filter((n) => n === 1).length / conteos.length,
          cuatro_o_mas: conteos.filter((n) => n >= 4).length / conteos.length,
        }
      : null;

    // Hay procesos sin NIT del ganador ("No Definido"); la lista de proponentes sí lo trae, así que se cruza por nombre.
    const nitPorNombre = new Map();
    for (const p of raw.entidad.proponentes) {
      if (p.nit && p.nombre) nitPorNombre.set(normalizarNombre(p.nombre), p.nit);
    }
    const victorias = new Map();
    for (const p of procesos) {
      const nit = p.nit_ganador || nitPorNombre.get(normalizarNombre(p.ganador)) || null;
      const clave = nit || p.ganador;
      if (!clave) continue;
      const actual = victorias.get(clave) || { nit, nombre: p.ganador, ganados: 0, valor: 0 };
      actual.ganados += 1;
      actual.valor += p.valor_adjudicado || 0;
      victorias.set(clave, actual);
    }
    const conGanador = [...victorias.values()].reduce((suma, g) => suma + g.ganados, 0);
    const ganadores = [...victorias.values()]
      .sort((a, b) => b.ganados - a.ganados || b.valor - a.valor)
      .slice(0, MAX_GANADORES)
      .map((g) => ({
        ...g,
        participaciones: Math.max(participaciones.get(g.nit || g.nombre) || 0, g.ganados),
      }));

    const descuentos = procesos.map((p) => descuento(p.presupuesto, p.valor_adjudicado)).filter((d) => d !== null);
    return {
      alcance: procesos.length ? "entidad" : "sin_datos",
      n_procesos: procesos.length,
      clase: raw.clase,
      oferentes,
      ganadores,
      concentracion: conGanador && ganadores.length ? { fraccion: ganadores[0].ganados / conGanador, de: conGanador } : null,
      descuento: descuentos.length
        ? { n: descuentos.length, mediano: mediana(descuentos), promedio: promedio(descuentos) }
        : null,
    };
  }

  function resumirPais(raw) {
    const { ganadores, totales } = raw.pais;
    const total = totales.n;
    const dto = descuento(totales.base, totales.adjudicado);
    return {
      alcance: total ? "pais" : "sin_datos",
      n_procesos: total,
      n_entidad: raw.entidad.procesos.length,
      clase: raw.clase,
      oferentes: null,
      ganadores: ganadores.slice(0, MAX_GANADORES).map((g) => ({ ...g, participaciones: null })),
      concentracion: total && ganadores.length ? { fraccion: ganadores[0].ganados / total, de: total } : null,
      descuento: dto === null ? null : { n: total, mediano: null, promedio: dto },
    };
  }

  // --- Índice de dificultad ---------------------------------------------------

  const NIVELES = [
    { hasta: 35, nombre: "Baja" },
    { hasta: 60, nombre: "Media" },
    { hasta: 101, nombre: "Alta" },
  ];

  /** Heurística explicable, 0 (fácil) a 100 (difícil). Cada factor muestra por qué puntúa lo que puntúa. */
  function indiceDificultad(resumen) {
    const factores = [];

    if (resumen.oferentes) {
      const m = resumen.oferentes.mediana;
      const puntos = m <= 1 ? 15 : m <= 2 ? 35 : m <= 3 ? 55 : m <= 5 ? 75 : 90;
      factores.push({
        clave: "oferentes", peso: 0.4, puntos,
        titulo: "Oferentes por proceso",
        detalle: `Mediana de ${m} oferente${m === 1 ? "" : "s"}; ${porcentaje(resumen.oferentes.uno_solo)} de los procesos tuvo un solo oferente.`,
      });
    }

    if (resumen.concentracion && resumen.concentracion.de >= MIN_PROCESOS) {
      const f = resumen.concentracion.fraccion;
      const puntos = f >= 0.6 ? 90 : f >= 0.4 ? 70 : f >= 0.25 ? 45 : 20;
      const g = resumen.ganadores[0];
      const nacional = resumen.alcance === "pais";
      factores.push({
        clave: "concentracion", peso: 0.35, puntos,
        titulo: nacional ? "Concentración del mercado (nacional)" : "Ganador recurrente en la entidad",
        detalle:
          `${nacional ? "En todo el país, el proveedor que más ganó acumula" : "El ganador más frecuente ganó"} ` +
          `${g.ganados} de ${resumen.concentracion.de} procesos (${porcentaje(f)}).`,
      });
    }

    if (resumen.descuento) {
      const d = resumen.descuento.mediano ?? resumen.descuento.promedio;
      const puntos = d >= 0.3 ? 85 : d >= 0.15 ? 65 : d >= 0.05 ? 40 : 20;
      factores.push({
        clave: "precio", peso: 0.25, puntos,
        titulo: "Competencia por precio",
        detalle: `Se adjudica con un descuento ${resumen.descuento.mediano === null ? "promedio" : "mediano"} de ${porcentaje(d)} sobre el presupuesto.`,
      });
    }

    const pesoTotal = factores.reduce((suma, f) => suma + f.peso, 0);
    if (resumen.n_procesos < MIN_PROCESOS || factores.length < 2) {
      return { puntaje: null, nivel: "Sin datos suficientes", factores, pesoTotal };
    }
    const puntaje = Math.round(factores.reduce((suma, f) => suma + f.puntos * f.peso, 0) / pesoTotal);
    return { puntaje, nivel: NIVELES.find((n) => puntaje < n.hasta).nombre, factores, pesoTotal, factores_de: 3 };
  }

  // --- Adjudicados y ejecución ------------------------------------------------

  /** Estadísticas de una lista de procesos adjudicados (con `contrato` opcional). */
  function resumirAdjudicados(lista) {
    const descuentos = lista.map((o) => descuento(o.presupuesto, o.valor_adjudicado)).filter((d) => d !== null);
    const conContrato = lista.filter((o) => o.contrato);
    const estados = {};
    for (const o of conContrato) estados[o.contrato.estado] = (estados[o.contrato.estado] || 0) + 1;
    return {
      n: lista.length,
      valor_adjudicado: lista.reduce((suma, o) => suma + (o.valor_adjudicado || 0), 0),
      descuento_mediano: mediana(descuentos),
      con_contrato: conContrato.length,
      estados,
    };
  }

  // --- Privacidad -------------------------------------------------------------

  // Nombres que indican persona jurídica. Si no aparece ninguno se asume persona natural y se oculta la cédula.
  const FORMAS_JURIDICAS = new RegExp(
    "\\b(S\\.?\\s?A\\.?\\s?S\\.?|S\\.?\\s?A\\.?|LTDA\\.?|LIMITADA|E\\.?\\s?U\\.?|S\\.?\\s?C\\.?\\s?A\\.?|CIA\\.?|COMPA[ÑN][IÍ]A|" +
      "COOPERATIVA|COOP\\.?|FUNDACI[OÓ]N|CORPORACI[OÓ]N|ASOCIACI[OÓ]N|UNIVERSIDAD|INSTITUTO|INSTITUCI[OÓ]N|CONSORCIO|" +
      "UNI[OÓ]N TEMPORAL|SOCIEDAD|EMPRESA|FEDERACI[OÓ]N|CAJA|FONDO|E\\.?\\s?S\\.?\\s?E\\.?|INC\\.?|LLC|CORP\\.?|GRUPO|" +
      "SERVICIOS|SOLUCIONES|INGENIER[IÍ]A|CONSTRUCCIONES|SUMINISTROS|TECNOLOG[IÍ]A|COLOMBIA)\\b",
    "i"
  );

  // Los NIT de empresas tienen 9 dígitos y empiezan por 8 o 9. Las cédulas llegan a unos 99 millones (8 dígitos)
  // o ya tienen 10 dígitos, así que un número de 9 dígitos que empieza por 8 o 9 no es una cédula.
  const PARECE_NIT_DE_EMPRESA = /^[89]\d{8}$/;

  /** Muestra el NIT de empresas y oculta la cédula de personas naturales (deja visibles solo 3 dígitos). */
  function enmascararDocumento(nombre, documento) {
    if (!documento) return "";
    const digitos = String(documento);
    if (FORMAS_JURIDICAS.test(nombre || "") || PARECE_NIT_DE_EMPRESA.test(digitos)) return digitos;
    return "•".repeat(Math.max(0, digitos.length - 3)) + digitos.slice(-3);
  }

  // --- Exportación ------------------------------------------------------------

  /** Número con coma decimal, como lo espera Excel en español. */
  const numeroCSV = (valor, decimales = 0) =>
    valor === null || valor === undefined || Number.isNaN(valor) ? "" : Number(valor).toFixed(decimales).replace(".", ",");

  /**
   * Genera un CSV que Excel abre bien en español: separador ";", fin de línea CRLF y BOM UTF-8 para las tildes.
   * `columnas`: [{encabezado, valor: (fila) => texto|número}]
   */
  function aCSV(columnas, filas) {
    const celda = (valor) => {
      const texto = valor === null || valor === undefined ? "" : String(valor);
      // Un texto que empieza con = + - @ se interpretaría como fórmula al abrirlo en Excel.
      const seguro = /^[=+\-@\t\r]/.test(texto) && Number.isNaN(Number(texto.replace(",", "."))) ? "'" + texto : texto;
      return /[";\r\n]/.test(seguro) ? '"' + seguro.replace(/"/g, '""') + '"' : seguro;
    };
    const lineas = [columnas.map((c) => celda(c.encabezado)).join(";")];
    for (const fila of filas) lineas.push(columnas.map((c) => celda(c.valor(fila))).join(";"));
    return "﻿" + lineas.join("\r\n") + "\r\n";
  }

  // --- Alertas -----------------------------------------------------------------

  /**
   * Texto JSON para el secreto ALERTAS_BUSQUEDAS de GitHub (ver alertas/README.md), a partir de las búsquedas
   * guardadas: [{nombre, perfil: {palabras, codigos, ...}}]. Va en una sola línea para que GitHub lo enmascare bien.
   */
  function aConfiguracionAlertas(busquedas) {
    return JSON.stringify(
      busquedas.map((b) => ({
        nombre: b.nombre,
        palabras: b.perfil.palabras || "",
        codigos: b.perfil.codigos || "",
        departamento: b.perfil.departamento || "",
        min: b.perfil.min || "",
        max: b.perfil.max || "",
        competitivos: b.perfil.competitivos === "0" ? "0" : "1",
        dias: "15",
        minimo: 40,
      }))
    );
  }

  return {
    MIN_PROCESOS,
    aConfiguracionAlertas,
    mediana,
    promedio,
    descuento,
    resumirCompetencia,
    indiceDificultad,
    resumirAdjudicados,
    enmascararDocumento,
    numeroCSV,
    aCSV,
  };
});
