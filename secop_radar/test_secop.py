import unittest
from datetime import datetime
from unittest import mock

import secop


class ValidacionTests(unittest.TestCase):
    def test_codigos_aceptan_completos_prefijos_y_formato_v1(self):
        self.assertEqual(
            secop.normalizar_codigos("V1.80111600, 8011 ; 7215"), ["80111600", "8011", "7215"]
        )

    def test_codigo_invalido_se_rechaza(self):
        for texto in ("80%", "123", "abcd", "123456789"):
            with self.subTest(texto=texto), self.assertRaises(secop.ErrorDeValidacion):
                secop.normalizar_codigos(texto)

    def test_palabras_se_limpian_y_conservan_tildes(self):
        self.assertEqual(
            secop.normalizar_palabras("  Mantenimiento , capacitación,"), ["MANTENIMIENTO", "CAPACITACIÓN"]
        )

    def test_palabras_con_caracteres_de_consulta_se_rechazan(self):
        for texto in ("x' OR 1=1 --", "50%", "a_b", "(select)"):
            with self.subTest(texto=texto), self.assertRaises(secop.ErrorDeValidacion):
                secop.normalizar_palabras(texto)

    def test_perfil_exige_palabras_o_codigos(self):
        with self.assertRaises(secop.ErrorDeValidacion):
            secop.parsear_perfil({"dias": "30"})

    def test_rango_de_presupuesto_debe_ser_coherente(self):
        with self.assertRaises(secop.ErrorDeValidacion):
            secop.parsear_perfil({"palabras": "software", "min": "5000000", "max": "1000000"})

    def test_dias_fuera_de_rango_o_no_numericos_se_rechazan(self):
        for dias in ("4000", "0", "abc"):
            with self.subTest(dias=dias), self.assertRaises(secop.ErrorDeValidacion):
                secop.parsear_perfil({"palabras": "software", "dias": dias})

    def test_dias_por_defecto_son_30(self):
        self.assertEqual(secop.parsear_perfil({"palabras": "software"})["dias"], 30)


class ClausulasTests(unittest.TestCase):
    def test_literal_duplica_comillas_simples(self):
        self.assertEqual(secop._literal("a'b"), "'a''b'")

    def test_clausula_oportunidades_filtra_estado_fecha_categoria_palabra_y_presupuesto(self):
        perfil = secop.parsear_perfil(
            {"codigos": "8011", "palabras": "mantenimiento", "min": "1000000", "max": "9000000",
             "departamento": "antioquia"}
        )
        clausula = secop.clausula_oportunidades(perfil, datetime(2026, 9, 13))
        self.assertIn("estado_de_apertura_del_proceso = 'Abierto'", clausula)
        self.assertIn("fecha_de_publicacion_del >= '2026-09-13T00:00:00'", clausula)
        self.assertIn("codigo_principal_de_categoria like 'V1.8011%'", clausula)
        self.assertIn("upper(nombre_del_procedimiento) like '%MANTENIMIENTO%'", clausula)
        self.assertIn("upper(descripci_n_del_procedimiento) like '%MANTENIMIENTO%'", clausula)
        self.assertIn("precio_base >= 1000000", clausula)
        self.assertIn("precio_base <= 9000000", clausula)
        self.assertIn("upper(departamento_entidad) like '%ANTIOQUIA%'", clausula)

    def test_clausula_mercado_excluye_valores_atipicos(self):
        perfil = secop.parsear_perfil({"codigos": "8011"})
        clausula = secop.clausula_mercado(perfil, 2023, solo_competitivas=False)
        self.assertIn(f"valor_del_contrato < {secop.VALOR_MAXIMO_PLAUSIBLE}", clausula)
        self.assertIn("fecha_de_firma >= '2023-01-01T00:00:00'", clausula)
        self.assertIn("codigo_de_categoria_principal like 'V1.8011%'", clausula)
        self.assertNotIn("not in", clausula)

    def test_filtro_competitivo_excluye_directa_pero_no_las_variantes_con_ofertas(self):
        perfil = secop.parsear_perfil({"codigos": "8011"})
        self.assertTrue(perfil["competitivos"])  # activado por defecto
        clausula = secop.clausula_oportunidades(perfil, datetime(2026, 9, 13))
        self.assertIn("modalidad_de_contratacion not in (", clausula)
        self.assertIn("'Contratación directa'", clausula)
        self.assertIn("'Contratación régimen especial'", clausula)
        self.assertNotIn("(con ofertas)", clausula)

    def test_filtro_competitivo_se_puede_desactivar(self):
        perfil = secop.parsear_perfil({"codigos": "8011", "competitivos": "0"})
        self.assertFalse(perfil["competitivos"])
        self.assertNotIn("not in", secop.clausula_oportunidades(perfil, datetime(2026, 9, 13)))


