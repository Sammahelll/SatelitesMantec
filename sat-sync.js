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

  async function actualizarEquipo(id, { nombre, tipo, ubicacion, marca, modelo, serie, estado, notas, criticidad } = {}) {
    if (!client) throw new Error('[SatSync] no inicializado — llamá a SatSync.init() primero');
    const cambios = {};
    if (nombre !== undefined) cambios.nombre = nombre;
    if (tipo !== undefined) cambios.tipo = tipo;
    if (ubicacion !== undefined) cambios.ubicacion = ubicacion;
    // Campos core agregados por la plantilla multi-hoja. Requieren haber
    // corrido el ALTER TABLE equipos (ver schema-core.sql) — si esa
    // migración no corrió todavía, Supabase devuelve error de columna
    // inexistente y el llamador (importEquiposRows) lo reporta por fila
    // en vez de romper todo el import.
    if (marca !== undefined) cambios.marca = marca;
    if (modelo !== undefined) cambios.modelo = modelo;
    if (serie !== undefined) cambios.serie = serie;
    if (estado !== undefined) cambios.estado = estado;
    if (notas !== undefined) cambios.notas = notas;
    if (criticidad !== undefined) cambios.criticidad = criticidad;
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
      .insert({
        tag, nombre: extra.nombre || tag, tipo: extra.tipo || null, ubicacion: extra.ubicacion || null,
        marca: extra.marca || null, modelo: extra.modelo || null, serie: extra.serie || null,
        estado: extra.estado || null, notas: extra.notas || null, criticidad: extra.criticidad || null
      })
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

  // ---- Especificaciones técnicas por tipo (equipos_specs) ----
  // Tabla hermana de `equipos`: una fila por (equipo_id, tipo_espec).
  // Un motor-bomba tiene 2 filas (tipo_espec='motor' y tipo_espec='bomba').
  // Requiere haber corrido schema-specs.sql en Supabase — si la tabla
  // todavía no existe, estas funciones tiran un error con código 42P01
  // que el llamador puede distinguir del resto.

  async function guardarSpec(equipoId, tipoEspec, specData) {
    if (!client) throw new Error('[SatSync] no inicializado — llamá a SatSync.init() primero');
    if (!specData || !Object.keys(specData).length) return null;
    const { data, error } = await client.from('equipos_specs')
      .upsert({ equipo_id: equipoId, tipo_espec: tipoEspec, spec_data: specData },
              { onConflict: 'equipo_id,tipo_espec' })
      .select().single();
    if (error) throw error;
    return data;
  }

  async function obtenerSpecsEquipo(equipoId) {
    if (!client) throw new Error('[SatSync] no inicializado — llamá a SatSync.init() primero');
    const { data, error } = await client.from('equipos_specs')
      .select('tipo_espec, spec_data')
      .eq('equipo_id', equipoId);
    if (error) throw error;
    const specs = {};
    (data || []).forEach(s => { specs[s.tipo_espec] = s.spec_data; });
    return specs; // { motor: {...}, bomba: {...} }
  }

  // Trae equipos + specs en una sola query (usa la vista equipos_full,
  // security_invoker = true). No reemplaza listarEquipos(): esta es
  // exclusivamente para las pantallas que necesitan mostrar RPM/potencia/etc.
  async function listarEquiposConSpecs({ incluirArchivados = false } = {}) {
    if (!client) throw new Error('[SatSync] no inicializado — llamá a SatSync.init() primero');
    return _paginar(() => {
      let q = client.from('equipos_full').select('*').order('tag');
      if (!incluirArchivados) q = q.eq('activo', true);
      return q;
    });
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

  // ══════════════════════════════════════════════════════════════════════
  // HELPERS DE NORMALIZACIÓN
  // ══════════════════════════════════════════════════════════════════════
  function normalizarClave(k) {
    return String(k)
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[°º]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toLowerCase();
  }

  const ALIASES_SPECS = {
    'rpm_nominal':              'rpm',
    'potencia':                 'potencia_kw',
    'voltaje_nominal':          'voltaje_v',
    'corriente_fla':            'corriente_a',
    'grado_ip':                 'ip',
    'caudal_nominal':           'caudal_m3h',
    'altura_nominal':           'altura_m',
    'npsh_requerido':           'npsh_m',
    'diametro_impulsor':        'diametro_impulsor_mm',
    'presion_estatica':         'presion_estatica_pa',
    'diametro_rodete':          'diametro_rodete_mm',
    'potencia_motor':           'potencia_motor_kw',
    'caudal':                   'caudal_m3min',
    'presion_trabajo':          'presion_trabajo_bar',
    'presion_maxima':           'presion_maxima_bar',
    'voltaje_de_barras':        'voltaje_barras',
    'corriente_nominal':        'corriente_nominal_a',
    'sistema_puesta_a_tierra':  'sistema_tierra',
    'corriente_cortocircuito':  'icc_ka',
    'capacidad_frigorifica':    'capacidad_btu',
    'potencia_electrica':       'potencia_kw',
    'carga_refrigerante':       'carga_refrigerante_kg',
    'capacidad_maxima':         'capacidad_max_kg',
    'altura_de_elevacion':      'altura_elevacion_m',
    'velocidad_elevacion':      'velocidad_elevacion_mpm',
    'velocidad_traslacion':     'velocidad_traslacion_mpm',
    'ancho_de_luz':             'ancho_luz_m',
    'n_caidas_de_cable':        'n_caidas_cable',
    'diametro_cable':           'diametro_cable_mm',
  };

  function claveCanonica(header) {
    const n = normalizarClave(header);
    return ALIASES_SPECS[n] || n;
  }

  function parsearValorSpec(v) {
    if (v === '' || v === null || v === undefined) return null;
    if (typeof v === 'number') return v;
    const s = String(v).trim();
    if (s === '' || s === '—' || s === '-') return null;
    if (/^-?\d+(\.\d+)?$/.test(s)) return parseFloat(s);
    return s;
  }

  // Fuente de verdad de los nombres de hoja: el hub deriva HOJA_POR_TIPO de
  // SatSync.HOJAS_SPECS_MAP. Para un tipo nuevo: agregá la línea acá y su
  // *_FIELDS + entrada en TIPOS_ESPEC del index.html.
  const HOJAS_SPECS_MAP = {
    'MOTORES':         'motor',
    'BOMBAS':          'bomba',
    'VENTILADORES':    'ventilador',
    'COMPRESORES':     'compresor',
    'TABLEROS':        'tablero',
    'REFRIGERACION':   'refrigeracion',
    'GRUAS_ELEVACION': 'grua',
    // ── tipos ampliados (fichas para futuras apps) ──
    "TANQUES_RECIPIENTES":     "tanque_recipiente",
    "INTERCAMBIADORES":        "intercambiador",
    "REACTORES":               "reactor",
    "TORRES_COLUMNAS":         "torre_columna",
    "FILTROS_TAMICES":         "filtro_tamiz",
    "VALVULAS_SELLOS":         "valvula_sello",
    "CALDERAS":                "caldera",
    "AGITADORES_MEZCLADORES":  "agitador_mezclador",
    "EQUIPOS_ELECTRICOS":      "equipo_electrico",
    "EQUIPOS_MOVILES":         "equipo_movil",
    "SECADORES_PLANTAS":       "secador_planta",
    "INSTRUMENTACION":         "instrumento",
  };

  // ══════════════════════════════════════════════════════════════════════
  // IMPORT MULTI-HOJA
  // ══════════════════════════════════════════════════════════════════════
  async function importarPlantillaEquipos(wb, onProgress) {
    if (!client) throw new Error('[SatSync] no inicializado — llamá a SatSync.init() primero');
    if (typeof global.XLSX === 'undefined' && typeof XLSX === 'undefined') {
      throw new Error('SheetJS no disponible');
    }
    const XLSXL = global.XLSX || XLSX;

    const hojaEq = wb.SheetNames.find(n => n.trim().toUpperCase() === 'EQUIPOS');
    if (!hojaEq) throw new Error('Falta la hoja EQUIPOS en el archivo');

    const rowsEq = XLSXL.utils.sheet_to_json(wb.Sheets[hojaEq], { defval: '' });
    const tagToId = new Map();
    const stats = { equipos: 0, specs: 0, errores: [] };

    // ── 1. EQUIPOS ─────────────────────────────────────────────────────
    for (let i = 0; i < rowsEq.length; i++) {
      const row = rowsEq[i];
      const tag = String(row['TAG'] || row['Tag'] || '').trim();
      if (!tag) { stats.errores.push(`EQUIPOS fila ${i+2}: sin TAG`); continue; }

      const core = {
        tag,
        nombre:    String(row['Nombre'] || '').trim() || null,
        tipo:      String(row['Tipo']   || '').trim() || null,
        planta:    String(row['Planta'] || '').trim() || null,
        ubicacion: String(row['Área / Ubicación'] || row['Area / Ubicacion'] || row['Ubicacion'] || row['Ubicación'] || '').trim() || null,
        marca:     String(row['Marca']  || '').trim() || null,
        modelo:    String(row['Modelo'] || '').trim() || null,
        serie:     String(row['N° Serie'] || row['N Serie'] || row['Serie'] || '').trim() || null,
        anio:      parseInt(row['Año Fabricación'] || row['Anio Fabricacion']) || null,
        criticidad: String(row['Criticidad'] || 'C').trim().toUpperCase() || 'C',
        estado:    String(row['Estado'] || 'operativo').trim() || 'operativo',
        proveedor: String(row['Proveedor'] || '').trim() || null,
        notas:     String(row['Notas'] || '').trim() || null,
      };

      // Fecha: acepta Date, DD/MM/YYYY, YYYY-MM-DD
      const fp = row['Fecha Puesta Marcha'];
      if (fp instanceof Date) {
        core.fecha_puesta_marcha = fp.toISOString().slice(0,10);
      } else if (typeof fp === 'string' && fp.trim()) {
        const m1 = fp.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        const m2 = fp.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (m1) core.fecha_puesta_marcha = `${m1[3]}-${m1[2].padStart(2,'0')}-${m1[1].padStart(2,'0')}`;
        else if (m2) core.fecha_puesta_marcha = `${m2[1]}-${m2[2]}-${m2[3]}`;
      }

      try {
        const { data, error } = await client
          .from('equipos')
          .upsert(core, { onConflict: 'tag' })
          .select('id').single();
        if (error) throw error;
        tagToId.set(tag, data.id);
        stats.equipos++;
      } catch (err) {
        stats.errores.push(`EQUIPOS "${tag}": ${err.message}`);
      }
      if (onProgress) onProgress('equipos', i + 1, rowsEq.length);
    }

    // ── 2. HOJAS TÉCNICAS ──────────────────────────────────────────────
    for (const [nombreHoja, tipoEspec] of Object.entries(HOJAS_SPECS_MAP)) {
      const sn = wb.SheetNames.find(n => n.trim().toUpperCase() === nombreHoja);
      if (!sn) continue;

      const rows = XLSXL.utils.sheet_to_json(wb.Sheets[sn], { defval: '' });
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const tag = String(row['TAG'] || row['Tag'] || '').trim();
        if (!tag) continue;

        const eqId = tagToId.get(tag);
        if (!eqId) {
          stats.errores.push(`${nombreHoja} fila ${i+2}: TAG "${tag}" no existe en EQUIPOS`);
          continue;
        }

        const specData = {};
        for (const [k, v] of Object.entries(row)) {
          if (k === 'TAG' || k === 'Tag') continue;
          const parsed = parsearValorSpec(v);
          if (parsed === null) continue;
          specData[claveCanonica(k)] = parsed;
        }
        if (Object.keys(specData).length === 0) continue;

        try {
          const { error } = await client
            .from('equipos_specs')
            .upsert({
              equipo_id: eqId,
              tipo_espec: tipoEspec,
              spec_data: specData
            }, { onConflict: 'equipo_id,tipo_espec' });
          if (error) throw error;
          stats.specs++;
        } catch (err) {
          stats.errores.push(`${nombreHoja} "${tag}": ${err.message}`);
        }
      }
      if (onProgress) onProgress(tipoEspec, rows.length, rows.length);
    }

    return stats;
  }

  // ══════════════════════════════════════════════════════════════════════
  // BORRAR SPEC INDIVIDUAL
  // ══════════════════════════════════════════════════════════════════════
  async function borrarSpec(equipoId, tipoEspec) {
    if (!client) throw new Error('[SatSync] no inicializado — llamá a SatSync.init() primero');
    const { error } = await client.from('equipos_specs')
      .delete()
      .eq('equipo_id', equipoId)
      .eq('tipo_espec', tipoEspec);
    if (error) throw error;
  }

  // ══════════════════════════════════════════════════════════════════════
  // VALIDACIÓN POST-IMPORT
  // ══════════════════════════════════════════════════════════════════════
  async function validarEquipos() {
    if (!client) throw new Error('[SatSync] no inicializado — llamá a SatSync.init() primero');
    const { data, error } = await client.from('equipos_full').select('*');
    if (error) throw error;

    const avisos = [];
    (data || []).forEach(e => {
      const specs = e.specs || {};
      const tipo = (e.tipo || '').toLowerCase();

      if (tipo.includes('motor') && !specs.motor?.rpm) {
        avisos.push({ tag: e.tag, sev: 'warn', msg: 'Motor sin RPM — Vibra Pro no clasifica ISO 10816' });
      }
      if (tipo.includes('motor') && !specs.motor?.potencia_kw) {
        avisos.push({ tag: e.tag, sev: 'warn', msg: 'Motor sin potencia — Motor Pro no calcula carga' });
      }
      if (tipo.includes('tablero') && !specs.tablero?.voltaje_barras) {
        avisos.push({ tag: e.tag, sev: 'crit', msg: 'Tablero sin voltaje de barras' });
      }
      if (tipo.includes('refrig') && !specs.refrigeracion?.refrigerante) {
        avisos.push({ tag: e.tag, sev: 'warn', msg: 'Refrigeración sin tipo de refrigerante' });
      }
      const tieneAlgunaSpec = Object.keys(specs).length > 0;
      if (!tieneAlgunaSpec && !tipo.includes('otro')) {
        avisos.push({ tag: e.tag, sev: 'warn', msg: `Tipo "${e.tipo}" sin hoja técnica cargada` });
      }
    });
    return avisos;
  }

  global.SatSync = {
    init, estaConfigurado, guardarConfig, leerConfig,
    listarEquipos, buscarOCrearEquipo, actualizarEquipo, archivarEquipo,
    guardarAnalisis, listarAnalisis, subirImagen,
    guardarCaptura, listarCapturasPendientes, marcarCapturaProcesada,
    buscarEquipoPorTag, guardarFichas, quitarModuloDeEquipo, renombrarEquipo,
    listarMediciones, guardarMediciones, borrarMedicion, cargarConfigApp, guardarConfigApp,
    guardarSpec, obtenerSpecsEquipo, listarEquiposConSpecs,

    // ── NUEVAS: import multi-hoja, borrado de specs y validación post-import ──
    importarPlantillaEquipos,
    // el hub deriva de acá los nombres de hoja de la plantilla (una sola fuente de verdad)
    HOJAS_SPECS_MAP,
    borrarSpec,
    validarEquipos,

    // helpers expuestos por si los tests los necesitan
    normalizarClave,
    claveCanonica,
  };
})(window);
