/**
 * MANTEC Satélites — sat-sync.js
 * Conector mínimo y compartido entre los 6 módulos (motor_pro,
 * tablero_pro, vibra_pro, thermovision, lubricacion, alineacion)
 * y el hub de escritorio.
 *
 * Cómo integrarlo en un módulo existente:
 *   1. <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
 *      <script src="./sat-sync.js"></script>
 *   2. SatSync.init();                 // lee config guardada por el hub
 *   3. await SatSync.guardarAnalisis({
 *        modulo: 'vibra_pro',
 *        equipo_tag: 'MOT-204',
 *        severidad: 'atencion',        // 'ok' | 'atencion' | 'critico'
 *        resumen: 'Vibración elevada en rodamiento LA',
 *        datos: {...}                  // el objeto que el módulo ya arma internamente
 *      });
 *
 * No cambia la lógica de análisis de cada módulo — solo agrega un
 * paso opcional de "guardar en la nube" además de lo que cada uno
 * ya hace localmente.
 */
(function (global) {
  const CFG_KEY = 'mantec_sat_hub_cfg';
  let client = null;

  // Config por defecto: así cualquier dispositivo (celu, tablet, otra PC)
  // arranca conectado sin pasar por "Configurar Supabase" primero.
  // La anon key es pública por diseño (la seguridad la da RLS en Supabase,
  // no el secreto de esta key), así que no hay problema en dejarla acá.
  // El botón "Configurar" sigue funcionando como override manual si algún
  // día cambia de proyecto Supabase.
  const CFG_DEFAULT = {
    url: 'https://wngzljsfqeocumrbgyoy.supabase.co',
    anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InduZ3psanNmcWVvY3VtcmJneW95Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk0NDU2NjksImV4cCI6MjEwNTAyMTY2OX0.ArrBbd95DYDio7ttZGAYBoYwXy3D58gORfIxxjpwpxg'
  };

  function leerConfig() {
    try {
      return JSON.parse(localStorage.getItem(CFG_KEY) || 'null');
    } catch {
      return null;
    }
  }

  function guardarConfig(url, anonKey) {
    localStorage.setItem(CFG_KEY, JSON.stringify({ url, anonKey }));
  }

  function init(url, anonKey) {
    const cfg = (url && anonKey) ? { url, anonKey } : (leerConfig() || CFG_DEFAULT);
    if (!cfg || !cfg.url || !cfg.anonKey) {
      console.warn('[SatSync] Sin configuración de Supabase. Llamá a SatSync.init(url, anonKey) o configurá desde el hub.');
      return false;
    }
    if (url && anonKey) guardarConfig(url, anonKey);
    if (typeof global.supabase === 'undefined') {
      console.error('[SatSync] Falta cargar @supabase/supabase-js antes de sat-sync.js');
      return false;
    }
    client = global.supabase.createClient(cfg.url, cfg.anonKey);
    return true;
  }

  function estaConfigurado() {
    return !!client;
  }

  // PostgREST devuelve máximo 1000 filas por consulta: se pagina hasta agotar.
  async function _paginar(construir, tam = 1000) {
    const out = [];
    for (let desde = 0; ; desde += tam) {
      const { data, error } = await construir().range(desde, desde + tam - 1);
      if (error) throw error;
      out.push(...data);
      if (data.length < tam) break;
    }
    return out;
  }

  async function listarEquipos({ incluirArchivados = false } = {}) {
    if (!client) throw new Error('[SatSync] no inicializado — llamá a SatSync.init() primero');
    return _paginar(() => {
      let q = client.from('equipos').select('*').order('tag');
      if (!incluirArchivados) q = q.eq('activo', true);
      return q;
    });
  }

  async function actualizarEquipo(id, { nombre, tipo, ubicacion } = {}) {
    if (!client) throw new Error('[SatSync] no inicializado — llamá a SatSync.init() primero');
    const cambios = {};
    if (nombre !== undefined) cambios.nombre = nombre;
    if (tipo !== undefined) cambios.tipo = tipo;
    if (ubicacion !== undefined) cambios.ubicacion = ubicacion;
    const { data, error } = await client.from('equipos')
      .update(cambios)
      .eq('id', id)
      .select().single();
    if (error) throw error;
    return data;
  }

  async function archivarEquipo(id, estabaActivo) {
    if (!client) throw new Error('[SatSync] no inicializado — llamá a SatSync.init() primero');
    const { data, error } = await client.from('equipos')
      .update({ activo: !estabaActivo })
      .eq('id', id)
      .select().single();
    if (error) throw error;
    return data;
  }

  async function buscarOCrearEquipo(tag, extra = {}) {
    if (!client) throw new Error('[SatSync] no inicializado');
    const { data: existente, error: e1 } = await client.from('equipos').select('*').eq('tag', tag).maybeSingle();
    if (e1) throw e1;
    if (existente) {
      // Antes esta rama devolvía "existente" sin tocarlo, así que un equipo
      // creado con solo el TAG (p. ej. desde una captura del hub de campo)
      // se quedaba con tipo/ubicacion en null para siempre, aunque un módulo
      // Pro más tarde llamara a esta misma función con esos datos completos.
      // Ahora rellena los campos vacíos — nunca sobreescribe un dato que ya
      // estaba cargado (respeta tanto ediciones manuales como importaciones).
      const updates = {};
      if (!existente.tipo && extra.tipo) updates.tipo = extra.tipo;
      if (!existente.ubicacion && extra.ubicacion) updates.ubicacion = extra.ubicacion;
      if ((!existente.nombre || existente.nombre === existente.tag) && extra.nombre) {
        updates.nombre = extra.nombre;
      }
      if (Object.keys(updates).length) {
        const { data, error } = await client.from('equipos')
          .update(updates).eq('id', existente.id).select().single();
        if (error) throw error;
        return data;
      }
      return existente;
    }
    const { data, error } = await client.from('equipos')
      .insert({ tag, nombre: extra.nombre || tag, tipo: extra.tipo || null, ubicacion: extra.ubicacion || null })
      .select().single();
    if (error) throw error;
    return data;
  }

  async function guardarAnalisis({ modulo, equipo_tag, severidad, resumen, datos, autor }) {
    if (!client) throw new Error('[SatSync] no inicializado — llamá a SatSync.init() primero');
    const equipo = await buscarOCrearEquipo(equipo_tag);
    const { data, error } = await client.from('analisis').insert({
      equipo_id: equipo.id,
      modulo,
      severidad: severidad || null,
      resumen: resumen || null,
      datos: datos || {},
      autor: autor || null
    }).select().single();
    if (error) throw error;
    return data;
  }

  async function listarAnalisis({ equipo_id, modulo, limite = 50 } = {}) {
    if (!client) throw new Error('[SatSync] no inicializado');
    // equipo_id/modulo se aceptan por compatibilidad, pero el hub filtra en
    // el cliente sobre la caché completa — acá solo se aplica `limite`.
    let q = client.from('analisis').select('*, equipos(tag, nombre)').order('fecha', { ascending: false }).limit(limite);
    if (equipo_id) q = q.eq('equipo_id', equipo_id);
    if (modulo) q = q.eq('modulo', modulo);
    const { data, error } = await q;
    if (error) throw error;
    return data;
  }

  async function subirImagen(archivo, carpeta = 'general') {
    if (!client) throw new Error('[SatSync] no inicializado');
    const nombre = `${carpeta}/${Date.now()}-${archivo.name}`;
    const { error } = await client.storage.from('analisis-media').upload(nombre, archivo);
    if (error) throw error;
    const { data } = client.storage.from('analisis-media').getPublicUrl(nombre);
    return data.publicUrl;
  }

  // ---- Hub de Campo: capturas crudas (alineación, motor, tablero) ----
  // Independiza lo que se carga a mano en el celular (sin diagnóstico)
  // de lo que ya calculó cada app Pro (tabla `analisis`). Una vez que la
  // app Pro procesa una captura, la marca como 'procesado' y queda
  // enlazada al registro de `analisis` que generó.

  async function guardarCaptura({ modulo, equipo_tag, datos, autor }) {
    if (!client) throw new Error('[SatSync] no inicializado — llamá a SatSync.init() primero');
    const equipo = await buscarOCrearEquipo(equipo_tag);
    const { data, error } = await client.from('capturas_campo').insert({
      equipo_id: equipo.id,
      modulo,
      datos: datos || {},
      autor: autor || 'técnico_campo',
      estado: 'pendiente'
    }).select().single();
    if (error) throw error;
    return data;
  }

  async function listarCapturasPendientes({ modulo, limite = 100 } = {}) {
    if (!client) throw new Error('[SatSync] no inicializado — llamá a SatSync.init() primero');
    let q = client.from('capturas_campo')
      .select('*, equipos(tag, nombre, ubicacion)')
      .eq('estado', 'pendiente')
      .order('fecha', { ascending: false })
      .limit(limite);
    if (modulo) q = q.eq('modulo', modulo);
    const { data, error } = await q;
    if (error) throw error;
    return data;
  }

  async function marcarCapturaProcesada(capturaId, analisisId) {
    if (!client) throw new Error('[SatSync] no inicializado — llamá a SatSync.init() primero');
    const { data, error } = await client.from('capturas_campo')
      .update({ estado: 'procesado', analisis_id: analisisId || null })
      .eq('id', capturaId)
      .select().single();
    if (error) throw error;
    return data;
  }

  // ---- Fichas técnicas, mediciones y configuración por módulo ----
  // equipos.ficha (jsonb) guarda un objeto por módulo: { bomba_pro: {...}, motor_pro: {...} }.
  // Las columnas tipo/ubicacion/criticidad de equipos son compartidas entre módulos.
  // mediciones: historial crudo (lo que se midió) por equipo + módulo + fecha.
  // config_apps: umbrales/opciones de cada módulo (compartidos entre dispositivos).

  async function buscarEquipoPorTag(tag) {
    if (!client) throw new Error('[SatSync] no inicializado');
    const { data, error } = await client.from('equipos').select('*').eq('tag', tag).maybeSingle();
    if (error) throw error;
    return data;
  }

  // lista: [{tag, tipo, ubicacion, criticidad, ficha}] → crea o actualiza equipos.
  // Devuelve las filas de equipos (con id) de todos los tags recibidos.
  // opts.noPisar: no sobreescribe una ficha del módulo que ya exista en la nube.
  async function guardarFichas(modulo, lista, { noPisar = false } = {}) {
    if (!client) throw new Error('[SatSync] no inicializado — llamá a SatSync.init() primero');
    if (!lista.length) return [];
    const ahora = new Date().toISOString();
    const existentes = [];
    const tags = lista.map(x => x.tag);
    for (let i = 0; i < tags.length; i += 100) {
      const { data, error } = await client.from('equipos').select('*').in('tag', tags.slice(i, i + 100));
      if (error) throw error;
      existentes.push(...data);
    }
    const porTag = new Map(existentes.map(e => [e.tag, e]));
    const resultado = [];
    const nuevos = [];
    const cambios = [];
    for (const it of lista) {
      const ex = porTag.get(it.tag);
      if (!ex) {
        nuevos.push({
          tag: it.tag, nombre: it.nombre || it.tag, tipo: it.tipo || null, ubicacion: it.ubicacion || null,
          criticidad: it.criticidad || null, ficha: { [modulo]: it.ficha }, ficha_actualizada: ahora
        });
        continue;
      }
      const previa = ex.ficha && ex.ficha[modulo];
      if (noPisar && previa && !previa.eliminada) { resultado.push(ex); continue; }
      // No pisar tipo/ubicacion/criticidad con null: otro módulo pudo haberlos cargado ya.
      // Solo se actualizan si este módulo trae un valor propio.
      cambios.push({ id: ex.id, valores: {
        tipo: it.tipo || ex.tipo || null, ubicacion: it.ubicacion || ex.ubicacion || null,
        criticidad: it.criticidad || ex.criticidad || null,
        ficha: Object.assign({}, ex.ficha || {}, { [modulo]: it.ficha }), ficha_actualizada: ahora
      }});
    }
    for (let i = 0; i < nuevos.length; i += 200) {
      const { data, error } = await client.from('equipos').insert(nuevos.slice(i, i + 200)).select();
      if (error) throw error;
      resultado.push(...data);
    }
    for (let i = 0; i < cambios.length; i += 10) {
      const lote = await Promise.all(cambios.slice(i, i + 10).map(async c => {
        const { data, error } = await client.from('equipos').update(c.valores).eq('id', c.id).select().single();
        if (error) throw error;
        return data;
      }));
      resultado.push(...lote);
    }
    return resultado;
  }

  // El equipo sigue existiendo (lo usan otros módulos): solo se marca la ficha del módulo
  // como eliminada y se borran sus mediciones.
  async function quitarModuloDeEquipo(modulo, equipoId) {
    if (!client) throw new Error('[SatSync] no inicializado');
    const { data: eq, error: e1 } = await client.from('equipos').select('id, ficha').eq('id', equipoId).maybeSingle();
    if (e1) throw e1;
    if (!eq) return;
    const ficha = Object.assign({}, eq.ficha || {}, { [modulo]: { eliminada: true } });
    const { error: e2 } = await client.from('equipos').update({ ficha, ficha_actualizada: new Date().toISOString() }).eq('id', equipoId);
    if (e2) throw e2;
    const { error: e3 } = await client.from('mediciones').delete().eq('equipo_id', equipoId).eq('modulo', modulo);
    if (e3) throw e3;
  }

  async function renombrarEquipo(tagViejo, tagNuevo) {
    if (!client) throw new Error('[SatSync] no inicializado');
    const eq = await buscarEquipoPorTag(tagViejo);
    if (!eq) return null;   // nunca llegó a la nube: la ficha se crea con el tag nuevo
    const cambios = { tag: tagNuevo };
    if (!eq.nombre || eq.nombre === eq.tag) cambios.nombre = tagNuevo;
    const { data, error } = await client.from('equipos').update(cambios).eq('id', eq.id).select().single();
    if (error) throw error;
    return data;
  }

  async function listarMediciones(modulo) {
    if (!client) throw new Error('[SatSync] no inicializado — llamá a SatSync.init() primero');
    return _paginar(() => client.from('mediciones')
      .select('equipo_id, fecha, datos, obs')
      .eq('modulo', modulo).order('fecha', { ascending: true }).order('id'));
  }

  // filas: [{equipo_id, fecha (ISO), datos, obs}] — upsert por (equipo_id, modulo, fecha)
  async function guardarMediciones(modulo, filas, autor) {
    if (!client) throw new Error('[SatSync] no inicializado — llamá a SatSync.init() primero');
    for (let i = 0; i < filas.length; i += 500) {
      const lote = filas.slice(i, i + 500).map(f => ({
        equipo_id: f.equipo_id, modulo, fecha: f.fecha, datos: f.datos || {}, obs: f.obs || null, autor: autor || null
      }));
      const { error } = await client.from('mediciones').upsert(lote, { onConflict: 'equipo_id,modulo,fecha' });
      if (error) throw error;
    }
  }

  async function borrarMedicion(modulo, equipoId, fecha) {
    if (!client) throw new Error('[SatSync] no inicializado');
    const { error } = await client.from('mediciones').delete()
      .eq('equipo_id', equipoId).eq('modulo', modulo).eq('fecha', fecha);
    if (error) throw error;
  }

  async function cargarConfigApp(modulo) {
    if (!client) throw new Error('[SatSync] no inicializado — llamá a SatSync.init() primero');
    const { data, error } = await client.from('config_apps').select('config').eq('modulo', modulo).maybeSingle();
    if (error) throw error;
    return data ? data.config : null;
  }

  async function guardarConfigApp(modulo, config) {
    if (!client) throw new Error('[SatSync] no inicializado — llamá a SatSync.init() primero');
    const { error } = await client.from('config_apps')
      .upsert({ modulo, config, updated_at: new Date().toISOString() }, { onConflict: 'modulo' });
    if (error) throw error;
  }

  global.SatSync = {
    init, estaConfigurado, guardarConfig, leerConfig,
    listarEquipos, buscarOCrearEquipo, actualizarEquipo, archivarEquipo,
    guardarAnalisis, listarAnalisis, subirImagen,
    guardarCaptura, listarCapturasPendientes, marcarCapturaProcesada,
    buscarEquipoPorTag, guardarFichas, quitarModuloDeEquipo, renombrarEquipo,
    listarMediciones, guardarMediciones, borrarMedicion, cargarConfigApp, guardarConfigApp
  };
})(window);
