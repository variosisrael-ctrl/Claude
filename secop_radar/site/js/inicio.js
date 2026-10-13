"use strict";

// Arranque de la página: enciende cada pantalla, aplica el perfil (de un enlace o el guardado) y busca.

function iniciar() {
  Radar.iniciadores.forEach((iniciador) => iniciador());
  document.querySelectorAll(".pestanas button").forEach((boton) => {
    boton.addEventListener("click", () => mostrarPestana(boton.dataset.tab));
  });

  const desdeEnlace = perfilDesdeURL();
  const perfil = desdeEnlace ?? leer(CLAVE_PERFIL, {});
  aplicarPerfilAlFormulario({ ...PERFIL_VACIO, ...perfil });

  if (perfilTieneAlcance(perfil)) {
    buscarOportunidades();
  } else {
    $("#vista-oportunidades").innerHTML = mensaje(
      "Completa tu perfil a la izquierda (palabras clave y/o códigos UNSPSC) y pulsa “Buscar oportunidades”."
    );
  }
}

document.addEventListener("DOMContentLoaded", iniciar);
