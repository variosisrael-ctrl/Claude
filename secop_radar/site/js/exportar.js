"use strict";

// Descarga de listas como CSV (se abre directo en Excel; ver Analisis.aCSV).

function descargarArchivo(nombreCompleto, contenido, tipo) {
  const url = URL.createObjectURL(new Blob([contenido], { type: tipo }));
  const enlace = document.createElement("a");
  enlace.href = url;
  enlace.download = nombreCompleto;
  document.body.appendChild(enlace);
  enlace.click();
  enlace.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function descargarCSV(nombre, columnas, filas) {
  descargarArchivo(`${nombre}-${Secop.fechaIso(new Date())}.csv`, Analisis.aCSV(columnas, filas), "text/csv;charset=utf-8");
}

const cop = (valor) => Analisis.numeroCSV(valor, 0);
const descuentoDe = (p) => Analisis.descuento(p.presupuesto, p.valor_adjudicado);

const COLUMNAS_OPORTUNIDADES = [
  { encabezado: "Coincidencia (%)", valor: (p) => p.puntaje },
  { encabezado: "Proceso", valor: (p) => p.nombre },
  { encabezado: "Entidad", valor: (p) => p.entidad },
  { encabezado: "Ciudad", valor: (p) => p.ciudad },
  { encabezado: "Departamento", valor: (p) => p.departamento },
  { encabezado: "Modalidad", valor: (p) => p.modalidad },
  { encabezado: "Presupuesto (COP)", valor: (p) => cop(p.presupuesto) },
  { encabezado: "Publicado", valor: (p) => p.publicado },
  { encabezado: "Cierre de ofertas", valor: (p) => p.cierre },
  { encabezado: "Categoría UNSPSC", valor: (p) => categoriaLegible(p.categoria) },
  { encabezado: "Referencia", valor: (p) => p.referencia },
  { encabezado: "Enlace SECOP II", valor: (p) => p.url },
];

const COLUMNAS_ADJUDICADOS = [
  { encabezado: "Proceso", valor: (p) => p.nombre },
  { encabezado: "Entidad", valor: (p) => p.entidad },
  { encabezado: "Modalidad", valor: (p) => p.modalidad },
  { encabezado: "Fecha de adjudicación", valor: (p) => p.fecha_adjudicacion },
  { encabezado: "Ganador", valor: (p) => p.ganador },
  { encabezado: "Documento del ganador", valor: (p) => Analisis.enmascararDocumento(p.ganador, p.nit_ganador) },
  { encabezado: "Presupuesto (COP)", valor: (p) => cop(p.presupuesto) },
  { encabezado: "Valor adjudicado (COP)", valor: (p) => cop(p.valor_adjudicado) },
  { encabezado: "Descuento (%)", valor: (p) => Analisis.numeroCSV(descuentoDe(p) === null ? null : descuentoDe(p) * 100, 1) },
  { encabezado: "Estado del contrato", valor: (p) => p.contrato?.estado },
  { encabezado: "Valor del contrato (COP)", valor: (p) => cop(p.contrato?.valor) },
  { encabezado: "Pagado (COP)", valor: (p) => cop(p.contrato?.pagado) },
  { encabezado: "Fin del contrato", valor: (p) => p.contrato?.fin },
  { encabezado: "Días adicionados", valor: (p) => p.contrato?.dias_adicionados },
  { encabezado: "Enlace SECOP II", valor: (p) => p.url },
];

const COLUMNAS_SEGUIMIENTO = [
  { encabezado: "Proceso", valor: (s) => s.nombre },
  { encabezado: "Entidad", valor: (s) => s.entidad },
  { encabezado: "Referencia", valor: (s) => s.referencia },
  { encabezado: "Presupuesto (COP)", valor: (s) => cop(s.presupuesto) },
  { encabezado: "Cierre de ofertas", valor: (s) => s.cierre },
  { encabezado: "Estado", valor: (s) => s.estado },
  { encabezado: "Requisitos listos", valor: (s) => `${s.requisitos.filter(Boolean).length} de ${REQUISITOS.length}` },
  { encabezado: "Notas", valor: (s) => s.nota },
  { encabezado: "Enlace SECOP II", valor: (s) => s.url },
];
