/*
 * exif.js — Lector mínimo de metadatos EXIF (JPEG y TIFF) sin dependencias.
 * Extrae GPS (latitud, longitud, altitud), fecha de captura y cámara.
 */
(function (global) {
  'use strict';

  var TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

  function readValue(view, tiffStart, entryOffset, little) {
    var type = view.getUint16(entryOffset + 2, little);
    var count = view.getUint32(entryOffset + 4, little);
    var size = TYPE_SIZE[type];
    if (!size) return null;

    var total = size * count;
    var dataOffset = total <= 4 ? entryOffset + 8 : tiffStart + view.getUint32(entryOffset + 8, little);
    if (dataOffset + total > view.byteLength) return null;

    if (type === 2) { // ASCII
      var chars = [];
      for (var i = 0; i < count; i++) {
        var c = view.getUint8(dataOffset + i);
        if (c === 0) break;
        chars.push(String.fromCharCode(c));
      }
      return chars.join('');
    }

    var out = [];
    for (var j = 0; j < count; j++) {
      var p = dataOffset + j * size;
      switch (type) {
        case 1: case 7: out.push(view.getUint8(p)); break;
        case 6: out.push(view.getInt8(p)); break;
        case 3: out.push(view.getUint16(p, little)); break;
        case 8: out.push(view.getInt16(p, little)); break;
        case 4: out.push(view.getUint32(p, little)); break;
        case 9: out.push(view.getInt32(p, little)); break;
        case 5: {
          var num = view.getUint32(p, little), den = view.getUint32(p + 4, little);
          out.push(den === 0 ? 0 : num / den);
          break;
        }
        case 10: {
          var sn = view.getInt32(p, little), sd = view.getInt32(p + 4, little);
          out.push(sd === 0 ? 0 : sn / sd);
          break;
        }
        case 11: out.push(view.getFloat32(p, little)); break;
        case 12: out.push(view.getFloat64(p, little)); break;
        default: return null;
      }
    }
    return count === 1 ? out[0] : out;
  }

  function readIfd(view, tiffStart, ifdOffset, little) {
    var tags = {};
    if (ifdOffset + 2 > view.byteLength) return tags;
    var entries = view.getUint16(ifdOffset, little);
    // Un IFD con miles de entradas es basura, no metadatos.
    if (entries > 512) return tags;
    for (var i = 0; i < entries; i++) {
      var entry = ifdOffset + 2 + i * 12;
      if (entry + 12 > view.byteLength) break;
      var tag = view.getUint16(entry, little);
      tags[tag] = readValue(view, tiffStart, entry, little);
    }
    return tags;
  }

  function toDecimal(dms, ref) {
    if (!Array.isArray(dms) || dms.length < 2) return null;
    var deg = dms[0] || 0, min = dms[1] || 0, sec = dms[2] || 0;
    var dec = deg + min / 60 + sec / 3600;
    if (ref === 'S' || ref === 'W') dec = -dec;
    return dec;
  }

  function parseTiff(view, tiffStart) {
    if (tiffStart + 8 > view.byteLength) return null;
    var order = view.getUint16(tiffStart);
    if (order !== 0x4949 && order !== 0x4D4D) return null;
    var little = order === 0x4949;
    if (view.getUint16(tiffStart + 2, little) !== 42) return null;

    var ifd0 = readIfd(view, tiffStart, tiffStart + view.getUint32(tiffStart + 4, little), little);
    var result = {
      make: ifd0[0x010F] || null,
      model: ifd0[0x0110] || null,
      orientation: ifd0[0x0112] || null,
      dateTime: ifd0[0x0132] || null,
      lat: null, lon: null, altitude: null, gpsDate: null, gpsTime: null
    };

    if (ifd0[0x8769]) {
      var exif = readIfd(view, tiffStart, tiffStart + ifd0[0x8769], little);
      result.dateTimeOriginal = exif[0x9003] || exif[0x9004] || null;
      result.lensModel = exif[0xA434] || null;
    }

    if (ifd0[0x8825]) {
      var gps = readIfd(view, tiffStart, tiffStart + ifd0[0x8825], little);
      result.lat = toDecimal(gps[0x0002], gps[0x0001]);
      result.lon = toDecimal(gps[0x0004], gps[0x0003]);
      if (typeof gps[0x0006] === 'number') {
        result.altitude = gps[0x0005] === 1 ? -gps[0x0006] : gps[0x0006];
      }
      result.gpsDate = gps[0x001D] || null;
      if (Array.isArray(gps[0x0007])) {
        result.gpsTime = gps[0x0007].map(function (n) {
          return String(Math.round(n)).padStart(2, '0');
        }).join(':');
      }
    }

    return result;
  }

  function parseJpeg(view) {
    if (view.getUint16(0) !== 0xFFD8) return undefined; // no es JPEG
    var offset = 2;
    while (offset + 4 <= view.byteLength) {
      if (view.getUint8(offset) !== 0xFF) { offset++; continue; }
      var marker = view.getUint8(offset + 1);
      if (marker === 0xFF) { offset++; continue; }
      if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { offset += 2; continue; }
      if (marker === 0xDA || marker === 0xD9) break; // empieza la imagen comprimida
      var size = view.getUint16(offset + 2);
      if (size < 2) break;
      if (marker === 0xE1 && offset + 10 <= view.byteLength) {
        if (view.getUint32(offset + 4) === 0x45786966 && view.getUint16(offset + 8) === 0x0000) {
          return parseTiff(view, offset + 10);
        }
      }
      offset += 2 + size;
    }
    return null; // JPEG sin bloque EXIF
  }

  /**
   * @param {ArrayBuffer} buffer
   * @returns {{data: object|null, format: string, note: string}}
   */
  function read(buffer) {
    var view = new DataView(buffer);
    if (view.byteLength < 12) return { data: null, format: 'desconocido', note: 'Archivo demasiado chico.' };

    var jpeg = parseJpeg(view);
    if (jpeg !== undefined) {
      return jpeg
        ? { data: jpeg, format: 'JPEG', note: '' }
        : { data: null, format: 'JPEG', note: 'El JPEG no trae bloque EXIF (probablemente lo borró la app que lo compartió).' };
    }

    // TIFF / DNG crudo
    var order = view.getUint16(0);
    if (order === 0x4949 || order === 0x4D4D) {
      var tiff = parseTiff(view, 0);
      if (tiff) return { data: tiff, format: 'TIFF', note: '' };
    }

    var sig4 = view.getUint32(0);
    if (sig4 === 0x89504E47) return { data: null, format: 'PNG', note: 'Los PNG casi nunca guardan GPS. Suele pasar con capturas de pantalla.' };
    if ((view.getUint16(0) === 0x4749)) return { data: null, format: 'GIF', note: 'Los GIF no guardan GPS.' };
    if (view.byteLength > 12 && view.getUint32(8) === 0x57454250) return { data: null, format: 'WebP', note: 'Este WebP no expone EXIF legible.' };
    if (view.byteLength > 12 && view.getUint32(4) === 0x66747970) return { data: null, format: 'HEIC/HEIF', note: 'Formato de iPhone: este lector no abre HEIC. Convertila a JPG y probá de nuevo.' };

    return { data: null, format: 'desconocido', note: 'No se pudo leer metadatos de este formato.' };
  }

  global.ExifReader = { read: read };
})(window);