class NormalizarProcesoTests(unittest.TestCase):
    def test_url_acepta_objeto_o_texto_pero_solo_https(self):
        base = {"id_del_proceso": "CO1.REQ.1"}
        casos = [
            ({"url": "https://x.gov.co/a"}, "https://x.gov.co/a"),
            ("https://x.gov.co/b", "https://x.gov.co/b"),
            ({"url": "javascript:alert(1)"}, None),
            (None, None),
        ]
        for entrada, esperado in casos:
            with self.subTest(entrada=entrada):
                self.assertEqual(secop.normalizar_proceso({**base, "urlproceso": entrada})["url"], esperado)

    def test_presupuesto_texto_se_convierte_en_numero(self):
        self.assertEqual(secop.normalizar_proceso({"precio_base": "7500000"})["presupuesto"], 7500000.0)
        self.assertIsNone(secop.normalizar_proceso({"precio_base": "N/D"})["presupuesto"])

    def test_fecha_se_recorta_a_dia(self):
        proceso = secop.normalizar_proceso({"fecha_de_publicacion_del": "2026-10-09T00:00:00.000"})
        self.assertEqual(proceso["publicado"], "2026-10-09")


class PuntuacionTests(unittest.TestCase):
    def test_categoria_y_palabras_suman_y_explican(self):
        perfil = secop.parsear_perfil({"codigos": "8011", "palabras": "mantenimiento,software"})
        oportunidad = {"nombre": "Mantenimiento de sistemas", "descripcion": "Incluye software",
                       "categoria": "V1.80111600", "presupuesto": 5_000_000}
        puntaje, razones = secop.puntuar(oportunidad, perfil)
        self.assertEqual(puntaje, 40 + 20 + 10)  # categoría + palabra en nombre + palabra en descripción
        self.assertEqual(len(razones), 3)

    def test_presupuesto_dentro_del_rango_suma_20(self):
        perfil = secop.parsear_perfil({"palabras": "software", "min": "1000000", "max": "9000000"})
        base = {"nombre": "Software", "descripcion": "", "categoria": "V1.1"}
        dentro, _ = secop.puntuar({**base, "presupuesto": 5_000_000}, perfil)
        fuera, _ = secop.puntuar({**base, "presupuesto": 50_000_000}, perfil)
        self.assertEqual(dentro - fuera, 20)

    def test_sin_coincidencias_no_puntua(self):
        perfil = secop.parsear_perfil({"palabras": "software"})
        oportunidad = {"nombre": "Suministro de alimentos", "descripcion": "", "categoria": "V1.50000000",
                       "presupuesto": None}
        self.assertEqual(secop.puntuar(oportunidad, perfil), (0, []))

    def test_puntaje_maximo_es_100(self):
        perfil = secop.parsear_perfil(
            {"codigos": "8011", "palabras": "a1,b2,c3", "min": "0", "max": "10"}
        )
        oportunidad = {"nombre": "A1 B2 C3", "descripcion": "", "categoria": "V1.80111600", "presupuesto": 5}
        self.assertEqual(secop.puntuar(oportunidad, perfil)[0], 100)


