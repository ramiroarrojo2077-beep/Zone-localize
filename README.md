# Zone Localize

Página web para saber **dónde fue tomada una foto** y obtener las **coordenadas listas para pegar en Google Maps**.

Funciona con fotos de cualquier lado: la vidriera de un shopping, una esquina, un aeropuerto, una plaza.

## Cómo funciona

La página intenta dos caminos independientes y muestra los dos resultados cuando ambos dan algo:

| Camino | De dónde salen las coordenadas | Precisión |
|---|---|---|
| **GPS de la foto** | Metadatos EXIF que graba la cámara al disparar | Exacta (metros) |
| **Reconocimiento visual** | Claude analiza lo que se ve: carteles, marcas, arquitectura, idioma, vegetación | Estimación |

El primero corre entero en el navegador y es instantáneo. El segundo manda la imagen a la API de Anthropic
y después confirma el lugar contra OpenStreetMap para no depender de la latitud y longitud que recuerde el modelo.

El resultado siempre incluye las coordenadas en formato `lat, lon` con un botón para copiar, un enlace directo a
Google Maps, otro a Street View y un mapa incrustado.

## Uso

1. Abrí `index.html` (o la página publicada).
2. Arrastrá la foto, hacé clic para elegirla, o pegala con `Ctrl+V`.
3. Tocá **Identificar el lugar**.

Para el reconocimiento visual hace falta una clave de API de Anthropic: tocá **Configurar clave** y pegala.
Se consigue en [console.anthropic.com](https://console.anthropic.com/settings/keys). Sin clave, la página
sigue funcionando con el GPS de los metadatos.

## App para Android (APK)

Hay una app que envuelve la página en un WebView, para usarla desde el celular sin abrir el navegador.
El APK lo compila GitHub Actions (`.github/workflows/apk.yml`), porque el runner ya trae el Android SDK.

**Bajarlo** — link directo, sin login y sin descomprimir nada:

```
https://github.com/ramiroarrojo2077-beep/Zone-localize/releases/latest/download/zone-localize.apk
```

Se puede abrir tal cual desde el celular. La URL no cambia: cada compilación reemplaza el archivo,
así que siempre sirve la última versión.

Al instalarlo, Android va a pedir permiso para "instalar apps desconocidas": es lo normal para una
app que no viene de Play Store. Está firmado con la clave de debug, así que sirve para uso personal
pero no para publicar en Play Store.

Cada corrida del workflow deja además el APK como artefacto en la pestaña
[Actions](https://github.com/ramiroarrojo2077-beep/Zone-localize/actions), por si hace falta una
versión anterior.

**Detalles de la implementación**, que son los que hacen que funcione de verdad:

- Los archivos **no** se cargan con `file://`. Ese esquema da origen `null`, y ahí el WebView bloquea
  `localStorage` (donde vive la clave de API) y la llamada a la API de Anthropic por CORS. Se sirven con
  `WebViewAssetLoader` desde un origen `https` virtual, y la página se comporta igual que en un navegador.
- Está implementado `onShowFileChooser`: sin eso, el botón de elegir foto no hace nada dentro de un WebView.
- Los enlaces a Google Maps y Street View se abren en la app externa; el mapa incrustado sigue adentro.
- El botón atrás navega el historial de la página antes de cerrar la app.
- Se aplican los insets del sistema, porque desde Android 15 el contenido va debajo de la barra de estado.

La página es la misma: al compilar, los cuatro archivos de la raíz se copian a los assets de la app,
así que no hay dos copias que se desincronicen.

## Correrla localmente

No hay build ni dependencias. Alcanza con abrir `index.html` en el navegador, aunque conviene servirla por HTTP:

```bash
python3 -m http.server 8000
# después: http://localhost:8000
```

## Publicarla

Es un sitio estático: se puede subir a GitHub Pages tal cual (Settings → Pages → rama y carpeta raíz),
o a cualquier hosting de archivos.

## Sobre la clave de API y la privacidad

- La clave se guarda **solo en tu navegador**, en `localStorage`, y viaja únicamente a `api.anthropic.com`.
- Al usar el reconocimiento visual, la foto se envía a la API de Anthropic. El GPS de los metadatos, en cambio,
  se lee sin que la foto salga de tu máquina.
- **No publiques esta página con una clave escrita en el código**: cualquiera que la abra puede leerla.
  Cada persona carga la suya.
- Cada análisis consume tokens de tu cuenta. La imagen se reduce a 1568 px de lado antes de enviarla para
  no gastar de más.

## Por qué muchas fotos no traen GPS

- WhatsApp, Instagram y Telegram borran los metadatos al comprimir. Mandá el archivo original, como "documento".
- En iPhone, al compartir: **Opciones → Ubicación** decide si el GPS viaja o no.
- Las capturas de pantalla y las imágenes bajadas de internet nunca lo traen.
- Los HEIC de iPhone no los lee esta página; convertilos a JPG.

En todos esos casos queda el reconocimiento visual, que trabaja sobre la imagen y no sobre los metadatos.

## Límites conocidos

- El reconocimiento visual **puede equivocarse**. La tarjeta muestra el nivel de confianza, las pistas concretas
  que usó y otras posibilidades. Verificá antes de darlo por cierto.
- Los interiores sin carteles ni marcas visibles son difíciles: un pasillo neutro de shopping puede ser cualquiera.
- El lector de EXIF cubre JPEG y TIFF/DNG. No abre HEIC ni RAW propietarios.
- La geocodificación usa la API pública de Nominatim, que tiene límite de una consulta por segundo.

## Estructura

```
index.html   estructura de la página
styles.css   estilos
app.js       flujo, llamadas a la API y render de resultados
exif.js      lector de EXIF/GPS propio, sin dependencias
android/     app Android que envuelve la página en un WebView
```
