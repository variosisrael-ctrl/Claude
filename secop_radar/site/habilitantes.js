/* Radar SECOP II: verificación de requisitos habilitantes y tarjeta de decisión (ofertar o no).
 *
 * Funciona en el navegador (define `Habilitantes` global) y en Node (module.exports). Es lógica pura y determinista:
 * compara los umbrales del pliego, ya validados por una persona, con los números del perfil de la empresa. No usa IA.
 * Es una ayuda para decidir, no un concepto jurídico: la entidad es quien verifica los requisitos.
 */
(function (raiz, fabrica) {
  if (typeof module === "object" && module.exports) module.exports = fabrica();
  else raiz.Habilitantes = fabrica();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Salario mínimo mensual legal vigente por año (COP). La experiencia se expresa en SMMLV del año en que terminó
  // cada contrato. Los decretos de cada diciembre fijan el valor del año siguiente: agrégalo aquí cuando salga.
  const SMMLV = {
    2010: 515000, 2011: 535600, 2012: 566700, 2013: 589500, 2014: 616000, 2015: 644350, 2016: 689455,
    2017: 737717, 2018: 781242, 2019: 828116, 2020: 877803, 2021: 908526, 2022: 1000000, 2023: 1160000,
    2024: 1300000, 2025: 1423500, 2026: 1750905,
  };
  const ULTIMO_ANIO_SMMLV = Math.max(...Object.keys(SMMLV).map(Number));

  const INDICADORES_FINANCIEROS = [
    ["liquidez", "Índice de liquidez", "veces", "Activo corriente ÷ pasivo corriente"],
    ["endeudamiento", "Nivel de endeudamiento", "%", "Pasivo total ÷ activo total × 100"],
    ["cobertura_intereses", "Razón de cobertura de intereses", "veces", "Utilidad operacional ÷ gastos de intereses"],
    ["rentabilidad_patrimonio", "Rentabilidad del patrimonio", "%", "Utilidad operacional ÷ patrimonio × 100"],
    ["rentabilidad_activo", "Rentabilidad del activo", "%", "Utilidad operacional ÷ activo total × 100"],
    ["capital_trabajo", "Capital de trabajo", "COP", "Activo corriente − pasivo corriente"],
    ["patrimonio", "Patrimonio", "COP", "Activo total − pasivo total"],
  ];
  const EN_PESOS = ["capital_trabajo", "patrimonio"];

  const formatoNumero = new Intl.NumberFormat("es-CO", { maximumFractionDigits: 2 });
  const cifra = (valor) => formatoNumero.format(valor);
  const pesos = (valor) => `$ ${Math.round(valor).toLocaleString("es-CO")}`;

  // --- Perfil estructurado de la empresa ---------------------------------------

  const numero = (valor) => {
    if (valor === "" || valor === null || valor === undefined) return null;
    const n = typeof valor === "number" ? valor : Number(String(valor).replace(",", "."));
    return Number.isFinite(n) ? n : null;
  };
  const texto = (valor, maximo) => (typeof valor === "string" ? valor.trim().slice(0, maximo) : "");
  const codigosDe = (valor) =>
    String(Array.isArray(valor) ? valor.join(",") : valor ?? "")
      .split(/[\s,;]+/).map((c) => c.replace(/\D/g, "")).filter((c) => c.length >= 4 && c.length <= 8).slice(0, 30);

  function normalizarContrato(crudo, indice) {
    const c = crudo && typeof crudo === "object" ? crudo : {};
    const valor = numero(c.valor);
    const anio = numero(c.anio);
    const participacion = numero(c.participacion);
    return {
      id: typeof c.id === "string" && /^[\w-]{1,40}$/.test(c.id) ? c.id : `c${indice}`,
      entidad: texto(c.entidad, 200),
      objeto: texto(c.objeto, 400),
      codigos: codigosDe(c.codigos),
      valor: valor !== null && valor > 0 ? valor : null,
      anio: anio !== null && Number.isInteger(anio) && anio >= 1990 && anio <= 2100 ? anio : null,
      // Parte del contrato que ejecutó la empresa cuando fue en consorcio o unión temporal.
      participacion: participacion !== null && participacion > 0 && participacion <= 100 ? participacion : 100,
    };
  }

  function normalizarEmpresa(crudo) {
    const e = crudo && typeof crudo === "object" ? crudo : {};
    const indicadores = e.indicadores && typeof e.indicadores === "object" ? e.indicadores : {};
    return {
      corte: texto(e.corte, 40),
      indicadores: Object.fromEntries(INDICADORES_FINANCIEROS.map(([clave]) => [clave, numero(indicadores[clave])])),
      // Sin gastos de intereses la cobertura es indeterminada y, por regla general, se cumple el requisito.
      sin_intereses: e.sin_intereses === true,
      experiencia: (Array.isArray(e.experiencia) ? e.experiencia.slice(0, 200) : []).map(normalizarContrato),
    };
  }

  /** Valor de un contrato en SMMLV del año en que terminó, por la parte que ejecutó la empresa. */
  function contratoEnSMMLV(contrato) {
    const salario = SMMLV[contrato.anio];
    if (!salario || !contrato.valor) return null;
    return (contrato.valor * contrato.participacion) / 100 / salario;
  }

  // --- Cruce de un requisito con la empresa -------------------------------------

  const comparar = (valor, operador, umbral) => (operador === "<=" ? valor <= umbral : valor >= umbral);
  const resultado = (estado, detalle, brecha = "") => ({ estado, detalle, brecha });

  /** Año del SMMLV con que se convierten los umbrales del pliego: el vigente, o el último de la tabla. */
  const salarioVigente = (anio) => SMMLV[anio] || SMMLV[ULTIMO_ANIO_SMMLV];

  function umbralEnPesos(requisito, contexto) {
    if (requisito.unidad === "cop") return requisito.valor;
    if (requisito.unidad === "smmlv") return requisito.valor * salarioVigente(contexto.anio);
    if (requisito.unidad === "porcentaje_presupuesto") {
      return contexto.presupuesto > 0 ? (requisito.valor / 100) * contexto.presupuesto : null;
    }
    return null;
  }

  function evaluarFinanciero(requisito, empresa, contexto) {
    const [, nombre, unidad] = INDICADORES_FINANCIEROS.find(([clave]) => clave === requisito.indicador);
    if (requisito.indicador === "cobertura_intereses" && empresa.sin_intereses) {
      return resultado("cumple", "La empresa no tiene gastos de intereses: la cobertura es indeterminada y cumple.");
    }
    const propio = empresa.indicadores[requisito.indicador];
    if (propio === null) {
      return resultado("falta_dato", `Falta el dato «${nombre}» en el perfil de la empresa.`);
    }

    let umbral = requisito.valor;
    if (EN_PESOS.includes(requisito.indicador)) {
      umbral = umbralEnPesos(requisito, contexto);
      if (umbral === null) {
        return resultado("falta_dato", requisito.unidad === "porcentaje_presupuesto"
          ? "El proceso no informa el presupuesto oficial: calcula el umbral en pesos y corrígelo."
          : "El umbral de este requisito debe estar en pesos, en SMMLV o como porcentaje del presupuesto: corrígelo.");
      }
    }
    const mostrar = (valor) => (unidad === "COP" ? pesos(valor) : `${cifra(valor)}${unidad === "%" ? " %" : ""}`);
    const frase = `${nombre}: la empresa tiene ${mostrar(propio)} y el pliego pide ${requisito.operador === "<=" ? "máximo" : "mínimo"} ${mostrar(umbral)}.`;
    if (comparar(propio, requisito.operador, umbral)) return resultado("cumple", frase);
    return resultado("no_cumple", frase, `${requisito.operador === "<=" ? "Sobra" : "Falta"} ${mostrar(Math.abs(umbral - propio))}.`);
  }

  /** Dos códigos coinciden si comparten la clase UNSPSC (los primeros 6 dígitos; 4 si alguno es más corto). */
  function mismoCodigo(a, b) {
    const largo = Math.min(6, a.length, b.length);
    return a.slice(0, largo) === b.slice(0, largo);
  }

  function evaluarExperiencia(requisito, empresa, contexto) {
    let umbral = null;
    if (requisito.unidad === "smmlv") umbral = requisito.valor;
    else if (requisito.unidad === "cop") umbral = requisito.valor / salarioVigente(contexto.anio);
    else if (requisito.unidad === "porcentaje_presupuesto" && contexto.presupuesto > 0) {
      umbral = ((requisito.valor / 100) * contexto.presupuesto) / salarioVigente(contexto.anio);
    }
    if (umbral === null) {
      return resultado("falta_dato", "El umbral de experiencia debe estar en SMMLV, en pesos o como porcentaje del presupuesto oficial (y el proceso debe informar ese presupuesto).");
    }
    if (!empresa.experiencia.length) {
      return resultado("falta_dato", "Agrega los contratos ejecutados en el perfil de la empresa.");
    }

    const delObjeto = requisito.codigos.length
      ? empresa.experiencia.filter((c) => c.codigos.some((propio) => requisito.codigos.some((pedido) => mismoCodigo(propio, pedido))))
      : empresa.experiencia;
    const valorados = delObjeto.map(contratoEnSMMLV).filter((v) => v !== null).sort((a, b) => b - a);
    const sinValor = delObjeto.length - valorados.length;
    const usados = requisito.max_contratos ? valorados.slice(0, requisito.max_contratos) : valorados;
    const total = usados.reduce((suma, v) => suma + v, 0);

    const alcance = [
      requisito.codigos.length ? `en los códigos ${requisito.codigos.join(", ")}` : "en cualquier código",
      `contando ${plural(usados.length, "contrato", "contratos")}${requisito.max_contratos ? ` (los de mayor valor; máximo ${requisito.max_contratos})` : ""}`,
    ].join(", ");
    const frase = `Experiencia: la empresa suma ${cifra(total)} SMMLV ${alcance} y el pliego pide ${cifra(umbral)} SMMLV.` +
      (sinValor ? ` ${sinValor} contrato${sinValor === 1 ? "" : "s"} no se contó por no tener valor o año de terminación con SMMLV conocido.` : "") +
      (requisito.codigos.length ? " Se cuenta un contrato si está clasificado en al menos uno de los códigos: confirma en el pliego si exige todos." : "");
    if (total >= umbral) return resultado("cumple", frase);
    return resultado("no_cumple", frase, `Faltan ${cifra(umbral - total)} SMMLV.`);
  }

  /**
   * Estado de un requisito: cumple, no_cumple, falta_dato o manual (pendiente de que una persona lo marque).
   * `contexto`: { presupuesto, anio } del proceso.
   */
  function evaluarRequisito(requisito, empresa, contexto = {}) {
    if (requisito.indicador === "ninguno" || requisito.valor === null) {
      if (requisito.manual === "cumple") return resultado("cumple", "Marcado como cumplido por la persona que revisó.");
      if (requisito.manual === "no_cumple") return resultado("no_cumple", "Marcado como no cumplido por la persona que revisó.");
      return resultado("manual", "Se revisa a mano: indica si la empresa lo cumple.");
    }
    if (requisito.indicador === "experiencia") return evaluarExperiencia(requisito, empresa, contexto);
    return evaluarFinanciero(requisito, empresa, contexto);
  }

  /**
   * Evalúa todos los requisitos habilitantes. Los que dan puntaje no habilitan ni inhabilitan, y los que nadie ha
   * validado contra el pliego no se evalúan: se cuentan aparte.
   */
  function evaluarHabilitantes(requisitos, empresaCruda, contexto = {}) {
    const empresa = normalizarEmpresa(empresaCruda);
    const conteo = { cumple: 0, no_cumple: 0, falta_dato: 0, manual: 0, sin_validar: 0, ponderables: 0 };
    const porRequisito = new Map();
    for (const requisito of requisitos) {
      if (requisito.tipo === "ponderable") {
        conteo.ponderables++;
      } else if (!requisito.validado) {
        conteo.sin_validar++;
      } else {
        const evaluado = evaluarRequisito(requisito, empresa, contexto);
        porRequisito.set(requisito.id, evaluado);
        conteo[evaluado.estado]++;
      }
    }
    return { conteo, porRequisito, evaluados: porRequisito.size };
  }

  // --- Tarjeta de decisión ------------------------------------------------------

  const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;

  const RECOMENDACIONES = {
    sin_datos: "Aún no se puede recomendar",
    no_ofertar: "No conviene ofertar así",
    revisar: "Falta revisar antes de decidir",
    ofertar: "Se puede ofertar",
  };

  /**
   * Reúne lo que se sabe del proceso en una recomendación explicable. No es una probabilidad de ganar: solo dice si
   * hay algo que impide ofertar o que falta revisar. La decisión la toma y la registra una persona.
   * `dificultad` es el resultado de Analisis.indiceDificultad (o null) y `diasAlCierre`, los días que faltan.
   */
  function tarjetaDecision({ habilitacion, dificultad = null, diasAlCierre = null, hitos = [] }) {
    const factores = [];
    const c = habilitacion.conteo;

    if (!habilitacion.evaluados) {
      factores.push({
        clave: "habilitacion", estado: "sin_datos", titulo: "Requisitos habilitantes",
        detalle: c.sin_validar
          ? `Hay ${plural(c.sin_validar, "requisito", "requisitos")} sin validar contra el pliego. Valídalos para poder evaluarlos.`
          : "Todavía no hay requisitos. Analiza el pliego y extrae sus requisitos, o agrégalos a mano.",
      });
    } else if (c.no_cumple) {
      factores.push({
        clave: "habilitacion", estado: "malo", titulo: "Requisitos habilitantes",
        detalle: `La empresa no cumple ${plural(c.no_cumple, "requisito", "requisitos")} de ${habilitacion.evaluados}. ` +
          "Un habilitante que no se cumple lleva al rechazo de la oferta; mira si un consorcio o una unión temporal real cubre la brecha.",
      });
    } else if (c.falta_dato || c.manual || c.sin_validar) {
      const pendientes = [
        c.falta_dato && `${plural(c.falta_dato, "requisito", "requisitos")} sin dato de la empresa`,
        c.manual && `${plural(c.manual, "requisito", "requisitos")} por revisar a mano`,
        c.sin_validar && `${plural(c.sin_validar, "requisito", "requisitos")} sin validar contra el pliego`,
      ].filter(Boolean).join(", ");
      factores.push({ clave: "habilitacion", estado: "medio", titulo: "Requisitos habilitantes", detalle: `Pendiente: ${pendientes}.` });
    } else {
      factores.push({
        clave: "habilitacion", estado: "bueno", titulo: "Requisitos habilitantes",
        detalle: `La empresa cumple los ${plural(habilitacion.evaluados, "requisito validado", "requisitos validados")}.`,
      });
    }

    if (diasAlCierre === null) {
      factores.push({ clave: "plazo", estado: "sin_datos", titulo: "Plazo", detalle: "No se conoce la fecha de cierre. Confírmala en SECOP II." });
    } else if (diasAlCierre < 0) {
      factores.push({ clave: "plazo", estado: "malo", titulo: "Plazo", detalle: "La fecha de cierre ya pasó." });
    } else if (diasAlCierre <= 3) {
      factores.push({
        clave: "plazo", estado: "medio", titulo: "Plazo",
        detalle: `Quedan ${plural(diasAlCierre, "día", "días")} para el cierre: revisa si alcanzas a reunir los documentos y la garantía de seriedad.`,
      });
    } else {
      factores.push({ clave: "plazo", estado: "bueno", titulo: "Plazo", detalle: `Quedan ${diasAlCierre} días para el cierre.` });
    }

    const cierre = hitos.find((h) => h.tipo === "cierre");
    factores.push(cierre?.confirmado
      ? { clave: "cronograma", estado: "bueno", titulo: "Cronograma", detalle: `Cierre confirmado para el ${cierre.fecha}${cierre.hora ? ` a las ${cierre.hora}` : ""}.` }
      : { clave: "cronograma", estado: "medio", titulo: "Cronograma", detalle: "Falta confirmar en SECOP II la fecha y la hora exactas del cierre." });

    if (!dificultad || dificultad.puntaje === null || dificultad.puntaje === undefined) {
      factores.push({ clave: "competencia", estado: "sin_datos", titulo: "Competencia", detalle: "No hay historial suficiente para estimar la competencia." });
    } else {
      factores.push({
        clave: "competencia", estado: dificultad.nivel === "Alta" ? "medio" : "bueno", titulo: "Competencia",
        detalle: `Dificultad ${dificultad.nivel.toLowerCase()} (${dificultad.puntaje}/100) según el historial de adjudicaciones. No impide ofertar: indica cuánto cuidar el precio.`,
      });
    }

    const estadoDe = (clave) => factores.find((f) => f.clave === clave).estado;
    let recomendacion = "ofertar";
    if (estadoDe("habilitacion") === "malo" || estadoDe("plazo") === "malo") recomendacion = "no_ofertar";
    else if (estadoDe("habilitacion") === "sin_datos") recomendacion = "sin_datos";
    else if (["habilitacion", "plazo", "cronograma"].some((clave) => estadoDe(clave) !== "bueno")) recomendacion = "revisar";

    return { recomendacion, titulo: RECOMENDACIONES[recomendacion], factores };
  }

  return {
    SMMLV,
    ULTIMO_ANIO_SMMLV,
    INDICADORES_FINANCIEROS,
    RECOMENDACIONES,
    normalizarEmpresa,
    contratoEnSMMLV,
    evaluarRequisito,
    evaluarHabilitantes,
    tarjetaDecision,
  };
});
