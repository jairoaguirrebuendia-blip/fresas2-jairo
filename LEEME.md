# FenoFresa — PWA

App instalable para analizar imágenes de fresa **en el propio teléfono**:
cuenta frutos y flores, clasifica estadios de madurez y guarda todo en una
**base de datos local (IndexedDB)**. Tras instalarla, **funciona sin conexión**.

---

## 1) Publicarla una vez (paso único, mejor desde una computadora)

Un service worker y la base local necesitan un origen seguro (**https**), así que
un archivo suelto en el teléfono no basta. Publícala una sola vez; después se
instala en el teléfono y ya vive ahí.

### Opción A — Netlify Drop (la más fácil, ~1 min)
1. Entra a **app.netlify.com/drop**.
2. Arrastra **toda esta carpeta** (`fenofresa-pwa`) a la página.
3. Te da una URL `https://…netlify.app`. Ábrela en el teléfono.

### Opción B — GitHub Pages
1. Crea un repositorio y sube estos archivos (respetando la carpeta `icons/`).
2. **Settings → Pages → Deploy from branch → main / root**.
3. Usa la URL `https://usuario.github.io/repo/` en el teléfono.

> Cualquier hosting estático sirve (Vercel, Cloudflare Pages, etc.).

---

## 2) Instalar en el teléfono

- **Android (Chrome):** abre la URL → menú ⋮ → **Instalar app** (o el botón
  **Instalar** que aparece en el encabezado). Queda un ícono en la pantalla de inicio.
- **iPhone (Safari):** abre la URL → **Compartir** → **Agregar a inicio**.

Ya instalada, ábrela desde el ícono. La primera vez cachea todo; luego abre y
analiza **sin internet**. Los registros se guardan en el teléfono.

---

## 3) Cómo funciona

- **Captura:** *Tomar foto* (cámara) o *Elegir imagen*.
- **Conteo automático (en el dispositivo):** visión por color (HSV) + detección
  de blobs. Fuerte en **fruto rojo** y en **flores** (por el centro amarillo).
- **Revisión:** todos los conteos son **editables** con − / +. *Verde* y *Blanco*
  van marcados **“revisar”** porque el color solo no los separa bien de hojas y
  flores. *Botones* es manual.
- **Guardar:** escribe el registro (con parcela, variedad y notas) en la base local.
- **Exportar / Importar:** CSV (para Excel, con acentos) y JSON. El JSON se puede
  volver a importar para respaldar o mover datos entre dispositivos.

---

## 4) Subir la precisión (siguiente paso)

El conteo por color es un primer paso. Para contar **flores y frutos verdes** de
forma defendible (tu artículo en Pistas Educativas), el camino es un **detector
entrenado**:

1. Anota fotos de tus parcelas del Bajío (clases: flor, botón, verde, blanco,
   envero, rojo) con una herramienta como Roboflow o CVAT.
2. Entrena un **YOLO** en Google Colab (que ya usas) y expórtalo a **TensorFlow.js**.
3. Reemplaza la función `analyze()` en `app.js` por la inferencia del modelo.
   La base de datos, la UI y la exportación quedan igual.

---

## Archivos
- `index.html` — interfaz
- `app.js` — motor de análisis + base local + PWA
- `sw.js` — cacheo offline
- `manifest.webmanifest` — datos de instalación
- `icons/` — íconos de la app
- `make_icons.py` — (opcional) regenerar íconos con Pillow

Para personalizar la marca o los estadios, edita las constantes al inicio de
`app.js` y el encabezado en `index.html`.
