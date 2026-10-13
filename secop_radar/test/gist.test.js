"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Gist = require("../site/gist.js");

const ID = "aa11bb22cc33dd44";

/** `fetch` simulado: `rutas` mapea "MÉTODO /ruta" a una función que devuelve {status, cuerpo, cabeceras}. */
function falso(rutas) {
  const llamadas = [];
  const fetchFn = async (url, opciones = {}) => {
    const ruta = new URL(url).pathname;
    const metodo = opciones.method ?? "GET";
    llamadas.push({ metodo, ruta, cabeceras: opciones.headers ?? {}, cuerpo: opciones.body ? JSON.parse(opciones.body) : undefined });
    const r = rutas[`${metodo} ${ruta}`];
    if (!r) throw new Error(`ruta inesperada ${metodo} ${ruta}`);
    const { status = 200, cuerpo = {}, cabeceras = {} } = await r(llamadas.at(-1));
    return { ok: status >= 200 && status < 300, status, json: async () => cuerpo, headers: { get: (n) => cabeceras[n.toLowerCase()] ?? null } };
  };
  return { fetchFn, llamadas };
}

test("problemaDelToken", async (t) => {
  await t.test("rechaza vacío, con espacios y los tokens fine-grained", () => {
    assert.match(Gist.problemaDelToken(""), /Pega el token/);
    assert.match(Gist.problemaDelToken("ghp_abc def"), /espacios/);
    assert.match(Gist.problemaDelToken("github_pat_11AAA"), /classic/);
    assert.equal(Gist.problemaDelToken("ghp_" + "a".repeat(36)), null);
  });
});

test("verificar", async (t) => {
  await t.test("devuelve el usuario y manda el token como Bearer", async () => {
    const { fetchFn, llamadas } = falso({ "GET /user": () => ({ cuerpo: { login: "persona" }, cabeceras: { "x-oauth-scopes": "gist" } }) });
    const cliente = Gist.crearClienteGist({ token: " ghp_x ", fetchFn });
    assert.deepEqual(await cliente.verificar(), { usuario: "persona" });
    assert.equal(llamadas[0].cabeceras.authorization, "Bearer ghp_x");
  });

  await t.test("avisa si GitHub informa permisos y falta «gist»", async () => {
    const { fetchFn } = falso({ "GET /user": () => ({ cuerpo: { login: "p" }, cabeceras: { "x-oauth-scopes": "repo, read:user" } }) });
    await assert.rejects(Gist.crearClienteGist({ token: "ghp_x", fetchFn }).verificar(), /permiso «gist»/);
  });

  await t.test("si GitHub no informa los permisos, no inventa un error", async () => {
    const { fetchFn } = falso({ "GET /user": () => ({ cuerpo: { login: "p" } }) });
    assert.deepEqual(await Gist.crearClienteGist({ token: "ghp_x", fetchFn }).verificar(), { usuario: "p" });
  });

  await t.test("traduce los errores sin repetir el token", async () => {
    const casos = [[401, /no reconoce el token/], [403, /casilla «gist»/], [404, /No se encontró/], [422, /rechazó/], [502, /problema por su lado/], [418, /error 418/]];
    for (const [status, patron] of casos) {
      const { fetchFn } = falso({ "GET /user": () => ({ status, cuerpo: { message: "x" } }) });
      await assert.rejects(Gist.crearClienteGist({ token: "ghp_secreto", fetchFn }).verificar(), (e) => {
        assert.ok(e instanceof Gist.ErrorDeGist);
        assert.match(e.message, patron);
        assert.ok(!e.message.includes("ghp_secreto"));
        assert.equal(e.estado, status);
        return true;
      });
    }
    const { fetchFn } = falso({ "GET /user": () => ({ status: 403, cuerpo: { message: "API rate limit exceeded" } }) });
    await assert.rejects(Gist.crearClienteGist({ token: "ghp_x", fetchFn }).verificar(), /limitó las consultas/);
  });

  await t.test("sin conexión da un mensaje claro", async () => {
    const fetchFn = async () => { throw new TypeError("fallo de red"); };
    await assert.rejects(Gist.crearClienteGist({ token: "ghp_x", fetchFn }).verificar(), /No se pudo conectar con GitHub/);
  });
});