def _fila(id_proceso, nombre, categoria, fecha):
    return {"id_del_proceso": id_proceso, "nombre_del_procedimiento": nombre,
            "descripci_n_del_procedimiento": "", "codigo_principal_de_categoria": categoria,
            "fecha_de_publicacion_del": fecha, "precio_base": "100"}


class CasosDeUsoTests(unittest.TestCase):
    def test_oportunidades_se_deduplican_y_ordenan_por_puntaje(self):
        filas = [
            _fila("B", "Software", "V1.50000000", "2026-10-10T00:00:00.000"),
            _fila("A", "Mantenimiento de software", "V1.80111600", "2026-10-09T00:00:00.000"),
            _fila("A", "Mantenimiento de software", "V1.80111600", "2026-10-09T00:00:00.000"),
            {"nombre_del_procedimiento": "Sin identificador"},
        ]
        with mock.patch.object(secop, "_consultar", return_value=filas) as consulta:
            resultado = secop.buscar_oportunidades({"palabras": "software, mantenimiento", "codigos": "8011"})

        self.assertEqual([op["id"] for op in resultado["resultados"]], ["A", "B"])
        self.assertEqual(resultado["filas_revisadas"], 4)
        url, parametros = consulta.call_args.args
        self.assertEqual(url, secop.URL_PROCESOS)
        self.assertIn("'Abierto'", parametros["$where"])
        self.assertEqual(parametros["$order"], "fecha_de_publicacion_del DESC")

    def test_mercado_convierte_texto_de_la_fuente_en_numeros(self):
        respuestas = {
            "nombre_entidad": [{"nombre_entidad": "Alcaldía X", "contratos": "12", "valor": "5414026672.5"}],
            "documento_proveedor": [
                {"documento_proveedor": "900123", "nombre": "PROVEEDOR SAS", "contratos": "3", "valor": "1000"}
            ],
            "modalidad_de_contratacion": [{"modalidad_de_contratacion": "Mínima cuantía", "contratos": "7"}],
        }

        def responder(url, parametros, timeout=None):
            return respuestas[parametros["$group"]]  # las consultas corren en paralelo: no importa el orden

        with mock.patch.object(secop, "_consultar", side_effect=responder) as consulta:
            resultado = secop.inteligencia_mercado({"codigos": "8011", "desde": "2024"})

        self.assertEqual(resultado["desde"], 2024)
        self.assertEqual(resultado["entidades"], [{"nombre": "Alcaldía X", "contratos": 12, "valor": 5414026672.5}])
        self.assertEqual(resultado["proveedores"][0]["contratos"], 3)
        self.assertEqual(resultado["proveedores"][0]["documento"], "900123")
        self.assertEqual(resultado["modalidades"], [{"nombre": "Mínima cuantía", "contratos": 7}])
        self.assertEqual(consulta.call_count, 3)
        self.assertTrue(all(c.args[0] == secop.URL_CONTRATOS for c in consulta.call_args_list))
        donde = {c.args[1]["$group"]: c.args[1]["$where"] for c in consulta.call_args_list}
        donde_entidades = donde["nombre_entidad"]
        donde_proveedores = donde["documento_proveedor"]
        donde_modalidades = donde["modalidad_de_contratacion"]
        self.assertIn("not in", donde_entidades)
        self.assertIn("not in", donde_proveedores)
        self.assertIn("documento_proveedor != 'No Definido'", donde_proveedores)
        self.assertNotIn("No Definido", donde_entidades)
        self.assertNotIn("not in", donde_modalidades)  # la mezcla de modalidades se muestra completa

    def test_mercado_rechaza_anio_inicial_invalido(self):
        with self.assertRaises(secop.ErrorDeValidacion):
            secop.inteligencia_mercado({"codigos": "8011", "desde": "1999"})


if __name__ == "__main__":
    unittest.main()
