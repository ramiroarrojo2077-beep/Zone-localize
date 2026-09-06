/*
 * app.js — Zone Localize
 *
 * Dos caminos independientes para ubicar una foto:
 *   1. GPS de los metadatos EXIF  -> coordenadas exactas, todo en el navegador.
 *   2. Reconocimiento visual con Claude -> estimación a partir de lo que se ve.
 * Las direcciones y coordenadas se resuelven contra Nominatim (OpenStreetMap).
 */
(function () {
  'use strict';

  var KEY_STORAGE = 'zone-localize:anthropic-key';
  var MODEL = 'claude-opus-5';
  var MAX_EDGE = 1568;        // lado máximo que se le manda al modelo
  var NOMINATIM = 'https://nominatim.openstreetmap.org';

  var $ = function (id) { return document.getElementById(id); };

  var state = { file: null, buffer: null, dataUrl: null, busy: false };

  /* ============================================================
     Utilidades
     ============================================================ */

  function fmtCoord(lat, lon) {
    return Number(lat).toFixed(6) + ', ' + Number(lon).toFixed(6);
  }

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function showStatus(msg, kind) {
    var el = $('status');
    el.className = 'status' + (kind === 'error' ? ' error' : '');
    el.innerHTML = (kind === 'loading' ? '<div class="spinner"></div>' : '') + '<div>' + esc(msg) + '</div>';
    el.classList.remove('hidden');
  }

  function hideStatus() { $('status').classList.add('hidden'); }

  function getKey() {
    try { return localStorage.getItem(KEY_STORAGE) || ''; } catch (e) { return ''; }
  }

  /* ============================================================
     Bloque de coordenadas reutilizable (copiar + enlaces + mapa)
     ============================================================ */

  function coordBlock(lat, lon, opts) {
    opts = opts || {};
    lat = Number(Number(lat).toFixed(6));
    lon = Number(Number(lon).toFixed(6));
    var coords = fmtCoord(lat, lon);
    var q = encodeURIComponent(coords);
    var d = 0.004;
    var bbox = [lon - d, lat - d, lon + d, lat + d].map(function (n) { return n.toFixed(5); }).join(',');

    var html =
      '<div class="coords">' +
        '<code>' + esc(coords) + '</code>' +
        '<button type="button" class="copy-btn" data-copy="' + esc(coords) + '">Copiar</button>' +
      '</div>' +
      '<div class="links">' +
        '<a href="https://www.google.com/maps/search/?api=1&query=' + q + '" target="_blank" rel="noopener">Abrir en Google Maps</a>' +
        '<a href="https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=' + q + '" target="_blank" rel="noopener">Street View</a>' +
        '<a href="https://www.openstreetmap.org/?mlat=' + lat + '&mlon=' + lon + '#map=17/' + lat + '/' + lon + '" target="_blank" rel="noopener">OpenStreetMap</a>' +
      '</div>';

    if (opts.note) html += '<p class="card-note" style="margin:8px 0 0">' + esc(opts.note) + '</p>';

    if (opts.map !== false) {
      html += '<iframe class="map" loading="lazy" title="Mapa de la ubicación" src="' +
        'https://www.openstreetmap.org/export/embed.html?bbox=' + encodeURIComponent(bbox) +
        '&amp;layer=mapnik&amp;marker=' + lat + ',' + lon + '"></iframe>';
    }
    return html;
  }

  document.addEventListener('click', function (ev) {
    var btn = ev.target.closest('.copy-btn');
    if (!btn) return;
    var text = btn.getAttribute('data-copy');
    var done = function () {
      btn.textContent = '¡Copiado!';
      btn.classList.add('done');
      setTimeout(function () { btn.textContent = 'Copiar'; btn.classList.remove('done'); }, 1800);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
    } else {
      fallbackCopy(text, done);
    }
  });

  function fallbackCopy(text, done) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { /* nada que hacer */ }
    document.body.removeChild(ta);
  }

  /* ============================================================
     Nominatim (OpenStreetMap)
     ============================================================ */

  function reverseGeocode(lat, lon) {
    var url = NOMINATIM + '/reverse?format=jsonv2&accept-language=es&zoom=18&lat=' + lat + '&lon=' + lon;
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('Nominatim ' + r.status);
      return r.json();
    }).catch(function () { return null; });
  }

  function forwardGeocode(query) {
    if (!query) return Promise.resolve(null);
    var url = NOMINATIM + '/search?format=jsonv2&accept-language=es&limit=1&addressdetails=1&q=' + encodeURIComponent(query);
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('Nominatim ' + r.status);
      return r.json();
    }).then(function (arr) {
      return arr && arr.length ? arr[0] : null;
    }).catch(function () { return null; });
  }

  /* ============================================================
     Preparación de la imagen para el modelo
     ============================================================ */

  function toModelImage(dataUrl) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight;
        var scale = Math.min(1, MAX_EDGE / Math.max(w, h));
        var cw = Math.max(1, Math.round(w * scale));
        var ch = Math.max(1, Math.round(h * scale));
        var canvas = document.createElement('canvas');
        canvas.width = cw;
        canvas.height = ch;
        canvas.getContext('2d').drawImage(img, 0, 0, cw, ch);
        var out = canvas.toDataURL('image/jpeg', 0.85);
        resolve({ media_type: 'image/jpeg', data: out.slice(out.indexOf(',') + 1) });
      };
      img.onerror = function () { reject(new Error('No se pudo decodificar la imagen.')); };
      img.src = dataUrl;
    });
  }

  /* ============================================================
     Claude — reconocimiento visual
     ============================================================ */

  var SYSTEM_PROMPT = [
    'Sos un analista de geolocalización de imágenes. A partir de una sola foto tenés que deducir dónde fue tomada.',
    '',
    'Método:',
    '1. Leé todo texto visible: carteles, marcas, vidrieras, señalética, patentes, menús, precios y su moneda, idioma y ortografía.',
    '2. Usá marcas y cadenas comerciales: muchas operan solo en ciertos países o tienen locales contados.',
    '3. Mirá la arquitectura, los materiales, la vegetación, el tipo de enchufes, los semáforos, el sentido del tránsito y la altura del sol.',
    '4. En interiores (shoppings, aeropuertos, estaciones, locales) apoyate en la señalética, la combinación de marcas, el diseño del piso y la barandas, y el estilo de los directorios.',
    '5. Cruzá las pistas: la intersección de varias señales débiles suele identificar un lugar único.',
    '',
    'Reglas de salida:',
    '- Contestá siempre en español rioplatense, claro y sin rodeos.',
    '- "lugar" tiene que ser lo más específico que puedas sostener: el nombre propio del shopping, edificio o esquina si lo reconocés; si no, el barrio o la zona.',
    '- "consulta_mapa" es el texto que un humano escribiría en Google Maps para llegar ahí (nombre del lugar + ciudad + país). Tiene que ser buscable, no una descripción.',
    '- "latitud"/"longitud" solo si reconocés el lugar puntual o el centro de la zona; si no, null.',
    '- "confianza": "alta" solo si identificás el lugar exacto por evidencia concreta; "media" si acertás ciudad o zona; "baja" si apenas llegás a país o región.',
    '- "pistas": las señales concretas que usaste, citando el texto que leíste en la imagen cuando lo haya.',
    '- "alternativas": otros lugares plausibles si tenés dudas; array vacío si no hay.',
    '- Nunca inventes un nombre para quedar bien. Si no llegás a nada, poné identificado=false y explicá en "pistas" qué faltó.'
  ].join('\n');

  var SCHEMA = {
    type: 'object',
    properties: {
      identificado: { type: 'boolean', description: 'true si pudiste ubicar la foto al menos a nivel ciudad o zona' },
      lugar: { type: 'string', description: 'Nombre del lugar lo más específico posible' },
      tipo: { type: 'string', description: 'Qué clase de lugar es (shopping, calle, plaza, aeropuerto, local...)' },
      direccion: { type: 'string', description: 'Dirección o referencia; vacío si no la sabés' },
      ciudad: { type: 'string' },
      region: { type: 'string', description: 'Provincia, estado o región' },
      pais: { type: 'string' },
      latitud: { type: ['number', 'null'] },
      longitud: { type: ['number', 'null'] },
      confianza: { type: 'string', enum: ['alta', 'media', 'baja'] },
      consulta_mapa: { type: 'string', description: 'Texto buscable en Google Maps' },
      pistas: { type: 'array', items: { type: 'string' } },
      alternativas: { type: 'array', items: { type: 'string' } }
    },
    required: ['identificado', 'lugar', 'tipo', 'direccion', 'ciudad', 'region', 'pais',
               'latitud', 'longitud', 'confianza', 'consulta_mapa', 'pistas', 'alternativas'],
    additionalProperties: false
  };

  function buildRequest(image, exif, useSchema) {
    var hint = '';
    if (exif && exif.dateTimeOriginal) hint += '\nFecha de captura según los metadatos: ' + exif.dateTimeOriginal + '.';
    if (exif && (exif.make || exif.model)) hint += '\nCámara: ' + [exif.make, exif.model].filter(Boolean).join(' ') + '.';

    var body = {
      model: MODEL,
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      output_config: { effort: 'high' },
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: image.media_type, data: image.data } },
          { type: 'text', text: '¿Dónde fue tomada esta foto? Identificá el lugar con el mayor detalle que la evidencia permita.' + hint }
        ]
      }]
    };

    if (useSchema) {
      body.output_config.format = { type: 'json_schema', schema: SCHEMA };
    } else {
      // Camino de respaldo: se pide el JSON por prompt y se extrae del texto.
      body.messages[0].content[1].text +=
        '\n\nRespondé únicamente con un objeto JSON con estas claves: ' +
        Object.keys(SCHEMA.properties).join(', ') + '. Sin texto alrededor ni bloques de código.';
    }
    return body;
  }

  function callClaude(body, apiKey) {
    return fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.text().then(function (text) {
        var json = null;
        try { json = JSON.parse(text); } catch (e) { /* respuesta no-JSON */ }
        return { ok: res.ok, status: res.status, json: json, text: text };
      });
    });
  }

  function extractJson(message) {
    var text = (message.content || [])
      .filter(function (b) { return b.type === 'text'; })
      .map(function (b) { return b.text; })
      .join('')
      .trim();

    if (!text) throw new Error('El modelo no devolvió texto.');
    try { return JSON.parse(text); } catch (e) { /* seguimos abajo */ }

    var fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) {
      try { return JSON.parse(fence[1]); } catch (e) { /* seguimos abajo */ }
    }
    var start = text.indexOf('{'), end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try { return JSON.parse(text.slice(start, end + 1)); } catch (e) { /* nada */ }
    }
    throw new Error('No se pudo interpretar la respuesta del modelo.');
  }

  function describeApiError(res) {
    if (res.status === 401) return 'La clave de API es inválida o fue revocada. Revisala en "Configurar clave".';
    if (res.status === 403) return 'La clave no tiene permiso para usar la API de mensajes.';
    if (res.status === 429) return 'Se alcanzó el límite de solicitudes. Esperá unos segundos y reintentá.';
    if (res.status === 529) return 'La API está sobrecargada en este momento. Reintentá en un rato.';
    var msg = res.json && res.json.error && res.json.error.message;
    return 'Error de la API (' + res.status + ')' + (msg ? ': ' + msg : '.');
  }

  function identifyWithClaude(image, exif, apiKey) {
    return callClaude(buildRequest(image, exif, true), apiKey).then(function (res) {
      // Si el esquema estructurado no es aceptado, se reintenta pidiendo JSON por prompt.
      var schemaProblem = !res.ok && res.status === 400 &&
        /output_config|json_schema|schema|format/i.test(res.text || '');
      if (schemaProblem) return callClaude(buildRequest(image, exif, false), apiKey);
      return res;
    }).then(function (res) {
      if (!res.ok) throw new Error(describeApiError(res));
      var message = res.json;
      if (!message) throw new Error('Respuesta inesperada de la API.');
      if (message.stop_reason === 'refusal') {
        throw new Error('El modelo se negó a analizar esta imagen.');
      }
      return extractJson(message);
    });
  }

  /* ============================================================
     Render
     ============================================================ */

  function renderExifCard(exif, place) {
    var body = '';
    body += '<p class="place-name">' + esc(place && place.name ? place.name : 'Ubicación registrada por la cámara') + '</p>';
    if (place && place.display_name) {
      body += '<p class="place-addr">' + esc(place.display_name) + '</p>';
    }
    body += coordBlock(exif.lat, exif.lon);

    var facts = '';
    if (exif.altitude != null) facts += '<dt>Altitud</dt><dd>' + exif.altitude.toFixed(1) + ' m</dd>';
    if (exif.dateTimeOriginal || exif.dateTime) facts += '<dt>Fecha de captura</dt><dd>' + esc(exif.dateTimeOriginal || exif.dateTime) + '</dd>';
    if (exif.gpsDate) facts += '<dt>Fecha GPS (UTC)</dt><dd>' + esc(exif.gpsDate) + (exif.gpsTime ? ' ' + esc(exif.gpsTime) : '') + '</dd>';
    if (exif.make || exif.model) facts += '<dt>Cámara</dt><dd>' + esc([exif.make, exif.model].filter(Boolean).join(' ')) + '</dd>';
    if (facts) body += '<dl class="facts">' + facts + '</dl>';

    $('exif-body').innerHTML = body;
    $('card-exif').classList.remove('hidden');
  }

  function renderVisionCard(result, place) {
    var conf = ['alta', 'media', 'baja'].indexOf(result.confianza) !== -1 ? result.confianza : 'baja';
    var badge = $('vision-confidence');
    badge.textContent = 'Confianza ' + conf;
    badge.className = 'badge badge-' + conf;

    var body = '';

    if (!result.identificado && !place) {
      body += '<p class="place-name">No se pudo identificar el lugar</p>';
      body += '<p class="place-addr">La imagen no tiene suficientes señales reconocibles.</p>';
    } else {
      body += '<p class="place-name">' + esc(result.lugar || 'Lugar sin nombre') + '</p>';
      var linea = [result.direccion, result.ciudad, result.region, result.pais]
        .filter(function (s) { return s && String(s).trim(); }).join(', ');
      if (linea) body += '<p class="place-addr">' + esc(linea) + '</p>';

      var lat = place ? parseFloat(place.lat) : result.latitud;
      var lon = place ? parseFloat(place.lon) : result.longitud;

      if (typeof lat === 'number' && typeof lon === 'number' && isFinite(lat) && isFinite(lon)) {
        body += coordBlock(lat, lon, {
          note: place
            ? 'Coordenadas tomadas de OpenStreetMap para «' + (result.consulta_mapa || result.lugar) + '».'
            : 'Coordenadas estimadas por el modelo, sin confirmar contra un mapa.'
        });
      } else {
        body += '<p class="card-note">No hay coordenadas: el modelo llegó a la zona pero no a un punto concreto.</p>';
      }

      if (result.tipo) {
        body += '<dl class="facts"><dt>Tipo de lugar</dt><dd>' + esc(result.tipo) + '</dd></dl>';
      }
    }

    if (Array.isArray(result.pistas) && result.pistas.length) {
      body += '<ul class="clues">' + result.pistas.map(function (p) {
        return '<li>' + esc(p) + '</li>';
      }).join('') + '</ul>';
    }

    if (Array.isArray(result.alternativas) && result.alternativas.length) {
      body += '<div class="alt"><h3>Otras posibilidades</h3><ul>' +
        result.alternativas.map(function (a) { return '<li>' + esc(a) + '</li>'; }).join('') +
        '</ul></div>';
    }

    $('vision-body').innerHTML = body;
    $('card-vision').classList.remove('hidden');
  }

  function renderEmptyCard(note, hasKey) {
    $('empty-note').textContent = note || 'El archivo no trae coordenadas GPS.';
    $('tip-key').classList.toggle('hidden', !!hasKey);
    $('card-empty').classList.remove('hidden');
  }

  function resetResults() {
    $('results').classList.add('hidden');
    ['card-exif', 'card-vision', 'card-empty'].forEach(function (id) { $(id).classList.add('hidden'); });
    $('exif-body').innerHTML = '';
    $('vision-body').innerHTML = '';
  }

  /* ============================================================
     Flujo principal
     ============================================================ */

  function loadFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      showStatus('Eso no es una imagen. Subí un JPG, PNG o WebP.', 'error');
      return;
    }
    resetResults();
    hideStatus();

    state.file = file;
    var reader = new FileReader();
    reader.onload = function () {
      state.buffer = reader.result;
      var blobUrl = URL.createObjectURL(file);
      state.dataUrl = blobUrl;
      $('preview-img').src = blobUrl;
      $('file-name').textContent = file.name || 'imagen';
      $('file-info').textContent = fmtBytes(file.size) + ' · ' + (file.type || 'tipo desconocido');
      $('preview-card').classList.remove('hidden');
      $('dropzone').classList.add('hidden');
      $('btn-analyze').disabled = false;
    };
    reader.onerror = function () { showStatus('No se pudo leer el archivo.', 'error'); };
    reader.readAsArrayBuffer(file);
  }

  function analyze() {
    if (state.busy || !state.buffer) return;
    state.busy = true;
    $('btn-analyze').disabled = true;
    resetResults();
    $('results').classList.remove('hidden');

    var exifRead = { data: null, format: '', note: '' };
    try {
      exifRead = window.ExifReader.read(state.buffer);
    } catch (e) {
      exifRead.note = 'No se pudieron leer los metadatos de este archivo.';
    }
    var exif = exifRead.data;
    var hasGps = !!(exif && typeof exif.lat === 'number' && typeof exif.lon === 'number' &&
                    isFinite(exif.lat) && isFinite(exif.lon) && !(exif.lat === 0 && exif.lon === 0));

    var apiKey = getKey();
    var steps = [];

    if (hasGps) {
      showStatus('Encontré GPS en la foto. Buscando la dirección…', 'loading');
      steps.push(
        reverseGeocode(exif.lat, exif.lon).then(function (place) {
          renderExifCard(exif, place);
        })
      );
    } else {
      renderEmptyCard(exifRead.note || 'El archivo no trae coordenadas GPS.', !!apiKey);
    }

    if (apiKey) {
      showStatus(hasGps ? 'Analizando la imagen con Claude…' : 'Sin GPS en el archivo. Analizando la imagen con Claude…', 'loading');
      steps.push(
        toModelImage(state.dataUrl)
          .then(function (image) { return identifyWithClaude(image, exif, apiKey); })
          .then(function (result) {
            var query = result.consulta_mapa ||
              [result.lugar, result.ciudad, result.pais].filter(Boolean).join(', ');
            return forwardGeocode(result.identificado ? query : null).then(function (place) {
              renderVisionCard(result, place);
            });
          })
          .catch(function (err) {
            $('vision-confidence').textContent = 'Falló';
            $('vision-confidence').className = 'badge badge-baja';
            $('vision-body').innerHTML = '<p class="place-addr">' + esc(err.message) + '</p>';
            $('card-vision').classList.remove('hidden');
          })
      );
    } else if (!hasGps) {
      showStatus('Esta foto no trae GPS. Para identificarla por lo que se ve, cargá tu clave de API en "Configurar clave".', 'error');
    }

    Promise.all(steps).then(function () {
      state.busy = false;
      $('btn-analyze').disabled = false;
      if (apiKey || hasGps) hideStatus();
    });
  }

  function reset() {
    state = { file: null, buffer: null, dataUrl: null, busy: false };
    $('preview-card').classList.add('hidden');
    $('dropzone').classList.remove('hidden');
    $('file-input').value = '';
    resetResults();
    hideStatus();
  }

  /* ============================================================
     Eventos
     ============================================================ */

  var dz = $('dropzone');

  dz.addEventListener('click', function () { $('file-input').click(); });
  dz.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file-input').click(); }
  });
  $('file-input').addEventListener('change', function (e) { loadFile(e.target.files[0]); });

  ['dragenter', 'dragover'].forEach(function (ev) {
    dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('dragging'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('dragging'); });
  });
  dz.addEventListener('drop', function (e) {
    if (e.dataTransfer && e.dataTransfer.files.length) loadFile(e.dataTransfer.files[0]);
  });

  document.addEventListener('paste', function (e) {
    var items = (e.clipboardData && e.clipboardData.items) || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image/') === 0) {
        loadFile(items[i].getAsFile());
        break;
      }
    }
  });

  $('btn-analyze').addEventListener('click', analyze);
  $('btn-reset').addEventListener('click', reset);

  // --- Modal de la clave ---
  function openModal() {
    $('api-key').value = getKey();
    $('modal').classList.remove('hidden');
    $('api-key').focus();
  }
  function closeModal() { $('modal').classList.add('hidden'); }

  $('btn-config').addEventListener('click', openModal);
  $('btn-cancel').addEventListener('click', closeModal);
  $('modal').addEventListener('click', function (e) { if (e.target === $('modal')) closeModal(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });

  $('btn-save-key').addEventListener('click', function () {
    var value = $('api-key').value.trim();
    try {
      if (value) localStorage.setItem(KEY_STORAGE, value);
      else localStorage.removeItem(KEY_STORAGE);
    } catch (err) {
      showStatus('El navegador bloqueó el almacenamiento local; la clave no se pudo guardar.', 'error');
    }
    closeModal();
    updateKeyButton();
  });

  $('btn-clear-key').addEventListener('click', function () {
    try { localStorage.removeItem(KEY_STORAGE); } catch (err) { /* nada */ }
    $('api-key').value = '';
    closeModal();
    updateKeyButton();
  });

  function updateKeyButton() {
    $('btn-config').textContent = getKey() ? 'Clave configurada ✓' : 'Configurar clave';
  }

  updateKeyButton();
})();