test("crear, leer y guardar", async (t) => {
  await t.test("crea un gist secreto con el archivo de alertas", async () => {
    const { fetchFn, llamadas } = falso({ "POST /gists": () => ({ status: 201, cuerpo: { id: ID } }) });
    const { id } = await Gist.crearClienteGist({ token: "ghp_x", fetchFn }).crear('{"version":1}');
    assert.equal(id, ID);
    assert.equal(llamadas[0].cuerpo.public, false);
    assert.equal(llamadas[0].cuerpo.files["radar-alertas.json"].content, '{"version":1}');
    assert.equal(llamadas[0].cabeceras["content-type"], "application/json");
  });

  await t.test("lee el contenido del archivo", async () => {
    const { fetchFn } = falso({ [`GET /gists/${ID}`]: () => ({ cuerpo: { files: { "radar-alertas.json": { content: "hola" } } } }) });
    assert.equal(await Gist.crearClienteGist({ token: "ghp_x", fetchFn }).leer(ID), "hola");
  });

  await t.test("leer sin token no manda Authorization", async () => {
    const { fetchFn, llamadas } = falso({ [`GET /gists/${ID}`]: () => ({ cuerpo: { files: { "radar-alertas.json": { content: "x" } } } }) });
    await Gist.crearClienteGist({ fetchFn }).leer(ID);
    assert.equal("authorization" in llamadas[0].cabeceras, false);
  });

  await t.test("si GitHub rechaza el token al leer, reintenta sin token (un gist secreto lo lee quien tenga la dirección)", async () => {
    let intentos = 0;
    const { fetchFn, llamadas } = falso({
      [`GET /gists/${ID}`]: (llamada) => {
        intentos += 1;
        return llamada.cabeceras.authorization ? { status: 403, cuerpo: { message: "Resource not accessible by integration" } } : { cuerpo: { files: { "radar-alertas.json": { content: "ok" } } } };
      },
    });
    assert.equal(await Gist.crearClienteGist({ token: "ghs_flujo", fetchFn }).leer(ID), "ok");
    assert.equal(intentos, 2);
    assert.equal("authorization" in llamadas[1].cabeceras, false);
  });

  await t.test("un 404 no se reintenta y se explica", async () => {
    const { fetchFn, llamadas } = falso({ [`GET /gists/${ID}`]: () => ({ status: 404 }) });
    await assert.rejects(Gist.crearClienteGist({ token: "ghp_x", fetchFn }).leer(ID), /No se encontró el gist/);
    assert.equal(llamadas.length, 1);
  });

  await t.test("falla si el gist no tiene el archivo o viene truncado", async () => {
    const sin = falso({ [`GET /gists/${ID}`]: () => ({ cuerpo: { files: { "otro.txt": { content: "x" } } } }) });
    await assert.rejects(Gist.crearClienteGist({ fetchFn: sin.fetchFn }).leer(ID), /no tiene el archivo/);
    const truncado = falso({ [`GET /gists/${ID}`]: () => ({ cuerpo: { files: { "radar-alertas.json": { truncated: true } } } }) });
    await assert.rejects(Gist.crearClienteGist({ fetchFn: truncado.fetchFn }).leer(ID), /demasiado grande/);
  });

  await t.test("guarda con PATCH solo el archivo de alertas", async () => {
    const { fetchFn, llamadas } = falso({ [`PATCH /gists/${ID}`]: () => ({ cuerpo: {} }) });
    await Gist.crearClienteGist({ token: "ghp_x", fetchFn }).guardar(ID, "nuevo");
    assert.deepEqual(llamadas[0].cuerpo, { files: { "radar-alertas.json": { content: "nuevo" } } });
  });

  await t.test("rechaza identificadores que no son de un gist, sin llamar a la red", async () => {
    const { fetchFn, llamadas } = falso({});
    const cliente = Gist.crearClienteGist({ token: "ghp_x", fetchFn });
    for (const id of ["", "../user", "zzzz", "a b", null]) {
      await assert.rejects(cliente.leer(id), /no es válido/);
      await assert.rejects(cliente.guardar(id, "x"), /no es válido/);
    }
    assert.equal(llamadas.length, 0);
  });
});
